// Surveillance en arrière-plan de la watchlist.
//
// Contrainte OS (assumée, pas contournable) : iOS/Android ne laissent PAS tourner
// du JS en continu en arrière-plan. On utilise `expo-background-fetch` : l'OS
// RÉVEILLE l'app périodiquement (≥ 15 min, cadence décidée par l'OS selon l'usage
// et la batterie) et nous accorde une courte fenêtre. À chaque réveil on sonde la
// watchlist ; si un nom s'est libéré, on tente le snipe (best-effort) et on
// envoie une notification avec le résultat.
//
// => Idéal pour « préviens-moi quand ce nom se libère ». PAS fiable pour caler un
//    drop à la seconde près (garder l'app au premier plan pour ça).
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { hydrateConfig } from './config.js';
import { getWatch, removeWatch, pushHistory, saveSettings } from './storage.js';
import { ADAPTERS } from './adapters.js';
import { notify } from './notify.js';

export const BG_TASK = 'snipe-hub-watch';

// --- Corps de la tâche : sonde chaque nom surveillé ---
async function runBackgroundPoll() {
  await hydrateConfig(); // contexte headless : la config n'est pas encore en mémoire
  const list = await getWatch();
  if (!list.length) return false;
  let didWork = false;

  for (const it of list) {
    const adapter = ADAPTERS[it.platform];
    if (!adapter) continue;

    let free = false;
    try { const r = await adapter.check(it.name); free = r.free === true; } catch { continue; }
    if (!free) continue;
    didWork = true;

    // Libre : tenter le snipe si un compte est connecté.
    let account = null;
    try { account = await adapter.whoami(); } catch { /* ignore */ }
    if (!account) {
      await notify(`🔔 ${it.name} est libre`, `${adapter.label} — ouvre Snipe Hub pour le réclamer (non connecté).`);
      continue;
    }

    let ok = false;
    try {
      // Snipe immédiat : dropAt ~maintenant, sans sync horloge (fenêtre courte).
      const res = await adapter.snipe({
        name: it.name, guildId: it.extra?.guildId,
        monitor: false, dropAt: Date.now() + 80,
        burst: 6, spacingMs: 25, leadMs: 0, offset: 0, skipNtp: true,
        shouldStop: () => false,
      });
      ok = !!res.success;
    } catch { /* échec = notif ci-dessous */ }

    await pushHistory({ platform: it.platform, name: it.name, ok });
    if (ok) {
      await notify('🎯 Snipe réussi', `${adapter.label} · ${it.name} récupéré !`);
      await removeWatch(it.id); // gagné : on retire de la watchlist
    } else {
      await notify(`⚠️ ${it.name} s'est libéré`, `${adapter.label} — tentative échouée, ouvre l'app pour réessayer.`);
    }
  }
  return didWork;
}

// Enregistrement global de la tâche (doit s'exécuter au chargement du bundle,
// y compris en réveil headless — d'où l'import dans index.js).
TaskManager.defineTask(BG_TASK, async () => {
  try {
    const didWork = await runBackgroundPoll();
    return didWork
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// --- Contrôle depuis l'UI ---
export async function registerBackground() {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Restricted
      || status === BackgroundFetch.BackgroundFetchStatus.Denied) {
      return { ok: false, reason: 'Arrière-plan refusé/restreint dans les réglages système.' };
    }
    await BackgroundFetch.registerTaskAsync(BG_TASK, {
      minimumInterval: 15 * 60, // secondes (plancher iOS ~15 min, l'OS peut espacer davantage)
      stopOnTerminate: false,   // Android : continuer après fermeture
      startOnBoot: true,        // Android : reprendre au redémarrage
    });
    await saveSettings({ bgMonitor: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export async function unregisterBackground() {
  try { await BackgroundFetch.unregisterTaskAsync(BG_TASK); } catch { /* ignore */ }
  await saveSettings({ bgMonitor: false });
}

export async function isBackgroundRegistered() {
  try { return await TaskManager.isTaskRegisteredAsync(BG_TASK); } catch { return false; }
}

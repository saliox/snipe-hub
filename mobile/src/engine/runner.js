// Orchestrateur d'un snipe : parse l'instant du drop, synchronise l'horloge,
// lance le moteur de la plateforme et enregistre l'historique. Expose un contrôle
// d'arrêt (stop()) pour le mode surveillance.
import { syncClock } from './time.js';
import { log } from './net.js';
import { pushHistory } from './storage.js';

// Parse l'instant du drop : ISO ("2026-07-10T15:00:00Z"), relatif ("90s", "5m"),
// ou epoch ms. Renvoie un timestamp ms, ou null.
export function parseDropAt(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const rel = s.match(/^(\d+)\s*(s|m|h)?$/i);
  if (rel) {
    const n = Number(rel[1]);
    const mult = { s: 1000, m: 60000, h: 3600000 }[(rel[2] || 's').toLowerCase()];
    return Date.now() + n * mult;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Contrôleur : { promise, stop() }. shouldStop lu par les moteurs en surveillance.
export function startSnipe(adapter, opts) {
  let stopped = false;
  const shouldStop = () => stopped;
  const run = (async () => {
    let offset = 0;
    if (opts.mode === 'at' || !opts.skipNtp) offset = await syncClock(opts.skipNtp);
    const dropAt = opts.mode === 'at' ? parseDropAt(opts.at) : null;
    if (opts.mode === 'at' && !dropAt) throw new Error('Instant du drop invalide (ex : 2026-07-10T15:00:00Z ou 90s).');
    let result;
    try {
      result = await adapter.snipe({
        name: opts.name, guildId: opts.guildId,
        monitor: opts.mode === 'monitor', dropAt,
        burst: opts.burst, spacingMs: opts.spacingMs, leadMs: opts.leadMs,
        offset, skipNtp: opts.skipNtp, shouldStop,
      });
    } catch (e) {
      log.err(e.message);
      result = { success: false, error: e.message };
    }
    if (!result.stopped) {
      await pushHistory({ platform: adapter.id, name: opts.name, ok: !!result.success });
    }
    return result;
  })();
  return { promise: run, stop: () => { stopped = true; } };
}

// Moteur de snipe Roblox : surveille la disponibilité d'un pseudo et le prend
// dès qu'il se libère (POST changement de pseudo).
//
// ⚠️ Sécurité Robux : un changement RÉUSSI coûte 1000 Robux. On tire donc les
// tentatives EN SÉRIE (jamais en parallèle) et on s'arrête au 1er succès → aucun
// risque de double débit. Les échecs « nom déjà pris » ne débitent rien.
import { log, sleep, sleepUntil, fmtDuration } from './util.js';
import { bestOffset } from './ntp.js';
import { validateName, changeUsername } from './roblox.js';
import { fetchCsrf } from './auth.js';

let stopFlag = false;
export function requestStop() { stopFlag = true; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Attente jusqu'à `target`, mais RÉACTIVE à l'arrêt : on dort par paliers de 200 ms
// tant qu'il reste du temps, puis on finit avec sleepUntil pour la précision. Sans ça,
// un snipe planifié dort d'un bloc : le bouton Arrêter ne fait rien ET le verrou global
// `running` de gui/main.js reste pris (plus aucun snipe possible, toutes plateformes).
async function waitUntilOrStop(target) {
  while (!stopFlag && Date.now() < target - 200) {
    await sleep(Math.min(200, target - Date.now()));
  }
  if (!stopFlag && Date.now() < target) await sleepUntil(target, 20);
}

// Tente le changement, en série. Gère la rotation du jeton CSRF (403) et le 429.
async function fireChange(name, session) {
  for (let i = 0; i < session.maxTries && !stopFlag; i++) {
    // Le POST doit survivre à une coupure réseau : sans ce try/catch, un ECONNRESET
    // AU MOMENT DE LA PRISE faisait avorter tout le snipe alors qu'il restait des
    // tentatives. Le `continue` préserve la règle « en série, arrêt au 1er succès »
    // (donc aucun risque de double débit de 1000 Robux).
    let r;
    try { r = await changeUsername(name, session); }
    catch (e) { log.warn(`tentative #${i + 1} : ${e.message} — nouvelle tentative.`); await sleep(300); continue; }
    if (r.ok) { log.ok(`🎯 Pseudo « ${name} » OBTENU (tentative #${i + 1}) — 1000 Robux débités.`); return { success: true, index: i + 1 }; }
    if (r.status === 403 && r.newCsrf) { session.csrf = r.newCsrf; log.warn('Jeton CSRF renouvelé — nouvelle tentative.'); continue; }
    if (r.status === 429) { log.warn('429 (rate-limit) — pause 800 ms.'); await sleep(800); continue; }
    const m = (r.message || '').toLowerCase();
    if (m.includes('password')) return { success: false, fatal: true, message: 'Mot de passe Roblox incorrect.' };
    if (m.includes('robux')) return { success: false, fatal: true, message: 'Robux insuffisants (1000 requis).' };
    if (m.includes('taken') || m.includes('in use')) return { success: false, taken: true, message: r.message };
    log.err(`Refus (${r.status}) : ${r.message}`);
    return { success: false, message: r.message, status: r.status };
  }
  return { success: false, message: 'tentatives épuisées' };
}

// Boucle : sonde la dispo, et dès que le nom est libre, tente la prise.
async function grabWhenFree(name, session, { pollMs }) {
  const MAX_TAKEN = 5;
  let takenLosses = 0, polls = 0;
  while (!stopFlag) {
    let r;
    try { r = await validateName(name, session.cookie); }
    catch (e) { log.warn(`sonde: ${e.message}`); await sleep(pollMs); continue; }
    polls++;
    if (r.rateLimited) { const w = (r.retryAfter || 2) * 1000; log.warn(`429 sur la sonde — pause ${Math.round(w / 1000)}s.`); await sleep(w); continue; }
    // Statut INDÉTERMINÉ (free == null) : sans ce garde-fou, un cookie expiré (401/403)
    // retombait dans la voie « toujours pris » et la surveillance tournait à l'infini,
    // muette, sans jamais prendre le pseudo ni signaler quoi que ce soit.
    if (r.free == null) {
      if (r.status === 401 || r.status === 403) {
        return { success: false, fatal: true, message: 'Cookie .ROBLOSECURITY invalide ou expiré — reconnecte-toi.' };
      }
      log.warn(`sonde indéterminée (statut ${r.status}) — nouvelle tentative.`);
      await sleep(pollMs);
      continue;
    }
    if (r.free) {
      log.ok(`« ${name} » est LIBRE — tentative de prise !`);
      try { session.csrf = await fetchCsrf(session.cookie); } catch (e) { log.warn(`CSRF: ${e.message}`); }
      const res = await fireChange(name, session);
      if (res.success) return res;
      if (res.fatal) return res;                 // mot de passe / Robux : inutile d'insister
      takenLosses++;
      if (takenLosses >= MAX_TAKEN) { log.err(`Abandon après ${takenLosses} prises manquées sur « ${name} ».`); return res; }
      log.warn(`Prise manquée (${takenLosses}/${MAX_TAKEN}) — quelqu'un a été plus rapide, reprise.`);
      await sleep(1000); continue;
    }
    if (r.code === 2) { log.err(`« ${name} » est refusé par Roblox (invalide/filtré).`); return { success: false, fatal: true, message: 'Nom invalide/filtré.' }; }
    if (polls % 20 === 0) log.info(`...toujours pris (${polls} sondages).`);
    await sleep(pollMs);
  }
  log.warn('Surveillance arrêtée.');
  return { success: false, stopped: true };
}

/**
 * @param {object} opts
 * @param {string} opts.name        pseudo cible
 * @param {string} opts.cookie      cookie .ROBLOSECURITY
 * @param {string} opts.password    mot de passe du compte (exigé par Roblox)
 * @param {number} [opts.dropAt]    epoch ms du drop (mode planifié)
 * @param {boolean} [opts.monitor]  surveillance jusqu'à libération
 * @param {number} [opts.burst]     tentatives EN SÉRIE max (def 1, cap 5)
 * @param {number} [opts.leadMs]    avance sur T0 en planifié (def 40)
 * @param {boolean} [opts.skipNtp]  ne pas synchroniser l'horloge
 */
export async function snipe(opts) {
  const { name, cookie, password, dropAt, monitor = false, burst = 1, leadMs = 40, skipNtp = false } = opts;
  if (!cookie) throw new Error('Non connecté (cookie .ROBLOSECURITY manquant).');
  if (!password) throw new Error('Mot de passe Roblox requis pour changer de pseudo.');

  stopFlag = false;
  const session = { cookie, password, csrf: null, maxTries: clamp(burst || 1, 1, 5) };
  log.warn('⚠ Un changement de pseudo RÉUSSI coûte 1000 Robux (un nom déjà pris ne débite rien).');

  let offset = 0;
  if (!skipNtp) {
    log.step('Synchronisation NTP');
    try { const o = await bestOffset(); offset = o.offset; log.ok(`Offset horloge : ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms (via ${o.server}).`); }
    catch (e) { log.warn(`NTP indisponible (${e.message}) — horloge locale.`); }
  }

  if (!monitor && dropAt) {
    const now = Date.now() + offset;
    log.step(`Snipe planifié de « ${name} »`);
    log.info(`Drop dans ${fmtDuration(dropAt - now)} (${new Date(dropAt).toISOString()}).`);
    const fireLocal = (dropAt - leadMs) - offset;
    if (fireLocal > Date.now()) await waitUntilOrStop(fireLocal);
    if (stopFlag) { log.warn('Snipe planifié annulé.'); return { success: false, stopped: true }; }
  } else {
    log.step(`Surveillance de « ${name} » (prise dès que libre)`);
  }
  return grabWhenFree(name, session, { pollMs: 1000 });
}

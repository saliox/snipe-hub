// Moteur de snipe X (Twitter) : surveille la disponibilité d'un @handle et le
// prend dès qu'il se libère. Tir unique (changer de @handle n'est pas illimité).
// La disponibilité et le renommage restent « à confirmer » (endpoints X volatils) :
// on ALERTE toujours quand une fenêtre de dispo est détectée.
import { log, sleep, sleepUntil, fmtDuration } from './util.js';
import { bestOffset } from './ntp.js';
import { checkAvailable, changeUsername } from './x.js';

let stopFlag = false;
export function requestStop() { stopFlag = true; }

async function grabWhenFree(name, session, { pollMs }) {
  const MAX_TAKEN = 5;
  let takenLosses = 0, polls = 0;
  while (!stopFlag) {
    let r;
    try { r = await checkAvailable(name, session.cred); }
    catch (e) { log.warn(`sonde: ${e.message}`); await sleep(pollMs); continue; }
    polls++;
    if (r.rateLimited) { const w = (r.retryAfter || 2) * 1000; log.warn(`429 sur la sonde — pause ${Math.round(w / 1000)}s.`); await sleep(w); continue; }
    if (r.free) {
      log.ok(`🔔 « @${name} » est LIBRE sur X — tentative de prise !`);
      const res = await changeUsername(name, session);
      if (res.ok) { log.ok(`🎯 @handle « @${name} » OBTENU !`); return { success: true }; }
      log.err(`Prise échouée : ${res.message || 'statut ' + res.status}.`);
      takenLosses++;
      if (takenLosses >= MAX_TAKEN) { log.err(`Abandon après ${takenLosses} tentatives sur « @${name} ».`); return { success: false, message: res.message }; }
      await sleep(1500); continue;
    }
    if (polls % 20 === 0) log.info(`...toujours pris (${polls} sondages).`);
    await sleep(pollMs);
  }
  log.warn('Surveillance arrêtée.');
  return { success: false, stopped: true };
}

/**
 * @param {object} opts
 * @param {string} opts.name        @handle cible (sans @)
 * @param {{auth_token:string,ct0:string}} opts.cred  identifiants de session X
 * @param {number} [opts.dropAt]    epoch ms du drop (mode planifié)
 * @param {boolean} [opts.monitor]  surveillance jusqu'à libération
 * @param {number} [opts.leadMs]    avance sur T0 en planifié (def 40)
 * @param {boolean} [opts.skipNtp]  ne pas synchroniser l'horloge
 */
export async function snipe(opts) {
  const { name, cred, dropAt, monitor = false, leadMs = 40, skipNtp = false } = opts;
  if (!cred || !cred.auth_token || !cred.ct0) throw new Error('Non connecté (identifiants de session X manquants).');

  stopFlag = false;
  const session = { cred };
  let offset = 0;
  if (!skipNtp) {
    log.step('Synchronisation NTP');
    try { const o = await bestOffset(); offset = o.offset; log.ok(`Offset horloge : ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms (via ${o.server}).`); }
    catch (e) { log.warn(`NTP indisponible (${e.message}) — horloge locale.`); }
  }

  if (!monitor && dropAt) {
    const now = Date.now() + offset;
    log.step(`Snipe planifié de « @${name} » (X)`);
    log.info(`Drop dans ${fmtDuration(dropAt - now)} (${new Date(dropAt).toISOString()}).`);
    const fireLocal = (dropAt - leadMs) - offset;
    if (fireLocal > Date.now()) await sleepUntil(fireLocal, 20);
  } else {
    log.step(`Surveillance de « @${name} » (X, prise dès que libre)`);
  }
  return grabWhenFree(name, session, { pollMs: 1500 });
}

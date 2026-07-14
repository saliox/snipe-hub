// Synchronisation d'horloge pour caler le burst sur l'instant du drop.
//
// Le moteur desktop utilise du SNTP (UDP, RFC 4330). En Expo managé, les sockets
// UDP bruts ne sont pas disponibles : on estime l'offset via HTTP.
//   - Mesure grossière : offset ≈ (Date serveur + RTT/2) − horloge locale.
//   - Raffinement : on répète des HEAD rapides et on détecte le FLIP de l'en-tête
//     `Date` (précision seconde côté serveur) pour resserrer à quelques dizaines de ms.
//
// Pour une précision sub-100 ms garantie (SNTP réel), utiliser un dev-build avec
// `react-native-udp` — voir README. Sinon, l'offset HTTP suffit pour la plupart
// des drops (l'option « Sans sync » reste disponible dans l'UI).
import { fetchT, nowMs, log } from './net.js';

const ENDPOINTS = [
  'https://cloudflare.com/cdn-cgi/trace',
  'https://www.google.com/generate_204',
  'https://www.apple.com/library/test/success.html',
];

// Une mesure : renvoie { offset, rtt, serverSec } ou null.
async function sample(url) {
  const t1 = nowMs();
  let res;
  try { res = await fetchT(url, { method: 'HEAD', timeout: 4000, cache: 'no-store' }); }
  catch { try { res = await fetchT(url, { method: 'GET', timeout: 4000, cache: 'no-store' }); } catch { return null; } }
  const t4 = nowMs();
  const dateHdr = res.headers.get('date');
  if (!dateHdr) return null;
  const serverMs = Date.parse(dateHdr);
  if (Number.isNaN(serverMs)) return null;
  const rtt = t4 - t1;
  // Serveur au moment de la réponse ≈ serverMs (tronqué à la seconde). Offset = serveur+rtt/2 − local.
  const offset = (serverMs + rtt / 2) - t4;
  return { offset, rtt, serverSec: Math.floor(serverMs / 1000), t1, t4 };
}

// Détection de flip : enchaîne des HEAD ; quand la seconde serveur incrémente,
// le passage a eu lieu entre l'envoi précédent et la réception courante.
async function refine(url, budgetMs = 1500) {
  const start = nowMs();
  let prev = null;
  let best = null;
  while (nowMs() - start < budgetMs) {
    const s = await sample(url);
    if (!s) break;
    if (prev && s.serverSec === prev.serverSec + 1) {
      // Le tick (s.serverSec * 1000) est survenu dans ]prev.t1 ; s.t4[.
      const mid = (prev.t1 + s.t4) / 2;
      const offset = (s.serverSec * 1000) - mid;
      const uncertainty = (s.t4 - prev.t1) / 2;
      if (!best || uncertainty < best.uncertainty) best = { offset, uncertainty, rtt: s.rtt };
      if (uncertainty < 40) break; // assez précis
    }
    prev = s;
  }
  return best;
}

// Offset horloge (ms) : positif => horloge locale EN RETARD sur le serveur.
// Renvoie { offset, rtt, method } ; lève si aucun endpoint joignable.
export async function bestOffset() {
  const results = [];
  for (const url of ENDPOINTS) {
    const r = await refine(url);
    if (r) { results.push({ offset: r.offset, rtt: r.uncertainty, method: 'flip', url }); continue; }
    // Repli : meilleure mesure demi-RTT sur quelques échantillons.
    let mn = null;
    for (let i = 0; i < 3; i++) { const s = await sample(url); if (s && (!mn || s.rtt < mn.rtt)) mn = s; }
    if (mn) results.push({ offset: mn.offset, rtt: mn.rtt, method: 'half-rtt', url });
  }
  if (!results.length) throw new Error('Aucune source de temps HTTP joignable');
  results.sort((a, b) => a.rtt - b.rtt);
  return results[0];
}

// Applique la sync et renvoie l'offset (ms), avec logs. skip => 0.
export async function syncClock(skip = false) {
  if (skip) { log.info('Sync horloge désactivée (mode « Sans sync »).'); return 0; }
  log.step('Synchronisation horloge (HTTP)');
  try {
    const o = await bestOffset();
    log.ok(`Offset : ${o.offset >= 0 ? '+' : ''}${o.offset.toFixed(0)} ms ` +
      `(${o.method}, ±${o.rtt.toFixed(0)} ms)`);
    if (Math.abs(o.offset) > 250) log.warn('Ton horloge dérive nettement — l\'offset corrige le tir.');
    return o.offset;
  } catch (e) {
    log.warn(`Sync indisponible (${e.message}) — horloge locale telle quelle.`);
    return 0;
  }
}

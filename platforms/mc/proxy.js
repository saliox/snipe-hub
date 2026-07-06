// Pool de proxies HTTP en rotation (round-robin) pour répartir les requêtes du
// check en masse sur plusieurs IP et éviter le rate-limit de Mojang.
import { ProxyAgent, request } from 'undici';

// Accepte les formats :  http://user:pass@host:port  |  host:port  |  host:port:user:pass
function normalize(raw) {
  let s = String(raw).trim();
  if (!s || s.startsWith('#')) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const p = s.split(':');
  if (p.length === 2) return `http://${p[0]}:${p[1]}`;
  if (p.length === 4) return `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`;
  return `http://${s}`;
}

// Pré-teste des proxies et ne renvoie que ceux qui répondent (via un endpoint
// neutre, léger et rapide). onProgress({ done, total, alive }) pour l'UI.
const TEST_URL = 'https://www.google.com/generate_204';
export async function testProxies(lines, { timeoutMs = 5000, concurrency = 50, onProgress = () => {} } = {}) {
  // Dédoublonne en gardant la ligne d'origine (format préservé pour l'UI).
  const seen = new Set();
  const list = [];
  for (const raw of lines) {
    const s = String(raw).trim();
    if (!s || s.startsWith('#') || !normalize(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s); list.push(s);
  }
  const alive = [];
  let idx = 0, done = 0;

  async function testOne(raw) {
    const agent = new ProxyAgent({ uri: normalize(raw), connect: { timeout: timeoutMs } });
    const probe = (async () => {
      const { statusCode, body } = await request(TEST_URL, {
        dispatcher: agent, method: 'GET', maxRedirections: 0,
        headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
      });
      await body.dump();
      return statusCode >= 200 && statusCode < 400;
    })();
    // Si le timeout gagne la course, `probe` reste en vol et finira par rejeter
    // (ou sera avorté par agent.destroy) : on avale ce rejet tardif ici pour
    // éviter un UnhandledPromiseRejection (fréquent sur les proxies morts).
    probe.catch(() => {});
    // Cap DUR : le worker n'attend jamais plus de timeoutMs sur un proxy bloqué.
    let ok = false;
    try { ok = await Promise.race([probe, new Promise((r) => setTimeout(() => r('to'), timeoutMs))]); }
    catch { ok = false; }
    agent.destroy().catch(() => {}); // nettoyage en tâche de fond, non bloquant
    return ok === true;
  }

  async function worker() {
    while (idx < list.length) {
      const raw = list[idx++];
      if (await testOne(raw)) alive.push(raw);
      onProgress({ done: ++done, total: list.length, alive: alive.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  return { alive, tested: list.length, aliveCount: alive.length };
}

export function makeProxyPool(lines = []) {
  const MAX_FAILS = 3; // échecs consécutifs avant éjection d'un proxy
  const agents = [];
  const fails = new Map(); // agent -> échecs consécutifs
  for (const raw of lines) {
    const url = normalize(raw);
    if (!url) continue;
    // connect.timeout : abandonne vite un proxy injoignable (fail-fast, pas de blocage).
    try { agents.push(new ProxyAgent({ uri: url, connect: { timeout: 8000 } })); }
    catch { /* proxy invalide ignoré */ }
  }
  let i = 0;
  const live = () => agents.filter((a) => (fails.get(a) || 0) < MAX_FAILS);
  return {
    size: agents.length,
    aliveCount() { return live().length; },
    // Round-robin sur les vivants. Si TOUS sont éjectés, on continue sur tous
    // (jamais null) : mieux vaut échouer via proxy que basculer en direct (leak IP).
    next() {
      if (!agents.length) return null;
      const pool = live();
      const arr = pool.length ? pool : agents;
      return arr[i++ % arr.length];
    },
    penalize(a) { if (a) fails.set(a, (fails.get(a) || 0) + 1); }, // échec réseau
    reward(a) { if (a && fails.get(a)) fails.set(a, 0); },          // a répondu
    async close() { for (const a of agents) { try { await a.close(); } catch {} } },
  };
}

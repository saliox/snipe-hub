// Check en masse unifié : lance `check(name, dispatcher)` sur une liste de noms,
// avec concurrence bornée et rotation optionnelle de proxies (round-robin, éjection
// des proxies morts). Réutilise le pool de proxies générique du moteur MC.
import { makeProxyPool } from '../platforms/mc/proxy.js';

/**
 * @param {object} o
 * @param {string[]} o.names                  noms à vérifier
 * @param {string[]} [o.proxies]              proxies (host:port | http://user:pass@host:port | host:port:user:pass)
 * @param {(name:string, dispatcher:any)=>Promise<{free:boolean|null}>} o.check
 * @param {number} [o.concurrency=20]
 * @param {(p:{done:number,total:number,name:string,free:boolean|null})=>void} [o.onProgress]
 * @returns {Promise<{name:string, free:boolean|null, error?:string}[]>}
 */
export async function runBulk({ names, proxies = [], check, concurrency = 20, onProgress }) {
  const clean = (names || []).map((s) => String(s).trim()).filter(Boolean);
  const pool = (proxies && proxies.length) ? makeProxyPool(proxies) : null;
  const results = new Array(clean.length);
  let idx = 0, done = 0;

  async function worker() {
    while (idx < clean.length) {
      const i = idx++;
      const name = clean[i];
      const agent = pool ? pool.next() : null;
      let r;
      try {
        r = await check(name, agent);
        if (pool && agent) pool.reward(agent);
      } catch (e) {
        if (pool && agent) pool.penalize(agent);
        r = { free: null, error: e?.message || String(e) };
      }
      results[i] = { name, free: r.free, ...(r.error ? { error: r.error } : {}) };
      onProgress?.({ done: ++done, total: clean.length, name, free: r.free });
    }
  }

  const n = Math.max(1, Math.min(concurrency, clean.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  if (pool) await pool.close().catch(() => {});
  return results;
}

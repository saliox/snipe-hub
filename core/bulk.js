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
  // Anti-fuite d'IP : si l'utilisateur a fourni des proxies mais qu'AUCUN n'est
  // valide, on refuse plutôt que de basculer silencieusement en direct (sinon la
  // vraie IP part alors qu'il pensait être masqué). `next()` ne renvoie null que
  // dans ce cas (0 agent) — dès qu'il y a ≥1 proxy, il ne bascule jamais en direct.
  if (pool && pool.size === 0) throw new Error('Aucun proxy valide dans la liste — check annulé (pour ne pas exposer ton IP). Vérifie le format : host:port ou http://user:pass@host:port.');
  const results = new Array(clean.length);
  let idx = 0, done = 0;

  // Reprise sur rate-limit. Sans elle, un 429 figeait le nom sur un « ⚪ ? » DÉFINITIF :
  // sur 500 noms, des dizaines de verdicts étaient perdus alors que l'API demandait
  // seulement d'attendre. Bornée à MAX_TRIES pour garantir la terminaison, même si
  // l'API répond 429 indéfiniment.
  const MAX_TRIES = 3;
  const tries = new Array(clean.length).fill(0);
  const retry = [];              // [{ i, notBefore }] — noms à resonder plus tard
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Prochain indice à traiter : d'abord une reprise arrivée à échéance, sinon un nom
  // neuf. -1 = rien de disponible MAINTENANT (des reprises peuvent rester en attente).
  function nextIndex() {
    const now = Date.now();
    for (let k = 0; k < retry.length; k++) {
      if (retry[k].notBefore <= now) return retry.splice(k, 1)[0].i;
    }
    if (idx < clean.length) return idx++;
    return -1;
  }

  async function worker() {
    for (;;) {
      const i = nextIndex();
      if (i === -1) {
        if (done >= clean.length) break;   // tout est verdicté : ce worker a fini
        await sleep(50);                   // des reprises attendent leur échéance
        continue;
      }
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
      tries[i]++;

      // Rate-limité et il reste des essais : on replanifie au lieu d'abandonner. Le
      // délai vient de l'API (retryAfter), borné à 30 s pour ne pas geler le scan.
      if (r && r.rateLimited && tries[i] < MAX_TRIES) {
        const waitMs = Math.min(30, Math.max(1, Number(r.retryAfter) || 2)) * 1000;
        retry.push({ i, notBefore: Date.now() + waitMs });
        continue;                          // ne compte PAS comme terminé
      }

      results[i] = { name, free: r.free, ...(r.error ? { error: r.error } : {}) };
      // ⚠️ `done` est incrémenté SÉPARÉMENT, jamais dans les arguments de onProgress :
      // avec `onProgress?.({ done: ++done })`, l'optional chaining n'évalue PAS ses
      // arguments quand le callback est absent — le compteur restait donc à 0, et la
      // condition de sortie `done >= clean.length` n'était jamais atteinte.
      done++;
      onProgress?.({ done, total: clean.length, name, free: r.free });
    }
  }

  const n = Math.max(1, Math.min(concurrency, clean.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  if (pool) await pool.close().catch(() => {});
  return results;
}

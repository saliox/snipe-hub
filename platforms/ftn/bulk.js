// Vérification en masse de disponibilité de display names Epic, avec
// anti-rate-limit ADAPTATIF (AIMD) et estimation du temps restant (ETA).
//
// Le lookup Epic exige un token (auth) — contrairement à Mojang. On répartit
// éventuellement sur des proxies (pool santé) pour aller plus vite sans se faire
// rate-limiter. Le token, lui, reste le tien : le scan ne « réclame » rien, il
// ne fait que LIRE la disponibilité.
//
// - succès répétés   -> on accélère (intervalle × 0.85)
// - 429 (rate limit) -> on ralentit fort (× 2) + pause qui respecte Retry-After ;
//   avec proxies, on tourne d'IP plutôt que de tout figer. Le pseudo est remis
//   en file (retry) — on ne perd jamais un nom.
import { displayNameStatus, validName } from './epicapi.js';

const START_INTERVAL = 90;   // ms entre deux départs au démarrage (Epic = prudent)
const MIN_INTERVAL = 30;     // plancher
const MAX_INTERVAL = 4000;   // plafond quand ça throttle
const MAX_INFLIGHT = 10;     // requêtes simultanées max
const SPEEDUP_AFTER = 15;    // succès consécutifs avant d'accélérer
const MAX_ATTEMPTS = 4;      // tentatives par pseudo avant abandon

// names: string[]
// opts.token         : access token Epic (REQUIS)
// opts.proxyPool     : pool de proxies (makeProxyPool) — optionnel
// opts.minIntervalMs : plancher d'intervalle
// opts.onResult(r)   : { done, total, name, state, detail } ; state ∈ free|taken|invalid|error
// opts.onStats(s)    : { done, total, rate, etaMs, inFlight, intervalMs, throttled, ... }
// opts.shouldStop()  : true pour interrompre
export async function bulkCheck(names, opts = {}) {
  const {
    token, minIntervalMs = MIN_INTERVAL, proxyPool = null,
    onResult = () => {}, onStats = () => {}, shouldStop = () => false,
  } = opts;
  if (!token) throw new Error('Token requis pour le scan (le lookup Epic est authentifié).');
  const floor = Math.max(MIN_INTERVAL, minIntervalMs | 0);

  const queue = [];
  const seen = new Set();
  const invalids = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!validName(name)) { invalids.push(name); continue; }
    queue.push({ name, attempts: 0 });
  }
  const retryQ = [];
  const total = queue.length;
  const invalid = invalids.length;
  const freeList = [];
  let checked = 0, free = 0, taken = 0, errors = 0;

  for (const name of invalids) {
    onResult({ done: checked, total, name, state: 'invalid', detail: 'format invalide (3-16 caractères)' });
  }

  let interval = Math.max(START_INTERVAL, floor);
  let inFlight = 0;
  let pauseUntil = 0;
  let successStreak = 0;
  let throttleEvents = 0;

  const start = Date.now();
  let ewmaRate = 0;
  function stats() {
    const elapsed = (Date.now() - start) / 1000;
    const avg = elapsed > 0 ? checked / elapsed : 0;
    ewmaRate = ewmaRate ? ewmaRate * 0.7 + avg * 0.3 : avg;
    const remaining = total - checked;
    const etaMs = ewmaRate > 0.01 ? (remaining / ewmaRate) * 1000 : null;
    onStats({
      done: checked, total, rate: ewmaRate, etaMs,
      free, taken, errors,
      inFlight, intervalMs: Math.round(interval),
      throttled: Date.now() < pauseUntil, throttleEvents,
      proxiesAlive: proxyPool ? proxyPool.aliveCount() : null,
      proxiesTotal: proxyPool ? proxyPool.size : null,
    });
  }

  function onThrottle(retryAfter) {
    throttleEvents++;
    // Avec des proxies, un 429 = CE proxy est limité, pas les autres : on tourne
    // d'IP sans figer toute la rotation. En direct, pause globale AIMD.
    if (proxyPool) return;
    interval = Math.min(interval * 2, MAX_INTERVAL);
    successStreak = 0;
    const backoff = retryAfter ? retryAfter * 1000 : Math.min(interval * 4, 8000);
    pauseUntil = Math.max(pauseUntil, Date.now() + backoff);
  }
  function onSuccess() {
    if (++successStreak >= SPEEDUP_AFTER && interval > floor) {
      interval = Math.max(floor, interval * 0.85);
      successStreak = 0;
    }
  }

  async function handleOne(item) {
    inFlight++;
    try {
      const agent = proxyPool ? proxyPool.next() : null;
      let res;
      try {
        res = await displayNameStatus(item.name, token, agent);
        if (proxyPool && agent) proxyPool.reward(agent);
      } catch (e) {
        if (proxyPool && agent) proxyPool.penalize(agent);
        if (item.attempts++ < MAX_ATTEMPTS) retryQ.push(item);
        else { errors++; checked++; onResult({ done: checked, total, name: item.name, state: 'error', detail: e.message }); }
        return;
      }

      if (res.rateLimited) {
        onThrottle(res.retryAfter);
        if (proxyPool && agent) proxyPool.penalize(agent);
        if (item.attempts++ < MAX_ATTEMPTS) retryQ.push(item);
        else { errors++; checked++; onResult({ done: checked, total, name: item.name, state: 'error', detail: 'rate-limité (abandon)' }); }
        return;
      }

      onSuccess();
      if (res.free === true) {
        free++; freeList.push(item.name); checked++;
        onResult({ done: checked, total, name: item.name, state: 'free', detail: 'réclamable' });
      } else if (res.free === false) {
        taken++; checked++;
        onResult({ done: checked, total, name: item.name, state: 'taken', detail: res.displayName || '' });
      } else {
        errors++; checked++;
        onResult({ done: checked, total, name: item.name, state: 'error', detail: `HTTP ${res.statusCode || '?'}` });
      }
    } finally {
      inFlight--;
    }
  }

  const nextItem = () => retryQ.shift() || queue.shift();

  await new Promise((resolve) => {
    const statsTimer = setInterval(stats, 300);
    const done = () => { clearInterval(statsTimer); stats(); resolve(); };

    function pump() {
      if (shouldStop()) {
        if (inFlight === 0) return done();
        return setTimeout(pump, 50);
      }
      const now = Date.now();
      if (now < pauseUntil) return setTimeout(pump, pauseUntil - now);

      if (inFlight < MAX_INFLIGHT) {
        const item = nextItem();
        if (item) {
          handleOne(item).then(() => { stats(); });
          return setTimeout(pump, interval);
        }
      }
      if (!queue.length && !retryQ.length && inFlight === 0) return done();
      setTimeout(pump, Math.min(interval, 80));
    }
    if (total === 0) return done();
    pump();
  });

  return { checked, free, taken, invalid, errors, freeList, throttleEvents, elapsedMs: Date.now() - start };
}

// Estimation grossière AVANT le scan.
export function estimateScanMs(count, minIntervalMs = MIN_INTERVAL) {
  const iv = Math.max(MIN_INTERVAL, minIntervalMs | 0);
  const perName = Math.max(iv, START_INTERVAL) * 0.8;
  return Math.round(count * perName);
}

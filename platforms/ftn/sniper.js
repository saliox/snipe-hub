// Moteur de snipe : surveille un display name Epic et, dès qu'il se libère,
// envoie une rafale de requêtes de changement de nom calibrée autour du drop,
// sur des connexions pré-chauffées.
import { Pool } from 'undici';
import { log, c, sleep, sleepUntil, fmtDuration } from './util.js';
import { bestOffset } from './ntp.js';
import { displayNameStatus } from './epicapi.js';
import { makeProxyDispatchers, closeDispatchers } from './proxy.js';
import { alertFreeName } from './alerts.js';

const HOST = 'https://account-public-service-prod.ol.epicgames.com';

// Arrêt coopératif (utilisé par une UI pour stopper le mode surveillance).
let stopFlag = false;
export function requestStop() { stopFlag = true; }

// Cloche terminal : alerte sonore quand le nom se libère (utile en monitor).
function bell() { try { process.stdout.write('\x07'); } catch {} }

// --- Métriques (diagnostic) : agrège RTT, codes de statut, 429, erreurs. ---
function newMetrics() {
  return {
    rtts: [], status: {}, count429: 0, errors: 0, polls: 0,
    record(r, dt) {
      if (typeof dt === 'number') this.rtts.push(dt);
      this.status[r.status] = (this.status[r.status] || 0) + 1;
      if (r.status === 429) this.count429++;
      if (r.status === 0) this.errors++;
    },
    summary() {
      const n = this.rtts.length;
      const sorted = [...this.rtts].sort((a, b) => a - b);
      const pct = (p) => n ? sorted[Math.min(n - 1, Math.floor(p * n))] : 0;
      return {
        n,
        min: n ? sorted[0] : 0,
        avg: n ? this.rtts.reduce((a, b) => a + b, 0) / n : 0,
        p50: pct(0.5), p95: pct(0.95),
        max: n ? sorted[n - 1] : 0,
        count429: this.count429, errors: this.errors, polls: this.polls,
        status: this.status,
      };
    },
  };
}

// Pré-établit `n` connexions TLS pour éliminer le handshake du chemin critique.
async function warmup(pool, token, n) {
  const warm = async () => {
    try {
      const { body } = await pool.request({
        path: '/account/api/oauth/verify',
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      await body.dump();
    } catch { /* peu importe, le but est d'ouvrir le socket */ }
  };
  await Promise.all(Array.from({ length: n }, warm));
}

// Un essai de changement de nom via le pool chaud. Renvoie { ok, status, retryAfter }.
async function attempt(pool, name, token, accountId) {
  try {
    const { statusCode, headers, body } = await pool.request({
      path: `/account/api/public/account/${encodeURIComponent(accountId)}`,
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : null;
    await body.dump();
    return { ok: statusCode === 200 || statusCode === 204, status: statusCode, retryAfter };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.name          display name cible
 * @param {string} opts.token         access token Epic
 * @param {string} opts.accountId     id du compte à renommer
 * @param {number} [opts.dropAt]      epoch ms du drop (mode planifié)
 * @param {boolean} [opts.monitor]    mode surveillance (poll jusqu'à libre)
 * @param {number} [opts.connections] connexions pré-chauffées (def 3)
 * @param {number} [opts.burst]       nb de requêtes dans la rafale (def 6)
 * @param {number} [opts.volley]      requêtes lâchées SIMULTANÉMENT à T0 (def 3)
 * @param {number} [opts.spacingMs]   espacement des relances après la volée (def 30ms)
 * @param {number} [opts.leadMs]      avance de la 1re requête sur T0 (def 40ms)
 * @param {number} [opts.pollMs]      intervalle de sondage en monitor (def 1000ms)
 * @param {string[]} [opts.proxies]   proxies (host:port ou URL) pour la détection
 * @param {boolean} [opts.diag]       journal détaillé + résumé de métriques
 * @param {boolean} [opts.skipNtp]    ne pas synchroniser l'horloge
 */
export async function snipe(opts) {
  const {
    name, token, accountId, dropAt, monitor = false,
    connections = 3, burst = 6, volley = 3, spacingMs = 30, leadMs = 40, pollMs = 1000,
    proxies = null, diag = false, skipNtp = false, onFree = null, displayName = null,
  } = opts;

  stopFlag = false;
  const pool = new Pool(HOST, { connections, pipelining: 1 });
  const pollDispatchers = (proxies && proxies.length) ? makeProxyDispatchers(proxies) : [];
  const metrics = newMetrics();
  let offset = 0;

  const syncNtp = async (label) => {
    try {
      const o = await bestOffset();
      offset = o.offset;
      log.ok(`${label} : offset ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms ` +
        `(via ${o.server}, rtt ${o.rtt.toFixed(0)} ms)`);
      if (Math.abs(offset) > 250) log.warn('Ton horloge Windows dérive beaucoup — l\'offset NTP corrige ça.');
    } catch (e) {
      log.warn(`NTP indisponible (${e.message}) — horloge locale telle quelle.`);
    }
  };

  try {
    if (!skipNtp) { log.step('Synchronisation NTP'); await syncNtp('Horloge'); }
    if (pollDispatchers.length) log.info(`Détection via ${pollDispatchers.length} proxy(s) en rotation.`);

    // "Maintenant" corrigé = Date.now() + offset. Pour viser un temps réel T,
    // on attend l'instant local L tel que L + offset = T, soit L = T - offset.
    const toLocal = (realMs) => realMs - offset;

    if (monitor) {
      const r = await monitorLoop(pool, name, token, accountId,
        { burst, volley, spacingMs, pollMs, dropAt, diag, metrics, pollDispatchers, getOffset: () => offset, onFree, displayName });
      logSummary(metrics, offset, diag);
      return r;
    }

    if (!dropAt) throw new Error('Mode planifié : --at requis (ou utilise --monitor).');

    const now = Date.now() + offset;
    log.step(`Snipe planifié de ${c.yellow}${name}${c.reset}`);
    log.info(`Drop dans ${c.cyan}${fmtDuration(dropAt - now)}${c.reset} (${new Date(dropAt).toISOString()})`);

    // Pré-chauffage ~10s avant le drop pour avoir des sockets frais.
    const warmAtLocal = toLocal(dropAt - 10_000);
    const longWait = (warmAtLocal - Date.now()) > 60_000;
    if (warmAtLocal > Date.now()) await sleepUntil(warmAtLocal);

    // Ré-sync NTP juste avant le tir si on a attendu longtemps (l'horloge dérive).
    if (!skipNtp && longWait) { log.step('Ré-synchronisation NTP (avant tir)'); await syncNtp('Horloge'); }

    log.info('Pré-chauffage des connexions...');
    await warmup(pool, token, connections);
    log.ok('Connexions prêtes.');

    // Rafale : volée de `volley` requêtes à T0-leadMs, puis relances espacées.
    const firstLocal = toLocal(dropAt - leadMs);
    log.info(`Rafale : volée de ${Math.min(volley, burst)} à T0-${leadMs} ms` +
      (burst > volley ? ` + ${burst - volley} relance(s) /${spacingMs} ms` : '') + '. En attente...');
    await sleepUntil(firstLocal, 20);

    const result = await fireBurst(pool, name, token, accountId, { burst, volley, spacingMs }, metrics);
    reportResult(result, name);
    logSummary(metrics, offset, diag);
    return result;
  } finally {
    await pool.close().catch(() => {});
    await closeDispatchers(pollDispatchers);
  }
}

// Rafale : `volley` requêtes lâchées SIMULTANÉMENT (course serrée à T0), puis
// `burst - volley` relances espacées de spacingMs (rattrape une libération
// légèrement retardée). S'arrête dès qu'une requête a gagné.
async function fireBurst(pool, name, token, accountId, { burst, volley, spacingMs }, metrics) {
  const inflight = [];
  let winner = null;
  const fire = (i) => {
    const t = Date.now();
    return attempt(pool, name, token, accountId).then((r) => {
      const dt = Date.now() - t;
      metrics.record(r, dt);
      log.info(`  req#${i + 1} → ${statusColor(r.status)} (${dt} ms)` +
        (r.retryAfter ? ` retry-after ${r.retryAfter}s` : ''));
      if (r.ok && !winner) winner = { ...r, index: i + 1 };
      return r;
    }).catch((e) => { log.warn(`  req#${i + 1} erreur: ${e.message}`); return { ok: false, status: 0 }; });
  };

  const v = Math.max(1, Math.min(volley, burst));
  // Volée initiale : v requêtes en parallèle, sans attente entre elles.
  for (let i = 0; i < v; i++) inflight.push(fire(i));
  // Relances échelonnées pour les requêtes restantes (stop si déjà gagné).
  for (let i = v; i < burst; i++) {
    await sleep(spacingMs);
    if (winner) break;
    inflight.push(fire(i));
  }
  const all = await Promise.all(inflight);
  return { success: !!winner, winner, attempts: all };
}

// Mode surveillance : poll la dispo et déclenche une rafale dès que le nom
// passe libre. C'est le mode principal côté Epic (pas d'horaire de drop public).
// Cadence adaptative : lente loin d'un drop connu, rapide dans la fenêtre du drop.
async function monitorLoop(pool, name, token, accountId, opts) {
  const { burst, volley, spacingMs, pollMs, dropAt, diag, metrics, pollDispatchers, getOffset, onFree, displayName } = opts;
  log.step(`Surveillance de ${c.yellow}${name}${c.reset} (Ctrl+C pour arrêter)`);
  await warmup(pool, token, 2);

  const dispatchers = pollDispatchers.length ? pollDispatchers : [pool];
  let di = 0;

  while (!stopFlag) {
    metrics.polls++;
    const disp = dispatchers[di++ % dispatchers.length];
    const st = await displayNameStatus(name, token, disp);

    if (st.free === true) {
      const detectedAt = Date.now();
      bell();
      log.ok(`${c.green}${name} est LIBRE — rafale !${c.reset}`);
      if (onFree) { try { onFree(name); } catch { /* ignore */ } }
      const result = await fireBurst(pool, name, token, accountId, { burst, volley, spacingMs }, metrics);
      if (result.attempts[0]) log.info(`Latence détection→1er tir : ${Date.now() - detectedAt} ms`);
      alertFreeName(name, { claimed: result.success, account: displayName }).catch(() => {});
      reportResult(result, name);
      return result;
    }
    if (st.rateLimited) {
      const wait = (st.retryAfter || 5) * 1000;
      log.warn(`Rate limit${dispatchers.length > 1 ? ' (proxy suivant)' : ''} — pause ${Math.round(wait / 1000)}s.`);
      // Avec des proxies, on ne bloque pas tout : petite pause et on tourne d'IP.
      await sleep(dispatchers.length > 1 ? Math.min(wait, 800) : wait);
      continue;
    }
    if (diag) log.info(`  sonde #${metrics.polls} → ${st.displayName ? 'pris' : (st.statusCode || 'pris')}`);
    else if (metrics.polls % 20 === 0) {
      const who = st.displayName ? `pris par ${st.displayName}` : (st.statusCode || 'pris');
      log.info(`...toujours indisponible (${who}) — ${metrics.polls} sondages`);
    }
    await sleep(nextPollDelay(pollMs, dropAt, Date.now() + getOffset()));
  }
  log.warn('Surveillance arrêtée.');
  return { success: false, stopped: true, attempts: [] };
}

/**
 * Watchlist : surveille PLUSIEURS display names à la fois et réclame le PREMIER
 * qui se libère (tu ne peux tenir qu'un pseudo, donc on s'arrête au 1er gagné).
 * Alerte Discord + cloche à la libération. Réutilise burst/volée/proxies/métriques.
 * @param {object} opts { names[], token, accountId, displayName?, connections?, burst?,
 *   volley?, spacingMs?, pollMs?, proxies?, diag?, skipNtp?, onFree? }
 */
export async function watchNames(opts) {
  const {
    names, token, accountId, displayName = null,
    connections = 3, burst = 6, volley = 3, spacingMs = 30, pollMs = 1000,
    proxies = null, diag = false, skipNtp = false, onFree = null,
  } = opts;

  const targets = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))];
  if (!targets.length) throw new Error('Watchlist vide.');

  stopFlag = false;
  const pool = new Pool(HOST, { connections, pipelining: 1 });
  const pollDispatchers = (proxies && proxies.length) ? makeProxyDispatchers(proxies) : [];
  const metrics = newMetrics();
  let offset = 0;

  try {
    if (!skipNtp) {
      log.step('Synchronisation NTP');
      try { const o = await bestOffset(); offset = o.offset; log.ok(`Offset ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms (via ${o.server}).`); }
      catch (e) { log.warn(`NTP indisponible (${e.message}).`); }
    }
    log.step(`Watchlist : ${c.yellow}${targets.length}${c.reset} noms surveillés (Ctrl+C pour arrêter)`);
    log.info(targets.join(', '));
    await warmup(pool, token, Math.min(connections, 3));

    const dispatchers = pollDispatchers.length ? pollDispatchers : [pool];
    let di = 0, ti = 0;
    // Chaque nom est sondé ~ tous les pollMs : on répartit sur le nombre de cibles.
    const perPoll = Math.max(50, Math.round(pollMs / targets.length));

    while (!stopFlag) {
      const name = targets[ti++ % targets.length];
      metrics.polls++;
      const disp = dispatchers[di++ % dispatchers.length];
      const st = await displayNameStatus(name, token, disp);

      if (st.free === true) {
        bell();
        log.ok(`${c.green}« ${name} » est LIBRE — rafale !${c.reset}`);
        if (onFree) { try { onFree(name); } catch { /* ignore */ } }
        const result = await fireBurst(pool, name, token, accountId, { burst, volley, spacingMs }, metrics);
        alertFreeName(name, { claimed: result.success, account: displayName }).catch(() => {});
        reportResult(result, name);
        logSummary(metrics, offset, diag);
        return { ...result, name };
      }
      if (st.rateLimited) {
        const wait = (st.retryAfter || 5) * 1000;
        await sleep(dispatchers.length > 1 ? Math.min(wait, 800) : wait);
        continue;
      }
      if (diag) log.info(`  ${name} → pris`);
      else if (metrics.polls % (20 * targets.length) === 0) {
        log.info(`...${targets.length} noms toujours pris (${metrics.polls} sondages)`);
      }
      await sleep(perPoll + Math.floor(Math.random() * Math.min(150, perPoll * 0.3)));
    }
    log.warn('Watchlist arrêtée.');
    logSummary(metrics, offset, diag);
    return { success: false, stopped: true, attempts: [] };
  } finally {
    await pool.close().catch(() => {});
    await closeDispatchers(pollDispatchers);
  }
}

// Cadence de sondage adaptative + jitter (évite un motif régulier détectable).
function nextPollDelay(pollMs, dropAt, nowReal) {
  const jitter = (base, frac) => base + Math.floor(Math.random() * Math.max(1, base * frac));
  if (!dropAt) return jitter(pollMs, 0.2);
  const toDrop = dropAt - nowReal; // temps réel restant avant le drop
  if (toDrop <= 5_000 && toDrop > -30_000) return jitter(150, 0.7);   // fenêtre serrée : ~150-250 ms
  if (toDrop <= 30_000 && toDrop > 0) return Math.min(pollMs, jitter(400, 0.3));
  return jitter(pollMs, 0.3);
}

function statusColor(s) {
  if (s === 200 || s === 204) return `${c.green}${s} OK${c.reset}`;
  if (s === 429) return `${c.red}429 rate-limit${c.reset}`;
  if (s === 403 || s === 400 || s === 409) return `${c.yellow}${s} indispo/refus${c.reset}`;
  if (s === 0) return `${c.gray}erreur réseau${c.reset}`;
  return `${c.gray}${s}${c.reset}`;
}

function reportResult(result, name) {
  console.log('');
  if (result.success) {
    log.ok(`${c.green}🎯 SNIPE RÉUSSI${c.reset} — ${name} obtenu (req#${result.winner.index}) !`);
  } else {
    const got429 = result.attempts.some((a) => a.status === 429);
    const got403 = result.attempts.some((a) => a.status === 403);
    log.err(`Échec du snipe de ${name}.` +
      (got429 ? ' Rate-limité (429) : réduis burst/volley ou augmente spacing.' : '') +
      (got403 ? ' Refus 403 : cooldown 2 semaines actif, ou nom repris par plus rapide.' : ''));
  }
}

// Résumé de métriques (toujours en fin de snipe ; détaillé si diag).
function logSummary(metrics, offset, diag) {
  const s = metrics.summary();
  if (!s.n && !s.polls) return;
  const parts = [];
  if (s.polls) parts.push(`${s.polls} sondage(s)`);
  if (s.n) parts.push(`RTT min/méd/p95/max ${fmt(s.min)}/${fmt(s.p50)}/${fmt(s.p95)}/${fmt(s.max)} ms`);
  if (s.count429) parts.push(`${s.count429}× 429`);
  if (s.errors) parts.push(`${s.errors} erreur(s) réseau`);
  parts.push(`offset ${offset >= 0 ? '+' : ''}${offset.toFixed(0)} ms`);
  log.info(`${c.gray}Diagnostic : ${parts.join(' · ')}${c.reset}`);
  if (diag && s.n) log.info(`${c.gray}  codes de statut : ${JSON.stringify(s.status)}${c.reset}`);
}
function fmt(x) { return Math.round(x); }

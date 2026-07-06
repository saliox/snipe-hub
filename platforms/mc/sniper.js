// Moteur de snipe : envoie une rafale de requêtes de changement de nom
// calibrée autour de l'instant du drop, sur des connexions pré-chauffées.
import { Pool } from 'undici';
import { log, c, sleep, sleepUntil, fmtDuration } from './util.js';
import { bestOffset } from './ntp.js';

const HOST = 'https://api.minecraftservices.com';

// Arrêt coopératif (utilisé par l'UI pour stopper le mode surveillance).
let stopFlag = false;
export function requestStop() { stopFlag = true; }

// Pré-établit `n` connexions TLS pour éliminer le handshake du chemin critique.
async function warmup(pool, token, n) {
  const warm = async () => {
    try {
      // GET léger et authentifié : ouvre la connexion sans effet de bord.
      const { body } = await pool.request({
        path: '/minecraft/profile',
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      await body.dump();
    } catch { /* peu importe, le but est d'ouvrir le socket */ }
  };
  await Promise.all(Array.from({ length: n }, warm));
}

// Un essai de changement de nom. Renvoie { ok, status, retryAfter }.
async function attempt(pool, name, token) {
  const { statusCode, headers, body } = await pool.request({
    path: `/minecraft/profile/name/${encodeURIComponent(name)}`,
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
  });
  const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : null;
  await body.dump();
  return { ok: statusCode === 200, status: statusCode, retryAfter };
}

/**
 * @param {object} opts
 * @param {string} opts.name          pseudo cible
 * @param {string} opts.token         token d'accès Minecraft
 * @param {number} [opts.dropAt]      epoch ms du drop (mode planifié)
 * @param {boolean} [opts.monitor]    mode surveillance (poll jusqu'à libre)
 * @param {number} [opts.connections] connexions pré-chauffées (def 3)
 * @param {number} [opts.burst]       nb de requêtes dans la rafale (def 6)
 * @param {number} [opts.spacingMs]   espacement entre requêtes (def 30ms)
 * @param {number} [opts.leadMs]      avance de la 1re requête sur T0 (def 40ms)
 * @param {boolean} [opts.skipNtp]    ne pas synchroniser l'horloge
 * @param {() => Promise<string>} [opts.getToken] fournisseur de token frais
 *        (rafraîchissement sur 401 / expiration ~24h en surveillance longue)
 */
export async function snipe(opts) {
  const {
    name, token, dropAt, monitor = false, getToken = null,
    connections = 3, burst = 6, spacingMs = 30, leadMs = 40, skipNtp = false,
  } = opts;

  stopFlag = false;
  const pool = new Pool(HOST, { connections, pipelining: 1 });
  // `session.token` est mutable : refreshToken() le remplace après un 401 / une
  // expiration. Le token d'accès Minecraft n'est valide que ~24h.
  const session = { token, getToken };
  let offset = 0;

  try {
    if (!skipNtp) {
      log.step('Synchronisation NTP');
      try {
        const o = await bestOffset();
        offset = o.offset;
        log.ok(`Offset horloge : ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms ` +
          `(via ${o.server}, rtt ${o.rtt.toFixed(0)} ms)`);
        if (Math.abs(offset) > 250) log.warn('Ton horloge Windows dérive beaucoup — l\'offset NTP corrige ça.');
      } catch (e) {
        log.warn(`NTP indisponible (${e.message}) — on utilise l'horloge locale telle quelle.`);
      }
    }
    // "Maintenant" corrigé = Date.now() + offset. Pour viser un temps réel T,
    // on attend l'instant local L tel que L + offset = T, soit L = T - offset.
    const toLocal = (realMs) => realMs - offset;

    if (monitor) return await monitorLoop(pool, name, session, { burst, spacingMs });

    if (!dropAt) throw new Error('Mode planifié : --at requis (ou utilise --monitor).');

    const now = Date.now() + offset;
    log.step(`Snipe planifié de ${c.yellow}${name}${c.reset}`);
    log.info(`Drop dans ${c.cyan}${fmtDuration(dropAt - now)}${c.reset} (${new Date(dropAt).toISOString()})`);

    // Pré-chauffage ~10s avant le drop pour avoir des sockets frais.
    const warmAtLocal = toLocal(dropAt - 10_000);
    if (warmAtLocal > Date.now()) {
      await sleepUntil(warmAtLocal);
    }
    // Rafraîchissement proactif juste avant le drop : sur un snipe planifié loin
    // dans le temps, le token pourrait avoir expiré depuis le démarrage.
    if (session.getToken) await refreshToken(session);
    log.info('Pré-chauffage des connexions...');
    await warmup(pool, session.token, connections);
    log.ok('Connexions prêtes.');

    // Rafale : première requête `leadMs` avant T0, puis toutes les `spacingMs`.
    const firstLocal = toLocal(dropAt - leadMs);
    log.info(`Rafale de ${burst} requêtes espacées de ${spacingMs} ms, ` +
      `1re à T0-${leadMs} ms. En attente...`);
    await sleepUntil(firstLocal, 20);

    let result = await fireBurst(pool, name, session, { burst, spacingMs });
    // Token expiré pile au moment du drop : rafraîchit et retente une fois.
    if (!result.success && session.getToken && result.attempts.some((a) => a.status === 401)) {
      log.warn('401 pendant la rafale — rafraîchissement du token et nouvelle tentative.');
      if (await refreshToken(session)) {
        await warmup(pool, session.token, connections);
        result = await fireBurst(pool, name, session, { burst, spacingMs });
      }
    }
    reportResult(result, name);
    return result;
  } finally {
    await pool.close().catch(() => {});
  }
}

// Rafraîchit le token d'accès Minecraft via le fournisseur `session.getToken`.
// Renvoie true UNIQUEMENT si un token RÉELLEMENT différent a été obtenu (sinon
// réessayer avec le même token bouclerait indéfiniment sur un 401).
async function refreshToken(session) {
  if (!session.getToken) return false;
  try {
    const t = await session.getToken();
    if (t && t !== session.token) {
      session.token = t;
      log.ok('Token Minecraft rafraîchi.');
      return true;
    }
  } catch (e) {
    log.err(`Échec du rafraîchissement du token : ${e.message}`);
  }
  return false;
}

async function fireBurst(pool, name, session, { burst, spacingMs }) {
  const inflight = [];
  let winner = null;
  for (let i = 0; i < burst; i++) {
    // Claim déjà réussi : inutile de continuer à spammer des requêtes de renommage.
    if (winner) break;
    const t = Date.now();
    inflight.push(
      attempt(pool, name, session.token).then((r) => {
        const dt = (Date.now() - t);
        log.info(`  req#${i + 1} → ${statusColor(r.status)} (${dt} ms)` +
          (r.retryAfter ? ` retry-after ${r.retryAfter}s` : ''));
        if (r.ok && !winner) winner = { ...r, index: i + 1 };
        return r;
      }).catch((e) => { log.warn(`  req#${i + 1} erreur: ${e.message}`); return { ok: false }; })
    );
    if (i < burst - 1) await sleep(spacingMs);
  }
  const all = await Promise.all(inflight);
  return { success: !!winner, winner, attempts: all };
}

// Mode surveillance : poll la dispo et déclenche une rafale dès que le nom
// passe libre. Utile quand on ne connaît pas la seconde exacte du drop.
const MAX_FAILED_BURSTS = 5; // rafales perdues (nom contesté) avant abandon
async function monitorLoop(pool, name, session, { burst, spacingMs }) {
  log.step(`Surveillance de ${c.yellow}${name}${c.reset} (Ctrl+C pour arrêter)`);
  await warmup(pool, session.token, 2);
  let polls = 0;
  let failedBursts = 0;
  while (!stopFlag) {
    polls++;
    const { body, statusCode } = await pool.request({
      // On sonde via l'endpoint public de Mojang par un fetch séparé serait plus
      // propre, mais rester sur le pool chaud réduit la latence de bascule.
      path: `/minecraft/profile/name/${encodeURIComponent(name)}/available`,
      method: 'GET',
      headers: { authorization: `Bearer ${session.token}` },
    });
    let status = null;
    if (statusCode === 200) status = (await body.json()).status;
    else await body.dump();

    // 401 : token expiré (la surveillance peut tourner >24h). Condition BRUYANTE,
    // jamais un status=null silencieux : on tente un rafraîchissement puis on reprend.
    if (statusCode === 401) {
      log.warn(`401 sur la sonde de ${name} — token expiré/invalide, tentative de rafraîchissement...`);
      if (!await refreshToken(session)) {
        log.err('Rafraîchissement impossible — surveillance interrompue (reconnecte-toi).');
        return { success: false, error: 'token-expired', attempts: [] };
      }
      await warmup(pool, session.token, 1);
      continue; // resonde avec le nouveau token
    }

    if (status === 'AVAILABLE') {
      log.ok(`${name} est DISPONIBLE — rafale !`);
      const result = await fireBurst(pool, name, session, { burst, spacingMs });
      if (result.success) { reportResult(result, name); return result; }

      // 401 pendant la rafale : rafraîchit et reprend sans consommer de tentative.
      if (result.attempts.some((a) => a.status === 401)) {
        log.warn('401 pendant la rafale — rafraîchissement du token puis reprise.');
        if (!await refreshToken(session)) {
          log.err('Rafraîchissement impossible — surveillance interrompue (reconnecte-toi).');
          return { success: false, error: 'token-expired', attempts: result.attempts };
        }
        await warmup(pool, session.token, 1);
        continue;
      }

      // Rafale perdue (nom pris par plus rapide / contesté) : on REPREND la
      // surveillance au lieu d'abandonner, jusqu'à un plafond de tentatives.
      failedBursts++;
      reportResult(result, name);
      if (failedBursts >= MAX_FAILED_BURSTS) {
        log.err(`Abandon après ${failedBursts} rafales échouées sur ${name}.`);
        return result;
      }
      log.warn(`Rafale perdue (${failedBursts}/${MAX_FAILED_BURSTS}) — reprise de la surveillance.`);
      await sleep(1000);
      continue;
    }
    if (polls % 20 === 0) log.info(`...toujours ${status || statusCode} (${polls} sondages)`);
    await sleep(1000); // 1 req/s : sûr vis-à-vis du rate limit
  }
  log.warn('Surveillance arrêtée.');
  return { success: false, stopped: true, attempts: [] };
}

function statusColor(s) {
  if (s === 200) return `${c.green}200 OK${c.reset}`;
  if (s === 429) return `${c.red}429 rate-limit${c.reset}`;
  if (s === 403 || s === 400) return `${c.yellow}${s} indispo/refus${c.reset}`;
  return `${c.gray}${s}${c.reset}`;
}

function reportResult(result, name) {
  console.log('');
  if (result.success) {
    log.ok(`${c.green}🎯 SNIPE RÉUSSI${c.reset} — ${name} obtenu (req#${result.winner.index}) !`);
  } else {
    const got401 = result.attempts.some((a) => a.status === 401);
    const got429 = result.attempts.some((a) => a.status === 429);
    log.err(`Échec du snipe de ${name}.` +
      (got401 ? ' Token expiré/invalide (401) : reconnecte-toi (node src/index.js login).' : '') +
      (got429 ? ' Rate-limité (429) : réduis burst/augmente spacing, ou nom pris par plus rapide.' : ''));
  }
}

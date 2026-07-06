// Moteur de snipe de vanity.
//  - Watchlist : surveille PLUSIEURS codes, tire dès que l'un se libère.
//  - Multi-bots : à T0, la rafale PATCH part de CHAQUE bot en parallèle (chacun a
//    son propre quota de rate-limit par route → plus de débit sans se 429 soi-même).
//  - Poll adaptatif : respecte Retry-After (429), détecte le ban Cloudflare 1015
//    (backoff + alerte), resserre l'intervalle vers la base et ÉTALE les sondes.
//  - Prédicteur : si le serveur détenteur retombe sous le niveau de boost 3, alerte.
//  - Auto-lead : mesure la latence au pré-chauffage et cale l'avance de tir.
//  - Abort-on-win : dès qu'un bot obtient 200, on annule les requêtes restantes.
//  - Pré-vol (preflight) : valide droits/éligibilité de chaque bot + latence AVANT
//    le drop (no-op PATCH de la vanity actuelle sur elle-même quand elle existe).
//
// ⚠️ Discord passe par Cloudflare : une rafale trop agressive peut déclencher un
// bannissement d'IP temporaire (1015) au pire moment. Reste modéré.
import { Pool, request } from 'undici';
import { log, c, sleep, sleepUntil, fmtDuration } from './util.js';
import { bestOffset } from './ntp.js';
import { API_PATH, UA, isCloudflareBan } from './discord.js';
import { RateGov } from './rategov.js';

const HOST = 'https://discord.com';

// Arrêt coopératif (utilisé par l'UI pour stopper surveillance OU planifié).
let stopFlag = false;
export function requestStop() { stopFlag = true; }

const STOPPED = { success: false, stopped: true };

function median(arr) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// Attente jusqu'à `target`, mais RÉACTIVE à l'arrêt : on dort par petits paliers
// tant qu'il reste du temps, puis on finit avec sleepUntil pour la précision.
async function waitUntilOrStop(target) {
  while (!stopFlag && Date.now() < target - 200) {
    await sleep(Math.min(200, target - Date.now()));
  }
  if (!stopFlag && Date.now() < target) await sleepUntil(target, 20);
}

// Pré-établit `n` connexions TLS. Renvoie { latency (médiane), dead } — dead=true
// si le token répond 401 (révoqué/invalide) → sert à écarter un bot mort.
async function warmup(pool, auth, n) {
  const lat = [];
  let dead = false;
  await Promise.all(Array.from({ length: n }, async () => {
    const t = Date.now();
    try {
      const { statusCode, body } = await pool.request({
        path: `${API_PATH}/users/@me`,
        method: 'GET',
        headers: { authorization: auth, 'user-agent': UA },
      });
      await body.dump();
      if (statusCode === 401) dead = true;
      else lat.push(Date.now() - t);
    } catch { /* erreur réseau : on n'en conclut pas que le bot est mort */ }
  }));
  return { latency: median(lat), dead };
}

// Chauffe tous les bots et ÉCARTE ceux dont le token est invalide (401), avec
// alerte. Renvoie { live: pools valides, latency: latence médiane des vivants }.
async function warmAndPrune(pools, n) {
  const res = await Promise.all(pools.map(async (bp) => ({ bp, ...(await warmup(bp.pool, bp.auth, n)) })));
  for (const w of res) if (w.dead) log.err(`Bot « ${w.bp.label} » : token invalide (401) — écarté du tir.`);
  const live = res.filter((w) => !w.dead);
  return { live: live.map((w) => w.bp), latency: median(live.map((w) => w.latency)) };
}

// Un essai de pose de vanity depuis un bot. `signal` permet l'abort-on-win.
async function attempt(pool, code, guildId, auth, signal) {
  try {
    const { statusCode, headers, body } = await pool.request({
      path: `${API_PATH}/guilds/${guildId}/vanity-url`,
      method: 'PATCH',
      headers: { authorization: auth, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ code }),
      signal,
    });
    const txt = await body.text().catch(() => '');
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { /* HTML Cloudflare */ }
    const retryAfter = headers['retry-after'] ? Number(headers['retry-after'])
      : (typeof data?.retry_after === 'number' ? data.retry_after : null);
    return { ok: statusCode === 200, status: statusCode, retryAfter };
  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'UND_ERR_ABORTED') return { ok: false, aborted: true };
    throw e;
  }
}

// Sonde la disponibilité en ANONYME (token jamais exposé) + niveau de boost.
async function probe(pool, code) {
  const { statusCode, headers, body } = await pool.request({
    path: `${API_PATH}/invites/${encodeURIComponent(code)}?with_counts=true`,
    method: 'GET',
    headers: { 'user-agent': UA },
  });
  if (statusCode === 404) { await body.dump(); return { free: true }; }
  const txt = await body.text().catch(() => '');
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { /* HTML Cloudflare */ }
  if (statusCode === 200) {
    const g = data?.guild || {};
    return {
      free: false,
      premiumTier: typeof g.premium_tier === 'number' ? g.premium_tier : null,
      boosts: typeof g.premium_subscription_count === 'number' ? g.premium_subscription_count : null,
    };
  }
  if (statusCode === 429 || statusCode === 403) {
    const ra = headers['retry-after'] ? Number(headers['retry-after'])
      : (typeof data?.retry_after === 'number' ? data.retry_after : null);
    return { free: null, rateLimited: true, cloudflare: isCloudflareBan(statusCode, txt), retryAfter: ra };
  }
  return { free: null, statusCode };
}

// --- Pré-vol : valide chaque bot AVANT le drop ---
async function getVanityRaw(auth, guildId) {
  const { statusCode, body } = await request(`${HOST}${API_PATH}/guilds/${guildId}/vanity-url`, {
    method: 'GET', headers: { authorization: auth, 'user-agent': UA },
  });
  const txt = await body.text().catch(() => '');
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { /* */ }
  return { ok: statusCode === 200, status: statusCode, code: d?.code || null };
}
async function patchVanityRaw(auth, guildId, code) {
  const { statusCode, body } = await request(`${HOST}${API_PATH}/guilds/${guildId}/vanity-url`, {
    method: 'PATCH',
    headers: { authorization: auth, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ code }),
  });
  const txt = await body.text().catch(() => '');
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { /* */ }
  return { ok: statusCode === 200, status: statusCode, message: d?.message };
}

// Vérifie droits + latence de chaque bot sur le serveur cible. Fait un no-op PATCH
// (remet la vanity actuelle sur elle-même) UNIQUEMENT si une vanity existe déjà —
// sûr, ça ne change rien, mais valide tout le chemin d'écriture + mesure la latence.
export async function preflight({ guildId, bots }) {
  const results = [];
  for (const b of bots) {
    const r = { label: b.label, canManage: false, latencyMs: null, patchOk: null, patchLatencyMs: null, vanityCode: null, error: null };
    try {
      const t0 = Date.now();
      const v = await getVanityRaw(b.auth, guildId);
      r.latencyMs = Date.now() - t0;
      r.canManage = v.ok;
      r.vanityCode = v.code;
      if (!v.ok) { r.error = `GET vanity → ${v.status} (le bot n'a pas « Gérer le serveur » ici ?)`; results.push(r); continue; }
      if (v.code) {
        const t1 = Date.now();
        const p = await patchVanityRaw(b.auth, guildId, v.code);
        r.patchLatencyMs = Date.now() - t1;
        r.patchOk = p.ok;
        if (!p.ok) r.error = `PATCH no-op → ${p.status}${p.message ? ': ' + p.message : ''}`;
      }
    } catch (e) { r.error = e.message; }
    results.push(r);
  }
  return results;
}

/**
 * @param {object} opts
 * @param {string[]} opts.codes        codes vanity à viser (watchlist)
 * @param {string} opts.guildId        serveur (le tien) où poser la vanity
 * @param {{auth:string,label:string}[]} opts.bots  bots qui tirent (>=1)
 * @param {number} [opts.dropAt]        epoch ms du drop (mode planifié)
 * @param {boolean} [opts.monitor]      mode surveillance
 * @param {number} [opts.connections]   connexions pré-chauffées par bot (def 3)
 * @param {number} [opts.burst]         requêtes par rafale et par bot (def 5)
 * @param {number} [opts.spacingMs]     espacement entre requêtes (def 40)
 * @param {number} [opts.leadMs]        avance de la 1re requête sur T0 (def 40)
 * @param {boolean} [opts.autoLead]     caler leadMs sur la latence mesurée
 * @param {number} [opts.baseIntervalMs] intervalle de poll de base (def 1200)
 * @param {boolean} [opts.skipNtp]      ne pas synchroniser l'horloge
 */
export async function snipe(opts) {
  const {
    codes, guildId, bots, dropAt, monitor = false,
    connections = 3, burst = 5, spacingMs = 40, leadMs = 40, autoLead = false,
    baseIntervalMs = 1200, skipNtp = false,
  } = opts;

  if (!Array.isArray(codes) || !codes.length) throw new Error('Aucun code à sniper.');
  if (!Array.isArray(bots) || !bots.length) throw new Error('Aucun bot pour tirer.');

  stopFlag = false;
  // ≥ burst : chaque requête de la rafale a sa propre connexion → elles partent
  // vraiment en parallèle (avec pipelining:1, une connexion = 1 requête à la fois).
  const poolConns = Math.max(connections, burst);
  const botPools = bots.map((b) => ({ ...b, pool: new Pool(HOST, { connections: poolConns, pipelining: 1 }) }));
  const probePool = new Pool(HOST, { connections: 2, pipelining: 1 });
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
        log.warn(`NTP indisponible (${e.message}) — horloge locale telle quelle.`);
      }
    }
    const toLocal = (realMs) => realMs - offset;

    if (monitor) {
      return await monitorMany(botPools, probePool, codes, guildId, { burst, spacingMs, baseIntervalMs, poolConns });
    }

    if (!dropAt) throw new Error('Mode planifié : dropAt requis (ou utilise monitor).');
    const code = codes[0]; // le mode planifié vise un code précis
    const now = Date.now() + offset;
    log.step(`Snipe planifié de ${c.yellow}discord.gg/${code}${c.reset} (${botPools.length} bot(s))`);
    log.info(`Drop dans ${c.cyan}${fmtDuration(dropAt - now)}${c.reset} (${new Date(dropAt).toISOString()})`);

    await waitUntilOrStop(toLocal(dropAt - 10_000));
    if (stopFlag) { log.warn('Snipe planifié annulé.'); return STOPPED; }
    log.info('Pré-chauffage des connexions...');
    const { live, latency: med } = await warmAndPrune(botPools, poolConns);
    if (!live.length) throw new Error('Tous les bots ont un token invalide (401).');
    let effLead = leadMs;
    if (med != null) {
      log.ok(`Connexions prêtes (${live.length} bot(s)). Latence médiane ≈ ${med} ms.`);
      if (autoLead) { effLead = med; log.info(`Auto-lead : tir calé à T0-${effLead} ms (latence mesurée).`); }
    } else {
      log.ok(`Connexions prêtes (${live.length} bot(s)).`);
    }

    log.info(`Rafale de ${burst}×${live.length} requêtes, 1re à T0-${effLead} ms. En attente...`);
    await waitUntilOrStop(toLocal(dropAt - effLead));
    if (stopFlag) { log.warn('Snipe planifié annulé.'); return STOPPED; }

    const result = await fireBurstAllBots(live, code, guildId, { burst, spacingMs });
    reportResult(result, code);
    return result;
  } finally {
    await Promise.all([
      ...botPools.map((bp) => bp.pool.close().catch(() => {})),
      probePool.close().catch(() => {}),
    ]);
  }
}

// Rafale d'un seul bot : `burst` PATCH cadencés à des instants ABSOLUS
// (fireStart + i·spacing) → pas de dérive cumulée comme avec des sleep enchaînés,
// et wait NON bloquant pour laisser les autres bots tirer en parallèle. Stoppe si
// un autre bot a déjà gagné (signal aborté).
async function fireBurstOne(pool, auth, label, code, guildId, { burst, spacingMs, fireStart }, controller) {
  const inflight = [];
  let idx = null;
  for (let i = 0; i < burst; i++) {
    if (controller?.signal.aborted) break; // gagné ailleurs → inutile d'en envoyer plus
    const wait = (fireStart + i * spacingMs) - Date.now();
    if (wait > 0) await sleep(wait);
    const t = Date.now();
    inflight.push(
      attempt(pool, code, guildId, auth, controller?.signal).then((r) => {
        if (!r.aborted) {
          log.info(`  [${label}] req#${i + 1} → ${statusColor(r.status)} (${Date.now() - t} ms)` +
            (r.retryAfter ? ` retry-after ${r.retryAfter}s` : ''));
        }
        if (r.ok && idx === null) idx = i + 1;
        return r;
      }).catch((e) => { log.warn(`  [${label}] req#${i + 1} erreur: ${e.message}`); return { ok: false }; })
    );
  }
  const all = await Promise.all(inflight);
  return { success: idx !== null, index: idx, attempts: all };
}

// Rafale simultanée depuis tous les bots ; on annule le reste dès le 1er 200.
// Tous partagent le MÊME fireStart → cadence alignée entre bots.
async function fireBurstAllBots(botPools, code, guildId, cfg) {
  const controller = new AbortController();
  const fireStart = Date.now();
  let winner = null;
  const runs = botPools.map((bp) =>
    fireBurstOne(bp.pool, bp.auth, bp.label, code, guildId, { ...cfg, fireStart }, controller).then((r) => {
      if (r.success && !winner) { winner = { code, bot: bp.label, index: r.index }; controller.abort(); }
      return r;
    }));
  const results = await Promise.all(runs);
  const got429 = results.some((r) => r.attempts?.some((a) => a.status === 429));
  return { success: !!winner, winner, got429 };
}

// Surveille plusieurs codes ; tire dès que l'un se libère. Poll adaptatif + étalé.
// Mode CHAUD : dès qu'un détenteur retombe sous le niveau 3 (drop imminent), on
// se concentre sur ce(s) code(s) à un intervalle très court et on re-chauffe les
// connexions, pour attraper la libération à la seconde.
async function monitorMany(botPools, probePool, codes, guildId, { burst, spacingMs, baseIntervalMs, poolConns }) {
  log.step(`Surveillance de ${codes.length} code(s) : ${codes.map((x) => 'gg/' + x).join(', ')} — ${botPools.length} bot(s)`);
  let live = (await warmAndPrune(botPools, poolConns)).live;
  if (!live.length) throw new Error('Tous les bots ont un token invalide (401).');
  const hotFloor = Math.min(250, baseIntervalMs); // cadence en drop imminent
  // Régulateur AIMD (comme le sniper MC) : accélère après des succès, ralentit
  // fort sur 429 (respecte Retry-After), pause sur Cloudflare 1015. Borné.
  const gov = new RateGov({ floorMs: baseIntervalMs, startMs: baseIntervalMs, ceilMs: 15_000 });
  let polls = 0;
  const hot = new Set(); // codes au niveau de boost < 3 (drop imminent)

  while (!stopFlag) {
    const hotMode = hot.size > 0;
    const pollSet = hotMode ? [...hot] : codes;
    for (const code of pollSet) {
      if (stopFlag) break;
      let r;
      try { r = await probe(probePool, code); }
      catch (e) { log.warn(`sonde ${code}: ${e.message}`); continue; }
      polls++;

      if (r.free) {
        hot.delete(code);
        log.ok(`discord.gg/${code} est LIBRE — rafale !`);
        const res = await fireBurstAllBots(live, code, guildId, { burst, spacingMs });
        reportResult(res, code);
        if (res.success) return res;
        log.warn(`Course perdue sur ${code} — on continue.`);
        continue;
      }
      if (r.cloudflare) {
        gov.onCloudflare(60_000); // plafond + longue pause
        log.err(`Cloudflare 1015 (IP bloquée) — pause ${Math.round(gov.nextDelay() / 1000)}s.`);
        await waitUntilOrStop(Date.now() + gov.nextDelay());
        continue;
      }
      if (r.rateLimited) {
        gov.onRateLimit(r.retryAfter); // ralentit ×2 + respecte Retry-After
        log.warn(`429 sur ${code} — recul ${Math.round(gov.nextDelay())} ms (throttle #${gov.throttleEvents}).`);
        await waitUntilOrStop(Date.now() + gov.nextDelay());
        continue;
      }
      // Sonde propre → l'AIMD accélère par petits pas après une série de succès.
      gov.onSuccess();
      // Prédicteur de drop (niveau de boost du détenteur).
      if (r.premiumTier != null && r.premiumTier < 3) {
        if (!hot.has(code)) {
          hot.add(code);
          log.warn(`⚠ discord.gg/${code} : détenteur au niveau ${r.premiumTier} (boosts ${r.boosts ?? '?'}) — DROP IMMINENT, poll accéléré à ${hotFloor} ms.`);
          // Re-chauffe les connexions maintenant (rafale prête + parallèle) et
          // écarte au passage un bot dont le token vient d'être révoqué.
          const rw = await warmAndPrune(live, poolConns);
          if (rw.live.length) live = rw.live;
          else { log.err('Plus aucun bot valide — arrêt.'); return STOPPED; }
        }
      } else if (r.premiumTier != null && r.premiumTier >= 3 && hot.delete(code)) {
        log.info(`discord.gg/${code} est remonté au niveau 3 — poll normal.`);
      }
      // Backoff prioritaire ; sinon en mode chaud on colle au plancher rapide ;
      // sinon on étale la cadence AIMD sur la watchlist.
      let delay;
      if (gov.throttled()) delay = gov.nextDelay();
      else if (hotMode) delay = hotFloor;
      else delay = Math.max(150, Math.round(gov.interval / codes.length));
      await waitUntilOrStop(Date.now() + delay);
    }
    if (polls % 40 < pollSet.length) {
      log.info(`...surveillance (${polls} sondages, ${hotMode ? 'ACCÉLÉRÉ ' + hotFloor : 'intervalle ' + gov.interval} ms${gov.throttleEvents ? `, ${gov.throttleEvents} throttles` : ''})`);
    }
  }
  log.warn('Surveillance arrêtée.');
  return STOPPED;
}

function statusColor(s) {
  if (s === 200) return `${c.green}200 OK${c.reset}`;
  if (s === 429) return `${c.red}429 rate-limit${c.reset}`;
  if (s === 400) return `${c.yellow}400 pris/invalide${c.reset}`;
  if (s === 403) return `${c.yellow}403 droits/inéligible${c.reset}`;
  return `${c.gray}${s}${c.reset}`;
}

function reportResult(result, code) {
  console.log('');
  if (result.success) {
    log.ok(`${c.green}🎯 SNIPE RÉUSSI${c.reset} — discord.gg/${code} obtenu par ${result.winner.bot} (req#${result.winner.index}) !`);
  } else {
    log.err(`Échec du snipe de discord.gg/${code}.` +
      (result.got429 ? ' Rate-limité (429) : réduis burst/augmente spacing, ou code pris par plus rapide.'
        : ' Code encore pris, ou serveur inéligible (boost < 3).'));
  }
}

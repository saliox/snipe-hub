// Moteur Minecraft (port mobile) : auth Microsoft device-code -> Xbox -> XSTS ->
// Minecraft, check de dispo (Mojang public + statut authentifié), et burst de
// renommage. Tout en fetch() : compatible React Native.
import { fetchT, form, log, sleep, sleepUntil, nowMs } from './net.js';
import { getConfig } from './config.js';
import { secureGet, secureSet, secureDelete } from './secure.js';

const KEY = 'mc.token';
const MC = 'https://api.minecraftservices.com';
const TENANT = 'consumers';
const DEVICECODE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const SCOPE = 'XboxLive.signin offline_access';

function clientId() {
  const id = getConfig().msClientId;
  if (!id) throw new Error('MS_CLIENT_ID manquant — renseigne-le dans Réglages (app Azure, public client, scope XboxLive.signin).');
  return id;
}

// --- Auth : device code flow (affiche un code + URL, aucun redirect) ---
export async function requestDeviceCode() {
  const res = await fetchT(DEVICECODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId(), scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`devicecode ${res.status}: ${await res.text()}`);
  return res.json(); // { device_code, user_code, verification_uri, interval, expires_in }
}

// Poll jusqu'à validation par l'utilisateur. onTick(remainingSec) optionnel.
export async function pollForMsToken(dc, onCancelled) {
  let interval = dc.interval || 5;
  const deadline = nowMs() + (dc.expires_in || 900) * 1000;
  while (nowMs() < deadline) {
    if (onCancelled && onCancelled()) throw new Error('Connexion annulée.');
    await sleep(interval * 1000);
    const res = await fetchT(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId(),
        device_code: dc.device_code,
      }),
    });
    const data = await res.json();
    if (res.ok) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5; continue; }
    throw new Error(`token: ${data.error} ${data.error_description || ''}`);
  }
  throw new Error('Code expiré — relance la connexion.');
}

async function refreshMsToken(refreshToken) {
  const res = await fetchT(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'refresh_token', client_id: clientId(), refresh_token: refreshToken, scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`refresh ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Chaîne Xbox Live -> XSTS -> Minecraft ---
async function xblAuth(msAccessToken) {
  const res = await fetchT('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    }),
  });
  if (!res.ok) throw new Error(`XBL ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
}
async function xstsAuth(xblToken) {
  const res = await fetchT('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    }),
  });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    const codes = {
      2148916233: 'Aucun compte Xbox (crée un profil Xbox pour ce compte Microsoft).',
      2148916235: 'Xbox Live indisponible dans ce pays.',
      2148916238: 'Compte enfant : doit être ajouté à une famille adulte.',
    };
    throw new Error(`XSTS refusé: ${codes[data.XErr] || data.XErr || 'inconnu'}`);
  }
  if (!res.ok) throw new Error(`XSTS ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
}
async function minecraftLogin(uhs, xstsToken) {
  const res = await fetchT(`${MC}/authentication/login_with_xbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` }),
  });
  if (res.status === 403) throw new Error('login_with_xbox 403 — l\'app Azure doit être approuvée : https://aka.ms/mce-reviewappid');
  if (!res.ok) throw new Error(`login_with_xbox ${res.status}: ${await res.text()}`);
  return res.json();
}
async function fetchProfile(token) {
  const res = await fetchT(`${MC}/minecraft/profile`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`profile ${res.status}`);
  return res.json();
}
async function msToMinecraft(msAccessToken) {
  const xbl = await xblAuth(msAccessToken);
  const xsts = await xstsAuth(xbl.token);
  const mc = await minecraftLogin(xsts.uhs, xsts.token);
  const profile = await fetchProfile(mc.access_token);
  return { accessToken: mc.access_token, expiresAt: nowMs() + (mc.expires_in - 60) * 1000, profile };
}

// Finalise le login à partir du token MS (device-code validé) et met en cache.
export async function completeLogin(msTok) {
  const mc = await msToMinecraft(msTok.access_token);
  await secureSet(KEY, {
    msRefreshToken: msTok.refresh_token, accessToken: mc.accessToken,
    expiresAt: mc.expiresAt, profile: mc.profile,
  });
  if (mc.profile) log.ok(`Connecté : ${mc.profile.name} (${mc.profile.id})`);
  else log.warn('Compte connecté mais aucun profil Java (Minecraft non acheté).');
  return mc.profile;
}

export async function whoami() {
  const c = await secureGet(KEY);
  const p = c?.profile;
  return p ? { name: p.name, id: p.id } : null;
}
export async function logout() { await secureDelete(KEY); }

// Token valide (refresh silencieux si expiré).
export async function getValidToken() {
  const cache = await secureGet(KEY);
  if (!cache) throw new Error('Non connecté (Minecraft).');
  if (cache.accessToken && cache.expiresAt && nowMs() < cache.expiresAt) return cache.accessToken;
  if (!cache.msRefreshToken) throw new Error('Session expirée — reconnecte-toi.');
  log.info('Token Minecraft expiré, rafraîchissement...');
  const msTok = await refreshMsToken(cache.msRefreshToken);
  const mc = await msToMinecraft(msTok.access_token);
  await secureSet(KEY, {
    msRefreshToken: msTok.refresh_token || cache.msRefreshToken,
    accessToken: mc.accessToken, expiresAt: mc.expiresAt, profile: mc.profile,
  });
  return mc.accessToken;
}

// --- Check de dispo ---
export function validName(name) { return /^[A-Za-z0-9_]{3,16}$/.test(name); }

// Public (anonyme) : 404 = libre, 200 = pris.
export async function isNameFree(name) {
  const res = await fetchT(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { timeout: 8000 });
  if (res.status === 404) return { free: true };
  if (res.status === 200) { const d = await res.json(); return { free: false, uuid: d.id }; }
  if (res.status === 429) return { free: null, rateLimited: true };
  return { free: null, status: res.status };
}

// Authentifié : distingue AVAILABLE / DUPLICATE / NOT_ALLOWED.
async function nameStatus(name, token) {
  const res = await fetchT(`${MC}/minecraft/profile/name/${encodeURIComponent(name)}/available`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 200) return (await res.json()).status;
  if (res.status === 401) return 'UNAUTHORIZED';
  return `HTTP_${res.status}`;
}

// --- Burst : PUT /minecraft/profile/name/{name} ---
async function warmup(token, n) {
  await Promise.all(Array.from({ length: n }, async () => {
    try { const r = await fetchT(`${MC}/minecraft/profile`, { headers: { authorization: `Bearer ${token}` }, timeout: 5000 }); await r.text(); } catch { /* ignore */ }
  }));
}
async function attempt(name, token, signal) {
  const res = await fetchT(`${MC}/minecraft/profile/name/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}` }, signal, timeout: 8000,
  });
  await res.text().catch(() => {});
  return { ok: res.status === 200, status: res.status };
}

// Rafale : `burst` PUT espacés de `spacing` ms. Abort-on-win.
async function fireBurst({ name, token, burst, spacingMs }) {
  const ctrl = new AbortController();
  let winner = null;
  const inflight = [];
  for (let i = 0; i < burst; i++) {
    if (winner) break;
    const idx = i + 1;
    const t = nowMs();
    inflight.push(
      attempt(name, token, ctrl.signal).then((r) => {
        log.info(`  req#${idx} → ${r.status} (${Math.round(nowMs() - t)} ms)`);
        if (r.ok && !winner) { winner = { ...r, index: idx }; ctrl.abort(); }
        return r;
      }).catch(() => ({ ok: false }))
    );
    if (i < burst - 1) await sleep(spacingMs);
  }
  const all = await Promise.all(inflight);
  return { success: !!winner, winner, attempts: all };
}

// opts unifiés : { name, dropAt, monitor, burst, spacingMs, leadMs, skipNtp, offset, shouldStop }
export async function snipe(opts) {
  const { name, dropAt, monitor = false, burst = 6, spacingMs = 30, leadMs = 40, offset = 0, shouldStop } = opts;
  const token = await getValidToken();
  const toLocal = (realMs) => realMs - offset;

  if (monitor) {
    log.step(`Surveillance de ${name}`);
    await warmup(token, 2);
    let polls = 0, failed = 0;
    while (!(shouldStop && shouldStop())) {
      polls++;
      const st = await nameStatus(name, token);
      if (st === 'UNAUTHORIZED') { log.err('401 — reconnecte-toi.'); return { success: false, error: 'token' }; }
      if (st === 'AVAILABLE') {
        log.ok(`${name} DISPONIBLE — rafale !`);
        const r = await fireBurst({ name, token, burst, spacingMs });
        if (r.success) { log.ok(`🎯 ${name} obtenu (req#${r.winner.index}) !`); return r; }
        if (++failed >= 5) { log.err(`Abandon après ${failed} rafales.`); return r; }
        log.warn(`Rafale perdue (${failed}/5) — reprise.`); await sleep(1000); continue;
      }
      if (polls % 20 === 0) log.info(`...toujours ${st} (${polls} sondages)`);
      await sleep(1000);
    }
    log.warn('Surveillance arrêtée.');
    return { success: false, stopped: true };
  }

  if (!dropAt) throw new Error('Mode planifié : renseigne la date/heure du drop.');
  log.step(`Snipe planifié de ${name}`);
  const warmAt = toLocal(dropAt - 10000);
  if (warmAt > nowMs()) await sleepUntil(warmAt);
  log.info('Pré-chauffage des connexions...');
  await warmup(token, 3);
  await sleepUntil(toLocal(dropAt - leadMs), 15);
  log.info(`Rafale de ${burst} (espacée ${spacingMs} ms, T0-${leadMs} ms)`);
  const r = await fireBurst({ name, token, burst, spacingMs });
  if (r.success) log.ok(`🎯 ${name} obtenu (req#${r.winner.index}) !`);
  else log.err(`Échec du snipe de ${name}.`);
  return r;
}

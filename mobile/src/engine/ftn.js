// Moteur Fortnite / Epic (port mobile) : login par authorizationCode (OAuth),
// check de dispo d'un display name, et burst PUT de changement de pseudo.
import { fetchT, form, log, sleep, sleepUntil, nowMs } from './net.js';
import { getConfig, EPIC_DEFAULT_ID, EPIC_DEFAULT_SECRET } from './config.js';
import { secureGet, secureSet, secureDelete } from './secure.js';

const HOST = 'https://account-public-service-prod.ol.epicgames.com';
const TOKEN_URL = `${HOST}/account/api/oauth/token`;
// Multi-comptes : store { activeId, accounts: [...] }. LEGACY = ancien mono-compte.
const STORE_KEY = 'ftn.store';
const LEGACY_KEY = 'ftn.account';

function clientId() { return getConfig().epicClientId || EPIC_DEFAULT_ID; }
function clientSecret() { return getConfig().epicClientSecret || EPIC_DEFAULT_SECRET; }
function basicAuth() {
  // btoa dispo en RN (Hermes) ; repli global.btoa.
  const raw = `${clientId()}:${clientSecret()}`;
  const b64 = typeof btoa === 'function' ? btoa(raw) : global.btoa(raw);
  return 'Basic ' + b64;
}

export function authCodeUrl() {
  return `https://www.epicgames.com/id/api/redirect?clientId=${clientId()}&responseType=code`;
}
export function validName(name) { return typeof name === 'string' && name.length >= 3 && name.length <= 16; }

async function exchangeAuthCode(code) {
  const res = await fetchT(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, token_type: 'eg1' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`oauth/token ${res.status}: ${data.errorMessage || data.error_description || ''}`);
  return data;
}
async function refreshTokens(refreshToken) {
  const res = await fetchT(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, token_type: 'eg1' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`refresh ${res.status}: ${data.errorMessage || ''}`);
  return data;
}
function cacheFrom(data) {
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) - 60000 : nowMs() + ((data.expires_in || 3600) - 60) * 1000;
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, accountId: data.account_id, displayName: data.displayName || null };
}

// --- Store multi-comptes ---
async function loadStore() {
  const s = await secureGet(STORE_KEY);
  if (s && Array.isArray(s.accounts)) return s;
  // Migration : ancien mono-compte -> store multi.
  const legacy = await secureGet(LEGACY_KEY);
  if (legacy && legacy.refreshToken) {
    const acc = mkAccount(legacy, legacy.displayName || 'Compte 1');
    const store = { activeId: acc.id, accounts: [acc] };
    await saveStore(store);
    await secureDelete(LEGACY_KEY);
    return store;
  }
  return { activeId: null, accounts: [] };
}
async function saveStore(s) { await secureSet(STORE_KEY, s); }
function mkAccount(info, label) {
  return {
    id: info.accountId, // accountId Epic = identifiant stable et unique
    label: (label || '').trim() || info.displayName || info.accountId,
    accountId: info.accountId, displayName: info.displayName || null,
    refreshToken: info.refreshToken, accessToken: info.accessToken || null,
    expiresAt: info.expiresAt || 0, addedAt: nowMs(),
  };
}
const publicAccount = (a) => (a ? { id: a.id, label: a.label, accountId: a.accountId, displayName: a.displayName } : null);

// Login : ajoute (ou met à jour) un compte depuis un authorizationCode, le rend actif.
export async function login(code, label) {
  const clean = String(code || '').trim().replace(/^"|"$/g, '');
  if (!clean) throw new Error('Colle ton authorizationCode Epic (voir le lien affiché).');
  const info = cacheFrom(await exchangeAuthCode(clean));
  const store = await loadStore();
  let acc = store.accounts.find((a) => a.accountId === info.accountId);
  if (acc) {
    acc.refreshToken = info.refreshToken; acc.accessToken = info.accessToken; acc.expiresAt = info.expiresAt;
    if (info.displayName) acc.displayName = info.displayName;
  } else { acc = mkAccount(info, label); store.accounts.push(acc); }
  store.activeId = acc.id;
  await saveStore(store);
  log.ok(`Connecté Epic : ${acc.displayName || acc.accountId}`);
  return { name: acc.displayName || acc.accountId, id: acc.accountId };
}

// Déconnexion : retire le compte ACTIF (les autres restent).
export async function logout() {
  const store = await loadStore();
  if (!store.accounts.length) { await secureDelete(STORE_KEY); return; }
  store.accounts = store.accounts.filter((a) => a.id !== store.activeId);
  store.activeId = store.accounts[0]?.id || null;
  await saveStore(store);
}

export async function whoami() {
  const store = await loadStore();
  const a = store.accounts.find((x) => x.id === store.activeId) || store.accounts[0];
  return a ? { name: a.displayName || a.accountId, id: a.accountId } : null;
}

// Panneau multi-comptes de l'UI (mode 'select' = un seul actif à la fois).
export async function listAccounts() {
  const s = await loadStore();
  return { activeId: s.activeId, accounts: s.accounts.map((a) => ({ ...publicAccount(a), active: a.id === s.activeId })) };
}
export async function setActive(id) {
  const s = await loadStore();
  if (s.accounts.find((a) => a.id === id)) { s.activeId = id; await saveStore(s); }
  return listAccounts();
}
export async function removeAccount(id) {
  const s = await loadStore();
  s.accounts = s.accounts.filter((a) => a.id !== id);
  if (s.activeId === id) s.activeId = s.accounts[0]?.id || null;
  await saveStore(s);
  return listAccounts();
}

// Rafraîchit si besoin et renvoie un token frais pour un compte donné.
async function freshFor(store, acc) {
  if (acc.accessToken && acc.expiresAt && nowMs() < acc.expiresAt) return { token: acc.accessToken, accountId: acc.accountId };
  if (!acc.refreshToken) throw new Error(`Compte « ${acc.label} » : reconnecte-le.`);
  log.info('Token Epic expiré, rafraîchissement...');
  const info = cacheFrom(await refreshTokens(acc.refreshToken));
  acc.accessToken = info.accessToken; acc.expiresAt = info.expiresAt;
  if (info.refreshToken) acc.refreshToken = info.refreshToken;
  if (info.displayName) acc.displayName = info.displayName;
  await saveStore(store);
  return { token: acc.accessToken, accountId: acc.accountId };
}

// Token frais du compte ACTIF.
export async function getValidToken() {
  const store = await loadStore();
  const acc = store.accounts.find((a) => a.id === store.activeId) || store.accounts[0];
  if (!acc) throw new Error('Non connecté (Epic).');
  return freshFor(store, acc);
}

// --- Check : 404 = libre, 200 = pris ---
export async function displayNameStatus(name, token) {
  const res = await fetchT(`${HOST}/account/api/public/account/displayName/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${token}` }, timeout: 8000,
  });
  if (res.status === 404) { await res.text(); return { free: true }; }
  if (res.status === 200) { const d = await res.json(); return { free: false, accountId: d.id }; }
  if (res.status === 429) return { free: null, rateLimited: true };
  await res.text().catch(() => {});
  return { free: null, status: res.status };
}
export async function check(name) {
  const { token } = await getValidToken();
  return displayNameStatus(name, token);
}

// --- Changement de display name : PUT /account/api/public/account/{id} ---
async function changeName(name, token, accountId, signal) {
  const res = await fetchT(`${HOST}/account/api/public/account/${encodeURIComponent(accountId)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: name }), signal, timeout: 8000,
  });
  let payload = null; try { payload = await res.json(); } catch { await res.text().catch(() => {}); }
  if (res.status === 200 || res.status === 204) return { ok: true, status: res.status };
  const blob = `${payload?.errorCode || ''} ${payload?.errorMessage || ''}`.toLowerCase();
  let reason;
  if (/throttl|change_limit|too_many|cooldown/.test(blob)) reason = 'Cooldown de pseudo actif (2 semaines).';
  else if (/taken|duplicate|unavailable|already/.test(blob)) reason = 'Nom déjà pris entre-temps.';
  else if (/validation|invalid|forbidden|profane/.test(blob)) reason = 'Nom refusé (format/filtre).';
  else reason = payload?.errorMessage || `HTTP ${res.status}`;
  return { ok: false, status: res.status, reason };
}

async function fireBurst({ name, token, accountId, burst, spacingMs }) {
  const ctrl = new AbortController();
  let winner = null;
  const inflight = [];
  for (let i = 0; i < burst; i++) {
    if (winner) break;
    const idx = i + 1, t = nowMs();
    inflight.push(changeName(name, token, accountId, ctrl.signal).then((r) => {
      log.info(`  req#${idx} → ${r.status} (${Math.round(nowMs() - t)} ms)${r.reason ? ' ' + r.reason : ''}`);
      if (r.ok && !winner) { winner = { index: idx }; ctrl.abort(); }
      return r;
    }).catch(() => ({ ok: false })));
    if (i < burst - 1) await sleep(spacingMs);
  }
  const all = await Promise.all(inflight);
  return { success: !!winner, winner, attempts: all };
}

// opts : { name, dropAt, monitor, burst, spacingMs, leadMs, offset, shouldStop }
export async function snipe(opts) {
  const { name, dropAt, monitor = false, burst = 6, spacingMs = 30, leadMs = 40, offset = 0, shouldStop } = opts;
  const { token, accountId } = await getValidToken();
  const toLocal = (realMs) => realMs - offset;

  if (monitor) {
    log.step(`Surveillance de ${name}`);
    let polls = 0, failed = 0;
    while (!(shouldStop && shouldStop())) {
      polls++;
      const st = await displayNameStatus(name, token);
      if (st.free) {
        log.ok(`${name} LIBRE — rafale !`);
        const r = await fireBurst({ name, token, accountId, burst, spacingMs });
        if (r.success) { log.ok(`🎯 ${name} obtenu (req#${r.winner.index}) !`); return r; }
        if (++failed >= 5) { log.err(`Abandon après ${failed} rafales.`); return r; }
        log.warn(`Rafale perdue (${failed}/5) — reprise.`); await sleep(1000); continue;
      }
      if (polls % 20 === 0) log.info(`...toujours pris (${polls} sondages)`);
      await sleep(1000);
    }
    log.warn('Surveillance arrêtée.');
    return { success: false, stopped: true };
  }

  if (!dropAt) throw new Error('Mode planifié : renseigne la date/heure du drop.');
  log.step(`Snipe planifié de ${name}`);
  await sleepUntil(toLocal(dropAt - leadMs), 15);
  const r = await fireBurst({ name, token, accountId, burst, spacingMs });
  if (r.success) log.ok(`🎯 ${name} obtenu (req#${r.winner.index}) !`);
  else log.err(`Échec du snipe de ${name}.`);
  return r;
}

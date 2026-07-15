// Moteur X / Twitter (port mobile) : login par identifiants de session (cookies
// auth_token + ct0), check de dispo via username_available.json, surveillance/
// alerte, et changement de @handle (⚠️ API X très verrouillée depuis 2023 —
// endpoint « à confirmer » : la surveillance ALERTE de façon fiable).
import { fetchT, log, sleep, sleepUntil, nowMs } from './net.js';
import { getConfig } from './config.js';
import { secureGet, secureSet, secureDelete } from './secure.js';

const KEY = 'x.creds';
const WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const ua = () => getConfig().xUA || UA;

export function validName(name) { return /^[A-Za-z0-9_]{4,15}$/.test(String(name || '')); }

function parseCreds(raw) {
  const s = String(raw || '');
  const at = (s.match(/auth_token=([0-9a-f]+)/i) || [])[1] || (s.match(/^\s*([0-9a-f]{30,})\s*$/i) || [])[1] || null;
  const ct0 = (s.match(/ct0=([0-9a-f]+)/i) || [])[1] || null;
  return { auth_token: at, ct0 };
}
function authHeaders(cred, extra = {}) {
  return {
    authorization: `Bearer ${WEB_BEARER}`,
    cookie: `auth_token=${cred.auth_token}; ct0=${cred.ct0}`,
    'x-csrf-token': cred.ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'user-agent': ua(),
    ...extra,
  };
}

async function verify(cred) {
  const res = await fetchT('https://api.twitter.com/1.1/account/verify_credentials.json', { headers: authHeaders(cred), timeout: 8000 });
  const txt = await res.text().catch(() => '');
  if (res.status === 200) { const u = JSON.parse(txt); return { screen_name: u.screen_name, id: u.id_str || String(u.id) }; }
  if (res.status === 401 || res.status === 403) throw new Error('Identifiants X invalides/expirés (auth_token ou ct0).');
  throw new Error(`verify_credentials a répondu ${res.status}`);
}

// Colle tes cookies x.com « auth_token=…; ct0=… ». Validés avant stockage.
export async function setToken(raw) {
  const cred = parseCreds(raw);
  if (!cred.auth_token) throw new Error('auth_token introuvable — colle tes cookies x.com (auth_token=…; ct0=…).');
  if (!cred.ct0) throw new Error('ct0 introuvable — colle AUSSI le cookie ct0 (anti-CSRF).');
  const profile = await verify(cred);
  await secureSet(KEY, { ...cred, profile });
  return { name: '@' + profile.screen_name, id: profile.id };
}
export async function logout() { await secureDelete(KEY); }
export async function whoami() {
  const s = await secureGet(KEY);
  return s?.profile ? { name: '@' + s.profile.screen_name, id: s.profile.id } : null;
}
async function creds() { const s = await secureGet(KEY); return (s && s.auth_token && s.ct0) ? { auth_token: s.auth_token, ct0: s.ct0 } : null; }

// Dispo via l'endpoint d'inscription : { valid:true } = libre.
export async function checkAvailable(name) {
  const cred = await creds();
  const headers = cred ? authHeaders(cred) : { authorization: `Bearer ${WEB_BEARER}`, 'user-agent': ua() };
  const res = await fetchT(`https://api.twitter.com/i/users/username_available.json?username=${encodeURIComponent(name)}`, { headers, timeout: 8000 });
  if (res.status === 429) { await res.text(); return { free: null, rateLimited: true, note: 'rate-limité' }; }
  const txt = await res.text().catch(() => '');
  let data = null; try { data = JSON.parse(txt); } catch { /* */ }
  if (res.status !== 200 || !data) return { free: null, note: `statut ${res.status}` };
  return { free: data.valid === true, note: data.reason && data.valid !== true ? data.reason : null };
}

async function changeUsername(name, cred) {
  const res = await fetchT('https://api.twitter.com/1.1/account/settings.json', {
    method: 'POST',
    headers: authHeaders(cred, { 'content-type': 'application/x-www-form-urlencoded' }),
    body: `screen_name=${encodeURIComponent(name)}`,
    timeout: 8000,
  });
  const txt = await res.text().catch(() => '');
  let data = null; try { data = JSON.parse(txt); } catch { /* */ }
  if (res.status === 200 && (data?.screen_name || '').toLowerCase() === name.toLowerCase()) return { ok: true };
  const err = Array.isArray(data?.errors) ? data.errors.map((e) => e.message).join(' ; ') : null;
  return { ok: false, reason: err || 'endpoint à confirmer' };
}

// opts : { name, dropAt, monitor, leadMs, offset, shouldStop }
export async function snipe(opts) {
  const { name, dropAt, monitor = false, leadMs = 40, offset = 0, shouldStop } = opts;
  const cred = await creds();
  if (!cred) throw new Error('Connecte-toi (cookies X : auth_token + ct0).');
  const attempt = async () => {
    const r = await changeUsername(name, cred);
    if (r.ok) { log.ok(`🎯 @${name} posé !`); return { success: true }; }
    log.warn(`Renommage refusé : ${r.reason}`);
    return { success: false, reason: r.reason };
  };

  if (monitor) {
    log.step(`Surveillance de @${name} (X)`);
    let polls = 0;
    while (!(shouldStop && shouldStop())) {
      polls++;
      const st = await checkAvailable(name);
      if (st.free) { log.ok(`@${name} semble LIBRE — tentative (endpoint à confirmer).`); const r = await attempt(); if (r.success) return r; await sleep(3000); }
      if (polls % 20 === 0) log.info(`...toujours pris (${polls} sondages)`);
      await sleep(1500);
    }
    log.warn('Surveillance arrêtée.');
    return { success: false, stopped: true };
  }
  if (!dropAt) throw new Error('Mode planifié : renseigne la date/heure du drop.');
  log.step(`Snipe planifié de @${name} (X)`);
  await sleepUntil((dropAt - leadMs) - offset, 15);
  return attempt();
}

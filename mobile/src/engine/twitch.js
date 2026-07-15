// Moteur Twitch (port mobile) : login par jeton OAuth (auth-token de session),
// check de dispo via Helix Get Users, surveillance/alerte, et changement de login
// via GQL (⚠️ mutation RESTREINTE par Twitch depuis 2022 — « à confirmer » : la
// surveillance ALERTE de façon fiable, l'auto-renommage peut échouer).
import { fetchT, log, sleep, sleepUntil, nowMs } from './net.js';
import { getConfig } from './config.js';
import { secureGet, secureSet, secureDelete } from './secure.js';

const KEY = 'twitch.token';
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const ua = () => getConfig().twitchUA || UA;
const clean = (raw) => String(raw || '').replace(/^OAuth\s+/i, '').trim();

export function validName(name) { return /^[A-Za-z0-9_]{4,25}$/.test(String(name || '')); }

async function validate(token) {
  const res = await fetchT('https://id.twitch.tv/oauth2/validate', {
    headers: { authorization: `OAuth ${clean(token)}`, 'user-agent': ua() }, timeout: 8000,
  });
  const txt = await res.text().catch(() => '');
  if (res.status === 200) { const d = JSON.parse(txt); return { login: d.login, id: d.user_id }; }
  if (res.status === 401) throw new Error('Jeton OAuth Twitch invalide/expiré (401).');
  throw new Error(`/oauth2/validate a répondu ${res.status}`);
}

// Colle le jeton OAuth (« auth-token » de ta session twitch.tv). Validé avant stockage.
export async function setToken(raw) {
  const token = clean(raw);
  if (!token) throw new Error('Jeton OAuth Twitch vide.');
  const profile = await validate(token);
  await secureSet(KEY, { token, profile });
  return profile;
}
export async function logout() { await secureDelete(KEY); }
export async function whoami() {
  const s = await secureGet(KEY);
  return s?.profile ? { name: s.profile.login, id: s.profile.id } : null;
}
async function token() { const s = await secureGet(KEY); return s?.token || null; }

// Dispo via Helix Get Users : data vide = aucun compte actif = candidat libre.
export async function checkAvailable(name) {
  const t = await token();
  if (!t) return { free: null, note: 'connexion requise (Helix exige un jeton)' };
  const res = await fetchT(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(name)}`, {
    headers: { 'client-id': WEB_CLIENT_ID, authorization: `Bearer ${t}`, 'user-agent': ua() }, timeout: 8000,
  });
  if (res.status === 429) { await res.text(); return { free: null, rateLimited: true, note: 'rate-limité' }; }
  const txt = await res.text().catch(() => '');
  if (res.status !== 200) return { free: null, note: `statut ${res.status}` };
  let data = null; try { data = JSON.parse(txt); } catch { /* */ }
  const arr = Array.isArray(data?.data) ? data.data : [];
  return { free: arr.length === 0 };
}

async function changeUsername(name, t) {
  const res = await fetchT('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'client-id': WEB_CLIENT_ID, authorization: `OAuth ${t}`, 'content-type': 'application/json', 'user-agent': ua() },
    body: JSON.stringify({
      operationName: 'UpdateUser',
      variables: { input: { login: name } },
      query: 'mutation UpdateUser($input: UpdateUserInput!){ updateUser(input:$input){ user{ id login } error{ code } } }',
    }),
    timeout: 8000,
  });
  const txt = await res.text().catch(() => '');
  let data = null; try { data = JSON.parse(txt); } catch { /* */ }
  if (res.status === 200 && data?.data?.updateUser?.user?.login) return { ok: true };
  const err = data?.data?.updateUser?.error?.code
    || (Array.isArray(data?.errors) ? data.errors.map((e) => e.message).join(' ; ') : null);
  return { ok: false, reason: err || 'mutation GQL à confirmer' };
}

// opts : { name, dropAt, monitor, leadMs, offset, shouldStop }
export async function snipe(opts) {
  const { name, dropAt, monitor = false, leadMs = 40, offset = 0, shouldStop } = opts;
  const t = await token();
  if (!t) throw new Error('Connecte-toi (jeton OAuth Twitch).');
  const attempt = async () => {
    const r = await changeUsername(name, t);
    if (r.ok) { log.ok(`🎯 login « ${name} » posé !`); return { success: true }; }
    log.warn(`Renommage refusé : ${r.reason}`);
    return { success: false, reason: r.reason };
  };

  if (monitor) {
    log.step(`Surveillance de ${name} (Twitch)`);
    let polls = 0;
    while (!(shouldStop && shouldStop())) {
      polls++;
      const st = await checkAvailable(name);
      if (st.free) { log.ok(`${name} semble LIBRE — tentative (mutation à confirmer).`); const r = await attempt(); if (r.success) return r; await sleep(3000); }
      if (polls % 20 === 0) log.info(`...toujours pris (${polls} sondages)`);
      await sleep(1500);
    }
    log.warn('Surveillance arrêtée.');
    return { success: false, stopped: true };
  }
  if (!dropAt) throw new Error('Mode planifié : renseigne la date/heure du drop.');
  log.step(`Snipe planifié de ${name} (Twitch)`);
  await sleepUntil((dropAt - leadMs) - offset, 15);
  return attempt();
}

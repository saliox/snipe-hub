// Moteur Roblox (port mobile) : login par cookie .ROBLOSECURITY, check de dispo
// via l'endpoint officiel de validation, surveillance, et changement de pseudo.
// ⚠️ Le renommage exige le MOT DE PASSE du compte et coûte 1000 Robux par
// changement RÉUSSI (un nom déjà pris ne débite rien). Le mot de passe n'est
// JAMAIS stocké : il est saisi au moment du snipe.
import { fetchT, log, sleep, sleepUntil, nowMs } from './net.js';
import { getConfig } from './config.js';
import { secureGet, secureSet, secureDelete } from './secure.js';

const KEY = 'roblox.cookie';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const ua = () => getConfig().robloxUA || UA;
const cookieHeader = (raw) => `.ROBLOSECURITY=${String(raw || '').trim()}`;

// 3-20 car., lettres/chiffres/underscore ; un seul « _ » non consécutif, ni au bord.
// Sans lookbehind (`(?<!_)`) : certains moteurs Hermes anciens ne le supportent pas.
// On interdit le « _ » final via un lookahead négatif `(?!.*_$)`.
export function validName(name) {
  return /^(?!_)(?!.*__)(?!.*_$)[A-Za-z0-9_]{3,20}$/.test(String(name || ''));
}

async function whoamiWith(cookie) {
  const res = await fetchT('https://users.roblox.com/v1/users/authenticated', {
    headers: { cookie: cookieHeader(cookie), 'user-agent': ua() }, timeout: 8000,
  });
  const txt = await res.text().catch(() => '');
  if (res.status === 200) { const u = JSON.parse(txt); return { id: u.id, name: u.name, displayName: u.displayName }; }
  if (res.status === 401) throw new Error('Cookie .ROBLOSECURITY invalide/expiré (401).');
  throw new Error(`/users/authenticated a répondu ${res.status}`);
}

// Colle ton cookie .ROBLOSECURITY. Validé avant stockage.
export async function setToken(raw) {
  const cookie = String(raw || '').trim();
  if (!cookie) throw new Error('Cookie .ROBLOSECURITY vide.');
  const profile = await whoamiWith(cookie);
  await secureSet(KEY, { cookie, profile });
  return profile;
}
export async function logout() { await secureDelete(KEY); }
export async function whoami() {
  const s = await secureGet(KEY);
  return s?.profile ? { name: s.profile.name || s.profile.displayName, id: s.profile.id } : null;
}
async function cookie() { const s = await secureGet(KEY); return s?.cookie || null; }

// Dispo via /usernames/validate : code 0 = libre, 1 = pris, 2 = inapproprié.
export async function validateName(name) {
  const ck = await cookie();
  const qs = `request.username=${encodeURIComponent(name)}&request.birthday=2000-01-01&request.context=UsernameChange`;
  const headers = { 'user-agent': ua() };
  if (ck) headers.cookie = cookieHeader(ck);
  const res = await fetchT(`https://auth.roblox.com/v1/usernames/validate?${qs}`, { headers, timeout: 8000 });
  if (res.status === 429) { await res.text(); return { free: null, rateLimited: true, note: 'rate-limité' }; }
  const txt = await res.text().catch(() => '');
  if (res.status !== 200) return { free: null, note: `statut ${res.status}` };
  let data = null; try { data = JSON.parse(txt); } catch { /* */ }
  return { free: data?.code === 0, note: data?.code === 2 ? (data?.message || 'inapproprié') : null };
}

// Jeton anti-CSRF : un POST sans jeton renvoie 403 + x-csrf-token (sans déconnecter).
async function getCsrf(ck) {
  const res = await fetchT('https://auth.roblox.com/v1/logout', {
    method: 'POST', headers: { cookie: cookieHeader(ck), 'user-agent': ua() }, timeout: 8000,
  });
  await res.text().catch(() => {});
  return res.headers.get('x-csrf-token');
}

// POST /v1/username { username, password }. Retente une fois si le CSRF a tourné (403).
async function changeUsername(name, ck, csrf, password) {
  const doPost = async (tok) => fetchT('https://accountsettings.roblox.com/v1/username', {
    method: 'POST',
    headers: { cookie: cookieHeader(ck), 'x-csrf-token': tok, 'content-type': 'application/json', 'user-agent': ua() },
    body: JSON.stringify({ username: name, password }),
    timeout: 8000,
  });
  let res = await doPost(csrf);
  if (res.status === 403) {
    const newCsrf = res.headers.get('x-csrf-token');
    await res.text().catch(() => {});
    if (newCsrf && newCsrf !== csrf) res = await doPost(newCsrf);
  }
  const txt = await res.text().catch(() => '');
  if (res.status === 200) return { ok: true };
  let data = null; try { data = JSON.parse(txt); } catch { /* */ }
  const msg = Array.isArray(data?.errors) ? data.errors.map((e) => e.message).filter(Boolean).join(' ; ') : `HTTP ${res.status}`;
  return { ok: false, reason: msg };
}

// opts : { name, password, dropAt, monitor, leadMs, offset, shouldStop }
export async function snipe(opts) {
  const { name, password, dropAt, monitor = false, leadMs = 40, offset = 0, shouldStop } = opts;
  const ck = await cookie();
  if (!ck) throw new Error('Connecte-toi (cookie .ROBLOSECURITY).');
  if (!password) throw new Error('Entre ton mot de passe Roblox (requis, jamais stocké).');

  const attempt = async () => {
    const csrf = await getCsrf(ck);
    const r = await changeUsername(name, ck, csrf, password);
    if (r.ok) { log.ok(`🎯 pseudo « ${name} » posé ! (1000 Robux débités)`); return { success: true }; }
    log.warn(`Renommage refusé : ${r.reason}`);
    return { success: false, reason: r.reason };
  };

  if (monitor) {
    log.step(`Surveillance de ${name} (Roblox)`);
    let polls = 0;
    while (!(shouldStop && shouldStop())) {
      polls++;
      const st = await validateName(name);
      if (st.free) { log.ok(`${name} LIBRE — tentative de renommage !`); const r = await attempt(); if (r.success) return r; await sleep(2000); }
      if (polls % 20 === 0) log.info(`...toujours pris (${polls} sondages)`);
      await sleep(1500);
    }
    log.warn('Surveillance arrêtée.');
    return { success: false, stopped: true };
  }
  if (!dropAt) throw new Error('Mode planifié : renseigne la date/heure du drop.');
  log.step(`Snipe planifié de ${name} (Roblox)`);
  await sleepUntil((dropAt - leadMs) - offset, 15);
  return attempt();
}

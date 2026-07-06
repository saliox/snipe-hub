// Authentification X (Twitter) par identifiants de session : cookie `auth_token`
// + jeton anti-CSRF `ct0` (récupérés dans les cookies de x.com via les DevTools).
//  - Stocke les identifiants chiffrés au repos (securebox).
//  - Valide via 1.1/account/verify_credentials.json (screen_name + id).
//
// ⚠️ L'API de X est très verrouillée depuis 2023 : ces endpoints peuvent changer
// ou exiger d'autres en-têtes. Endpoint de renommage marqué « à confirmer » (cf. x.js).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { log } from './util.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(__dirname, '..', 'data'); }
function credFile() { return path.join(dataDir(), 'x.enc'); }

// Bearer public du client web de X (identique pour tous les navigateurs).
export const WEB_BEARER = process.env.X_BEARER
  || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
export const UA = process.env.X_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// Extrait auth_token + ct0 d'un collage libre (chaîne de cookies, ou "auth_token; ct0").
export function parseCreds(raw) {
  const s = String(raw || '');
  const at = (s.match(/auth_token=([0-9a-f]+)/i) || [])[1] || (s.match(/^\s*([0-9a-f]{30,})\s*$/i) || [])[1] || null;
  const ct0 = (s.match(/ct0=([0-9a-f]+)/i) || [])[1] || null;
  return { auth_token: at, ct0 };
}

// En-têtes authentifiés pour l'API X.
export function headers(cred, extra = {}) {
  return {
    authorization: `Bearer ${WEB_BEARER}`,
    cookie: `auth_token=${cred.auth_token}; ct0=${cred.ct0}`,
    'x-csrf-token': cred.ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'user-agent': UA,
    ...extra,
  };
}

function stored() { return loadEncrypted(credFile()); }
export function cachedProfile() { const s = stored(); return s?.profile || null; }
export function loadCreds() { const s = stored(); return (s && s.auth_token && s.ct0) ? { auth_token: s.auth_token, ct0: s.ct0 } : null; }
export function clearCreds() {
  try { fs.rmSync(credFile(), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(credFile() + '.salt', { force: true }); } catch { /* ignore */ }
}

// Valide les identifiants et renvoie { screen_name, id }. Lève si invalides.
export async function verify(cred) {
  const { statusCode, body } = await request('https://api.twitter.com/1.1/account/verify_credentials.json', {
    method: 'GET', headers: headers(cred),
  });
  const txt = await body.text().catch(() => '');
  if (statusCode === 200) { const u = JSON.parse(txt); return { screen_name: u.screen_name, id: u.id_str || String(u.id) }; }
  if (statusCode === 401 || statusCode === 403) throw new Error('Identifiants X invalides/expirés (auth_token ou ct0).');
  throw new Error(`verify_credentials a répondu ${statusCode} ${txt.slice(0, 120)}`);
}

export async function whoami() {
  const cred = loadCreds();
  if (!cred) return null;
  try { return await verify(cred); } catch { return null; }
}

// Enregistre les identifiants APRÈS validation. Renvoie le profil { screen_name, id }.
export async function storeCreds(raw) {
  const cred = parseCreds(raw);
  if (!cred.auth_token) throw new Error('auth_token introuvable — colle tes cookies x.com (auth_token=…; ct0=…).');
  if (!cred.ct0) throw new Error('ct0 introuvable — colle AUSSI le cookie ct0 (jeton anti-CSRF).');
  const profile = await verify(cred);   // valide avant d'enregistrer
  saveEncrypted(credFile(), { ...cred, profile, savedAt: Date.now() });
  return profile;
}

export function logout() { clearCreds(); log.ok('Déconnecté de X (identifiants effacés).'); }

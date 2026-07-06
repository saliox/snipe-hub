// Authentification Twitch par jeton OAuth (le « auth-token » de ta session twitch.tv).
//  - Stocke le jeton chiffré au repos (securebox).
//  - Valide via l'endpoint OFFICIEL id.twitch.tv/oauth2/validate (login + user_id).
// Le Client-ID web public est utilisé pour les appels GQL (gql.twitch.tv).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { log } from './util.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(__dirname, '..', 'data'); }
function tokenFile() { return path.join(dataDir(), 'twitch.enc'); }

// Client-ID web public de Twitch (identique pour tous les navigateurs).
export const WEB_CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const UA = process.env.TWITCH_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// Le jeton peut être collé avec ou sans le préfixe « OAuth ».
export function cleanToken(raw) { return String(raw || '').replace(/^OAuth\s+/i, '').trim(); }

function stored() { return loadEncrypted(tokenFile()); }
export function cachedProfile() { const s = stored(); return s?.profile || null; }
export function loadToken() { const s = stored(); return s?.token || null; }
export function clearToken() {
  try { fs.rmSync(tokenFile(), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tokenFile() + '.salt', { force: true }); } catch { /* ignore */ }
}

// Valide un jeton et renvoie { login, id }. Lève si invalide/expiré.
export async function validate(token) {
  const t = cleanToken(token);
  const { statusCode, body } = await request('https://id.twitch.tv/oauth2/validate', {
    method: 'GET',
    headers: { authorization: `OAuth ${t}`, 'user-agent': UA },
  });
  const txt = await body.text().catch(() => '');
  if (statusCode === 200) { const d = JSON.parse(txt); return { login: d.login, id: d.user_id, clientId: d.client_id, scopes: d.scopes }; }
  if (statusCode === 401) throw new Error('Jeton OAuth Twitch invalide ou expiré (401).');
  throw new Error(`/oauth2/validate a répondu ${statusCode} ${txt.slice(0, 120)}`);
}

export async function whoami() {
  const token = loadToken();
  if (!token) return null;
  try { return await validate(token); } catch { return null; }
}

// Enregistre le jeton APRÈS validation. Renvoie le profil public { login, id }.
export async function storeToken(raw) {
  const token = cleanToken(raw);
  if (!token) throw new Error('Jeton OAuth Twitch vide.');
  const profile = await validate(token);   // valide avant d'enregistrer
  saveEncrypted(tokenFile(), { token, profile, savedAt: Date.now() });
  return profile;
}

export function logout() { clearToken(); log.ok('Déconnecté de Twitch (jeton effacé).'); }

// Authentification Roblox par cookie .ROBLOSECURITY.
//  - Stocke le cookie chiffré au repos (securebox).
//  - Fournit l'en-tête Cookie + le jeton anti-CSRF (X-CSRF-TOKEN) requis pour
//    toute écriture (changement de pseudo). Le jeton tourne : on le rafraîchit
//    à la demande via le POST logout (403 renvoie le jeton, SANS déconnecter).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { log } from './util.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Partage SNIPE_DATA_DIR (fichier distinct 'roblox.enc' → aucune collision mc/ftn).
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(__dirname, '..', 'data'); }
function cookieFile() { return path.join(dataDir(), 'roblox.enc'); }

export const UA = process.env.ROBLOX_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// Le cookie doit être envoyé tel quel (il contient le préfixe _|WARNING…|_).
export function cookieHeader(raw) {
  const v = String(raw || '').trim();
  return `.ROBLOSECURITY=${v}`;
}

function stored() { return loadEncrypted(cookieFile()); }
export function cachedProfile() { const s = stored(); return s?.profile || null; }
export function loadCookie() { const s = stored(); return s?.cookie || null; }
export function clearCookie() {
  try { fs.rmSync(cookieFile(), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(cookieFile() + '.salt', { force: true }); } catch { /* ignore */ }
}

// Valide un cookie et renvoie le profil { id, name, displayName }. Lève si invalide.
export async function whoamiWith(cookie) {
  const { statusCode, body } = await request('https://users.roblox.com/v1/users/authenticated', {
    method: 'GET',
    headers: { cookie: cookieHeader(cookie), 'user-agent': UA },
  });
  const txt = await body.text().catch(() => '');
  if (statusCode === 200) { const u = JSON.parse(txt); return { id: u.id, name: u.name, displayName: u.displayName }; }
  if (statusCode === 401) throw new Error('Cookie .ROBLOSECURITY invalide ou expiré (401).');
  throw new Error(`/users/authenticated a répondu ${statusCode} ${txt.slice(0, 120)}`);
}

// Profil du compte connecté (cookie enregistré).
export async function whoami() {
  const cookie = loadCookie();
  if (!cookie) return null;
  try { return await whoamiWith(cookie); } catch { return null; }
}

// Enregistre le cookie APRÈS validation (whoami). Renvoie le profil public.
export async function storeCookie(raw) {
  const cookie = String(raw || '').trim();
  if (!cookie) throw new Error('Cookie .ROBLOSECURITY vide.');
  const profile = await whoamiWith(cookie);   // valide avant d'enregistrer
  saveEncrypted(cookieFile(), { cookie, profile, savedAt: Date.now() });
  return profile;
}

// Récupère un jeton anti-CSRF. POST logout SANS jeton → 403 + header x-csrf-token,
// et Roblox ne déconnecte pas (la validation CSRF échoue avant le traitement).
export async function fetchCsrf(cookie) {
  const { statusCode, headers, body } = await request('https://auth.roblox.com/v2/logout', {
    method: 'POST',
    headers: { cookie: cookieHeader(cookie), 'user-agent': UA, 'content-length': '0' },
  });
  await body.dump().catch(() => {});
  const token = headers['x-csrf-token'];
  if (!token) throw new Error(`Impossible d'obtenir le jeton CSRF (statut ${statusCode}).`);
  return Array.isArray(token) ? token[0] : token;
}

// Cookie enregistré + jeton CSRF frais, prêts à écrire. Lève si non connecté.
export async function getSession() {
  const cookie = loadCookie();
  if (!cookie) throw new Error('Non connecté. Enregistre ton cookie .ROBLOSECURITY.');
  const csrf = await fetchCsrf(cookie);
  return { cookie, csrf };
}

export function logout() { clearCookie(); log.ok('Déconnecté de Roblox (cookie effacé).'); }

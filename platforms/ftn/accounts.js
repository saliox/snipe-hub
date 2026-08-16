// Gestionnaire de comptes Epic (mono OU multi-comptes). Source de vérité unique
// pour l'identité de l'app. Stocke les refresh tokens chiffrés au repos
// (securebox) et fournit des access tokens FRAIS à la demande (refresh auto).
//
// Store (accounts.enc) : { activeId, accounts: [{ id, label, accountId,
//   displayName, refreshToken, accessToken, expiresAt, addedAt }] }.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log, c } from './util.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';
import { exchangeAuthCode, refreshTokens, cacheFromToken, authCodeUrl } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(__dirname, '..', 'data'); }
function storeFile() { return path.join(dataDir(), 'accounts.enc'); }
// ⚠️ Dans le hub, SNIPE_DATA_DIR est PARTAGÉ avec le moteur Minecraft, qui écrit son
// propre `token.enc` au même endroit. Cet ancien chemin (hérité du CLI snipe-ftn
// autonome, qui avait son dossier à lui) désignait donc le coffre de MC. La migration
// ne se déclenchait pas — les clés de dérivation diffèrent, le déchiffrement échoue —
// mais la ligne 35 aurait SUPPRIMÉ le token Minecraft si elle avait abouti.
// On vise désormais un nom propre à Epic, et la suppression ne peut plus toucher MC.
function legacyTokenFile() { return path.join(dataDir(), 'ftn-token.enc'); }

function loadStore() {
  const s = loadEncrypted(storeFile());
  if (s && Array.isArray(s.accounts)) return s;
  // Migration : ancien token.enc mono-compte -> store multi.
  const legacy = loadEncrypted(legacyTokenFile());
  if (legacy && legacy.refreshToken) {
    const acc = mkAccount({
      accountId: legacy.accountId,
      displayName: legacy.displayName || null,
      refreshToken: legacy.refreshToken,
      accessToken: legacy.accessToken || null,
      expiresAt: legacy.expiresAt || 0,
    }, legacy.displayName || 'Compte 1');
    const store = { activeId: acc.id, accounts: [acc] };
    saveStore(store);
    try { fs.rmSync(legacyTokenFile(), { force: true }); } catch { /* ignore */ }
    return store;
  }
  return { activeId: null, accounts: [] };
}
function saveStore(s) { saveEncrypted(storeFile(), s); }

function mkAccount(info, label) {
  return {
    id: crypto.randomUUID(),
    label: (label || '').trim() || info.displayName || info.accountId,
    accountId: info.accountId,
    displayName: info.displayName || null,
    refreshToken: info.refreshToken,
    accessToken: info.accessToken || null,
    expiresAt: info.expiresAt || 0,
    addedAt: Date.now(),
  };
}

function publicAccount(a) {
  return a ? { id: a.id, label: a.label, accountId: a.accountId, displayName: a.displayName } : null;
}

// Ajoute (ou met à jour, par accountId) un compte depuis un authorizationCode.
// Le rend actif. Renvoie le compte (public, sans token).
export async function addAccountFromCode(code, label) {
  const clean = String(code || '').trim().replace(/^"|"$/g, '');
  if (!clean) throw new Error('authorizationCode vide.');
  const info = cacheFromToken(await exchangeAuthCode(clean));
  const store = loadStore();
  let acc = store.accounts.find((a) => a.accountId === info.accountId);
  if (acc) {
    acc.refreshToken = info.refreshToken;
    acc.accessToken = info.accessToken;
    acc.expiresAt = info.expiresAt;
    if (info.displayName) acc.displayName = info.displayName;
    if (label) acc.label = label.trim();
  } else {
    acc = mkAccount(info, label);
    store.accounts.push(acc);
  }
  store.activeId = acc.id;
  saveStore(store);
  return publicAccount(acc);
}

// Login interactif (compat CLI/GUI). getCode() renvoie l'authorizationCode collé.
export async function loginInteractive(getCode, label) {
  log.step('Connexion Epic Games');
  console.log(
    `\n  1. Connecte-toi sur ${c.cyan}https://www.epicgames.com${c.reset} (dans ton navigateur).\n` +
    `  2. Ouvre cette URL :\n     ${c.cyan}${authCodeUrl()}${c.reset}\n` +
    `  3. Copie la valeur de ${c.yellow}"authorizationCode"${c.reset} affichée en JSON.\n`
  );
  const acc = await addAccountFromCode(await getCode(), label);
  log.ok(`Connecté en tant que ${c.green}${acc.displayName || acc.accountId}${c.reset} (${acc.accountId})`);
  return acc;
}

// Liste (sans tokens) pour l'UI / le CLI.
export function listAccounts() {
  const s = loadStore();
  return {
    activeId: s.activeId,
    accounts: s.accounts.map((a) => ({ ...publicAccount(a), active: a.id === s.activeId })),
  };
}

// Compte actif en cache (sans réseau).
export function cachedAccount() {
  const s = loadStore();
  const a = s.accounts.find((x) => x.id === s.activeId) || s.accounts[0];
  return a ? { accountId: a.accountId, displayName: a.displayName } : null;
}

export function removeAccount(id) {
  const s = loadStore();
  s.accounts = s.accounts.filter((a) => a.id !== id);
  if (s.activeId === id) s.activeId = s.accounts[0]?.id || null;
  saveStore(s);
  return listAccounts();
}

export function setActive(id) {
  const s = loadStore();
  if (!s.accounts.find((a) => a.id === id)) throw new Error('Compte introuvable.');
  s.activeId = id;
  saveStore(s);
  return listAccounts();
}

// Refresh EN VOL par compte. Epic invalide un refresh token dès qu'il est consommé :
// deux rafraîchissements concurrents sur le même compte échangent le MÊME token, le
// second reçoit un refus, et le compte devient irrécupérable (reconnexion manuelle).
// Le cas arrivait facilement : le balayage de watchlist, un check et un snipe peuvent
// appeler getValidToken() en même temps, et chacun relit le store depuis le disque.
const refreshInFlight = new Map(); // accountId (interne) -> Promise en cours

/**
 * Déduplique les opérations concurrentes portant la même clé : le premier appelant
 * lance le travail, les suivants attendent le MÊME résultat. Exporté pour les tests.
 * @internal
 */
export function _dedupe(key, fn) {
  const pending = refreshInFlight.get(key);
  if (pending) return pending;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => { refreshInFlight.delete(key); });
  refreshInFlight.set(key, p);
  return p;
}

// Écrit les champs de jeton d'UN compte sans écraser le reste du store.
// saveStore(store) réécrivait un instantané chargé AVANT le refresh : toute
// modification concurrente (ajout de compte, changement d'actif) était perdue.
function persistAccount(acc) {
  const fresh = loadStore();
  const i = fresh.accounts.findIndex((a) => a.id === acc.id);
  if (i >= 0) {
    fresh.accounts[i] = {
      ...fresh.accounts[i],
      accessToken: acc.accessToken,
      expiresAt: acc.expiresAt,
      refreshToken: acc.refreshToken,
      displayName: acc.displayName,
    };
  } else {
    fresh.accounts.push(acc);
  }
  saveStore(fresh);
}

// Rafraîchit (si nécessaire) et renvoie un access token frais pour un compte.
async function freshFor(store, acc) {
  if (acc.accessToken && acc.expiresAt && Date.now() < acc.expiresAt) {
    return { accessToken: acc.accessToken, accountId: acc.accountId, displayName: acc.displayName };
  }
  if (!acc.refreshToken) throw new Error(`Compte "${acc.label}" : refresh indisponible, reconnecte-le.`);
  return _dedupe(acc.id, async () => {
    const info = cacheFromToken(await refreshTokens(acc.refreshToken));
    acc.accessToken = info.accessToken;
    acc.expiresAt = info.expiresAt;
    if (info.refreshToken) acc.refreshToken = info.refreshToken;
    if (info.displayName) acc.displayName = info.displayName;
    persistAccount(acc);
    return { accessToken: acc.accessToken, accountId: acc.accountId, displayName: acc.displayName };
  });
}

// Token frais du compte ACTIF (compat getValidToken de l'ancienne auth.js).
export async function getValidToken() {
  const store = loadStore();
  const acc = store.accounts.find((a) => a.id === store.activeId) || store.accounts[0];
  if (!acc) throw new Error('Non connecté. Lance : node src/index.js login');
  return freshFor(store, acc);
}

// Tokens frais de TOUS les comptes (snipe multi-comptes). Ignore les comptes
// dont le refresh échoue. Renvoie [{ id, label, accountId, displayName, accessToken }].
export async function allFreshTokens() {
  const store = loadStore();
  const out = await Promise.all(store.accounts.map(async (a) => {
    try { return { id: a.id, label: a.label, ...(await freshFor(store, a)) }; }
    catch (e) { log.warn(`Compte "${a.label}" ignoré : ${e.message}`); return null; }
  }));
  return out.filter(Boolean);
}

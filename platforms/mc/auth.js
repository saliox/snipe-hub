// Authentification Microsoft -> Xbox Live -> XSTS -> Minecraft.
// Utilise le "device code flow" (aucun serveur de redirection nécessaire).
//
// Il faut un client_id d'application Azure AD (public client activé, scope
// XboxLive.signin). Renseigne MS_CLIENT_ID dans .env. Si login_with_xbox
// renvoie 403 "Invalid app registration", l'app doit être approuvée via
// https://aka.ms/mce-reviewappid (même piège que côté launcher).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, sleep, c } from './util.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dossier de données : userData (GUI, défini par main.js) sinon data/ du projet
// (CLI). Résolu à l'usage pour que main.js puisse définir SNIPE_DATA_DIR d'abord.
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(__dirname, '..', 'data'); }
function tokenFile() { return path.join(dataDir(), 'token.enc'); }
function legacyFile() { return path.join(__dirname, '..', 'data', 'token.json'); }

const TENANT = 'consumers';
const DEVICECODE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const SCOPE = 'XboxLive.signin offline_access';

function clientId() {
  const id = process.env.MS_CLIENT_ID;
  if (!id) {
    throw new Error(
      'MS_CLIENT_ID manquant. Crée une app Azure AD (public client, scope XboxLive.signin) ' +
      'et renseigne MS_CLIENT_ID dans .env. Voir README.'
    );
  }
  return id;
}

function saveCache(obj) {
  saveEncrypted(tokenFile(), obj); // chiffré au repos
}

function loadCache() {
  const enc = loadEncrypted(tokenFile());
  if (enc) return enc;
  // Migration : ancien cache en clair -> ré-enregistré chiffré, puis supprimé.
  try {
    const old = JSON.parse(fs.readFileSync(legacyFile(), 'utf8'));
    if (old && (old.msRefreshToken || old.accessToken)) {
      saveEncrypted(tokenFile(), old);
      fs.rmSync(legacyFile(), { force: true });
      return old;
    }
  } catch { /* pas d'ancien cache */ }
  return null;
}

// --- Étape 1 : device code flow Microsoft ---
async function requestDeviceCode() {
  const res = await fetch(DEVICECODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`devicecode ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pollForToken(deviceCode, interval) {
  while (true) {
    await sleep(interval * 1000);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId(),
        device_code: deviceCode,
      }),
    });
    const data = await res.json();
    if (res.ok) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5; continue; }
    throw new Error(`token: ${data.error} ${data.error_description || ''}`);
  }
}

async function refreshMsToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId(),
      refresh_token: refreshToken,
      scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`refresh ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Étape 2 : Xbox Live ---
async function xblAuth(msAccessToken) {
  const res = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  });
  if (!res.ok) throw new Error(`XBL ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
}

// --- Étape 3 : XSTS ---
async function xstsAuth(xblToken) {
  const res = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
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

// --- Étape 4 : Minecraft services ---
async function minecraftLogin(uhs, xstsToken) {
  const res = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` }),
  });
  if (res.status === 403) {
    throw new Error(
      'login_with_xbox 403 "Invalid app registration". L\'app Azure doit être ' +
      'approuvée pour Minecraft : https://aka.ms/mce-reviewappid'
    );
  }
  if (!res.ok) throw new Error(`login_with_xbox ${res.status}: ${await res.text()}`);
  return res.json(); // { access_token, expires_in, ... }
}

async function fetchProfile(mcAccessToken) {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { authorization: `Bearer ${mcAccessToken}` },
  });
  if (res.status === 404) return null; // compte sans profil Java (pas encore acheté)
  if (!res.ok) throw new Error(`profile ${res.status}: ${await res.text()}`);
  return res.json();
}

// Convertit un MS access_token en token Minecraft complet (+ profil).
async function msToMinecraft(msAccessToken) {
  const xbl = await xblAuth(msAccessToken);
  const xsts = await xstsAuth(xbl.token);
  const mc = await minecraftLogin(xsts.uhs, xsts.token);
  const profile = await fetchProfile(mc.access_token);
  return {
    accessToken: mc.access_token,
    expiresAt: Date.now() + (mc.expires_in - 60) * 1000,
    profile,
  };
}

// Flux interactif complet (à lancer une fois).
// onPrompt({ verificationUri, userCode }) est appelé pour afficher le code
// (console en CLI, fenêtre en GUI).
export async function loginInteractive(onPrompt) {
  log.step('Connexion Microsoft (device code)');
  const dc = await requestDeviceCode();
  if (onPrompt) onPrompt({ verificationUri: dc.verification_uri, userCode: dc.user_code });
  console.log(
    `\n  Ouvre ${c.cyan}${dc.verification_uri}${c.reset} et saisis le code : ` +
    `${c.yellow}${dc.user_code}${c.reset}\n`
  );
  log.info('En attente de validation...');
  const msTok = await pollForToken(dc.device_code, dc.interval || 5);

  log.step('Chaîne Xbox Live -> Minecraft');
  const mc = await msToMinecraft(msTok.access_token);

  saveCache({
    msRefreshToken: msTok.refresh_token,
    accessToken: mc.accessToken,
    expiresAt: mc.expiresAt,
    profile: mc.profile,
  });

  if (mc.profile) {
    log.ok(`Connecté en tant que ${c.green}${mc.profile.name}${c.reset} (${mc.profile.id})`);
  } else {
    log.warn('Compte connecté mais AUCUN profil Java détecté (Minecraft non acheté sur ce compte).');
  }
  return mc;
}

// Renvoie un token Minecraft valide, en rafraîchissant silencieusement si besoin.
export async function getValidToken() {
  const cache = loadCache();
  if (!cache) throw new Error('Non connecté. Lance : node src/index.js login');

  if (cache.accessToken && cache.expiresAt && Date.now() < cache.expiresAt) {
    return { accessToken: cache.accessToken, profile: cache.profile };
  }

  if (!cache.msRefreshToken) throw new Error('Token expiré, refresh indisponible. Relance login.');
  log.info('Token Minecraft expiré, rafraîchissement...');
  const msTok = await refreshMsToken(cache.msRefreshToken);
  const mc = await msToMinecraft(msTok.access_token);
  saveCache({
    msRefreshToken: msTok.refresh_token || cache.msRefreshToken,
    accessToken: mc.accessToken,
    expiresAt: mc.expiresAt,
    profile: mc.profile,
  });
  return { accessToken: mc.accessToken, profile: mc.profile };
}

export function cachedProfile() {
  return loadCache()?.profile || null;
}

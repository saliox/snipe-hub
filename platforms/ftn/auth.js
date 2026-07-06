// Authentification Epic Games — PROTOCOLE OAuth uniquement (échange de code,
// refresh, vérif). Le STOCKAGE des comptes (mono ou multi) est géré par
// accounts.js, qui s'appuie sur les fonctions exportées ici.
//
// Flux : l'utilisateur se connecte sur epicgames.com, ouvre authCodeUrl(),
// copie "authorizationCode", et on l'échange contre access + refresh token.
//
// ⚠️ CGU : cet échange s'appuie sur les identifiants d'un client de JEU Epic
// (Basic auth ci-dessous), zone grise comme la plupart des outils Fortnite.
// Configurable via .env : EPIC_CLIENT_ID / EPIC_CLIENT_SECRET
// (défaut = fortniteIOSGameClient).

const ACCOUNT_HOST = 'https://account-public-service-prod.ol.epicgames.com';
const TOKEN_URL = `${ACCOUNT_HOST}/account/api/oauth/token`;
const VERIFY_URL = `${ACCOUNT_HOST}/account/api/oauth/verify`;

function clientId() { return process.env.EPIC_CLIENT_ID || '3446cd72694c4a4485d81b77adbb2141'; }
function clientSecret() { return process.env.EPIC_CLIENT_SECRET || '9209d4a5e25a457fb9b07489d313b41a'; }
function basicAuth() {
  return 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
}

// URL à ouvrir (connecté sur epicgames.com) pour obtenir un authorizationCode.
export function authCodeUrl() {
  return `https://www.epicgames.com/id/api/redirect?clientId=${clientId()}&responseType=code`;
}

// Échange authorization_code -> tokens.
export async function exchangeAuthCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, token_type: 'eg1' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`oauth/token ${res.status}: ${data.errorMessage || data.error_description || JSON.stringify(data)}`);
  }
  return data;
}

// Rafraîchit les tokens depuis un refresh_token.
export async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, token_type: 'eg1' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`refresh ${res.status}: ${data.errorMessage || data.error_description || JSON.stringify(data)}`);
  return data;
}

// Normalise une réponse oauth en objet exploitable par accounts.js.
export function cacheFromToken(data) {
  // expires_at fourni par Epic (ISO) ; on garde une marge de 60s.
  const expiresAt = data.expires_at
    ? Date.parse(data.expires_at) - 60_000
    : Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    accountId: data.account_id,
    displayName: data.displayName || null,
  };
}

// Valide un token en interrogeant oauth/verify. Renvoie les infos de session.
export async function verifyToken(accessToken) {
  const res = await fetch(VERIFY_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`verify ${res.status}`);
  return res.json();
}

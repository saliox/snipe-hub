// Vérifications et actions sur les pseudos (display names) Epic Games.
// Toutes authentifiées par un token du service de compte Epic (auth.js).
import { request } from 'undici';

const HOST = 'https://account-public-service-prod.ol.epicgames.com';

// --- Disponibilité d'un display name ---
// GET /account/api/public/account/displayName/{name}
//   200 -> PRIS (renvoie { id, displayName, ... })
//   404 -> LIBRE
//   429 -> rate limit
// dispatcher optionnel : Pool/proxy undici pour rester sur des sockets chauds.
export async function displayNameStatus(name, accessToken, dispatcher = null) {
  const opts = {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
    headersTimeout: 8000,
    bodyTimeout: 8000,
  };
  if (dispatcher) opts.dispatcher = dispatcher;
  const { statusCode, headers, body } = await request(
    `${HOST}/account/api/public/account/displayName/${encodeURIComponent(name)}`,
    opts
  );
  if (statusCode === 404) { await body.dump(); return { free: true }; }
  if (statusCode === 200) {
    const data = await body.json();
    return { free: false, accountId: data.id, displayName: data.displayName };
  }
  if (statusCode === 429) {
    await body.dump();
    const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : null;
    return { free: null, rateLimited: true, retryAfter };
  }
  await body.dump();
  return { free: null, statusCode };
}

// --- Vérifie / rafraîchit l'identité du token ---
export async function accountFromToken(accessToken) {
  const { statusCode, body } = await request(`${HOST}/account/api/oauth/verify`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (statusCode === 200) {
    const d = await body.json();
    return { accountId: d.account_id, displayName: d.displayName };
  }
  await body.dump();
  if (statusCode === 401) throw new Error('Token invalide ou expiré (401).');
  throw new Error(`verify: HTTP ${statusCode}`);
}

// --- Changement de display name ---
//
// ENDPOINT CONFIRMÉ (FortniteEndpointsDocumentation → AccountService/Account/
// UpdateAccount) :
//   PUT /account/api/public/account/{accountId}   body { "displayName": "..." }
//   Scope requis : `account:public:account UPDATE`. Le displayName NE demande PAS
//   la permission "sensitive" (réservée à email/username/password).
//   Réponse 200 : { accountInfo: { displayName, canUpdateDisplayName,
//   lastDisplayNameChange, numberOfDisplayNameChanges, ... } }.
// Le seul aléa restant : que le token du client de JEU par défaut porte bien ce
// scope pour TON compte (vrai en pratique) — confirmé au 1er changement réel.
//
// Renvoie { ok, status, retryAfter, reason, errorCode }.
export async function changeDisplayName(name, accessToken, accountId) {
  const { statusCode, headers, body } = await request(
    `${HOST}/account/api/public/account/${encodeURIComponent(accountId)}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
      headersTimeout: 8000,
      bodyTimeout: 8000,
    }
  );
  let payload = null;
  try { payload = await body.json(); } catch { await body.dump(); }

  if (statusCode === 200 || statusCode === 204) {
    const applied = payload?.accountInfo?.displayName || name;
    return { ok: true, status: statusCode, name: applied };
  }

  const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : null;
  const errCode = String(payload?.errorCode || '');
  const errMsg = payload?.errorMessage || '';
  const blob = `${errCode} ${errMsg}`.toLowerCase();

  // Mapping basé sur les vrais codes d'erreur Epic (substrings, robuste aux variantes).
  let reason;
  if (/throttl|change_limit|too_many|frequency|cooldown/.test(blob)) {
    reason = 'Cooldown de changement de pseudo actif (2 semaines).';
  } else if (/taken|duplicate|unavailable|already/.test(blob)) {
    reason = 'Nom déjà pris entre-temps.';
  } else if (/validation|invalid|forbidden_name|blacklist|profane/.test(blob)) {
    reason = `Nom refusé (format/mot filtré) : ${errMsg || errCode}`;
  } else {
    const generic = {
      401: 'Token invalide/expiré (401).',
      403: 'Refusé (403) — scope account:public:account UPDATE manquant sur ce token.',
      404: 'Compte introuvable (404).',
      429: `Rate limit (429)${retryAfter ? `, retry-after ${retryAfter}s` : ''}.`,
    };
    reason = generic[statusCode] || errMsg || `HTTP ${statusCode}`;
  }
  return { ok: false, status: statusCode, retryAfter, reason, errorCode: errCode };
}

// Éligibilité au changement de pseudo (cooldown 2 semaines). Lit TON compte :
// GET /account/api/public/account/{accountId} (avec ton token) renvoie les champs
// étendus canUpdateDisplayName / lastDisplayNameChange / numberOfDisplayNameChanges.
// Renvoie { canUpdate, lastChange, availableAt, changes, displayName }.
export async function nameChangeEligibility(accessToken, accountId) {
  const { statusCode, body } = await request(
    `${HOST}/account/api/public/account/${encodeURIComponent(accountId)}`,
    { headers: { authorization: `Bearer ${accessToken}` }, headersTimeout: 8000, bodyTimeout: 8000 }
  );
  if (statusCode !== 200) { await body.dump(); throw new Error(`compte HTTP ${statusCode}`); }
  const d = await body.json();
  const lastChange = d.lastDisplayNameChange ? Date.parse(d.lastDisplayNameChange) : null;
  const COOLDOWN = 14 * 24 * 3600 * 1000;
  // canUpdateDisplayName fait autorité ; sinon on estime via lastChange + 14j.
  const canUpdate = d.canUpdateDisplayName !== undefined
    ? !!d.canUpdateDisplayName
    : (lastChange ? Date.now() >= lastChange + COOLDOWN : true);
  const availableAt = (!canUpdate && lastChange) ? lastChange + COOLDOWN : null;
  return {
    canUpdate,
    lastChange,
    availableAt,
    changes: d.numberOfDisplayNameChanges ?? null,
    displayName: d.displayName || null,
  };
}

// Règles de display name Epic : 3 à 16 caractères. Epic autorise lettres,
// chiffres et quelques symboles ; on reste permissif et on se contente de la
// longueur (le filtre de contenu réel est côté serveur).
export function validName(name) {
  return typeof name === 'string' && name.length >= 3 && name.length <= 16;
}

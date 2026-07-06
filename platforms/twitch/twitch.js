// API Twitch : validation de pseudo (côté client), disponibilité (endpoint public
// d'inscription), et changement de pseudo via GQL.
//
// ⚠️ Le changement de login passe par GraphQL, dont Twitch a RESTREINT la plupart
// des mutations depuis sept. 2022 : la mutation ci-dessous est INDICATIVE (le snipe
// ALERTE dès qu'un login se libère, mais l'auto-renommage peut échouer → capture
// DevTools requise pour le fiabiliser). La DISPONIBILITÉ, elle, utilise Helix Get Users.
import { request } from 'undici';
import { WEB_CLIENT_ID, UA, cleanToken } from './auth.js';

// Twitch : 4-25 caractères, lettres/chiffres/underscore.
export function validName(name) {
  return /^[A-Za-z0-9_]{4,25}$/.test(String(name || ''));
}

// Disponibilité via Helix Get Users (Twitch n'expose PAS d'endpoint public de « dispo » :
// passport/usernames renvoie 404). `data` vide = aucun compte ACTIF avec ce login → candidat
// libre. Nécessite Client-Id + un Bearer (le token de session convient).
// ⚠️ Un login en « hold » (~6 mois après libération) renvoie aussi data vide → signalé libre
// alors qu'il n'est pas encore reprenable : la surveillance peut donc alerter un peu tôt.
export async function checkAvailable(name, token = null, dispatcher = null) {
  const t = cleanToken(token);
  if (!t) return { free: null, status: 401, message: 'Connexion requise (Helix exige un token).' };
  const opts = {
    method: 'GET',
    headers: { 'client-id': WEB_CLIENT_ID, authorization: `Bearer ${t}`, 'user-agent': UA },
  };
  if (dispatcher) opts.dispatcher = dispatcher;
  const { statusCode, headers, body } = await request(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(name)}`, opts);
  const txt = await body.text().catch(() => '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { /* */ }
  if (statusCode === 429) {
    const ra = headers['ratelimit-reset'] ? Number(headers['ratelimit-reset']) : null;
    return { free: null, rateLimited: true, retryAfter: ra, status: 429 };
  }
  if (statusCode !== 200) return { free: null, status: statusCode, message: txt.slice(0, 120) };
  const arr = Array.isArray(data?.data) ? data.data : [];
  return { free: arr.length === 0, status: 200 };
}

// Change le login du compte connecté. ⚠️ mutation à CONFIRMER (voir en-tête).
// Renvoie { ok, status, message } ; message contient les erreurs GQL le cas échéant.
export async function changeUsername(name, { token }) {
  const t = cleanToken(token);
  const payload = {
    operationName: 'UpdateUser',
    variables: { input: { login: name } },
    query: 'mutation UpdateUser($input: UpdateUserInput!){ updateUser(input:$input){ user{ id login } error{ code } } }',
  };
  const { statusCode, body } = await request('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'client-id': WEB_CLIENT_ID, authorization: `OAuth ${t}`, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(payload),
  });
  const txt = await body.text().catch(() => '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { /* */ }
  if (statusCode === 200) {
    const gqlErr = Array.isArray(data?.errors) ? data.errors.map((e) => e.message).join(' ; ') : null;
    const opErr = data?.data?.updateUser?.error?.code || null;
    if (gqlErr) return { ok: false, status: 200, message: `GQL: ${gqlErr} (mutation à confirmer)` };
    if (opErr) return { ok: false, status: 200, message: `Refus Twitch: ${opErr}` };
    if (data?.data?.updateUser?.user?.login) return { ok: true, status: 200 };
    return { ok: false, status: 200, message: 'Réponse GQL inattendue (mutation à confirmer).' };
  }
  return { ok: false, status: statusCode, message: txt.slice(0, 160) };
}

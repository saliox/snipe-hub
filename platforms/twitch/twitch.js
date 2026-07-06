// API Twitch : validation de pseudo (côté client), disponibilité (endpoint public
// d'inscription), et changement de pseudo via GQL.
//
// ⚠️ Le changement de login Twitch est une opération de compte sensible et non
// documentée publiquement : la mutation GQL ci-dessous est FOURNIE À TITRE
// INDICATIF et doit être vérifiée/ajustée sur le flux live (settings/profile).
// La DISPONIBILITÉ, elle, est fiable (endpoint passport officiel d'inscription).
import { request } from 'undici';
import { WEB_CLIENT_ID, UA, cleanToken } from './auth.js';

// Twitch : 4-25 caractères, lettres/chiffres/underscore.
export function validName(name) {
  return /^[A-Za-z0-9_]{4,25}$/.test(String(name || ''));
}

// Disponibilité via l'endpoint d'inscription : 200/204 = libre ; 409/400/422 = pris/invalide.
export async function checkAvailable(name, dispatcher = null) {
  const opts = {
    method: 'GET',
    headers: { 'client-id': WEB_CLIENT_ID, 'user-agent': UA },
  };
  if (dispatcher) opts.dispatcher = dispatcher;
  const { statusCode, headers, body } = await request(`https://passport.twitch.tv/usernames/${encodeURIComponent(name)}`, opts);
  await body.dump().catch(() => {});
  if (statusCode === 200 || statusCode === 204) return { free: true, status: statusCode };
  if (statusCode === 429) {
    const ra = headers['retry-after'] ? Number(headers['retry-after']) : null;
    return { free: null, rateLimited: true, retryAfter: ra, status: 429 };
  }
  if ([400, 409, 422].includes(statusCode)) return { free: false, status: statusCode };
  return { free: null, status: statusCode };
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

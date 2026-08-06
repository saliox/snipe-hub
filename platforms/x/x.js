// API X (Twitter) : validation de @handle (côté client), disponibilité, et
// changement de @handle.
//
// ⚠️ Endpoints X très volatils/verrouillés depuis 2023. La disponibilité
// (username_available.json) et le renommage (account/settings.json) sont FOURNIS
// À TITRE INDICATIF et peuvent nécessiter d'autres en-têtes/flags — à confirmer sur
// le flux live. Le sniper ALERTE toujours quand une fenêtre de dispo est détectée.
import { request } from 'undici';
import { headers, UA, WEB_BEARER } from './auth.js';

// @handle X : 4-15 caractères, lettres/chiffres/underscore.
export function validName(name) {
  return /^[A-Za-z0-9_]{4,15}$/.test(String(name || ''));
}

// Disponibilité via l'endpoint d'inscription. { valid:true } = libre.
export async function checkAvailable(name, cred = null, dispatcher = null) {
  const h = cred
    ? headers(cred)
    : { authorization: `Bearer ${WEB_BEARER}`, 'user-agent': UA };
  const opts = { method: 'GET', headers: h };
  if (dispatcher) opts.dispatcher = dispatcher;
  const { statusCode, headers: rh, body } = await request(
    `https://api.twitter.com/i/users/username_available.json?username=${encodeURIComponent(name)}`, opts);
  const txt = await body.text().catch(() => '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { /* */ }
  if (statusCode === 429) {
    const ra = rh['retry-after'] ? Number(rh['retry-after']) : null;
    return { free: null, rateLimited: true, retryAfter: ra, status: 429 };
  }
  if (statusCode !== 200 || !data) return { free: null, status: statusCode, message: txt.slice(0, 120) };
  // { valid:true } => libre ; { valid:false, reason:'taken'|... } => pris/invalide.
  // Un 200 SANS champ `valid` booléen (charge d'erreur { errors:[...] } ou schéma changé
  // — très plausible vu la volatilité des endpoints X) était conclu « pris » de façon
  // catégorique. On le rapporte désormais comme INDÉTERMINÉ.
  if (typeof data.valid !== 'boolean') {
    return { free: null, status: 200, message: `réponse inattendue : ${txt.slice(0, 120)}` };
  }
  return { free: data.valid === true, status: 200, reason: data.reason, message: data.msg || '' };
}

// Change le @handle du compte connecté. ⚠️ endpoint à CONFIRMER (voir en-tête).
// Renvoie { ok, status, message }.
export async function changeUsername(name, { cred }) {
  const { statusCode, body } = await request('https://api.twitter.com/1.1/account/settings.json', {
    method: 'POST',
    headers: headers(cred, { 'content-type': 'application/x-www-form-urlencoded' }),
    body: `screen_name=${encodeURIComponent(name)}`,
  });
  const txt = await body.text().catch(() => '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { /* */ }
  if (statusCode === 200) {
    if (data && (data.screen_name || '').toLowerCase() === name.toLowerCase()) return { ok: true, status: 200 };
    return { ok: false, status: 200, message: 'Réponse inattendue (endpoint à confirmer).' };
  }
  const errs = Array.isArray(data?.errors) ? data.errors.map((e) => e.message).join(' ; ') : '';
  return { ok: false, status: statusCode, message: errs || txt.slice(0, 160) };
}

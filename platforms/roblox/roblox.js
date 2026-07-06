// API Roblox : validation de pseudo (côté client), disponibilité, et changement
// de pseudo. ⚠️ Le changement de pseudo Roblox exige le MOT DE PASSE du compte et
// coûte 1000 Robux par changement RÉUSSI (un nom déjà pris ne débite rien).
import { request } from 'undici';
import { cookieHeader, UA } from './auth.js';

// Règles Roblox : 3-20 caractères, lettres/chiffres/underscore, un seul underscore
// non consécutif, ni au début ni à la fin.
export function validName(name) {
  return /^(?=.{3,20}$)(?!_)(?!.*__)[A-Za-z0-9_]+(?<!_)$/.test(String(name || ''));
}

// Disponibilité via l'endpoint officiel de validation (contexte changement de pseudo).
// code 0 = valide/libre ; 1 = déjà pris ; 2 = inapproprié/invalide.
export async function validateName(name, cookie = null, dispatcher = null) {
  const qs = new URLSearchParams({
    'request.username': name,
    'request.birthday': '2000-01-01',
    'request.context': 'UsernameChange',
  });
  const headers = { 'user-agent': UA };
  if (cookie) headers.cookie = cookieHeader(cookie);
  const opts = { method: 'GET', headers };
  if (dispatcher) opts.dispatcher = dispatcher;
  const { statusCode, headers: h, body } = await request(`https://auth.roblox.com/v1/usernames/validate?${qs}`, opts);
  const txt = await body.text().catch(() => '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { /* */ }
  if (statusCode === 429) {
    const ra = h['retry-after'] ? Number(h['retry-after']) : null;
    return { free: null, rateLimited: true, retryAfter: ra, status: 429 };
  }
  if (statusCode !== 200) return { free: null, status: statusCode, message: txt.slice(0, 120) };
  return { free: data?.code === 0, code: data?.code, message: data?.message || '' };
}

// Change le pseudo du compte connecté. session = { cookie, csrf, password }.
// Renvoie { ok, status, message?, errors?, newCsrf? } ; newCsrf est fourni si le
// jeton anti-CSRF a tourné (403) → l'appelant réessaie avec ce nouveau jeton.
export async function changeUsername(name, { cookie, csrf, password }) {
  const { statusCode, headers, body } = await request('https://accountsettings.roblox.com/v1/username', {
    method: 'POST',
    headers: {
      cookie: cookieHeader(cookie),
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      'user-agent': UA,
    },
    body: JSON.stringify({ username: name, password }),
  });
  const txt = await body.text().catch(() => '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { /* */ }
  const rawCsrf = headers['x-csrf-token'];
  const newCsrf = rawCsrf ? (Array.isArray(rawCsrf) ? rawCsrf[0] : rawCsrf) : null;
  if (statusCode === 200) return { ok: true, status: 200 };
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const message = errors.map((e) => e.message).filter(Boolean).join(' ; ') || txt.slice(0, 160);
  return { ok: false, status: statusCode, errors, message, newCsrf };
}

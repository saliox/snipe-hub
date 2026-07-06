// Actions authentifiées sur le compte via un token d'accès Minecraft.
// Le token peut venir du login Microsoft (auth.js) ou être collé à la main.
import { request } from 'undici';

const HOST = 'https://api.minecraftservices.com';

// Valide un token en récupérant le profil. Renvoie { id, name } ou lève une erreur.
export async function profileFromToken(token) {
  const { statusCode, body } = await request(`${HOST}/minecraft/profile`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (statusCode === 200) {
    const d = await body.json();
    return { id: d.id, name: d.name };
  }
  await body.dump();
  if (statusCode === 401) throw new Error('Token invalide ou expiré (401).');
  if (statusCode === 404) throw new Error('Ce compte n\'a pas de profil Java Minecraft.');
  throw new Error(`Profil: HTTP ${statusCode}`);
}

// Éligibilité au changement de nom (cooldown 30 jours).
// Renvoie { allowed, changedAt, createdAt, availableAt } (availableAt = null si allowed).
export async function nameChangeInfo(token) {
  const { statusCode, body } = await request(`${HOST}/minecraft/profile/namechange`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (statusCode !== 200) { await body.dump(); throw new Error(`namechange HTTP ${statusCode}`); }
  const d = await body.json();
  const changedAt = d.changedAt ? Date.parse(d.changedAt) : null;
  const COOLDOWN = 30 * 24 * 3600 * 1000;
  const availableAt = (!d.nameChangeAllowed && changedAt) ? changedAt + COOLDOWN : null;
  return { allowed: !!d.nameChangeAllowed, changedAt, createdAt: d.createdAt ? Date.parse(d.createdAt) : null, availableAt };
}

// Change le pseudo du compte lié au token.
// Renvoie { ok, status, reason }.
export async function changeName(name, token) {
  const { statusCode, headers, body } = await request(
    `${HOST}/minecraft/profile/name/${encodeURIComponent(name)}`,
    { method: 'PUT', headers: { authorization: `Bearer ${token}` } }
  );
  let payload = null;
  try { payload = await body.json(); } catch { await body.dump(); }

  if (statusCode === 200) return { ok: true, status: 200, name: payload?.name || name };

  const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : null;
  const reasons = {
    400: 'Nom invalide ou changement impossible.',
    401: 'Token invalide/expiré.',
    403: payload?.details?.status === 'DUPLICATE'
      ? 'Nom déjà pris (DUPLICATE).'
      : payload?.details?.status === 'NOT_ALLOWED'
        ? 'Nom non autorisé (NOT_ALLOWED).'
        : 'Refusé (403) — nom pris, réservé, ou cooldown de 30 jours actif.',
    429: `Rate limit (429)${retryAfter ? `, retry-after ${retryAfter}s` : ''}.`,
  };
  return { ok: false, status: statusCode, retryAfter, reason: reasons[statusCode] || `HTTP ${statusCode}` };
}

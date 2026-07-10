// Vérifications publiques (sans auth) de disponibilité de pseudo.
import { request } from 'undici';

// API Mojang historique : 200 = pris (renvoie le profil), 404 = libre.
// dispatcher optionnel : proxy undici pour répartir les requêtes.
export async function isNameFree(name, dispatcher = null) {
  // Timeouts courts : un proxy gratuit qui traîne échoue vite (au lieu des 300s
  // par défaut) → il est retenté sur un autre proxy.
  const opts = { method: 'GET', headersTimeout: 8000, bodyTimeout: 8000 };
  if (dispatcher) opts.dispatcher = dispatcher;
  const { statusCode, headers, body } = await request(
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
    opts
  );
  if (statusCode === 404) { await body.dump(); return { free: true }; }
  if (statusCode === 200) {
    const data = await body.json();
    return { free: false, uuid: data.id, name: data.name };
  }
  if (statusCode === 429) {
    await body.dump();
    const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : null;
    return { free: null, rateLimited: true, retryAfter };
  }
  await body.dump();
  return { free: null, statusCode };
}

// Disponibilité côté compte connecté : indique aussi NOT_ALLOWED (nom réservé,
// juron filtré, etc.) que l'API publique ne distingue pas.
// Renvoie 'AVAILABLE' | 'DUPLICATE' | 'NOT_ALLOWED'.
export async function nameStatus(name, accessToken) {
  const { statusCode, body } = await request(
    `https://api.minecraftservices.com/minecraft/profile/name/${encodeURIComponent(name)}/available`,
    { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } }
  );
  if (statusCode === 200) {
    const data = await body.json();
    return data.status;
  }
  await body.dump();
  throw new Error(`nameStatus a répondu ${statusCode}`);
}

// Vérifie que le nom respecte les règles Minecraft (3-16 car., [A-Za-z0-9_]).
// Le typeof évite que null/undefined soient coercés en "null"/"undefined",
// qui passeraient la regex comme des pseudos valides.
export function validName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

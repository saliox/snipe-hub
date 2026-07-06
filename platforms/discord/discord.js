// Client de l'API Discord pour le snipe d'URL personnalisée (vanity URL).
//
// Une "vanity URL" (discord.gg/moncode) est un code d'invitation permanent et
// GLOBALEMENT unique. Un serveur ne peut en avoir une que s'il possède le
// feature "VANITY_URL" (niveau de boost 3, ou serveur partenaire/vérifié).
// Quand un serveur perd sa vanity (retombe sous le niveau 3, la change, ou est
// supprimé), le code redevient LIBRE : ce module permet de le vérifier puis de
// le réclamer sur TON PROPRE serveur via l'API officielle.
//
// Aucune action ne touche un serveur tiers : on ne fait que définir la vanity
// de TON serveur (PATCH /guilds/{id}/vanity-url), exactement comme le sniper MC
// ne fait que renommer TON compte.
import { request } from 'undici';

export const API = 'https://discord.com/api/v10';
export const API_PATH = '/api/v10';

// Discord demande un User-Agent. Surchargeable via .env (DISCORD_UA).
export const UA = process.env.DISCORD_UA
  || 'snipe-discord (https://github.com/saliox/snipe-discord, 1.0.0)';

// Bits de permissions Discord.
const CREATE_INSTANT_INVITE = 1n << 0n;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

// Construit l'en-tête Authorization. Les tokens de bot s'utilisent préfixés de
// "Bot ", les tokens utilisateur s'envoient bruts.
export function authHeader(token, type = 'bot') {
  const t = String(token || '').replace(/^Bot\s+/i, '').trim();
  return type === 'user' ? t : `Bot ${t}`;
}

// Un code vanity : 2-32 caractères, minuscules/chiffres/traits d'union.
// Discord met le code en minuscules côté serveur.
export function validVanity(code) {
  return /^[a-z0-9-]{2,32}$/.test(String(code || '').toLowerCase());
}

async function apiGet(path, auth, { dispatcher, timeout = 8000 } = {}) {
  const headers = { 'user-agent': UA };
  if (auth) headers.authorization = auth;
  const opts = { method: 'GET', headers, headersTimeout: timeout, bodyTimeout: timeout };
  if (dispatcher) opts.dispatcher = dispatcher;
  return request(`${API}${path}`, opts);
}

// Valide un token pour un type donné et renvoie le compte (/users/@me).
export async function whoami(token, type = 'bot') {
  const { statusCode, body } = await apiGet('/users/@me', authHeader(token, type));
  if (statusCode === 200) {
    const u = await body.json();
    return { ...u, tokenType: type };
  }
  const txt = await body.text().catch(() => '');
  if (statusCode === 401) throw new Error('Token invalide (401).');
  throw new Error(`/users/@me a répondu ${statusCode} ${txt.slice(0, 160)}`);
}

// Détecte automatiquement si le token est un token de bot ou d'utilisateur.
// On tente bot d'abord (usage recommandé + conforme aux CGU Discord).
export async function resolveToken(rawToken) {
  const token = String(rawToken || '').replace(/^Bot\s+/i, '').trim();
  if (!token) throw new Error('Token vide.');
  let lastErr;
  for (const type of ['bot', 'user']) {
    try {
      const user = await whoami(token, type);
      return { token, type, user };
    } catch (e) {
      lastErr = e;
      if (!/401/.test(e.message)) throw e; // vraie erreur réseau -> on remonte
    }
  }
  throw new Error(`Token non reconnu (ni bot ni utilisateur). ${lastErr?.message || ''}`);
}

// Liste les serveurs du compte (/users/@me/guilds).
export async function listGuilds(token, type = 'bot') {
  const { statusCode, body } = await apiGet('/users/@me/guilds', authHeader(token, type));
  if (statusCode !== 200) {
    const txt = await body.text().catch(() => '');
    throw new Error(`/users/@me/guilds a répondu ${statusCode} ${txt.slice(0, 160)}`);
  }
  return body.json();
}

function permsOf(g) { try { return BigInt(g.permissions); } catch { return 0n; } }
const hasPerm = (p, bit) => (p & bit) === bit;

// Ai-je le droit de gérer ce serveur ?
export function canManageGuild(g) {
  if (g.owner) return true;
  const p = permsOf(g);
  return hasPerm(p, ADMINISTRATOR) || hasPerm(p, MANAGE_GUILD);
}

// Ce serveur peut-il recevoir une vanity ET ai-je les droits pour la poser ?
// Exigences de l'API "Modify Guild Vanity URL" :
//   - feature VANITY_URL (boost niv.3) ou GUILD_WEB_PAGE_VANITY_URL ;
//   - permissions MANAGE_GUILD **ET** CREATE_INSTANT_INVITE (ou Admin/propriétaire).
// ⚠️ Cet endpoint est réservé aux BOTS (inutilisable par un compte utilisateur).
export function canSetVanity(g) {
  const feat = Array.isArray(g.features)
    && (g.features.includes('VANITY_URL') || g.features.includes('GUILD_WEB_PAGE_VANITY_URL'));
  if (!feat) return false;
  if (g.owner) return true;
  const p = permsOf(g);
  if (hasPerm(p, ADMINISTRATOR)) return true;
  return hasPerm(p, MANAGE_GUILD) && hasPerm(p, CREATE_INSTANT_INVITE);
}

// Vanity actuelle d'un serveur (nécessite Manage Guild). { code, uses }.
export async function getVanity(guildId, token, type = 'bot') {
  const { statusCode, body } = await apiGet(`/guilds/${guildId}/vanity-url`, authHeader(token, type));
  if (statusCode === 200) return body.json();
  const txt = await body.text().catch(() => '');
  throw new Error(`vanity-url a répondu ${statusCode} ${txt.slice(0, 160)}`);
}

// Détecte un bannissement Cloudflare (erreur 1015) : réponse HTML au lieu de JSON.
export function isCloudflareBan(status, text) {
  return (status === 429 || status === 403)
    && /error code:\s*1015|<!DOCTYPE html|cf-error|Cloudflare/i.test(String(text || ''));
}

// Disponibilité d'un code, en ANONYME (le token n'est jamais exposé, comme les
// checks publics du sniper MC). 404 = libre, 200 = pris (+ niveau de boost du
// détenteur, pour le prédicteur de drop).
// dispatcher optionnel : proxy undici pour cacher/répartir l'IP.
export async function checkVanityFree(code, { dispatcher, auth } = {}) {
  const { statusCode, headers, body } = await apiGet(
    `/invites/${encodeURIComponent(code)}?with_counts=true`,
    auth || null,
    { dispatcher }
  );
  if (statusCode === 404) { await body.dump(); return { free: true }; }
  const txt = await body.text().catch(() => '');
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { /* HTML Cloudflare */ }

  if (statusCode === 200) {
    const g = data?.guild || {};
    return {
      free: false,
      guild: g.name || null,
      guildId: g.id || null,
      premiumTier: typeof g.premium_tier === 'number' ? g.premium_tier : null,
      boosts: typeof g.premium_subscription_count === 'number' ? g.premium_subscription_count : null,
    };
  }
  if (statusCode === 429 || statusCode === 403) {
    const cf = isCloudflareBan(statusCode, txt);
    const ra = headers['retry-after'] ? Number(headers['retry-after'])
      : (typeof data?.retry_after === 'number' ? data.retry_after : null);
    return { free: null, rateLimited: true, cloudflare: cf, retryAfter: ra, statusCode };
  }
  return { free: null, statusCode };
}

// NB : poser la vanity au moment du drop se fait dans sniper.js (PATCH sur un pool
// de connexions PRÉ-CHAUFFÉES, pour la précision de timing) — pas ici.

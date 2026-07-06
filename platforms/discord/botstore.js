// Flotte de bots (chiffrée) pour la rafale multi-bots : plusieurs tokens de bot,
// tous membres du serveur cible, tirent en parallèle à T0 → chacun a son propre
// quota de rate-limit par route, ce qui multiplie le débit sans se 429 soi-même.
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './paths.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';
import { resolveToken } from './discord.js';

const file = () => path.join(dataDir(), 'bots.enc');

function all() { return loadEncrypted(file()) || []; }
function persist(list) { saveEncrypted(file(), list); }

function tagOf(u) {
  return u.discriminator && u.discriminator !== '0'
    ? `${u.username}#${u.discriminator}`
    : (u.global_name || u.username);
}

// Vue publique (SANS token) pour le renderer.
export function listBots() {
  return all().map((b) => ({ id: b.id, label: b.label, tag: b.tag }));
}

// Ajoute un bot (refuse un token utilisateur : il ne peut pas poser de vanity).
export async function addBot(rawToken, label) {
  const info = await resolveToken(rawToken);
  if (info.type !== 'bot') throw new Error('Seuls les tokens de BOT peuvent tirer (compte utilisateur refusé).');
  const list = all();
  if (list.some((b) => b.userId === info.user.id)) throw new Error('Ce bot est déjà enregistré.');
  const tag = tagOf(info.user);
  const entry = { id: crypto.randomUUID(), label: (label || tag).slice(0, 40), token: info.token, userId: info.user.id, tag };
  list.push(entry);
  persist(list);
  return { id: entry.id, label: entry.label, tag };
}

export function removeBot(id) { persist(all().filter((b) => b.id !== id)); }

// Usage SERVEUR uniquement (jamais renvoyé au renderer) : tokens pour tirer.
export function botAuths() {
  return all().map((b) => ({ id: b.id, label: b.label, token: b.token }));
}

export function count() { return all().length; }

// Registre unifié des plateformes : chaque adaptateur expose la même interface
// pour l'UI (whoami / check / snipe / login…), en routant vers son moteur.
import * as mc from './mc.js';
import * as discord from './discord.js';
import * as ftn from './ftn.js';

export const ADAPTERS = {
  mc: {
    id: 'mc', label: 'Minecraft', emoji: '🟩', color: '#3fb950',
    target: 'pseudo', loginKind: 'device',
    needs: 'Compte Microsoft + MS_CLIENT_ID (app Azure) dans Réglages.',
    validName: mc.validName,
    whoami: mc.whoami, logout: mc.logout,
    async check(name) { const r = await mc.isNameFree(name); return { free: r.free, note: r.rateLimited ? 'rate-limité' : null }; },
    snipe: mc.snipe,
    // Login interactif : device code (voir écran de login).
    engine: mc,
  },
  discord: {
    id: 'discord', label: 'Discord vanity', emoji: '🟣', color: '#8b5cf6',
    target: 'code vanity', loginKind: 'token', needsGuild: true,
    needs: 'Token(s) de BOT (permission « Gérer le serveur ») + serveur boost niv. 3. Plusieurs tokens = plus de débit.',
    validName: discord.validVanity,
    whoami: discord.whoami, logout: discord.logout,
    async check(code) { const r = await discord.checkVanityFree(code); return { free: r.free, note: r.guild ? `pris par « ${r.guild} » (tier ${r.premiumTier})` : (r.rateLimited ? 'rate-limité' : null) }; },
    snipe: discord.snipe,
    engine: discord,
  },
  ftn: {
    id: 'ftn', label: 'Fortnite / Epic', emoji: '🎮', color: '#4f9dff',
    target: 'pseudo', loginKind: 'code',
    needs: 'Compte Epic (authorizationCode). Clique « Obtenir un code » pour ouvrir la page Epic.',
    validName: ftn.validName,
    whoami: ftn.whoami, logout: ftn.logout,
    async check(name) { const r = await ftn.check(name); return { free: r.free, note: r.rateLimited ? 'rate-limité' : null }; },
    snipe: ftn.snipe,
    engine: ftn,
  },
};

export const PLATFORM_ORDER = ['mc', 'discord', 'ftn'];
export function getAdapter(id) { return ADAPTERS[id]; }

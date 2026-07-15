// Registre unifié des plateformes : chaque adaptateur expose la même interface
// pour l'UI (whoami / check / snipe / login…), en routant vers son moteur.
import * as mc from './mc.js';
import * as discord from './discord.js';
import * as ftn from './ftn.js';
import * as twitch from './twitch.js';
import * as x from './x.js';
import * as roblox from './roblox.js';

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
    target: 'pseudo', loginKind: 'code', multiAccount: true,
    needs: 'Compte(s) Epic (authorizationCode). « Obtenir un code » ouvre la page Epic. Tu peux ajouter plusieurs comptes.',
    validName: ftn.validName,
    whoami: ftn.whoami, logout: ftn.logout,
    accountsList: ftn.listAccounts, setActive: ftn.setActive, removeAccount: ftn.removeAccount,
    async check(name) { const r = await ftn.check(name); return { free: r.free, note: r.rateLimited ? 'rate-limité' : null }; },
    snipe: ftn.snipe,
    engine: ftn,
  },
  twitch: {
    id: 'twitch', label: 'Twitch', emoji: '💜', color: '#9146ff',
    target: 'login', loginKind: 'token',
    loginPlaceholder: 'jeton OAuth (auth-token de ta session twitch.tv)…',
    needs: 'Jeton OAuth Twitch (« auth-token » de session). La dispo est fiable ; le renommage GQL est restreint par Twitch (« à confirmer »).',
    validName: twitch.validName,
    whoami: twitch.whoami, logout: twitch.logout,
    async check(name) { const r = await twitch.checkAvailable(name); return { free: r.free, note: r.note }; },
    snipe: twitch.snipe,
    engine: twitch,
  },
  x: {
    id: 'x', label: 'X (Twitter)', emoji: '✖️', color: '#1d9bf0',
    target: '@handle', loginKind: 'token', loginMultiline: true,
    loginPlaceholder: 'cookies x.com : auth_token=…; ct0=…',
    needs: 'Cookies de session X (auth_token + ct0, via DevTools). API X verrouillée : la surveillance ALERTE dès qu\'un @handle se libère ; renommage « à confirmer ».',
    validName: x.validName,
    whoami: x.whoami, logout: x.logout,
    async check(name) { const r = await x.checkAvailable(name); return { free: r.free, note: r.note }; },
    snipe: x.snipe,
    engine: x,
  },
  roblox: {
    id: 'roblox', label: 'Roblox', emoji: '🟥', color: '#e2231a',
    target: 'pseudo', loginKind: 'cookie', needsPassword: true,
    loginPlaceholder: 'cookie .ROBLOSECURITY (_|WARNING…|_…)',
    needs: 'Cookie .ROBLOSECURITY + mot de passe au snipe. ⚠️ Un renommage RÉUSSI coûte 1000 Robux (jamais débité si le nom est déjà pris).',
    validName: roblox.validName,
    whoami: roblox.whoami, logout: roblox.logout,
    async check(name) { const r = await roblox.validateName(name); return { free: r.free, note: r.note }; },
    snipe: roblox.snipe,
    engine: roblox,
  },
};

export const PLATFORM_ORDER = ['mc', 'discord', 'ftn', 'twitch', 'x', 'roblox'];
export function getAdapter(id) { return ADAPTERS[id]; }

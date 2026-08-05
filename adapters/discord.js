// Adaptateur Discord vanity (multi-bots) : normalise le moteur snipe-discord vers l'interface du hub.
// Plusieurs tokens de bot = plus de débit (chaque bot a son propre quota de rate-limit).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as dc from '../platforms/discord/discord.js';
import * as store from '../platforms/discord/tokenstore.js';
import { saveEncrypted, loadEncrypted } from '../platforms/discord/securebox.js';
import { dataDir } from '../platforms/discord/paths.js';
import { snipe, requestStop } from '../platforms/discord/sniper.js';

const botsFile = () => path.join(dataDir(), 'bots.enc');

// Liste des bots enregistrés : [{ id, token, type, name }]. Migre l'ancien token unique.
function loadBots() {
  const s = loadEncrypted(botsFile());
  if (s && Array.isArray(s.bots)) return s.bots;
  const tok = store.loadToken?.();
  if (tok) {
    const token = typeof tok === 'string' ? tok : (tok.token || tok.value);
    const type = (typeof tok === 'object' && tok.type) || (typeof tok === 'object' && tok.user ? 'user' : 'bot');
    if (token) return [{ id: crypto.randomUUID(), token, type, name: (typeof tok === 'object' && tok.name) || 'compte' }];
  }
  return [];
}
function saveBots(bots) { saveEncrypted(botsFile(), { bots }); }
// Garde token.enc synchronisé sur le 1er bot (compat CLI + check authentifié).
function syncPrimary(bots) {
  if (bots[0]) store.storeToken({ token: bots[0].token, type: bots[0].type, user: bots[0].type === 'user' });
  else store.clearToken?.();
}

export default {
  id: 'discord',
  loginKind: 'token',
  target: 'code vanity',
  needs: 'Token(s) de BOT (présent dans ton serveur, permission « Gérer le serveur ») + serveur boost niv. 3. Astuce : colle plusieurs tokens (1 par ligne) = plus de débit.',
  extraFields: [{ key: 'guildId', label: 'ID du serveur (le tien)', required: true }],

  validName: (n) => { try { return dc.validVanity(n); } catch { return true; } },

  async whoami() {
    const bots = loadBots();
    if (!bots.length) return null;
    const b0 = bots[0];
    return { name: b0.name + (bots.length > 1 ? ` (+${bots.length - 1})` : ''), id: b0.id };
  },

  // Colle un OU plusieurs tokens (1 par ligne / séparés par des virgules) : chacun est
  // auto-détecté (bot/user) et VALIDÉ avant ajout. Dédoublonnage par id de compte.
  async setToken(input) {
    const parts = String(input || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error('Aucun token fourni.');
    const bots = loadBots();
    const added = [];
    for (const raw of parts) {
      const r = await dc.resolveToken(raw);   // { token, type, user } ; lève si invalide
      const id = r.user?.id || crypto.randomUUID();
      const name = r.user?.username || r.user?.id || 'bot';
      const ex = bots.find((b) => b.id === id || b.token === r.token);
      if (ex) { ex.token = r.token; ex.type = r.type; ex.name = name; }
      else bots.push({ id, token: r.token, type: r.type, name });
      added.push(name);
    }
    saveBots(bots); syncPrimary(bots);
    return { added, count: bots.length };
  },
  async logout() {
    try { const f = botsFile(); fs.rmSync(f, { force: true }); fs.rmSync(f + '.salt', { force: true }); } catch { /* */ }
    try { store.clearToken?.(); } catch { /* */ }
    return null;
  },

  // Panneau multi-bots de l'UI. mode 'all' = tous les bots tirent ensemble.
  async accountsList() {
    const bots = loadBots();
    return { mode: 'all', items: bots.map((b) => ({ id: b.id, label: (b.type === 'user' ? '👤 ' : '🤖 ') + b.name, active: true })) };
  },
  async removeAccount(id) {
    const bots = loadBots().filter((b) => b.id !== id);
    saveBots(bots); syncPrimary(bots);
    return this.accountsList();
  },

  // dc.checkVanityFree renvoie un OBJET { free: true|false|null, ... } — il faut lire le champ
  // .free : un `!!` sur l'objet vaudrait toujours true, y compris pour un code PRIS ou un
  // blocage Cloudflare (qui serait alors annoncé « libre » à tort).
  async check(code) {
    const bots = loadBots();
    const opts = {};
    if (bots[0]) opts.auth = dc.authHeader(bots[0].token, bots[0].type);
    const r = await dc.checkVanityFree(code, opts);
    if (r.free == null) {
      throw new Error(r.cloudflare ? 'Bloqué par Cloudflare (1015) — attends un peu.'
        : r.rateLimited ? 'Rate-limité par Discord — réessaie dans un moment.'
        : `Discord a répondu ${r.statusCode}.`);
    }
    return { free: r.free, guild: r.guild, premiumTier: r.premiumTier };
  },

  // opts unifiés : { name (=code(s) séparés par des virgules), guildId, autoLead, dropAt, monitor, connections, burst, spacingMs, leadMs, skipNtp }
  stop() { try { requestStop(); } catch { /* */ } },

  async snipe(o) {
    if (!o.guildId) throw new Error('Renseigne l\'ID de ton serveur (guildId).');
    const bots = loadBots();
    if (!bots.length) throw new Error('Aucun token Discord enregistré — connecte-toi d\'abord.');
    // L'API « Modify Guild Vanity URL » est réservée aux BOTS : on ne tire qu'avec les tokens de bot.
    const botOnly = bots.filter((b) => b.type === 'bot');
    if (!botOnly.length) throw new Error('Le snipe de vanity exige au moins un token de BOT (un token utilisateur ne peut pas poser de vanity).');
    return snipe({
      codes: String(o.name).split(',').map((s) => s.trim()).filter(Boolean),
      guildId: o.guildId,
      bots: botOnly.map((b) => ({ auth: dc.authHeader(b.token, b.type), label: b.name })),
      dropAt: o.dropAt, monitor: o.monitor, autoLead: o.autoLead,
      connections: o.connections, burst: o.burst, spacingMs: o.spacingMs, leadMs: o.leadMs, skipNtp: o.skipNtp,
    });
  },
};

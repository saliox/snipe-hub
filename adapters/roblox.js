// Adaptateur Roblox : normalise le moteur roblox (platforms/roblox) vers l'interface unifiée du hub.
import * as auth from '../platforms/roblox/auth.js';
import { validateName, validName } from '../platforms/roblox/roblox.js';
import { snipe as runSnipe, requestStop } from '../platforms/roblox/sniper.js';

export default {
  id: 'roblox',
  loginKind: 'cookie',          // on colle le cookie .ROBLOSECURITY
  target: 'pseudo',
  needs: 'Cookie .ROBLOSECURITY + mot de passe du compte. ⚠ Un changement de pseudo réussi coûte 1000 Robux.',
  // Champ requis au moment du snipe (jamais stocké) : Roblox réclame le mot de passe à chaque changement.
  extraFields: [{ key: 'password', label: 'Mot de passe Roblox', type: 'password', required: true, scope: 'snipe' }],

  validName: (n) => { try { return validName(n); } catch { return true; } },

  async whoami() {
    try { const p = await auth.whoami(); return p ? { name: p.name || p.displayName || String(p.id), id: p.id } : null; }
    catch { return null; }
  },

  async setToken(cookie) { return auth.storeCookie(cookie); },   // valide via whoami avant d'enregistrer
  async logout() { try { return auth.logout(); } catch { return null; } },

  async check(name) {
    const r = await validateName(name, auth.loadCookie());
    if (r.free == null) throw new Error(r.rateLimited ? 'Rate-limité par Roblox — réessaie.' : (r.message || `statut ${r.status}`));
    return { free: !!r.free };
  },
  // Check en masse : validation de dispo (via proxy si fourni). Utilise le cookie si connecté.
  async bulkChecker() {
    const cookie = auth.loadCookie();
    return async (name, dispatcher) => {
      const r = await validateName(name, cookie, dispatcher);
      return { free: r.free, rateLimited: r.rateLimited, retryAfter: r.retryAfter };
    };
  },

  // opts unifiés : { name, password, dropAt, monitor, burst, leadMs, skipNtp }
  stop() { try { requestStop(); } catch { /* */ } },

  async snipe(o) {
    const cookie = auth.loadCookie();
    if (!cookie) throw new Error('Connecte-toi d\'abord (cookie .ROBLOSECURITY).');
    if (!o.password) throw new Error('Entre ton mot de passe Roblox dans le champ dédié.');
    return runSnipe({
      name: o.name, cookie, password: o.password,
      dropAt: o.dropAt, monitor: o.monitor, burst: o.burst, leadMs: o.leadMs, skipNtp: o.skipNtp,
    });
  },
};

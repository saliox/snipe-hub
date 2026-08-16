// Adaptateur Twitch : normalise le moteur twitch (platforms/twitch) vers l'interface du hub.
import * as auth from '../platforms/twitch/auth.js';
import { validName, checkAvailable } from '../platforms/twitch/twitch.js';
import { snipe as runSnipe, requestStop } from '../platforms/twitch/sniper.js';

export default {
  id: 'twitch',
  loginKind: 'token',           // on colle le jeton OAuth (auth-token de la session twitch.tv)
  target: 'login',
  needs: 'Jeton OAuth Twitch (« auth-token » de ta session). ⚠ Un login libéré passe par un hold (~6 mois) et le renommage a un cooldown ; la mutation de renommage reste à confirmer — la surveillance de disponibilité, elle, est fiable.',

  validName: (n) => { try { return validName(n); } catch { return true; } },

  async whoami() {
    try { const p = await auth.whoami(); return p ? { name: p.login || String(p.id), id: p.id } : null; }
    catch { return null; }
  },

  async setToken(token) { return auth.storeToken(token); },   // valide via /oauth2/validate avant d'enregistrer
  async logout() { try { return auth.logout(); } catch { return null; } },

  async check(name) {
    const r = await checkAvailable(name, auth.loadToken());
    if (r.free == null) throw new Error(r.rateLimited ? 'Rate-limité par Twitch — réessaie.' : (r.message || `statut ${r.status}`));
    return { free: !!r.free };
  },
  // Dispo via Helix Get Users (nécessite le token) → check en masse proxifié.
  async bulkChecker() {
    const token = auth.loadToken();
    // Helix EXIGE un jeton : sans lui, checkAvailable renvoie { free: null } pour
    // CHAQUE nom. Sur une liste de 1000 noms, l'utilisateur obtenait 1000 lignes
    // « ⚪ ? » et « 0/N libres » sans qu'on lui dise jamais qu'il faut se connecter.
    // On échoue tout de suite, avec la cause.
    if (!token) throw new Error('Connecte-toi d\'abord à Twitch : l\'API Helix exige un jeton pour vérifier la disponibilité.');
    return async (name, dispatcher) => {
      const r = await checkAvailable(name, token, dispatcher);
      return { free: r.free, rateLimited: r.rateLimited, retryAfter: r.retryAfter };
    };
  },

  // opts unifiés : { name, dropAt, monitor, leadMs, skipNtp }
  stop() { try { requestStop(); } catch { /* */ } },

  async snipe(o) {
    const token = auth.loadToken();
    if (!token) throw new Error('Connecte-toi d\'abord (jeton OAuth Twitch).');
    return runSnipe({ name: o.name, token, dropAt: o.dropAt, monitor: o.monitor, leadMs: o.leadMs, skipNtp: o.skipNtp });
  },
};

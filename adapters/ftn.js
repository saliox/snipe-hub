// Adaptateur Fortnite / Epic : normalise le moteur snipe-ftn (platforms/ftn) vers l'interface unifiée.
import * as accounts from '../platforms/ftn/accounts.js';
import * as epic from '../platforms/ftn/epicapi.js';
import { snipe, requestStop } from '../platforms/ftn/sniper.js';

export default {
  id: 'ftn',
  loginKind: 'code',            // Epic authorizationCode (coller un code)
  target: 'pseudo',
  needs: 'Compte Epic (authorizationCode) — endpoint changeDisplayName à confirmer',

  validName: (n) => { try { return epic.validName(n); } catch { return true; } },

  async whoami() {
    try { const a = await (accounts.cachedAccount?.() ?? null); return a ? { name: a.displayName || a.name || a.id, id: a.accountId || a.id } : null; } catch { return null; }
  },

  // L'utilisateur colle directement son authorizationCode -> addAccountFromCode (login interactif
  // du moteur attend un callback getCode() : inadapté ici).
  async login(code) {
    const clean = String(code || '').trim();
    if (!clean) throw new Error('Colle ton authorizationCode Epic (voir le lien affiché).');
    return accounts.addAccountFromCode(clean);
  },
  async logout() {
    try {
      const { activeId, accounts: list } = accounts.listAccounts();
      const id = activeId || list?.[0]?.id;
      if (id) accounts.removeAccount(id);
    } catch { /* ignore */ }
    return null;
  },
  // Panneau multi-comptes de l'UI. mode 'select' = un seul compte actif à la fois.
  async accountsList() {
    try {
      const s = accounts.listAccounts();
      return { mode: 'select', items: (s.accounts || []).map((a) => ({ id: a.id, label: a.label || a.displayName || a.accountId, active: a.active })) };
    } catch { return { mode: 'select', items: [] }; }
  },
  async setActive(id) { accounts.setActive(id); return this.accountsList(); },
  async removeAccount(id) { accounts.removeAccount(id); return this.accountsList(); },

  // accounts.getValidToken() renvoie { accessToken, accountId, displayName } : epicapi attend
  // la CHAÎNE (`Bearer ${accessToken}`). Passer l'objet donnait « Bearer [object Object] » → 401,
  // et la réponse d'erreur retombait en { free: null } → tout nom affiché « pris ».
  async check(name) {
    const { accessToken } = await accounts.getValidToken();
    const st = await epic.displayNameStatus(name, accessToken);
    if (st.free == null) {
      throw new Error(st.rateLimited ? 'Rate-limité par Epic — réessaie dans un moment.' : `Epic a répondu ${st.statusCode}.`);
    }
    return { free: st.free, accountId: st.accountId };
  },
  // Check en masse : on récupère UN token frais puis on sonde chaque nom (via proxy si fourni).
  async bulkChecker() {
    const { accessToken } = await accounts.getValidToken();
    return async (name, dispatcher) => {
      const st = await epic.displayNameStatus(name, accessToken, dispatcher);
      return { free: st.free, rateLimited: st.rateLimited, retryAfter: st.retryAfter };
    };
  },

  // opts unifiés : { name, dropAt, monitor, connections, burst, spacingMs, leadMs, skipNtp }
  stop() { try { requestStop(); } catch { /* */ } },

  async snipe(o) {
    // Idem : le moteur documente `@param {string} opts.token` (platforms/ftn/sniper.js).
    const { accessToken, accountId } = await accounts.getValidToken();
    const acc = await (accounts.cachedAccount?.() ?? null);
    return snipe({
      name: o.name,
      token: accessToken,
      // Une surveillance dure des heures alors qu'un access token Epic vaut ~1 h :
      // le moteur doit pouvoir le renouveler lui-même sur 401.
      getToken: async () => (await accounts.getValidToken()).accessToken,
      accountId: accountId || acc?.accountId || acc?.id,
      dropAt: o.dropAt, monitor: o.monitor,
      connections: o.connections, burst: o.burst, spacingMs: o.spacingMs, leadMs: o.leadMs, skipNtp: o.skipNtp,
    });
  },
};

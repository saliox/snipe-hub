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

  async check(name) {
    const token = await accounts.getValidToken();
    const st = await epic.displayNameStatus(name, token);
    // displayNameStatus peut renvoyer un objet {free} ou un booléen selon l'implémentation
    const free = typeof st === 'boolean' ? st : (st?.free ?? (st?.status === 'free'));
    return { free: !!free, raw: st };
  },
  // Check en masse : on récupère UN token frais puis on sonde chaque nom (via proxy si fourni).
  async bulkChecker() {
    const token = await accounts.getValidToken();
    return async (name, dispatcher) => {
      const st = await epic.displayNameStatus(name, token, dispatcher);
      const free = typeof st === 'boolean' ? st : (st?.free ?? (st?.status === 'free'));
      return { free: !!free };
    };
  },

  // opts unifiés : { name, dropAt, monitor, connections, burst, spacingMs, leadMs, skipNtp }
  stop() { try { requestStop(); } catch { /* */ } },

  async snipe(o) {
    const token = await accounts.getValidToken();
    const acc = await (accounts.cachedAccount?.() ?? null);
    return snipe({
      name: o.name, token, accountId: acc?.accountId || acc?.id,
      dropAt: o.dropAt, monitor: o.monitor,
      connections: o.connections, burst: o.burst, spacingMs: o.spacingMs, leadMs: o.leadMs, skipNtp: o.skipNtp,
    });
  },
};

// Adaptateur X (Twitter) : normalise le moteur x (platforms/x) vers l'interface du hub.
import * as auth from '../platforms/x/auth.js';
import { validName, checkAvailable } from '../platforms/x/x.js';
import { snipe as runSnipe, requestStop } from '../platforms/x/sniper.js';

export default {
  id: 'x',
  loginKind: 'token',           // on colle les cookies de session (auth_token + ct0)
  target: '@handle',
  needs: 'Identifiants de session X : colle tes cookies x.com « auth_token=…; ct0=… » (DevTools → Application → Cookies). ⚠ API X très verrouillée depuis 2023 — disponibilité et renommage à confirmer ; la surveillance ALERTE quand même dès qu\'un @handle se libère.',

  validName: (n) => { try { return validName(n); } catch { return true; } },

  async whoami() {
    try { const p = await auth.whoami(); return p ? { name: '@' + p.screen_name, id: p.id } : null; }
    catch { return null; }
  },

  async setToken(input) { const p = await auth.storeCreds(input); return { name: '@' + p.screen_name, id: p.id }; },
  async logout() { try { return auth.logout(); } catch { return null; } },

  async check(name) {
    const r = await checkAvailable(name, auth.loadCreds());
    if (r.free == null) throw new Error(r.rateLimited ? 'Rate-limité par X — réessaie.' : (r.message || `statut ${r.status}`));
    return { free: !!r.free };
  },
  async bulkChecker() {
    const cred = auth.loadCreds();
    return async (name, dispatcher) => { const r = await checkAvailable(name, cred, dispatcher); return { free: r.free }; };
  },

  // opts unifiés : { name, dropAt, monitor, leadMs, skipNtp }
  stop() { try { requestStop(); } catch { /* */ } },

  async snipe(o) {
    const cred = auth.loadCreds();
    if (!cred) throw new Error('Connecte-toi d\'abord (identifiants de session X : auth_token + ct0).');
    return runSnipe({ name: o.name, cred, dropAt: o.dropAt, monitor: o.monitor, leadMs: o.leadMs, skipNtp: o.skipNtp });
  },
};

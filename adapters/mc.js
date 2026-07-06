// Adaptateur Minecraft : normalise le moteur snipe-mc (copié dans platforms/mc) vers l'interface unifiée du hub.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from '../platforms/mc/auth.js';
import * as mojang from '../platforms/mc/mojang.js';
import { snipe, requestStop } from '../platforms/mc/sniper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Chemin du cache MC, calqué sur platforms/mc/auth.js (dataDir = SNIPE_DATA_DIR || platforms/data).
const mcTokenFile = () => path.join(process.env.SNIPE_DATA_DIR || path.join(HERE, '..', 'platforms', 'data'), 'token.enc');

export default {
  id: 'mc',
  loginKind: 'device',          // Microsoft device code (affiche un code + URL)
  target: 'pseudo',             // ce qu'on snipe
  needs: 'Compte Microsoft + variable MS_CLIENT_ID (app Azure approuvée)',

  validName: (n) => { try { return mojang.validName(n); } catch { return true; } },

  async whoami() {
    try { const p = await (auth.cachedProfile?.() ?? null); return p ? { name: p.name || p.username || p.id, id: p.id } : null; } catch { return null; }
  },

  // interactif : onPrompt (fourni par main) ouvre la page + copie le code ; le code/URL sort aussi en console → journal.
  async login(_arg, ctx) { return auth.loginInteractive(ctx?.onPrompt); },
  async logout() {
    // Le moteur n'expose pas de logout : on efface le cache chiffré (token.enc + son sel).
    try { const f = mcTokenFile(); fs.rmSync(f, { force: true }); fs.rmSync(f + '.salt', { force: true }); } catch { /* ignore */ }
    return null;
  },

  async check(name) {
    const free = await mojang.isNameFree(name);
    return { free: !!free };
  },
  // Check anonyme (Mojang) → parfait pour le check en masse proxifié.
  async bulkChecker() {
    return async (name, dispatcher) => { const free = await mojang.isNameFree(name, dispatcher); return { free: !!free }; };
  },

  // opts unifiés : { name, dropAt, monitor, connections, burst, spacingMs, leadMs, skipNtp }
  stop() { try { requestStop(); } catch { /* */ } },

  async snipe(o) {
    const token = await auth.getValidToken();
    return snipe({
      name: o.name, token, getToken: auth.getValidToken,
      dropAt: o.dropAt, monitor: o.monitor,
      connections: o.connections, burst: o.burst, spacingMs: o.spacingMs, leadMs: o.leadMs, skipNtp: o.skipNtp,
    });
  },
};

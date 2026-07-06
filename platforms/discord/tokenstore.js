// Stockage chiffré du token Discord actif (bot ou utilisateur), pour le CLI.
// Le GUI passe son propre dossier via SNIPE_DISCORD_DATA_DIR (userData Electron).
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';

function tokenFile() { return path.join(dataDir(), 'token.enc'); }

export function storeToken({ token, type, user }) {
  saveEncrypted(tokenFile(), { token, type, user, savedAt: Date.now() });
}

export function loadToken() {
  return loadEncrypted(tokenFile());
}

export function clearToken() {
  try { fs.rmSync(tokenFile(), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tokenFile() + '.salt', { force: true }); } catch { /* ignore */ }
}

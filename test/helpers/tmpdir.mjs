// Dossier temporaire jetable pour les tests qui touchent au disque
// (securebox, history, schedule, settings…).
//
// PIÈGE À CONNAÎTRE : les moteurs résolvent leur dossier de données À L'APPEL
// (`dataDir()` lit process.env au moment où on l'invoque), PAS à l'import.
// On peut donc poser SNIPE_DATA_DIR depuis le test lui-même — mais il faut le
// faire AVANT le premier appel qui écrit, pas seulement avant l'import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = [];

/** Crée un dossier temporaire unique et le mémorise pour le nettoyage. */
export function tmpdir(prefix = 'snipehub-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

/**
 * Isole les dossiers de données des moteurs dans un tmpdir dédié.
 * Renvoie une fonction de restauration à appeler en fin de test.
 */
export function isolateDataDirs(dir = tmpdir()) {
  const saved = {
    SNIPE_DATA_DIR: process.env.SNIPE_DATA_DIR,
    SNIPE_DISCORD_DATA_DIR: process.env.SNIPE_DISCORD_DATA_DIR,
  };
  process.env.SNIPE_DATA_DIR = path.join(dir, 'accounts');
  process.env.SNIPE_DISCORD_DATA_DIR = path.join(dir, 'discord');
  fs.mkdirSync(process.env.SNIPE_DATA_DIR, { recursive: true });
  fs.mkdirSync(process.env.SNIPE_DISCORD_DATA_DIR, { recursive: true });
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

/** Supprime tous les dossiers temporaires créés pendant la session de test. */
export function cleanupTmp() {
  for (const d of created.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Dossier de données partagé (token, bots, préférences). userData en GUI (défini
// par main.js), sinon data/ du projet en CLI. Résolu à l'usage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function dataDir() {
  return process.env.SNIPE_DISCORD_DATA_DIR || path.join(__dirname, '..', 'data');
}

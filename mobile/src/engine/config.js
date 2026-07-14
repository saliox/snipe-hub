// Config runtime lue par les moteurs (équivalent des variables d'env du desktop).
// Hydratée depuis AsyncStorage au démarrage, mise à jour par l'écran Réglages.
import { getSettings, saveSettings } from './storage.js';

let CONF = { msClientId: '', epicClientId: '', epicClientSecret: '', discordUA: '' };

export function getConfig() { return CONF; }
export async function hydrateConfig() { CONF = await getSettings(); return CONF; }
export async function setConfig(patch) { CONF = await saveSettings(patch); return CONF; }

// Défauts Epic (client de jeu Fortnite iOS) si non renseignés — comme le desktop.
export const EPIC_DEFAULT_ID = '3446cd72694c4a4485d81b77adbb2141';
export const EPIC_DEFAULT_SECRET = '9209d4a5e25a457fb9b07489d313b41a';
export const DISCORD_DEFAULT_UA = 'snipe-hub-mobile (https://github.com/saliox/snipe-hub, 0.4.0)';

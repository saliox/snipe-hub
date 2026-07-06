// Préférences persistées (chiffrées) : derniers réglages du snipe + session en
// cours à reprendre au prochain lancement + URL de webhook.
import path from 'node:path';
import { dataDir } from './paths.js';
import { saveEncrypted, loadEncrypted } from './securebox.js';

const file = () => path.join(dataDir(), 'prefs.enc');

export function loadPrefs() { return loadEncrypted(file()) || {}; }
function save(p) { saveEncrypted(file(), p); }

// Réglages du formulaire (burst/spacing/serveur cible/webhook/…).
export function getSettings() { return loadPrefs().settings || null; }
export function saveSettings(settings) { const p = loadPrefs(); p.settings = settings; save(p); }

// Session = snipe(s) voulu(s) laissé(s) en cours, à proposer de reprendre.
export function getSession() { return loadPrefs().session || null; }
export function saveSession(session) { const p = loadPrefs(); p.session = { ...session, savedAt: Date.now() }; save(p); }
export function clearSession() { const p = loadPrefs(); delete p.session; save(p); }

// Réglages applicatifs (tray / démarrage Windows / notifications / son / reprise auto).
const APP_DEFAULTS = { minimizeToTray: false, launchAtLogin: false, notifications: true, sound: true, autoResume: false };
export function getApp() { return { ...APP_DEFAULTS, ...(loadPrefs().app || {}) }; }
export function saveApp(appCfg) { const p = loadPrefs(); p.app = { ...APP_DEFAULTS, ...(p.app || {}), ...appCfg }; save(p); return p.app; }

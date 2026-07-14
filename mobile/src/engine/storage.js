// Stockage NON-secret (réglages, watchlist, historique) via AsyncStorage.
// Les secrets (tokens) vont dans secure.js, pas ici.
import AsyncStorage from '@react-native-async-storage/async-storage';

const K = {
  settings: 'sh:settings',
  watchlist: 'sh:watchlist',
  history: 'sh:history',
};

async function getJSON(key, fallback) {
  try { const raw = await AsyncStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
async function setJSON(key, value) {
  try { await AsyncStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// --- Réglages (IDs d'app pour MC/Epic, proxies par défaut, etc.) ---
export const DEFAULT_SETTINGS = { msClientId: '', epicClientId: '', epicClientSecret: '', discordUA: '' };
export async function getSettings() { return { ...DEFAULT_SETTINGS, ...(await getJSON(K.settings, {})) }; }
export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await setJSON(K.settings, next);
  return next;
}

// --- Watchlist unifiée : [{ id, platform, name, extra }] ---
export async function getWatch() { return getJSON(K.watchlist, []); }
export async function addWatch(item) {
  const list = await getWatch();
  const id = `${item.platform}:${item.name}`.toLowerCase();
  if (!list.some((w) => w.id === id)) list.unshift({ ...item, id, at: Date.now() });
  await setJSON(K.watchlist, list);
  return list;
}
export async function removeWatch(id) {
  const list = (await getWatch()).filter((w) => w.id !== id);
  await setJSON(K.watchlist, list);
  return list;
}
export async function clearWatch() { await setJSON(K.watchlist, []); return []; }

// --- Historique des snipes : [{ platform, name, ok, at }] ---
export async function getHistory() { return getJSON(K.history, []); }
export async function pushHistory(entry) {
  const list = await getHistory();
  list.unshift({ ...entry, at: Date.now() });
  await setJSON(K.history, list.slice(0, 100));
  return list;
}

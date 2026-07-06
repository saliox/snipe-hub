// Snipe Hub — processus principal Electron. Fenêtre unique + IPC unifié au-dessus des adaptateurs
// (platforms/* via adapters/*), watchlist commune persistée, capture des logs de snipe, auto-update GitHub.
import { app, BrowserWindow, ipcMain, shell, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { listPlatforms, getAdapter, platformMeta } from '../adapters/index.js';
import { initUpdater, checkForUpdates, applyUpdate } from '../core/updater.js';
import { runBulk } from '../core/bulk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win = null;

// Les moteurs (mc/discord/ftn) persistent leurs tokens dans un dossier résolu via
// variable d'env. Sans ça ils écrivent dans platforms/*/data => à l'intérieur de
// app.asar (lecture seule) une fois packagé => connexion jamais mémorisée.
// On les redirige vers userData (inscriptible). MC (token.enc) et FTN (accounts.enc)
// peuvent partager SNIPE_DATA_DIR : noms de fichiers distincts + clés securebox
// distinctes => aucune collision. `||=` respecte un éventuel override dans .env.
function initDataDirs() {
  const ud = app.getPath('userData');
  process.env.SNIPE_DATA_DIR ||= path.join(ud, 'accounts');
  process.env.SNIPE_DISCORD_DATA_DIR ||= path.join(ud, 'discord');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1060, height: 720, minWidth: 900, minHeight: 600,
    backgroundColor: '#080a0f', title: 'Snipe Hub',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------- Watchlist unifiée (userData/watchlist.json) : { platform, name, guildId?, addedAt } ----------
const WATCH_FILE = () => path.join(app.getPath('userData'), 'watchlist.json');
const readWatch = () => { try { return JSON.parse(fs.readFileSync(WATCH_FILE(), 'utf8')); } catch { return []; } };
const writeWatch = (arr) => { try { fs.mkdirSync(path.dirname(WATCH_FILE()), { recursive: true }); fs.writeFileSync(WATCH_FILE(), JSON.stringify(arr, null, 2)); } catch {} };

const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, '');

app.whenReady().then(() => {
  initDataDirs();
  createWindow();
  try { initUpdater(() => win); setTimeout(() => checkForUpdates({ silent: true }).catch(() => {}), 4000); } catch {}
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC : méta ----------
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('platforms:list', () => listPlatforms());
// Normalise la réponse pour le renderer : { ok, updateAvailable, current, version } | { ok:false, error }.
ipcMain.handle('update:check', async () => {
  try {
    const r = await checkForUpdates({ silent: false });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, updateAvailable: !!r.available, current: r.current, version: r.version };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:apply', () => applyUpdate().catch((e) => ({ ok: false, error: e.message })));

// Helper : récupère un adaptateur prêt ou renvoie une erreur normalisée.
async function withAdapter(pid, fn) {
  try {
    const a = await getAdapter(pid);
    if (!a) return { ok: false, error: 'Plateforme indisponible (bientôt).' };
    return await fn(a);
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

// ---------- IPC : par plateforme ----------
ipcMain.handle('pf:info', (_e, pid) => {
  const meta = platformMeta(pid);
  if (meta && meta.soon) return { ok: true, soon: true, id: meta.id, label: meta.label, emoji: meta.emoji, needs: meta.needs, loginKind: null, extraFields: [] };
  return withAdapter(pid, (a) => ({ ok: true, soon: false, id: a.id, label: a.label, emoji: a.emoji, loginKind: a.loginKind, target: a.target, needs: a.needs, extraFields: a.extraFields || [], bulk: !!a.bulkChecker }));
});
ipcMain.handle('pf:whoami', (_e, pid) => withAdapter(pid, async (a) => ({ ok: true, account: await a.whoami() })));
ipcMain.handle('pf:check', (_e, pid, name) => withAdapter(pid, async (a) => {
  if (a.validName && !a.validName(name)) return { ok: false, error: 'Nom invalide pour cette plateforme.' };
  const r = await a.check(name); return { ok: true, ...r };
}));
ipcMain.handle('pf:setToken', (_e, pid, token, isUser) => withAdapter(pid, async (a) => {
  if (!a.setToken) return { ok: false, error: 'Cette plateforme ne prend pas de token.' };
  await a.setToken(token, isUser); return { ok: true, account: await a.whoami() };
}));
ipcMain.handle('pf:logout', (_e, pid) => withAdapter(pid, async (a) => { await a.logout?.(); return { ok: true }; }));

// ---------- IPC : multi-comptes / multi-bots ----------
ipcMain.handle('pf:accounts', (_e, pid) => withAdapter(pid, async (a) => ({ ok: true, ...(a.accountsList ? await a.accountsList() : { mode: null, items: [] }) })));
ipcMain.handle('pf:accountSetActive', (_e, pid, id) => withAdapter(pid, async (a) => (a.setActive ? { ok: true, ...(await a.setActive(id)) } : { ok: false, error: 'non supporté' })));
ipcMain.handle('pf:accountRemove', (_e, pid, id) => withAdapter(pid, async (a) => (a.removeAccount ? { ok: true, ...(await a.removeAccount(id)) } : { ok: false, error: 'non supporté' })));

// Login interactif (device code / code Epic) — les instructions sortent en console → streamées au renderer.
ipcMain.handle('pf:login', (_e, pid, arg) => withAdapter(pid, async (a) => {
  const send = (line) => { try { win?.webContents.send('log', { pid, line: stripAnsi(line) }); } catch {} };
  const orig = { log: console.log, err: console.error, warn: console.warn };
  console.log = (...x) => { send(x.join(' ')); orig.log(...x); };
  console.error = (...x) => { send(x.join(' ')); orig.err(...x); };
  console.warn = (...x) => { send(x.join(' ')); orig.warn(...x); };
  // Device code (MC) : ouvre la page de vérification et copie le code, en plus du journal.
  const onPrompt = ({ verificationUri, userCode }) => {
    send(`🔑 Connexion Microsoft : entre le code ${userCode} sur ${verificationUri}`);
    send('   → page ouverte dans ton navigateur, code copié dans le presse-papier.');
    try { clipboard.writeText(userCode); } catch {}
    try { if (verificationUri) shell.openExternal(verificationUri); } catch {}
  };
  try { await a.login(arg, { onPrompt }); return { ok: true, account: await a.whoami() }; }
  finally { console.log = orig.log; console.error = orig.err; console.warn = orig.warn; }
}));

// Snipe : lance le moteur de la plateforme et STREAME sa sortie console vers le panneau de logs.
let running = false;
ipcMain.handle('pf:snipe', (_e, pid, opts) => withAdapter(pid, async (a) => {
  if (running) return { ok: false, error: 'Un snipe est déjà en cours.' };
  running = true;
  const send = (line) => { try { win?.webContents.send('log', { pid, line: stripAnsi(line) }); } catch {} };
  const orig = { log: console.log, err: console.error, warn: console.warn };
  console.log = (...x) => { send(x.join(' ')); orig.log(...x); };
  console.error = (...x) => { send(x.join(' ')); orig.err(...x); };
  console.warn = (...x) => { send(x.join(' ')); orig.warn(...x); };
  try {
    send(`▶️ Snipe « ${opts.name} » — ${opts.monitor ? 'surveillance' : 'planifié'}…`);
    const r = await a.snipe(opts);
    send('✅ Terminé.'); return { ok: true, result: r };
  } catch (e) { send('❌ ' + (e?.message || e)); return { ok: false, error: e?.message || String(e) }; }
  finally { console.log = orig.log; console.error = orig.err; console.warn = orig.warn; running = false; }
}));

// ---------- IPC : check en masse (avec proxies optionnels) ----------
ipcMain.handle('pf:bulk', (_e, pid, payload) => withAdapter(pid, async (a) => {
  if (!a.bulkChecker) return { ok: false, error: 'Check en masse non supporté pour cette plateforme.' };
  const names = String(payload?.names || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return { ok: false, error: 'Aucun nom à vérifier.' };
  const proxies = String(payload?.proxies || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const check = await a.bulkChecker();   // peut lever (ex. non connecté) → capté par withAdapter
  const onProgress = (p) => { try { win?.webContents.send('bulk', { pid, ...p }); } catch {} };
  const results = await runBulk({ names, proxies, check, concurrency: Math.max(1, Math.min(100, +payload?.concurrency || 20)), onProgress });
  return { ok: true, results, free: results.filter((r) => r.free === true).length, total: results.length };
}));

// ---------- IPC : watchlist unifiée ----------
ipcMain.handle('watch:get', () => ({ ok: true, items: readWatch() }));
ipcMain.handle('watch:add', (_e, item) => {
  const arr = readWatch();
  if (!item || !item.platform || !item.name) return { ok: false, error: 'Entrée invalide.' };
  if (arr.some((x) => x.platform === item.platform && x.name.toLowerCase() === item.name.toLowerCase())) return { ok: true, items: arr };
  arr.unshift({ platform: item.platform, name: item.name, guildId: item.guildId || null, addedAt: Date.now() });
  writeWatch(arr.slice(0, 200)); return { ok: true, items: readWatch() };
});
ipcMain.handle('watch:remove', (_e, platform, name) => {
  const arr = readWatch().filter((x) => !(x.platform === platform && x.name === name));
  writeWatch(arr); return { ok: true, items: arr };
});
ipcMain.handle('watch:clear', () => { writeWatch([]); return { ok: true, items: [] }; });

// Snipe Hub — processus principal Electron. Fenêtre unique + IPC unifié au-dessus des adaptateurs
// (platforms/* via adapters/*), watchlist commune persistée, capture des logs de snipe, auto-update GitHub.
import { app, BrowserWindow, ipcMain, shell, clipboard, Notification, screen } from 'electron';
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

// ---------- Géométrie de fenêtre mémorisée (userData/window.json) ----------
const WIN_FILE = () => path.join(app.getPath('userData'), 'window.json');
const readWinState = () => { try { return JSON.parse(fs.readFileSync(WIN_FILE(), 'utf8')); } catch { return {}; } };
// Un écran débranché depuis la dernière session laisserait la fenêtre hors champ.
function sanePos(st) {
  if (!Number.isInteger(st.x) || !Number.isInteger(st.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return st.x < b.x + b.width - 80 && st.x + (st.width || 0) > b.x + 80 && st.y >= b.y - 10 && st.y < b.y + b.height - 60;
  });
}
function persistWinState() {
  try {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    fs.mkdirSync(path.dirname(WIN_FILE()), { recursive: true });
    fs.writeFileSync(WIN_FILE(), JSON.stringify({ ...b, max: win.isMaximized() }));
  } catch {}
}
let winSaveTimer = null;
function saveWinState() {   // debounce : pas une écriture disque par pixel de resize
  if (winSaveTimer) clearTimeout(winSaveTimer);
  winSaveTimer = setTimeout(() => { winSaveTimer = null; persistWinState(); }, 400);
}

function createWindow() {
  const st = readWinState();
  const ok = sanePos(st);
  win = new BrowserWindow({
    width: st.width || 1060, height: st.height || 720, minWidth: 900, minHeight: 600,
    ...(ok ? { x: st.x, y: st.y } : {}),
    show: false,                                   // pas de fenêtre VIDE pendant le chargement
    backgroundColor: '#080a0f', title: 'Snipe Hub',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      // Fenêtre minimisée pendant un snipe : sans ça le renderer est throttlé à ~1 Hz et le
      // journal se fige. Les animations décoratives sont gelées côté CSS (anim-idle).
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => { if (st.max) win.maximize(); win.show(); });
  win.on('resize', saveWinState); win.on('move', saveWinState);
  win.on('maximize', saveWinState); win.on('unmaximize', saveWinState);
  win.on('close', () => { if (winSaveTimer) { clearTimeout(winSaveTimer); winSaveTimer = null; } persistWinState(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Écriture JSON ATOMIQUE. Écrire directement sur le fichier final laissait un JSON
// TRONQUÉ si le process mourait pendant l'écriture (crash, extinction, antivirus) —
// et readX() traite un JSON invalide en `catch -> valeur vide`, donc la watchlist ou
// l'historique disparaissaient SILENCIEUSEMENT. rename() est atomique (NTFS et POSIX).
// Renvoie true/false : les appelants IPC peuvent enfin dire la vérité au renderer
// au lieu de répondre « ok » alors que rien n'a été persisté.
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error(`[persist] échec d'écriture ${path.basename(file)} : ${e.message}`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

// ---------- Watchlist unifiée (userData/watchlist.json) : { platform, name, guildId?, addedAt } ----------
const WATCH_FILE = () => path.join(app.getPath('userData'), 'watchlist.json');
const readWatch = () => { try { return JSON.parse(fs.readFileSync(WATCH_FILE(), 'utf8')); } catch { return []; } };
const writeWatch = (arr) => writeJsonAtomic(WATCH_FILE(), arr);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Notification bureau native (Windows) + rappel dans le journal. Un clic ramène l'app au 1er plan.
function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { try { win?.show(); win?.focus(); } catch {} });
    n.show();
  } catch {}
}

// ---------- Réglages (creds + proxies) persistés (userData/settings.json) ----------
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { return {}; } };
const writeSettings = (s) => writeJsonAtomic(SETTINGS_FILE(), s);
// Applique les creds saisis dans l'UI aux variables d'env que lisent les moteurs
// (MC device code / Epic). Ne touche qu'aux champs renseignés → un vrai .env reste prioritaire si l'UI est vide.
// Vider un champ RETIRE la variable : sinon, après avoir effacé un identifiant dans
// les Réglages, le moteur continuait d'utiliser l'ancienne valeur jusqu'au
// redémarrage — on croyait avoir révoqué une app Azure encore active.
function applySettings(s) {
  const map = {
    MS_CLIENT_ID: s && s.msClientId,
    EPIC_CLIENT_ID: s && s.epicClientId,
    EPIC_CLIENT_SECRET: s && s.epicClientSecret,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v) process.env[k] = v; else delete process.env[k];
  }
}

// ---------- Historique des snipes (userData/history.json, 100 derniers) ----------
const HISTORY_FILE = () => path.join(app.getPath('userData'), 'history.json');
const readHistory = () => { try { return JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8')); } catch { return []; } };
function pushHistory(entry) {
  const h = readHistory(); h.unshift(entry);
  writeJsonAtomic(HISTORY_FILE(), h.slice(0, 100));
}

const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, '');

app.whenReady().then(() => {
  initDataDirs();
  applySettings(readSettings());
  createWindow();
  try { initUpdater(() => win); setTimeout(() => checkForUpdates({ silent: true }).catch(() => {}), 4000); } catch {}
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC : méta ----------
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('platforms:list', () => listPlatforms());
ipcMain.handle('settings:get', () => ({ ok: true, settings: readSettings() }));
ipcMain.handle('settings:save', (_e, s) => {
  const clean = { msClientId: s?.msClientId || '', epicClientId: s?.epicClientId || '', epicClientSecret: s?.epicClientSecret || '', proxies: s?.proxies || '' };
  const saved = writeSettings(clean);
  // On applique quand même en mémoire : la session courante fonctionne, mais l'UI
  // doit savoir que le réglage ne survivra PAS au redémarrage (elle affichait
  // « ✅ Enregistré. » quoi qu'il arrive).
  applySettings(clean);
  return saved ? { ok: true } : { ok: false, error: 'Réglages appliqués pour cette session, mais NON enregistrés sur le disque.' };
});
ipcMain.handle('history:get', () => ({ ok: true, items: readHistory() }));
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

// Capture RÉENTRANTE des logs console des moteurs → panneau du renderer. Le patch
// n'est installé qu'une fois ; chaque opération pousse son pid sur une pile et le
// retire (par référence) à la fin. La vraie console est restaurée quand la pile est
// vide → une opération qui se termine avant une autre ne laisse JAMAIS la console
// patchée à vie (bug de l'ancien save/restore-vers-le-précédent en cas non-LIFO).
const realConsole = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console) };
const logStack = [];
// Les moteurs sont TRÈS bavards en burst (spacingMs=30, connections=3 → des dizaines à
// centaines de lignes/s) et beginCapture patche console.* : un send PAR LIGNE = une
// sérialisation structured-clone + un saut de processus + un réveil du renderer par ligne,
// précisément au moment où l'app doit être précise en timing. On agrège par ~frame.
const LOG_FLUSH_MS = 50, LOG_MAX_BATCH = 400;
let logBuf = [], logFlushTimer = null;
function flushLogs() {
  logFlushTimer = null;
  if (!logBuf.length) return;
  const batch = logBuf; logBuf = [];
  try { if (win && !win.isDestroyed()) win.webContents.send('log', { batch }); } catch {}
}
function sendLog(pid, line) {
  logBuf.push({ pid, line: stripAnsi(line) });
  if (logBuf.length >= LOG_MAX_BATCH) {           // moteur parti en vrille : on vide tout de suite
    if (logFlushTimer) clearTimeout(logFlushTimer);
    flushLogs(); return;
  }
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
}
function forwardLog(line) { const top = logStack[logStack.length - 1]; if (top) sendLog(top.pid, line); }
function beginCapture(pid) {
  const entry = { pid };
  logStack.push(entry);
  if (logStack.length === 1) {
    console.log = (...x) => { forwardLog(x.join(' ')); realConsole.log(...x); };
    console.error = (...x) => { forwardLog(x.join(' ')); realConsole.error(...x); };
    console.warn = (...x) => { forwardLog(x.join(' ')); realConsole.warn(...x); };
  }
  return entry;
}
function endCapture(entry) {
  const i = logStack.indexOf(entry);
  if (i >= 0) logStack.splice(i, 1);
  if (!logStack.length) { console.log = realConsole.log; console.error = realConsole.error; console.warn = realConsole.warn; }
}

// Login interactif (device code / code Epic) — les instructions sortent en console → streamées au renderer.
ipcMain.handle('pf:login', (_e, pid, arg) => withAdapter(pid, async (a) => {
  const cap = beginCapture(pid);
  const send = (line) => sendLog(pid, line);
  // Device code (MC) : ouvre la page de vérification et copie le code, en plus du journal.
  const onPrompt = ({ verificationUri, userCode }) => {
    send(`🔑 Connexion Microsoft : entre le code ${userCode} sur ${verificationUri}`);
    send('   → page ouverte dans ton navigateur, code copié dans le presse-papier.');
    try { clipboard.writeText(userCode); } catch {}
    try { if (verificationUri) shell.openExternal(verificationUri); } catch {}
  };
  try { await a.login(arg, { onPrompt }); return { ok: true, account: await a.whoami() }; }
  finally { endCapture(cap); }
}));

// Snipe : lance le moteur de la plateforme et STREAME sa sortie console vers le panneau de logs.
let running = false;
let stopCurrent = null;   // fonction d'arrêt coopératif du snipe en cours (moteur.requestStop)
// Arrête le snipe en cours (bouton Stop) : le moteur voit son stopFlag et sort → le
// `await a.snipe` se résout → le finally ci-dessous relâche le verrou `running`.
ipcMain.handle('pf:stop', () => { try { stopCurrent && stopCurrent(); } catch {} return { ok: true }; });
// ⚠️ Le verrou est pris AVANT tout await. Il était posé DANS le callback de withAdapter,
// donc après `await getAdapter(pid)` : deux invocations concurrentes arrivées pendant le
// chargement de l'adaptateur passaient TOUTES LES DEUX le test -> deux snipes simultanés
// sur le même compte, et le second écrasait stopCurrent (bouton Stop inopérant).
ipcMain.handle('pf:snipe', (_e, pid, opts) => {
  if (running) return { ok: false, error: 'Un snipe est déjà en cours.' };
  running = true;
  return withAdapter(pid, async (a) => {
    stopCurrent = () => a.stop?.();
    const cap = beginCapture(pid);
    const send = (line) => sendLog(pid, line);
    try {
      send(`▶️ Snipe « ${opts.name} » — ${opts.monitor ? 'surveillance' : 'planifié'}…`);
      const r = await a.snipe(opts);
      if (r && r.success) notify('🎯 Snipe réussi !', `« ${opts.name} » obtenu sur ${pid}.`);
      if (!(r && r.stopped)) pushHistory({ platform: pid, name: opts.name, success: !!(r && r.success), at: Date.now() });
      send('✅ Terminé.'); return { ok: true, result: r };
    } catch (e) { send('❌ ' + (e?.message || e)); return { ok: false, error: e?.message || String(e) }; }
    finally { endCapture(cap); }
  }).finally(() => { running = false; stopCurrent = null; });   // libéré même si getAdapter lève
});

// ---------- IPC : check en masse (avec proxies optionnels) ----------
ipcMain.handle('pf:bulk', (_e, pid, payload) => withAdapter(pid, async (a) => {
  if (!a.bulkChecker) return { ok: false, error: 'Check en masse non supporté pour cette plateforme.' };
  const names = String(payload?.names || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return { ok: false, error: 'Aucun nom à vérifier.' };
  const proxies = String(payload?.proxies || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const check = await a.bulkChecker();   // peut lever (ex. non connecté) → capté par withAdapter
  // core/bulk.js appelle onProgress après CHAQUE nom : avec 1000 noms, 1000 messages IPC
  // en quelques secondes alors que le renderer n'écrit qu'un compteur (999 peints puis
  // aussitôt écrasés). ~10 rafraîchissements/s max, mais TOUJOURS le dernier.
  let lastEmit = 0;
  const onProgress = (p) => {
    const now = Date.now();
    if (p.done !== p.total && now - lastEmit < 100) return;
    lastEmit = now;
    try { if (win && !win.isDestroyed()) win.webContents.send('bulk', { pid, ...p }); } catch {}
  };
  const results = await runBulk({ names, proxies, check, concurrency: Math.max(1, Math.min(100, +payload?.concurrency || 20)), onProgress });
  return { ok: true, results, free: results.filter((r) => r.free === true).length, total: results.length };
}));

// ---------- IPC : watchlist unifiée ----------
ipcMain.handle('watch:get', () => ({ ok: true, items: readWatch() }));
// Ces handlers remontent désormais l'échec d'écriture : ils répondaient « ok » même
// quand rien n'était persisté (writeWatch avalait l'erreur), donc l'UI affichait une
// watchlist qui disparaissait au redémarrage sans que rien ne l'ait signalé.
const PERSIST_KO = 'Impossible d\'écrire sur le disque (droits ou espace insuffisants).';
ipcMain.handle('watch:add', (_e, item) => {
  if (!item || !item.platform || !item.name) return { ok: false, error: 'Entrée invalide.' };
  const arr = readWatch();
  if (arr.some((x) => x.platform === item.platform && x.name.toLowerCase() === item.name.toLowerCase())) return { ok: true, items: arr };
  arr.unshift({ platform: item.platform, name: item.name, guildId: item.guildId || null, addedAt: Date.now() });
  const next = arr.slice(0, 200);
  // On renvoie la liste qu'on VIENT d'écrire au lieu de relire le fichier : une
  // relecture de plus pour un résultat identique, et surtout elle masquait l'échec.
  if (!writeWatch(next)) return { ok: false, error: PERSIST_KO, items: readWatch() };
  return { ok: true, items: next };
});
ipcMain.handle('watch:remove', (_e, platform, name) => {
  const arr = readWatch().filter((x) => !(x.platform === platform && x.name === name));
  if (!writeWatch(arr)) return { ok: false, error: PERSIST_KO, items: readWatch() };
  return { ok: true, items: arr };
});
ipcMain.handle('watch:clear', () => {
  if (!writeWatch([])) return { ok: false, error: PERSIST_KO, items: readWatch() };
  return { ok: true, items: [] };
});

// ---------- Surveillance de la watchlist (poll périodique + notifications bureau) ----------
let watchTimer = null;
let watchBusy = false;
const notifiedFree = new Set(); // n'alerte qu'UNE fois par libération (pas à chaque passage)

// Sonde UNE entrée. Isolée pour que la boucle reste lisible et que l'espacement
// anti rate-limit soit garanti par l'appelant.
async function probeWatchEntry(it) {
  const key = it.platform + ':' + String(it.name).toLowerCase();
  let a;
  try { a = await getAdapter(it.platform); } catch { return; }
  if (!a || !a.check) return;
  let r;
  try { r = await a.check(it.name); } catch { return; } // pas connecté / erreur → on saute
  if (r && r.free) {
    if (!notifiedFree.has(key)) {
      notifiedFree.add(key);
      notify('🔔 Nom libre !', `« ${it.name} » est libre sur ${it.platform}.`);
      try { win?.webContents.send('watch-free', { platform: it.platform, name: it.name }); } catch {}
    }
  } else if (r) { notifiedFree.delete(key); } // repris → re-notifiable s'il se relibère
}

async function sweepWatchlist() {
  if (watchBusy) return;
  watchBusy = true;
  try {
    const items = readWatch();

    // Purge des clés dont l'entrée a été retirée de la watchlist : sans ça, notifiedFree
    // grossissait indéfiniment au fil des ajouts/suppressions (fuite mémoire lente).
    const liveKeys = new Set(items.map((it) => it.platform + ':' + String(it.name).toLowerCase()));
    for (const k of notifiedFree) if (!liveKeys.has(k)) notifiedFree.delete(k);

    // Le rate-limit est imposé PAR API, pas globalement : sonder Mojang n'a aucune
    // incidence sur Epic. On balayait pourtant tout en série avec 500 ms entre CHAQUE
    // entrée — 50 noms = plus de 25 s, pendant lesquelles une libération sur la
    // dernière plateforme passait inaperçue. On groupe donc par plateforme, on lance
    // les groupes EN PARALLÈLE, et on conserve l'espacement de 500 ms À L'INTÉRIEUR
    // de chaque groupe (c'est lui qui protège réellement du rate-limit).
    const byPlatform = new Map();
    for (const it of items) {
      if (!byPlatform.has(it.platform)) byPlatform.set(it.platform, []);
      byPlatform.get(it.platform).push(it);
    }

    await Promise.all([...byPlatform.values()].map(async (group) => {
      for (const it of group) {
        // try/finally : un `return` de probeWatchEntry ne doit jamais sauter
        // l'espacement, sinon une liste dont les sondes échouent serait parcourue à
        // pleine vitesse — ce qui aggrave précisément le rate-limit qu'on veut éviter.
        try { await probeWatchEntry(it); } finally { await sleep(500); }
      }
    }));
  } finally { watchBusy = false; }
}

ipcMain.handle('watch:monitor', (_e, on) => {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  notifiedFree.clear();
  if (on) { sweepWatchlist().catch(() => {}); watchTimer = setInterval(() => sweepWatchlist().catch(() => {}), 45000); }
  return { ok: true, monitoring: !!on };
});

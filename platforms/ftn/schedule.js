// Snipes planifiés qui SURVIVENT AU REDÉMARRAGE. La file est persistée
// (data/schedules.json) et chaque snipe crée une Tâche Windows (via PowerShell,
// sans droits admin) qui relance l'outil ~2 min avant le drop. Grâce à
// -StartWhenAvailable, une tâche manquée (PC éteint à l'heure) se lance dès le
// retour de la machine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(ROOT, 'data'); }
function file() { return path.join(dataDir(), 'schedules.json'); }
function schedDir() { return path.join(dataDir(), 'sched'); }
const TASK_PREFIX = 'FortniteSniper_';
const LEAD_MS = 120_000; // la tâche se déclenche 2 min avant le drop

function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return []; } }
function save(arr) { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(arr, null, 2)); }

export function listSchedules() { return load(); }

// Ajoute un snipe planifié. opts = flags de snipe (burst, volley, monitor=false…).
// register:false pour ne PAS créer la tâche Windows (tests).
export function addSchedule({ name, dropAt, opts = {} }, { register = true } = {}) {
  if (!name || !dropAt) throw new Error('name et dropAt requis.');
  const id = crypto.randomUUID().slice(0, 8);
  const item = { id, name, dropAt, opts, createdAt: Date.now(), taskName: `${TASK_PREFIX}${id}` };
  const arr = load(); arr.push(item); save(arr);
  if (register) {
    try { item.registered = registerTask(item); }
    catch (e) { item.registerError = e.message; }
    save(arr);
  }
  return item;
}

export function removeSchedule(id) {
  const arr = load();
  const item = arr.find((x) => x.id === id);
  save(arr.filter((x) => x.id !== id));
  if (item) { try { unregisterTask(item); } catch { /* ignore */ } cleanupFiles(item); }
  return item || null;
}

// Purge les entrées dont le drop est passé depuis > 1h (tâche déjà consommée).
export function pruneSchedules() {
  const arr = load();
  const now = Date.now();
  const keep = arr.filter((x) => x.dropAt > now - 3_600_000);
  const removed = arr.filter((x) => !keep.includes(x));
  if (removed.length) { save(keep); for (const it of removed) { try { unregisterTask(it); } catch {} cleanupFiles(it); } }
  return removed.length;
}

// --- Détails d'implémentation ---

// Reconstruit les flags CLI depuis les opts stockés.
function flagsFromOpts(o) {
  const a = [];
  const num = (k, f) => { if (o[k] != null) a.push(f, String(o[k])); };
  num('burst', '--burst'); num('volley', '--volley'); num('spacing', '--spacing');
  num('lead', '--lead'); num('poll', '--poll'); num('connections', '--connections');
  if (o.proxies) a.push('--proxies', o.proxies);
  if (o.allAccounts) a.push('--all-accounts');
  if (o.diag) a.push('--diag');
  if (o.skipNtp) a.push('--skip-ntp');
  return a;
}

// Écrit un .cmd qui lance le snipe (chemins absolus) + journalise le résultat.
function writeCmd(item) {
  fs.mkdirSync(schedDir(), { recursive: true });
  const cmdPath = path.join(schedDir(), `${item.id}.cmd`);
  const logPath = path.join(schedDir(), `${item.id}.log`);
  const node = process.execPath;
  const script = path.join(ROOT, 'src', 'index.js');
  const iso = new Date(item.dropAt).toISOString();
  const args = ['snipe', item.name, '--at', iso, ...flagsFromOpts(item.opts)]
    .map((s) => `"${String(s).replace(/"/g, '')}"`).join(' ');
  const body =
    '@echo off\r\n' +
    `cd /d "${ROOT}"\r\n` +
    `"${node}" "${script}" ${args} >> "${logPath}" 2>&1\r\n`;
  fs.writeFileSync(cmdPath, body);
  return cmdPath;
}

function cleanupFiles(item) {
  try { fs.rmSync(path.join(schedDir(), `${item.id}.cmd`), { force: true }); } catch {}
}

function registerTask(item) {
  const cmdPath = writeCmd(item);
  const fireAt = new Date(item.dropAt - LEAD_MS);
  // DateTime construit par composants LOCAUX -> aucun souci de locale.
  const dt = `New-Object DateTime(${fireAt.getFullYear()},${fireAt.getMonth() + 1},${fireAt.getDate()},${fireAt.getHours()},${fireAt.getMinutes()},${fireAt.getSeconds()})`;
  const q = (s) => String(s).replace(/'/g, "''");
  const ps =
    `$a = New-ScheduledTaskAction -Execute '${q(cmdPath)}' -WorkingDirectory '${q(ROOT)}';` +
    `$t = New-ScheduledTaskTrigger -Once -At (${dt});` +
    `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;` +
    `Register-ScheduledTask -TaskName '${q(item.taskName)}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`Register-ScheduledTask a échoué (code ${r.status}). ${String(r.stderr || '').trim().slice(0, 200)}`);
  return true;
}

function unregisterTask(item) {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Unregister-ScheduledTask -TaskName '${String(item.taskName).replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`],
    { stdio: 'ignore' });
}

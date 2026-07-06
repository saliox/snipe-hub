// Historique persistant des noms vus (libre/pris) au fil des vérifs et scans.
// Permet de repérer les noms qui « tournent » et de retrouver les libres passés.
// Stockage : data/history.json (map name -> { state, at, firstFree }).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(__dirname, '..', 'data'); }
function file() { return path.join(dataDir(), 'history.json'); }

let cache = null;
let dirty = false;
let timer = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { cache = {}; }
  return cache;
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, 1000);
  if (timer.unref) timer.unref(); // ne maintient pas le process en vie
}

export function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache));
    dirty = false;
  } catch { /* disque plein / droits : on garde en mémoire */ }
}

// Enregistre l'état courant d'un nom. Conserve la 1re date où on l'a vu libre.
export function record(name, state) {
  if (state !== 'free' && state !== 'taken') return;
  const h = load();
  const key = String(name);
  const prev = h[key];
  h[key] = {
    state,
    at: Date.now(),
    firstFree: state === 'free' ? (prev?.firstFree || Date.now()) : (prev?.firstFree || null),
  };
  dirty = true;
  scheduleFlush();
}

export function lookup(name) { return load()[String(name)] || null; }

export function stats() {
  const vals = Object.values(load());
  return {
    total: vals.length,
    free: vals.filter((v) => v.state === 'free').length,
    taken: vals.filter((v) => v.state === 'taken').length,
    everFree: vals.filter((v) => v.firstFree).length,
  };
}

// Noms actuellement marqués libres (les plus récemment vus d'abord).
export function allFree() {
  return Object.entries(load())
    .filter(([, v]) => v.state === 'free')
    .sort((a, b) => b[1].at - a[1].at)
    .map(([k]) => k);
}

export function searchFree(q) {
  const s = String(q).toLowerCase();
  return allFree().filter((n) => n.toLowerCase().includes(s));
}

export function clear() {
  cache = {};
  dirty = false;
  try { fs.rmSync(file(), { force: true }); } catch { /* ignore */ }
}

// Flush de sécurité à la sortie du process (writeFileSync = sync, OK dans 'exit').
process.on('exit', () => { try { flush(); } catch { /* ignore */ } });

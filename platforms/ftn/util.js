// Petites fonctions utilitaires partagées.
import { EventEmitter } from 'node:events';

// Bus d'événements : une éventuelle UI (Electron) s'y abonne pour afficher les
// logs en direct. Le CLI, lui, ignore le bus et lit simplement la sortie console.
export const bus = new EventEmitter();

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function emit(level, m) {
  // On envoie le message brut (sans codes couleur) à l'UI.
  bus.emit('log', { level, msg: stripAnsi(String(m)), t: Date.now() });
}

export const log = {
  info: (m) => { emit('info', m); console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${m}`); },
  ok: (m) => { emit('ok', m); console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.green}✓${COLORS.reset} ${m}`); },
  warn: (m) => { emit('warn', m); console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.yellow}!${COLORS.reset} ${m}`); },
  err: (m) => { emit('err', m); console.log(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.red}✗${COLORS.reset} ${m}`); },
  step: (m) => { emit('step', m); console.log(`\n${COLORS.cyan}▸ ${m}${COLORS.reset}`); },
};

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export const c = COLORS;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attente haute précision : setTimeout grossier puis busy-wait sur les derniers ms.
export async function sleepUntil(targetEpochMs, busyWindowMs = 15) {
  const coarseTarget = targetEpochMs - busyWindowMs;
  let remaining = coarseTarget - Date.now();
  if (remaining > 0) await sleep(remaining);
  // Busy-wait final pour la précision sub-milliseconde.
  while (Date.now() < targetEpochMs) { /* spin */ }
}

export function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  const parts = [];
  if (d) parts.push(`${d}j`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

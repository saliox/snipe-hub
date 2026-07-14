// Helpers réseau + journal + timing, compatibles React Native (fetch/AbortController).
// Remplace `undici` (Node-only) du moteur desktop : pas de pool de connexions
// bas-niveau sur mobile, mais on pré-chauffe les sockets TLS avant la rafale.

// --- Journal en direct (streamé vers l'UI) ---
const listeners = new Set();
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(level, msg) {
  const line = { t: nowMs(), level, msg: String(msg) };
  for (const fn of listeners) { try { fn(line); } catch { /* ignore */ } }
}
export const log = {
  step: (m) => emit('step', m),
  info: (m) => emit('info', m),
  ok: (m) => emit('ok', m),
  warn: (m) => emit('warn', m),
  err: (m) => emit('err', m),
};

// --- Horloge monotone quand dispo (précision sub-ms pour le burst) ---
export function nowMs() {
  try {
    if (typeof global !== 'undefined' && global.performance && global.performance.now) {
      // performance.now() est monotone ; on l'ancre sur Date.now() une fois.
      return perfBase + global.performance.now();
    }
  } catch { /* ignore */ }
  return Date.now();
}
const perfBase = (() => {
  try {
    if (typeof global !== 'undefined' && global.performance && global.performance.now) {
      return Date.now() - global.performance.now();
    }
  } catch { /* ignore */ }
  return 0;
})();

// --- Sommeil ---
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Attend un instant local absolu (ms epoch). Coarse via setTimeout puis spin
// serré sur les ~12 dernières ms pour absorber le jitter des timers RN.
export async function sleepUntil(targetMs, spinMs = 12) {
  let remaining = targetMs - nowMs();
  if (remaining > spinMs) await sleep(remaining - spinMs);
  // Spin actif final (mobile throttle les timers : on ne peut pas se fier au setTimeout au ms près).
  while (nowMs() < targetMs) { /* busy wait très court */ }
}

// Encode un corps application/x-www-form-urlencoded SANS dépendre de
// URLSearchParams (dont le polyfill React Native est incomplet selon les versions).
export function form(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// --- fetch avec timeout (AbortController) ---
export async function fetchT(url, { timeout = 8000, signal, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeout);
  // Combine un signal externe (abort-on-win) avec le timeout, défensivement :
  // certaines implémentations RN n'exposent pas addEventListener/reason.
  if (signal) {
    try {
      if (signal.aborted) ctrl.abort();
      else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => { try { ctrl.abort(); } catch { /* ignore */ } });
      }
    } catch { /* ignore */ }
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m${r ? ` ${r}s` : ''}`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h${rm ? ` ${rm}m` : ''}`;
}

// Check en masse : vérifie une liste de noms avec concurrence bornée.
//
// ⚠️ Différence desktop : le `fetch` React Native ne permet pas de router chaque
// requête via un proxy arbitraire (pas de dispatcher `undici`). La rotation de
// proxies du desktop N'EST DONC PAS portée ici — les checks partent de l'IP de
// l'appareil. On borne la concurrence pour rester correct vis-à-vis du rate-limit.
export async function runBulk({ names, check, concurrency = 12, onProgress }) {
  const clean = (names || []).map((s) => String(s).trim()).filter(Boolean);
  const results = new Array(clean.length);
  let idx = 0, done = 0;

  async function worker() {
    while (idx < clean.length) {
      const i = idx++;
      const name = clean[i];
      let r;
      try { r = await check(name); }
      catch (e) { r = { free: null, error: e?.message || String(e) }; }
      results[i] = { name, free: r?.free ?? null, note: r?.note, error: r?.error };
      onProgress?.({ done: ++done, total: clean.length, name });
    }
  }

  const n = Math.max(1, Math.min(concurrency, clean.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

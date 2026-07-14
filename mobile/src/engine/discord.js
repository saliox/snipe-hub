// Moteur Discord vanity (port mobile) : gestion multi-tokens, check anonyme de
// dispo d'un code, et burst PATCH /guilds/{id}/vanity-url sur TON serveur.
// L'endpoint « Modify Guild Vanity URL » est réservé aux BOTS.
import { fetchT, log, sleep, sleepUntil, nowMs } from './net.js';
import { getConfig, DISCORD_DEFAULT_UA } from './config.js';
import { secureGet, secureSet, secureDelete } from './secure.js';

const API = 'https://discord.com/api/v10';
const KEY = 'discord.bots';
const ua = () => getConfig().discordUA || DISCORD_DEFAULT_UA;

export function validVanity(code) { return /^[a-z0-9-]{2,32}$/.test(String(code || '').toLowerCase()); }
export function authHeader(token, type = 'bot') {
  const t = String(token || '').replace(/^Bot\s+/i, '').trim();
  return type === 'user' ? t : `Bot ${t}`;
}

async function apiGet(path, auth, { signal } = {}) {
  const headers = { 'user-agent': ua() };
  if (auth) headers.authorization = auth;
  return fetchT(`${API}${path}`, { method: 'GET', headers, signal, timeout: 8000 });
}

// Valide un token (bot puis user) et renvoie { token, type, user }.
export async function resolveToken(raw) {
  const token = String(raw || '').replace(/^Bot\s+/i, '').trim();
  if (!token) throw new Error('Token vide.');
  let lastErr;
  for (const type of ['bot', 'user']) {
    try {
      const res = await apiGet('/users/@me', authHeader(token, type));
      if (res.status === 200) { const u = await res.json(); return { token, type, user: u }; }
      if (res.status === 401) { lastErr = new Error('401'); continue; }
      throw new Error(`/users/@me ${res.status}`);
    } catch (e) { lastErr = e; if (!/401/.test(e.message)) throw e; }
  }
  throw new Error(`Token non reconnu (ni bot ni user). ${lastErr?.message || ''}`);
}

// --- Store multi-bots : [{ id, token, type, name }] ---
async function loadBots() { return (await secureGet(KEY))?.bots || []; }
async function saveBots(bots) { await secureSet(KEY, { bots }); }

export async function addTokens(input) {
  const parts = String(input || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Aucun token fourni.');
  const bots = await loadBots();
  const added = [];
  for (const raw of parts) {
    const r = await resolveToken(raw);
    const id = r.user?.id || `${nowMs()}-${added.length}`;
    const name = r.user?.username || r.user?.id || 'bot';
    const ex = bots.find((b) => b.id === id || b.token === r.token);
    if (ex) { ex.token = r.token; ex.type = r.type; ex.name = name; }
    else bots.push({ id, token: r.token, type: r.type, name });
    added.push(name);
  }
  await saveBots(bots);
  return { added, count: bots.length };
}
export async function removeBot(id) { await saveBots((await loadBots()).filter((b) => b.id !== id)); return loadBots(); }
export async function logout() { await secureDelete(KEY); }

export async function whoami() {
  const bots = await loadBots();
  if (!bots.length) return null;
  return { name: bots[0].name + (bots.length > 1 ? ` (+${bots.length - 1})` : ''), id: bots[0].id, bots };
}
export async function accountsList() {
  const bots = await loadBots();
  return bots.map((b) => ({ id: b.id, label: (b.type === 'user' ? '👤 ' : '🤖 ') + b.name, type: b.type }));
}

// --- Check anonyme : 404 = libre, 200 = pris (+ niveau de boost) ---
export async function checkVanityFree(code) {
  const res = await apiGet(`/invites/${encodeURIComponent(code)}?with_counts=true`, null);
  if (res.status === 404) { await res.text(); return { free: true }; }
  const txt = await res.text().catch(() => '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { /* HTML CF */ }
  if (res.status === 200) {
    const g = data?.guild || {};
    return { free: false, guild: g.name || null, premiumTier: g.premium_tier ?? null, boosts: g.premium_subscription_count ?? null };
  }
  if (res.status === 429 || res.status === 403) {
    const cf = /error code:\s*1015|<!DOCTYPE html|Cloudflare/i.test(txt);
    return { free: null, rateLimited: true, cloudflare: cf, status: res.status };
  }
  return { free: null, status: res.status };
}

// --- Burst PATCH depuis chaque bot en parallèle ---
async function warmupBot(auth) {
  try { const r = await apiGet('/users/@me', auth); await r.text(); } catch { /* ignore */ }
}
async function patchVanity(guildId, code, auth, signal) {
  const res = await fetchT(`${API}/guilds/${guildId}/vanity-url`, {
    method: 'PATCH',
    headers: { authorization: auth, 'content-type': 'application/json', 'user-agent': ua() },
    body: JSON.stringify({ code }), signal, timeout: 8000,
  });
  await res.text().catch(() => {});
  return { ok: res.status === 200, status: res.status };
}

// opts : { name(=code(s)), guildId, dropAt, monitor, burst, spacingMs, leadMs, offset, shouldStop }
export async function snipe(opts) {
  const { name, guildId, dropAt, monitor = false, burst = 6, spacingMs = 40, leadMs = 40, offset = 0, shouldStop } = opts;
  if (!guildId) throw new Error('Renseigne l\'ID de ton serveur.');
  const bots = (await loadBots()).filter((b) => b.type === 'bot');
  if (!bots.length) throw new Error('Le snipe de vanity exige au moins un token de BOT.');
  const codes = String(name).split(',').map((s) => s.trim()).filter(Boolean);
  const auths = bots.map((b) => authHeader(b.token, b.type));
  const toLocal = (realMs) => realMs - offset;

  const fire = async (code) => {
    const ctrl = new AbortController();
    let winner = null;
    const runs = [];
    for (const auth of auths) {
      runs.push((async () => {
        for (let i = 0; i < burst; i++) {
          if (winner || ctrl.signal.aborted) break;
          const r = await patchVanity(guildId, code, auth, ctrl.signal).catch(() => ({ ok: false }));
          if (r.ok && !winner) { winner = { code }; ctrl.abort(); log.ok(`🎯 vanity « ${code} » posée !`); }
          await sleep(spacingMs);
        }
      })());
    }
    await Promise.all(runs);
    return !!winner;
  };

  if (monitor) {
    log.step(`Surveillance de ${codes.join(', ')}`);
    await Promise.all(auths.map(warmupBot));
    let polls = 0;
    while (!(shouldStop && shouldStop())) {
      polls++;
      for (const code of codes) {
        const st = await checkVanityFree(code);
        if (st.rateLimited && st.cloudflare) { log.warn('Ban Cloudflare 1015 — pause 60s.'); await sleep(60000); break; }
        if (st.free) { log.ok(`${code} LIBRE — rafale !`); if (await fire(code)) return { success: true, code }; }
      }
      if (polls % 10 === 0) log.info(`...surveillance (${polls} sondages)`);
      await sleep(2000); // Discord/Cloudflare : rester modéré
    }
    log.warn('Surveillance arrêtée.');
    return { success: false, stopped: true };
  }

  if (!dropAt) throw new Error('Mode planifié : renseigne la date/heure du drop.');
  log.step(`Snipe planifié de ${codes[0]}`);
  await sleepUntil(toLocal(dropAt - 8000));
  await Promise.all(auths.map(warmupBot));
  await sleepUntil(toLocal(dropAt - leadMs), 15);
  const ok = await fire(codes[0]);
  if (!ok) log.err(`Échec du snipe de ${codes[0]}.`);
  return { success: ok, code: codes[0] };
}

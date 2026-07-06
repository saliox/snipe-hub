// Alertes à distance : webhook Discord (+ hook pour notif native côté GUI).
// Le webhook est un secret (qui l'a peut poster dans ton salon) : stocké chiffré
// au repos (securebox), avec surcharge possible par .env DISCORD_WEBHOOK_URL.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveEncrypted, loadEncrypted } from './securebox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function dataDir() { return process.env.SNIPE_DATA_DIR || path.join(__dirname, '..', 'data'); }
function file() { return path.join(dataDir(), 'alerts.enc'); }

export function getWebhookUrl() {
  const env = process.env.DISCORD_WEBHOOK_URL && process.env.DISCORD_WEBHOOK_URL.trim();
  if (env) return env;
  const s = loadEncrypted(file());
  return s?.webhookUrl || null;
}

export function setWebhookUrl(url) {
  const clean = String(url || '').trim();
  if (clean && !/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//i.test(clean)) {
    throw new Error('URL de webhook Discord invalide.');
  }
  saveEncrypted(file(), { webhookUrl: clean });
  return !!clean;
}

export function alertsConfigured() { return !!getWebhookUrl(); }

// Envoi bas niveau. Fail-silent (une alerte ratée ne doit jamais casser un snipe).
export async function sendDiscord({ content, embeds } = {}) {
  const url = getWebhookUrl();
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, embeds, username: 'Fortnite Sniper' }),
      signal: AbortSignal.timeout(6000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Alerte "nom libre" (claimed: true=réclamé, false=échec, null=juste détecté).
export async function alertFreeName(name, { claimed = null, account = null } = {}) {
  const title = claimed === true ? `🎯 « ${name} » RÉCLAMÉ !`
    : claimed === false ? `⚠️ « ${name} » était LIBRE — claim échoué`
      : `🔔 « ${name} » est LIBRE`;
  const color = claimed === true ? 0x57f287 : claimed === false ? 0xed4245 : 0x37e6ff;
  const fields = account ? [{ name: 'Compte', value: String(account), inline: true }] : undefined;
  return sendDiscord({ embeds: [{ title, color, fields, timestamp: new Date().toISOString() }] });
}

export async function testAlert() {
  return sendDiscord({ embeds: [{ title: '✅ Test — Fortnite Sniper', description: 'Les alertes Discord fonctionnent.', color: 0xa24bff, timestamp: new Date().toISOString() }] });
}

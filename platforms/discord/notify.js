// Notification par webhook Discord : poste un joli embed (ex. snipe réussi).
import { request } from 'undici';
import { UA } from './discord.js';

// Poste un embed sur un webhook Discord. url facultative → no-op.
export async function postWebhook(url, { title, description, color = 0x5865F2, fields } = {}) {
  const clean = String(url || '').trim();
  if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//i.test(clean)) {
    return { ok: false, error: 'URL de webhook Discord invalide' };
  }
  try {
    const { statusCode, body } = await request(clean, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({
        embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }],
      }),
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    await body.dump();
    return { ok: statusCode >= 200 && statusCode < 300, status: statusCode };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

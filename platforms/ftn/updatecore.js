// Cœur de l'auto-update, sans dépendance à Electron (donc testable en Node pur).
// Repris de snipe-mc, adapté au CLI : l'asset de release est un ZIP de sources
// (snipe-ftn.zip) et non un installeur .exe.
//
// Deux sources possibles :
//  - GitHub Releases (défaut, autonome) : le dépôt public sert de flux, aucune
//    config ni serveur requis.
//  - Flux HTTP générique (dev/LAN) : un dossier servi contenant latest.json
//    + le zip (voir scripts/serve-updates.mjs).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';

const UA = 'snipe-ftn-updater';

// Compare deux versions "x.y.z". Renvoie true si `a` est strictement plus récente que `b`.
export function isNewer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

// --- Source GitHub Releases ---
// repo = "owner/name". Renvoie { version, url, file, size, sha256, notes, assets }.
export async function fetchLatestGithub(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const { statusCode, body } = await request(url, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
    maxRedirections: 3, headersTimeout: 6000, bodyTimeout: 10000,
  });
  if (statusCode !== 200) {
    await body.dump();
    if (statusCode === 403) throw new Error('GitHub API 403 (limite de requêtes atteinte — réessaie plus tard).');
    if (statusCode === 404) throw new Error('Aucune release publiée (dépôt/release absent).');
    throw new Error(`GitHub API HTTP ${statusCode}`);
  }
  const rel = await body.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const assets = (rel.assets || []).map((a) => ({
    name: a.name, url: a.browser_download_url, size: a.size,
    sha256: (a.digest && a.digest.startsWith('sha256:')) ? a.digest.slice(7) : null,
  }));
  // CLI : on cherche le zip de sources (repli sur le 1er asset).
  const asset = assets.find((a) => /\.zip$/i.test(a.name)) || assets[0];
  if (!version || !asset) throw new Error('Release GitHub sans zip de sources');
  return { version, url: asset.url, file: asset.name, size: asset.size, sha256: asset.sha256, notes: rel.body || '', assets };
}

// --- Source HTTP générique (latest.json) ---
export async function fetchLatest(feedBase) {
  const base = ensureSlash(feedBase);
  const url = new URL('latest.json', base).toString();
  const { statusCode, body } = await request(url, { method: 'GET', headersTimeout: 5000, bodyTimeout: 8000 });
  if (statusCode !== 200) { await body.dump(); throw new Error(`latest.json HTTP ${statusCode}`); }
  const info = await body.json();
  if (!info || !info.version || !info.file) throw new Error('latest.json invalide (version/file manquants)');
  info.url = new URL(encodeURIComponent(info.file), base).toString();
  return info;
}

// Télécharge info.url dans `dest`, vérifie le SHA-256 si connu, renvoie `dest`.
// onProgress({ received, total, pct }) est appelé pendant le téléchargement.
export async function downloadTo(info, dest, onProgress) {
  const { statusCode, headers, body } = await request(info.url, {
    maxRedirections: 5,
    headers: { 'user-agent': UA },
  });
  if (statusCode !== 200) { await body.dump(); throw new Error(`téléchargement HTTP ${statusCode}`); }

  const total = Number(info.size) || Number(headers['content-length']) || 0;
  let received = 0;
  const hash = crypto.createHash('sha256');
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      if (onProgress) onProgress({ received, total, pct: total ? Math.round((received / total) * 100) : 0 });
      cb(null, chunk);
    },
  });

  await pipeline(body, meter, fs.createWriteStream(dest));

  const digest = hash.digest('hex').toLowerCase();
  if (info.sha256 && digest !== String(info.sha256).toLowerCase()) {
    fs.rmSync(dest, { force: true });
    throw new Error('Somme de contrôle SHA-256 invalide — fichier corrompu ou altéré.');
  }
  return dest;
}

function ensureSlash(base) {
  return base.endsWith('/') ? base : base + '/';
}

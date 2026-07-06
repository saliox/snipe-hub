// Génère le logo de Snipe Hub (réticule de visée cramoisi sur pastille sombre)
// en PUR Node : build/icon.png (256x256) + build/icon.ico.
// Aucune dépendance : rendu supersamplé (anti-aliasing), encodage PNG maison,
// empaquetage ICO (PNG intégré). Calque le logo SVG de la barre de titre.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });

const N = 256;         // taille finale
const SS = 4;          // supersampling
const H = N * SS;      // rendu hi-res

// Couleurs (thème « réticule grimdark »)
const BG_C = [22, 27, 38];    // centre du fond (#161b26)
const BG_E = [7, 9, 16];      // bord du fond (#070910)
const HALO = [237, 66, 69];   // halo rouge (#ED4245)
const RET_A = [255, 107, 111];// réticule haut-gauche (#ff6b6f)
const RET_B = [139, 0, 0];    // réticule bas-droite (#8B0000)
const DOT = [255, 107, 111];  // point central
const RIM = [10, 12, 20];     // liseré interne

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// Dégradé diagonal du réticule (top-left -> bottom-right, comme le SVG).
const retColor = (fx, fy) => mix(RET_A, RET_B, clamp((fx + fy + 300) / 600, 0, 1));

// Couleur (hard-edge) au point hi-res ; alpha 0 = transparent.
function colorAt(x, y) {
  const s = SS, cx = H / 2, cy = H / 2;
  const fx = (x - cx) / s, fy = (y - cy) / s;   // repère final centré (256)

  // Fond en carré arrondi (transparent dehors).
  const sd = sdRoundRect(fx, fy, 0, 0, 127, 127, 44);
  if (sd > 0) return [0, 0, 0, 0];

  const d = Math.hypot(fx, fy);

  // 1) Fond : dégradé radial + halo rouge en haut.
  let col = mix(BG_C, BG_E, clamp(d / 150, 0, 1));
  const halo = clamp(1 - Math.hypot(fx, fy + 18) / 120, 0, 1) * 0.35;
  col = mix(col, HALO, halo);

  const ret = retColor(fx, fy);

  // 2) Anneau de visée externe.
  if (Math.abs(d - 75) <= 4.6) col = ret;

  // 3) Anneau interne pointillé (6 tirets, ~46% pleins).
  if (Math.abs(d - 48) <= 2.6) {
    const a = (Math.atan2(fy, fx) / (2 * Math.PI) + 1) % 1;
    if ((a * 6) % 1 < 0.46) col = mix(col, ret, 0.7);
  }

  // 4) Croix de visée (4 traits, haut/bas/gauche/droite).
  const half = 4.6, inR = 60, outR = 93;
  if (Math.abs(fx) <= half && Math.abs(fy) >= inR && Math.abs(fy) <= outR) col = ret;
  if (Math.abs(fy) <= half && Math.abs(fx) >= inR && Math.abs(fx) <= outR) col = ret;

  // 5) Point central.
  if (d <= 14) col = DOT;

  // 6) Liseré interne fin (contour).
  if (sd > -3) col = mix(col, RIM, 0.6);

  return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255];
}

// Rendu hi-res puis downscale moyenné -> AA.
function render() {
  const out = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = colorAt(x * SS + sx + 0.5, y * SS + sy + 0.5);
          const af = pa / 255;
          r += pr * af; g += pg * af; b += pb * af; a += pa;
        }
      }
      const n = SS * SS, af = a / (255 * n), idx = (y * N + x) * 4;
      out[idx] = af ? Math.round(r / (af * n)) : 0;
      out[idx + 1] = af ? Math.round(g / (af * n)) : 0;
      out[idx + 2] = af ? Math.round(b / (af * n)) : 0;
      out[idx + 3] = Math.round(a / n);
    }
  }
  return out;
}

// --- Encodage PNG (RGBA 8 bits) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function pngToIco(png) {
  const dir = Buffer.alloc(6); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  const e = Buffer.alloc(16); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8); e.writeUInt32LE(22, 12);
  return Buffer.concat([dir, e, png]);
}

const rgba = render();
const png = encodePNG(N, N, rgba);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), pngToIco(png));
console.log(`Icône générée : build/icon.png (${(png.length / 1024).toFixed(1)} Ko) + build/icon.ico`);

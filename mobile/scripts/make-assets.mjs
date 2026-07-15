// Génère les assets de l'app mobile (réticule Snipe Hub) en PUR Node, sans
// dépendance — rendu supersamplé + encodage PNG maison, calqué sur le logo desktop.
//   assets/icon.png          1024² plein cadre opaque (icône iOS + fallback)
//   assets/adaptive-icon.png 1024² réticule transparent (avant-plan Android)
//   assets/splash-icon.png   1024² réticule transparent (splash, plus petit)
//   assets/favicon.png       48²   plein cadre (web)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'assets');
fs.mkdirSync(outDir, { recursive: true });

const BG_C = [22, 27, 38], BG_E = [7, 9, 16], HALO = [237, 66, 69];
const RET_A = [255, 107, 111], RET_B = [139, 0, 0], DOT = [255, 107, 111];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
const retColor = (fx, fy) => mix(RET_A, RET_B, clamp((fx + fy + 300) / 600, 0, 1));

// Couleur au point (fx,fy) exprimé dans le repère 256 centré ([-128,128]).
function colorAt(fx, fy, drawBg) {
  const d = Math.hypot(fx, fy);
  const ret = retColor(fx, fy);
  let col = null;
  if (drawBg) {
    col = mix(BG_C, BG_E, clamp(d / 150, 0, 1));
    const halo = clamp(1 - Math.hypot(fx, fy + 18) / 120, 0, 1) * 0.35;
    col = mix(col, HALO, halo);
  }
  let mark = null;
  if (Math.abs(d - 75) <= 4.6) mark = ret;                                   // anneau externe
  if (Math.abs(d - 48) <= 2.6) {                                             // anneau pointillé
    const a = (Math.atan2(fy, fx) / (2 * Math.PI) + 1) % 1;
    if ((a * 6) % 1 < 0.46) mark = mix(col || ret, ret, drawBg ? 0.7 : 1);
  }
  const half = 4.6, inR = 60, outR = 93;                                     // croix de visée
  if (Math.abs(fx) <= half && Math.abs(fy) >= inR && Math.abs(fy) <= outR) mark = ret;
  if (Math.abs(fy) <= half && Math.abs(fx) >= inR && Math.abs(fx) <= outR) mark = ret;
  if (d <= 14) mark = DOT;                                                   // point central
  if (mark) col = mark;
  if (!col) return [0, 0, 0, 0];
  return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255];
}

// Rendu d'une image size×size. drawBg=fond plein ; scale<1 = réticule plus petit.
function render(size, { drawBg, scale = 1, ss = 2 }) {
  const out = Buffer.alloc(size * size * 4);
  const toF = (p) => ((p / (size / 2)) - 1) * 128 / scale; // pixel -> repère 256, scalé
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [pr, pg, pb, pa] = colorAt(toF(x + (sx + 0.5) / ss), toF(y + (sy + 0.5) / ss), drawBg);
          const af = pa / 255; r += pr * af; g += pg * af; b += pb * af; a += pa;
        }
      }
      const n = ss * ss, af = a / (255 * n), idx = (y * size + x) * 4;
      out[idx] = af ? Math.round(r / (af * n)) : 0;
      out[idx + 1] = af ? Math.round(g / (af * n)) : 0;
      out[idx + 2] = af ? Math.round(b / (af * n)) : 0;
      out[idx + 3] = Math.round(a / n);
    }
  }
  return out;
}

// --- Encodage PNG (RGBA 8 bits) ---
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const write = (name, size, opts) => {
  const png = encodePNG(size, size, render(size, opts));
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`  ${name} (${size}²) — ${(png.length / 1024).toFixed(1)} Ko`);
};

console.log('Génération des assets Snipe Hub :');
write('icon.png', 1024, { drawBg: true, scale: 0.82 });
write('adaptive-icon.png', 1024, { drawBg: false, scale: 0.60 });
write('splash-icon.png', 1024, { drawBg: false, scale: 0.40 });
write('favicon.png', 48, { drawBg: true, scale: 0.82, ss: 4 });
console.log('OK → mobile/assets/');

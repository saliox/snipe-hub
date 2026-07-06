// Coffre chiffré simple pour secrets au repos (cookie .ROBLOSECURITY). AES-256-GCM,
// clé dérivée (scrypt) d'un identifiant machine + utilisateur + sel aléatoire persistant.
// Pur Node : le fichier copié/synchronisé sur une AUTRE machine/utilisateur est indéchiffrable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function keyFor(saltPath) {
  let salt;
  try {
    salt = fs.readFileSync(saltPath);
    if (salt.length < 16) throw new Error('sel invalide');
  } catch {
    salt = crypto.randomBytes(16);
    fs.mkdirSync(path.dirname(saltPath), { recursive: true });
    fs.writeFileSync(saltPath, salt);
    try { fs.chmodSync(saltPath, 0o600); } catch { /* no-op Windows */ }
  }
  const material = `${os.hostname()}|${os.userInfo().username}|snipe-roblox-v1`;
  return crypto.scryptSync(material, salt, 32);
}

export function saveEncrypted(filePath, obj) {
  const key = keyFor(filePath + '.salt');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([iv, tag, data]));
  try { fs.chmodSync(filePath, 0o600); } catch { /* no-op Windows */ }
}

export function loadEncrypted(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(filePath + '.salt'), iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch { return null; }
}

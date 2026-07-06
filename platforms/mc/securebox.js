// Coffre chiffré simple pour secrets au repos (tokens). AES-256-GCM, clé dérivée
// (scrypt) d'un identifiant machine + utilisateur + sel aléatoire persistant.
// Pur Node (aucune dépendance Electron) : fonctionne pour le CLI comme le GUI.
//
// Menace couverte : vol/sync cloud du fichier, copie sur une AUTRE machine ou
// un AUTRE compte utilisateur -> indéchiffrable (la clé dépend hostname+user).
// Non couvert : attaquant local, même utilisateur (il peut de toute façon
// lancer l'app). Suffisant comme chiffrement au repos.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Dérive la clé AES-256 depuis le sel persistant `saltPath`.
// `hasCiphertext` : true s'il existe DÉJÀ des données chiffrées dépendant de ce sel.
// Dans ce cas, si le sel est absent/tronqué, régénérer un nouveau sel rendrait ces
// données indéchiffrables EN SILENCE : on refuse et on lève une erreur SALT_MISSING
// claire. On ne génère un sel neuf QUE lors d'une première initialisation (aucune
// donnée chiffrée existante).
function keyFor(saltPath, hasCiphertext) {
  let salt = null;
  try {
    const s = fs.readFileSync(saltPath);
    if (s.length >= 16) salt = s;
  } catch { /* sel absent */ }

  if (!salt) {
    if (hasCiphertext) {
      const err = new Error('SALT_MISSING : sel de chiffrement absent ou corrompu alors que des données chiffrées existent — déchiffrement impossible (relance le login).');
      err.code = 'SALT_MISSING';
      throw err;
    }
    salt = crypto.randomBytes(16);
    fs.mkdirSync(path.dirname(saltPath), { recursive: true });
    fs.writeFileSync(saltPath, salt);
    try { fs.chmodSync(saltPath, 0o600); } catch { /* no-op Windows */ }
  }
  const material = `${os.hostname()}|${os.userInfo().username}|snipe-mc-v1`;
  return crypto.scryptSync(material, salt, 32);
}

export function saveEncrypted(filePath, obj) {
  // Écriture : on RÉÉCRIT entièrement le fichier, donc régénérer un sel absent est
  // sans risque (pas de donnée existante perdue) -> hasCiphertext=false.
  const key = keyFor(filePath + '.salt', false);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([iv, tag, data]));
  try { fs.chmodSync(filePath, 0o600); } catch { /* no-op Windows */ }
}

export function loadEncrypted(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch { return null; } // pas de fichier chiffré (jamais connecté)
  try {
    if (buf.length < 28) return null; // iv(12)+tag(16) minimum
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    // Des données chiffrées EXISTENT : hasCiphertext=true -> refuse de régénérer le sel.
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(filePath + '.salt', true), iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch (e) {
    // Surface la cause précise (sel perdu) au lieu d'un null aveugle.
    if (e && e.code === 'SALT_MISSING') {
      console.error(`[securebox] ${filePath} : ${e.message}`);
    }
    return null;
  }
}

// --- Variante « chaîne » : chiffre/déchiffre un secret pour l'intégrer dans un JSON
// (ex. accounts.json quand le coffre OS safeStorage est indisponible). Le sel est
// persistant dans `saltPath` et partagé par toutes les valeurs de ce fichier.
export function encryptString(plaintext, saltPath) {
  // Production de nouvelles données -> régénération d'un sel absent tolérée.
  const key = keyFor(saltPath, false);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64');
}

export function decryptString(b64, saltPath) {
  const buf = Buffer.from(String(b64), 'base64');
  if (buf.length < 28) throw new Error('Données chiffrées invalides (trop courtes).');
  // On DÉTIENT des données chiffrées -> hasCiphertext=true (refus si sel perdu).
  const key = keyFor(saltPath, true);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

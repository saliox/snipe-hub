// Coffre chiffré simple pour secrets au repos (tokens). AES-256-GCM, clé dérivée
// (scrypt) d'un identifiant machine + utilisateur + sel aléatoire persistant.
// Pur Node (aucune dépendance Electron) : fonctionne pour le CLI comme le GUI.
//
// Menace couverte : vol/sync cloud du fichier, copie sur une AUTRE machine ou
// un AUTRE compte utilisateur -> indéchiffrable (la clé dépend hostname+user).
// Non couvert : attaquant local, même utilisateur (il peut de toute façon
// lancer l'app). Suffisant comme chiffrement au repos.
//
// ┌─ COPIE SYNCHRONISÉE ────────────────────────────────────────────────────────┐
// │ Ce fichier est identique dans les 6 moteurs, À UNE LIGNE PRÈS : le suffixe   │
// │ de `material` ci-dessous. Les moteurs sont volontairement autonomes (aucun   │
// │ import hors de leur dossier) pour pouvoir être ré-extraits en projets        │
// │ séparés — d'où la copie plutôt qu'un module commun.                          │
// │ Toute correction doit être appliquée AUX SIX. Le test                        │
// │ test/unit/securebox.test.mjs est paramétré sur les 6 et échoue si l'une      │
// │ d'elles diverge (c'est ainsi qu'on a découvert que 5 coffres sur 6           │
// │ régénéraient le sel en silence, détruisant les identifiants).                │
// └─────────────────────────────────────────────────────────────────────────────┘
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Cache des clés dérivées. scryptSync coûte 30-80 ms de CPU BLOQUANT (N=16384, 16 Mo)
// et était rejoué à CHAQUE lecture de coffre : un balayage de watchlist de 50 entrées
// figeait la boucle d'événements 1,5 à 4 s — y compris pendant une rafale de tir.
// La clé est mémoïsée par chemin de sel ET par CONTENU du sel : si le sel change sur
// disque (restauration, nouvelle init), la clé est re-dérivée automatiquement.
const KEY_CACHE = new Map(); // saltPath -> { saltHex, key }

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
    KEY_CACHE.delete(saltPath);            // sel neuf : toute clé mémoïsée est périmée
  }

  const saltHex = salt.toString('hex');
  const hit = KEY_CACHE.get(saltPath);
  if (hit && hit.saltHex === saltHex) return hit.key;

  const material = `${os.hostname()}|${os.userInfo().username}|snipe-x-v1`;
  const key = crypto.scryptSync(material, salt, 32);
  KEY_CACHE.set(saltPath, { saltHex, key });
  return key;
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
  // Écriture ATOMIQUE : écrire directement sur le fichier final laissait un coffre
  // TRONQUÉ si le process mourait en cours d'écriture (crash, extinction, antivirus)
  // -> loadEncrypted renvoyait null et TOUS les identifiants étaient perdus. Le
  // fichier est réécrit à chaque refresh de token, donc la fenêtre se répétait.
  // rename() est atomique sur NTFS comme sur POSIX.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([iv, tag, data]));
  try { fs.chmodSync(tmp, 0o600); } catch { /* no-op Windows */ }
  fs.renameSync(tmp, filePath);
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

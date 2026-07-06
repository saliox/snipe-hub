// Auto-update côté CLI (équivalent de gui/updater.js de snipe-mc, sans Electron).
// S'appuie sur updatecore.js pour la logique réseau ; ici on gère la version
// locale, l'extraction du zip de sources et le remplacement des fichiers.
//
// AUTONOME par défaut : se met à jour depuis les Releases GitHub du dépôt public
// DEFAULT_REPO, sans aucune config ni serveur. Overrides via .env :
//   UPDATE_REPO=owner/name        (autre dépôt GitHub)
//   UPDATE_URL=http://ip:8770/    (flux HTTP local, voir scripts/serve-updates.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, c, fmtDuration } from './util.js';
import { isNewer, fetchLatest, fetchLatestGithub, downloadTo } from './updatecore.js';

const DEFAULT_REPO = 'saliox/snipe-ftn';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // racine du projet

function source() {
  const feedUrl = process.env.UPDATE_URL && process.env.UPDATE_URL.trim();
  const repo = (process.env.UPDATE_REPO && process.env.UPDATE_REPO.trim()) || DEFAULT_REPO;
  return feedUrl ? { kind: 'http', base: feedUrl } : { kind: 'github', repo };
}

export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

// Fichier de suivi de la dernière vérification (pour le check quotidien discret).
function stampFile() {
  const dir = process.env.SNIPE_DATA_DIR || path.join(ROOT, 'data');
  return path.join(dir, 'update-check.json');
}

// Récupère les infos de la dernière release. Renvoie { available, current, version, notes, info }.
export async function checkForUpdates() {
  const src = source();
  const info = src.kind === 'http' ? await fetchLatest(src.base) : await fetchLatestGithub(src.repo);
  const current = currentVersion();
  return { available: isNewer(info.version, current), current, version: info.version, notes: info.notes || '', info };
}

// Vérification discrète, au plus une fois par 24 h, non bloquante en cas d'échec.
// Affiche un simple avis si une nouvelle version existe. Retourne true si avis affiché.
export async function maybeNotify(maxAgeMs = 24 * 3600 * 1000) {
  try {
    const f = stampFile();
    let last = 0;
    try { last = JSON.parse(fs.readFileSync(f, 'utf8')).t || 0; } catch {}
    if (Date.now() - last < maxAgeMs) return false;

    // On horodate la TENTATIVE tout de suite : ainsi une release absente ou un
    // réseau coupé ne relance pas la vérif (jusqu'à 2,5 s) à chaque commande.
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ t: Date.now() }));
    } catch {}

    const res = await Promise.race([
      checkForUpdates(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ]);

    if (res.available) {
      console.log(
        `\n${c.yellow}★ Mise à jour disponible${c.reset} : ${res.current} → ${c.green}${res.version}${c.reset}. ` +
        `Lance ${c.cyan}node src/index.js update${c.reset} pour l'installer.\n`
      );
      return true;
    }
  } catch { /* réseau indisponible / repo absent : on ignore silencieusement */ }
  return false;
}

// Vérifie puis, si dispo (ou si force), télécharge et applique la mise à jour.
export async function runUpdate({ check = false } = {}) {
  log.step('Recherche de mise à jour');
  const src = source();
  log.info(`Source : ${src.kind === 'http' ? src.base : 'github:' + src.repo}`);

  let res;
  try {
    res = await checkForUpdates();
  } catch (e) {
    log.err(`Vérification impossible : ${e.message}`);
    return;
  }

  log.info(`Version locale : ${res.current}  |  distante : ${res.version}`);
  if (!res.available) { log.ok('Déjà à jour.'); return; }
  if (res.notes) log.info(`Notes : ${res.notes.split('\n')[0]}`);
  if (check) {
    log.warn(`Mise à jour ${res.version} disponible. Relance sans --check pour l'installer.`);
    return;
  }

  await applyUpdate(res.info);
}

// Télécharge le zip de sources, l'extrait, remplace les fichiers du projet,
// puis réinstalle les dépendances. Ne touche pas à data/ ni .env (absents du zip).
export async function applyUpdate(info) {
  const started = Date.now();
  const tmpZip = path.join(os.tmpdir(), 'snipe-ftn-update.zip');
  const staging = path.join(os.tmpdir(), 'snipe-ftn-update-staging');

  log.step(`Téléchargement de la version ${info.version}`);
  let lastPct = -1;
  await downloadTo(info, tmpZip, ({ pct }) => {
    if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`  ${pct}%\r`); }
  });
  process.stdout.write('        \r');
  log.ok('Téléchargement terminé, extraction...');

  // Extraction via PowerShell (pas de dépendance de dézippage). Windows-only,
  // comme tout l'écosystème de ces outils.
  fs.rmSync(staging, { recursive: true, force: true });
  const q = (s) => String(s).replace(/'/g, "''");
  const exp = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -LiteralPath '${q(tmpZip)}' -DestinationPath '${q(staging)}' -Force`], { stdio: 'inherit' });
  if (exp.status !== 0) { log.err('Échec de l\'extraction (Expand-Archive).'); return; }

  // Le zip peut contenir les fichiers à la racine, ou dans un sous-dossier unique.
  const srcRoot = resolveStagingRoot(staging);

  // Remplace les fichiers (src/, scripts/, package.json, README, .env.example…).
  // fs.cpSync ne copie que ce qui existe dans le zip : data/ et .env sont préservés.
  log.info('Remplacement des fichiers...');
  fs.cpSync(srcRoot, ROOT, { recursive: true, force: true });

  // Si la MAJ embarque déjà les deps runtime (node_modules/undici), on évite
  // npm install — indispensable sur une machine sans Node/npm (app packagée).
  if (fs.existsSync(path.join(srcRoot, 'node_modules', 'undici'))) {
    log.info('Dépendances embarquées dans la MAJ — pas de npm install nécessaire.');
  } else {
    log.info('Réinstallation des dépendances (npm install)...');
    // shell:true requis sous Windows : depuis un correctif de sécurité Node,
    // spawn refuse de lancer un .cmd (npm.cmd) sans passer par le shell.
    const ni = spawnSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit', shell: true });
    if (ni.status !== 0) log.warn('npm install a échoué — lance-le à la main si besoin.');
  }

  fs.rmSync(tmpZip, { force: true });
  fs.rmSync(staging, { recursive: true, force: true });

  log.ok(`${c.green}Mis à jour vers ${info.version}${c.reset} en ${fmtDuration(Date.now() - started)}. ` +
    `Relance ta commande.`);
}

// Trouve le vrai dossier racine dans le staging : si un seul sous-dossier
// contient package.json, c'est lui ; sinon le staging lui-même.
function resolveStagingRoot(staging) {
  if (fs.existsSync(path.join(staging, 'package.json'))) return staging;
  const entries = fs.readdirSync(staging, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const e of entries) {
    const sub = path.join(staging, e.name);
    if (fs.existsSync(path.join(sub, 'package.json'))) return sub;
  }
  return staging;
}

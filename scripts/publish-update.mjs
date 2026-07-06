// Prépare et publie une mise à jour : construit l'installeur si besoin, calcule
// son SHA-256, écrit release/latest.json, et crée la Release GitHub (installeur +
// app.zip différentiel). Les apps clientes se mettent à jour toutes seules ensuite.
//
//   node scripts/publish-update.mjs ["notes de version"]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const notes = process.argv.slice(2).join(' ');

const installerName = `Snipe Hub Setup ${version}.exe`;
const installerPath = path.join(root, 'dist', installerName);
const releaseDir = path.join(root, 'release');

// 1. S'assurer que l'installeur de cette version existe (sinon : electron-builder).
if (!fs.existsSync(installerPath)) {
  console.log(`Installeur ${version} absent, construction (electron-builder)...`);
  // npm.cmd sur Windows (sans shell:true → évite DEP0190 et toute concaténation d'args).
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, ['run', 'dist'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(installerPath)) {
    console.error(`Échec de la construction de l'installeur (attendu : dist/${installerName}).`);
    process.exit(1);
  }
}

// 2. SHA-256 + taille.
const buf = fs.readFileSync(installerPath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const size = buf.length;

// 3. Dossier release/ : installeur + latest.json.
fs.mkdirSync(releaseDir, { recursive: true });
fs.copyFileSync(installerPath, path.join(releaseDir, installerName));

const latest = {
  version,
  file: installerName,
  sha256,
  size,
  notes,
  pubDate: new Date().toISOString(),
};
const latestJsonPath = path.join(releaseDir, 'latest.json');
fs.writeFileSync(latestJsonPath, JSON.stringify(latest, null, 2));

console.log('Feed local prêt dans release/ :');
console.log(`  version : ${version}  |  ${(size / 1e6).toFixed(1)} Mo  |  sha256 ${sha256.slice(0, 12)}…`);

// 4. Publication GitHub Releases (canal d'auto-update autonome).
//    Nécessite gh authentifié. Si la release existe déjà, on remplace l'asset.
const tag = `v${version}`;
console.log(`\nPublication GitHub (${tag})...`);
const exists = spawnSync('gh', ['release', 'view', tag], { stdio: 'ignore' }).status === 0;
let gh;
// On publie AUSSI latest.json comme asset : c'est le repli qui porte le sha256
// quand GitHub ne fournit pas de `digest` (fetchLatestGithub le lit pour vérifier).
if (exists) {
  console.log('  release existante → remplacement de l\'asset');
  gh = spawnSync('gh', ['release', 'upload', tag, installerPath, latestJsonPath, '--clobber'], { stdio: 'inherit' });
} else {
  gh = spawnSync('gh', ['release', 'create', tag, installerPath, latestJsonPath,
    '--title', `Snipe Hub ${version}`, '--notes', notes || `Snipe Hub ${version}`], { stdio: 'inherit' });
}
if (gh.status !== 0) {
  console.error('\n⚠ Publication GitHub échouée (gh non authentifié ?). Le feed local reste utilisable.');
  process.exit(1);
}

// 5. MAJ différentielle : app.zip (juste resources/app) + app-update.json.
//    Permet aux clients de ne télécharger ~1 Mo au lieu de l'installeur complet
//    quand le runtime Electron est inchangé.
try {
  const portableApp = path.join(root, 'dist', 'win-unpacked', 'resources', 'app');
  const appZip = path.join(root, 'dist', 'app.zip');
  fs.rmSync(appZip, { force: true });
  const z = spawnSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${portableApp}' -DestinationPath '${appZip}' -Force`], { stdio: 'inherit' });
  if (z.status === 0 && fs.existsSync(appZip)) {
    const zbuf = fs.readFileSync(appZip);
    const electronVer = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
    const meta = { version, electron: electronVer, sha256: crypto.createHash('sha256').update(zbuf).digest('hex'), size: zbuf.length };
    const metaFile = path.join(root, 'dist', 'app-update.json');
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    const up = spawnSync('gh', ['release', 'upload', tag, appZip, metaFile, '--clobber'], { stdio: 'inherit' });
    if (up.status === 0) console.log(`  ✓ MAJ différentielle publiée (app.zip ${(zbuf.length / 1e6).toFixed(1)} Mo, electron ${electronVer})`);
  } else {
    console.log('  (app.zip non créé — les clients utiliseront l\'installeur complet)');
  }
} catch (e) {
  console.log('  (MAJ différentielle ignorée :', e.message, ')');
}

console.log(`\n✓ Publié : https://github.com/saliox/snipe-hub/releases/tag/${tag}`);
console.log('  Les apps installées le récupéreront automatiquement au prochain lancement.');

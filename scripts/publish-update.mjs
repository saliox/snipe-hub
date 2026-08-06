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

// Date du fichier source le plus récent : sert à détecter un installeur périmé.
function newestSourceMs() {
  let newest = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|json|html|css)$/.test(e.name)) {
        try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* ignore */ }
      }
    }
  };
  for (const d of ['gui', 'core', 'adapters', 'platforms']) walk(path.join(root, d));
  try { newest = Math.max(newest, fs.statSync(path.join(root, 'package.json')).mtimeMs); } catch { /* ignore */ }
  return newest;
}

// 1. S'assurer que l'installeur de cette version existe ET qu'il est à jour.
//    Sans ce contrôle, corriger du code sans bumper la version republiait en ~2 s
//    l'installeur d'un build PRÉCÉDENT : les correctifs n'y étaient pas, et aucun
//    client ne se mettait à jour (isNewer renvoie false à version égale).
const stale = fs.existsSync(installerPath) && fs.statSync(installerPath).mtimeMs < newestSourceMs();
if (stale) console.log(`⚠ dist/${installerName} est plus ancien que les sources → reconstruction.`);
if (!fs.existsSync(installerPath) || stale) {
  console.log(`Installeur ${version} absent ou périmé, construction (electron-builder)...`);
  // shell:true est nécessaire pour résoudre npm(.cmd) sur Windows. Les arguments sont
  // STATIQUES ('run','dist') → aucune surface d'injection (l'avertissement DEP0190,
  // qui concerne des args non échappés, ne s'applique pas ici).
  const r = spawnSync('npm', ['run', 'dist'], { cwd: root, stdio: 'inherit', shell: true });
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
// Tous les appels gh sont ancrés sur la racine du projet ET sur le dépôt explicite :
// lancé depuis un autre dossier (tâche planifiée, chemin absolu), gh ciblait sinon le
// dépôt du répertoire courant — ou échouait en laissant croire à un problème d'auth.
const REPO = 'saliox/snipe-hub';
const ghOpts = { cwd: root, stdio: 'ignore' };
const viewed = spawnSync('gh', ['release', 'view', tag, '--repo', REPO], ghOpts);
if (viewed.error) {
  console.error(`\n⚠ gh introuvable (${viewed.error.message}) — installe GitHub CLI ou publie à la main.`);
  process.exit(1);
}
const exists = viewed.status === 0;   // status != 0 ici = release absente, pas gh cassé
let gh;
// On publie AUSSI latest.json comme asset : c'est le repli qui porte le sha256
// quand GitHub ne fournit pas de `digest` (fetchLatestGithub le lit pour vérifier).
if (exists) {
  console.log('  release existante → remplacement de l\'asset');
  gh = spawnSync('gh', ['release', 'upload', tag, installerPath, latestJsonPath, '--clobber', '--repo', REPO],
    { cwd: root, stdio: 'inherit' });
} else {
  gh = spawnSync('gh', ['release', 'create', tag, installerPath, latestJsonPath, '--repo', REPO,
    '--title', `Snipe Hub ${version}`, '--notes', notes || `Snipe Hub ${version}`], { cwd: root, stdio: 'inherit' });
}
if (gh.status !== 0) {
  console.error('\n⚠ Publication GitHub échouée (gh non authentifié ?). Le feed local reste utilisable.');
  process.exit(1);
}

// 5. MAJ différentielle : app.zip (juste resources/app) + app-update.json.
//    Permet aux clients de ne télécharger ~1 Mo au lieu de l'installeur complet
//    quand le runtime Electron est inchangé.
try {
  // electron-builder empaquette en asar (défaut) : il produit resources/app.asar et
  // AUCUN dossier resources/app. Le script zippait donc un chemin inexistant, app.zip
  // n'était jamais créé, et tout le chemin différentiel de core/updater.js était mort
  // (chaque client retéléchargeait l'installeur complet de ~79 Mo).
  // applyAppZip fait Expand-Archive vers <install>\resources : un app.zip contenant
  // app.asar à sa racine remplace donc directement le bon fichier.
  const portableApp = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
  const appZip = path.join(root, 'dist', 'app.zip');
  fs.rmSync(appZip, { force: true });
  if (!fs.existsSync(portableApp)) {
    throw new Error(`${path.relative(root, portableApp)} absent — lance d'abord « npm run dist »`);
  }
  const z = spawnSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${portableApp}' -DestinationPath '${appZip}' -Force`], { stdio: 'inherit' });
  if (z.status === 0 && fs.existsSync(appZip)) {
    const zbuf = fs.readFileSync(appZip);
    const electronVer = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
    const meta = { version, electron: electronVer, sha256: crypto.createHash('sha256').update(zbuf).digest('hex'), size: zbuf.length };
    const metaFile = path.join(root, 'dist', 'app-update.json');
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    const up = spawnSync('gh', ['release', 'upload', tag, appZip, metaFile, '--clobber', '--repo', REPO],
      { cwd: root, stdio: 'inherit' });
    if (up.status === 0) console.log(`  ✓ MAJ différentielle publiée (app.zip ${(zbuf.length / 1e6).toFixed(1)} Mo, electron ${electronVer})`);
  } else {
    console.log('  (app.zip non créé — les clients utiliseront l\'installeur complet)');
  }
} catch (e) {
  console.log('  (MAJ différentielle ignorée :', e.message, ')');
}

console.log(`\n✓ Publié : https://github.com/saliox/snipe-hub/releases/tag/${tag}`);
console.log('  Les apps installées le récupéreront automatiquement au prochain lancement.');

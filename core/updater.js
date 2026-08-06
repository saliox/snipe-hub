// Auto-update côté Electron (processus principal). S'appuie sur src/updatecore.js
// pour la logique réseau, et pilote l'UI + le lancement de l'installeur.
//
// AUTONOME : se met à jour depuis les Releases GitHub du dépôt public
// DEFAULT_REPO, sans aucune config, aucun serveur, aucune adresse IP.
// Seul override .env : UPDATE_REPO=owner/name (autre dépôt GitHub — jamais une IP).
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isNewer, fetchLatestGithub, downloadTo, fetchJson } from '../platforms/mc/updatecore.js';

const DEFAULT_REPO = 'saliox/snipe-hub';

let getWin = () => null;
let source = { repo: DEFAULT_REPO };
let lastInfo = null;
let busy = false;

export function initUpdater(winGetter) {
  getWin = winGetter;
  const repo = (process.env.UPDATE_REPO && process.env.UPDATE_REPO.trim()) || DEFAULT_REPO;
  source = { repo };
  console.log(`[update] source: github:${source.repo}`);
}

function send(channel, data) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

// Vérifie la présence d'une mise à jour. silent=false -> on notifie aussi
// "à jour"/"désactivé"/"erreur" (bouton manuel) ; silent=true -> on ne
// remonte que si une MAJ est disponible (vérif de démarrage).
export async function checkForUpdates({ silent = true } = {}) {
  try {
    const info = await fetchLatestGithub(source.repo);
    const current = app.getVersion();
    const available = isNewer(info.version, current);
    lastInfo = info;
    console.log(`[update] actuel=${current} distant=${info.version} dispo=${available}`);
    if (available) send('update-status', { state: 'available', current, version: info.version, notes: info.notes || '' });
    else if (!silent) send('update-status', { state: 'uptodate', current });
    return { available, current, version: info.version };
  } catch (e) {
    console.log('[update] échec de la vérification:', e.message);
    if (!silent) send('update-status', { state: 'error', error: e.message });
    return { available: false, error: e.message };
  }
}

// Télécharge la MAJ puis l'installe. Essaie d'abord la MAJ DIFFÉRENTIELLE
// (app.zip ~1 Mo, si le runtime Electron est inchangé), sinon l'installeur complet.
export async function applyUpdate() {
  if (busy) return { ok: false, error: 'Mise à jour déjà en cours' };
  if (!lastInfo) return { ok: false, error: 'Aucune mise à jour prête' };
  busy = true;
  try {
    if (await tryAppOnlyUpdate()) return { ok: true };

    // Repli : installeur complet.
    const dest = path.join(os.tmpdir(), sanitize(lastInfo.file));
    send('update-status', { state: 'downloading' });
    await downloadTo(lastInfo, dest, (p) => send('update-progress', p));
    send('update-status', { state: 'installing' });
    quitAndInstall(dest);
    return { ok: true };
  } catch (e) {
    send('update-status', { state: 'error', error: e.message });
    return { ok: false, error: e.message };
  } finally {
    // Le verrou n'était relâché QUE sur erreur : si la fermeture n'aboutissait pas
    // (installeur bloqué par l'antivirus, app.quit() empêché), le bouton MàJ répondait
    // « Mise à jour déjà en cours » jusqu'au redémarrage manuel. Le quit intervient de
    // toute façon ~400 ms plus tard, donc relâcher ici ne crée pas de double install.
    busy = false;
  }
}

// MAJ différentielle : ne remplace que resources/app (code), ~1 Mo au lieu de 81 Mo.
// Conditions : assets app.zip + app-update.json présents et MÊME version majeure
// d'Electron (pas de changement de runtime). Renvoie true si appliquée.
async function tryAppOnlyUpdate() {
  try {
    const assets = lastInfo.assets || [];
    const metaAsset = assets.find((a) => a.name === 'app-update.json');
    const zipAsset = assets.find((a) => a.name === 'app.zip');
    if (!metaAsset || !zipAsset) return false;

    const meta = await fetchJson(metaAsset.url);
    const curMajor = String(process.versions.electron || '').split('.')[0];
    const newMajor = String(meta.electron || '').split('.')[0];
    if (!curMajor || curMajor !== newMajor) {
      console.log(`[update] runtime Electron différent (${curMajor}->${newMajor}) : installeur complet`);
      return false;
    }

    const dest = path.join(os.tmpdir(), 'snipemc-app.zip');
    send('update-status', { state: 'downloading' });
    // Préfère le digest calculé par GitHub (serveur) ; repli sur app-update.json.
    await downloadTo({ url: zipAsset.url, size: meta.size, sha256: zipAsset.sha256 || meta.sha256 }, dest, (p) => send('update-progress', p));
    send('update-status', { state: 'installing' });
    applyAppZip(dest, meta.version || lastInfo.version);
    return true;
  } catch (e) {
    console.log('[update] MAJ différentielle impossible, repli installeur :', e.message);
    return false;
  }
}

// Remplace resources/app par le contenu de app.zip (racine = dossier app/) via un
// script PowerShell détaché, puis relance l'app.
function applyAppZip(zipPath, version) {
  // Échappe les apostrophes pour les chaînes PowerShell (ex. C:\Users\O'Brien).
  const q = (s) => String(s).replace(/'/g, "''");
  const exe = process.execPath;
  const resourcesDir = process.resourcesPath; // <install>\resources
  const ps = path.join(os.tmpdir(), 'snipemc-appupdate.ps1');
  const script =
    "$ErrorActionPreference='SilentlyContinue'\r\n" +
    'Start-Sleep -Seconds 1\r\n' +
    `Expand-Archive -Path '${q(zipPath)}' -DestinationPath '${q(resourcesDir)}' -Force\r\n` +
    // Aligne la version affichée dans « Applications installées ». La clé était codée
    // en dur sur « SnipeMC » (ancien projet) : elle n'existe pas pour Snipe Hub, donc la
    // version affichée n'était jamais mise à jour. On résout la clé dynamiquement.
    "$k = Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.GetValue('DisplayName') -like 'Snipe Hub*' } | Select-Object -First 1\r\n" +
    `if ($k) { Set-ItemProperty -Path $k.PSPath -Name DisplayVersion -Value '${q(version || '')}' }\r\n` +
    `Start-Process -FilePath '${q(exe)}'\r\n`;
  fs.writeFileSync(ps, script);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => app.quit(), 400);
}

// Lance l'installeur en silencieux via un script détaché qui attend la fin de
// l'install puis relance l'app (l'installeur ferme l'app en cours au démarrage).
function quitAndInstall(installerPath) {
  const exe = process.execPath;
  const script = path.join(os.tmpdir(), 'snipemc-update.cmd');
  // ping = petite temporisation pour laisser l'app se fermer proprement.
  const body =
    '@echo off\r\n' +
    'ping 127.0.0.1 -n 2 >nul\r\n' +
    `"${installerPath}" /S\r\n` +
    `start "" "${exe}"\r\n`;
  fs.writeFileSync(script, body);
  const child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => app.quit(), 400);
}

function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9 ._-]/g, '_');
}

# 🎯 Snipe Hub (bêta)

Hub de **sniping multi-plateforme** : un seul logiciel qui fusionne tes 3 snipers existants
(**Minecraft**, **Discord vanity**, **Fortnite/Epic**) autour d'un **moteur commun** (auth, sync NTP,
burst timing) avec une **watchlist unifiée**, des **alertes**, et l'**auto-update GitHub** — plus des
emplacements prêts pour **Roblox / Twitch / X**.

> ⚠️ Bêta. Les moteurs de base (`C:\Users\teamf\snipe mc`, `snipe url serveur discord`, `snipe ftn`)
> ne sont **pas modifiés** : leur code `src/` est **copié** dans `platforms/` et orchestré par une
> nouvelle coquille Electron. Rien ne casse tes apps d'origine.

## Architecture
```
snipe-hub/
  gui/            coquille Electron unifiée (main.js, preload.cjs, renderer/)
  adapters/       interface normalisée par plateforme (mc, discord, ftn) + registre
  platforms/      moteurs COPIÉS tels quels (mc/ discord/ ftn/) — code d'origine intact
  core/           auto-update GitHub (updater.js)
  scripts/        publish-update.mjs (release)
```
Chaque adaptateur expose la même interface : `whoami()` · `login()` · `check(nom)` · `snipe(opts)` ·
`validName()`. La coquille route l'UI et **streame la sortie console** des snipes vers le journal.

## Utilisation (dev)
```bash
npm start            # lance l'app
```
Copie `.env.example` → `.env` et renseigne `MS_CLIENT_ID` (MC) et `EPIC_CLIENT_ID/SECRET` (Epic).
Discord : on colle un token de bot directement dans l'app.

## Build & release (comme tes autres apps)
```bash
npm run dist               # installeur NSIS + portable (dist/)
npm run publish:update     # SHA-256 + Release GitHub (nécessite `gh` authentifié)
```
Auto-update : **100 % GitHub Releases** de `saliox/snipe-hub` (aucune IP, aucun serveur — override
optionnel `.env` `UPDATE_REPO=owner/name`). Crée le dépôt `saliox/snipe-hub` avant la 1re release.

## Statut bêta
- ✅ Coquille + dashboard + watchlist unifiée + journal en direct + auto-update câblé.
- ✅ Les 3 moteurs se chargent via les adaptateurs (check / snipe / whoami).
- ⏳ À polir : flux de login par plateforme (device code MC, code Epic, token Discord), les options
  avancées propres à chaque moteur (proxies MC/FTN, multi-bots Discord), et Roblox/Twitch/X.

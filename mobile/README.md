# 📱 Snipe Hub Mobile (bêta)

Port **iOS + Android** de [Snipe Hub](../README.md) — le hub de sniping multi-plateforme
(**Minecraft**, **Discord vanity**, **Fortnite/Epic**). Une seule base de code
**Expo / React Native** qui reprend le moteur commun du desktop (auth, sync horloge,
burst timing), la **watchlist unifiée**, le **check de dispo** et le **journal en direct**.

> ⚠️ Bêta. Même esprit que la version desktop : aucune action ne touche un compte/serveur
> tiers — on ne fait que renommer **ton** compte (MC/Epic) ou poser la vanity de **ton**
> serveur (Discord) via les API officielles.

## Stack

- **Expo SDK 52** / React Native 0.76 (JS pur, comme le desktop — pas de TypeScript)
- `expo-secure-store` — tokens dans le **Keychain (iOS) / Keystore (Android)**, adossé au matériel
- `@react-native-async-storage/async-storage` — réglages, watchlist, historique (non-secrets)
- `expo-web-browser` / `expo-clipboard` — flux de login (device code MC, code Epic)
- Aucune lib d'UI externe : thème sombre maison (rouge/noir de la marque)

## Structure

```
mobile/
  App.js                    en-tête + navigation par onglets (Snipe / Watchlist / Réglages)
  src/
    theme.js                couleurs & espacements
    engine/                 moteur porté en fetch() (compatible RN)
      net.js                journal en direct, fetch+timeout, timing, form-encode
      time.js               sync d'horloge HTTP (remplace le SNTP/UDP du desktop)
      secure.js             wrapper SecureStore (tokens)
      storage.js            AsyncStorage (réglages/watchlist/historique)
      config.js             config runtime (IDs d'app), hydratée au démarrage
      mc.js discord.js ftn.js  auth + check + burst par plateforme
      adapters.js           interface unifiée + registre
      runner.js             orchestration (parse drop, sync, stop, historique)
    ui/                     composants, journal, modale de login
    screens/                Snipe, Watchlist, Réglages
```

Chaque adaptateur expose la même interface que le desktop : `whoami` · `check` · `snipe` ·
`validName` · `logout`, plus le login spécifique (`device` MC / `token` Discord / `code` Epic).

## Lancer en dev

```bash
cd mobile
npm install
npx expo start          # QR code -> app Expo Go (iOS/Android), ou 'i'/'a' pour un simulateur
```

Tous les modules utilisés (SecureStore, WebBrowser, Clipboard, AsyncStorage) fonctionnent
dans **Expo Go**, donc aucun build natif n'est nécessaire pour développer.

## Build (stores / APK)

```bash
# Cloud (recommandé) — EAS Build
npm i -g eas-cli && eas login
eas build -p ios          # .ipa (compte Apple Developer requis)
eas build -p android      # .aab / .apk

# Local — prebuild + build natif
npx expo prebuild
npx expo run:android      # ou run:ios (macOS + Xcode)
```

## Configuration

Écran **Réglages** :

| Champ | Rôle |
|---|---|
| `MS_CLIENT_ID` | **Requis pour Minecraft.** App Azure AD (public client, scope `XboxLive.signin`), approuvée via https://aka.ms/mce-reviewappid |
| `EPIC_CLIENT_ID` / `SECRET` | Optionnel — défaut = client de jeu Fortnite iOS |
| Discord | On colle le(s) token(s) de **bot** directement dans l'app (écran de connexion) |

Les secrets ne quittent jamais l'appareil (SecureStore).

## Différences avec le desktop (assumées en bêta)

- **Sync horloge** : le desktop fait du **SNTP** (UDP). Expo managé n'a pas de socket UDP →
  on estime l'offset en **HTTP** (en-tête `Date` + détection de flip, précision ~dizaines de ms).
  Pour du SNTP réel sub-100 ms, faire un dev-build avec `react-native-udp`.
- **Burst** : pas de pool `undici` bas-niveau ; on pré-chauffe les sockets TLS puis on tire
  des `fetch()` concurrents avec abort-on-win. Suffisant pour la plupart des drops.
- **Premier plan requis** : iOS/Android throttlent les timers en arrière-plan — garde l'app
  ouverte pendant un snipe planifié ou une surveillance.
- **Non encore porté** : check en masse proxifié, multi-comptes Epic, Roblox/Twitch/X
  (emplacements présents côté desktop, à venir ici).

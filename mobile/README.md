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
- `expo-notifications` — notifications locales des résultats de snipe
- `expo-background-fetch` / `expo-task-manager` — surveillance de la watchlist en arrière-plan
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
      notify.js             notifications locales (résultats de snipe)
      background.js         tâche de fond : sonde la watchlist + snipe + notif
      mc.js discord.js ftn.js  auth + check + burst par plateforme
      adapters.js           interface unifiée + registre
      runner.js             orchestration (parse drop, sync, stop, historique, notif)
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

La plupart des modules (SecureStore, WebBrowser, Clipboard, AsyncStorage, notifications
**locales**) fonctionnent dans **Expo Go**. En revanche la **surveillance en arrière-plan**
(`expo-background-fetch`) nécessite un **dev-build** :

```bash
npx expo install expo-notifications expo-task-manager expo-background-fetch  # versions exactes du SDK
npx expo run:android      # ou run:ios — dev-build avec les modules natifs
```

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
- **Non encore porté** : check en masse proxifié, multi-comptes Epic, Roblox/Twitch/X
  (emplacements présents côté desktop, à venir ici).

## Arrière-plan & notifications

Depuis l'écran **Watchlist**, active **« Surveillance en arrière-plan »**. À partir de là,
même app fermée :

1. l'OS **réveille** l'app périodiquement (via `expo-background-fetch`) ;
2. à chaque réveil, chaque nom de la watchlist est **sondé** ;
3. si un nom s'est libéré et qu'un compte est connecté, un **snipe est tenté** ;
4. tu reçois une **notification** avec le résultat (🎯 réussi / nom libéré / échec).

Les résultats des snipes lancés **au premier plan** notifient aussi (pratique si tu changes d'app
pendant une surveillance).

**Limites imposées par iOS/Android (pas contournables) :**

- La cadence des réveils est **décidée par l'OS** — plancher ~**15 min**, souvent plus, et
  dépend de l'usage de l'app et de la batterie. Ce n'est **pas** un timer précis.
- Donc l'arrière-plan est parfait pour *« préviens-moi quand ce pseudo se libère »*, mais **pas**
  pour caler un drop planifié **à la seconde** : pour ça, garde l'app **ouverte au premier plan**
  (le mode « Surveiller » ou « Planifié » de l'écran Snipe tire alors avec la précision maximale).
- Nécessite un **dev-build** (pas Expo Go) et l'autorisation **Notifications** (demandée à l'activation).
- Aucun JS ne tourne en continu en fond : entre deux réveils, l'app est suspendue.

# 📱 Snipe Hub Mobile (bêta)

Port **iOS + Android** de [Snipe Hub](../README.md) — le hub de sniping multi-plateforme
(**Minecraft**, **Discord vanity**, **Fortnite/Epic**, **Twitch**, **X**, **Roblox**). Une
seule base de code **Expo / React Native** qui reprend le moteur commun du desktop (auth, sync
horloge, burst timing), la **watchlist unifiée**, le **check de dispo** et le **journal en direct**.

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
  assets/                 icône, icône adaptative, splash, favicon (générés)
  scripts/make-assets.mjs générateur d'assets (réticule Snipe Hub, pur Node)
```

### Icône & splash (branding)

Les assets sont générés depuis le logo « réticule » de la marque, en **pur Node** (aucune
dépendance) :

```bash
npm run assets   # (re)génère assets/icon.png, adaptive-icon.png, splash-icon.png, favicon.png
```

`app.json` les câble : icône iOS (plein cadre), **icône adaptative** Android (avant-plan
transparent + fond `#0d0d10`), **splash** (via `expo-splash-screen`) et favicon web.

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
- **Check en masse** : porté (concurrence bornée), **mais sans rotation de proxies** — le
  `fetch` RN ne peut pas router par proxy arbitraire. Les checks partent de l'IP de l'appareil.
- **Non encore porté** : rotation de proxies (check en masse / snipe).

## Plateformes & fiabilité du renommage

| Plateforme | Connexion | Dispo / surveillance | Renommage (snipe) |
|---|---|---|---|
| Minecraft | Microsoft device-code | ✅ fiable | ✅ burst PUT |
| Discord vanity | token(s) de bot | ✅ fiable | ✅ burst PATCH (multi-bots) |
| Fortnite / Epic | authorizationCode | ✅ fiable | ✅ PUT displayName |
| Twitch | jeton OAuth de session | ✅ fiable (Helix) | ⚠️ mutation GQL restreinte — « à confirmer » |
| X (Twitter) | cookies auth_token + ct0 | ✅ **alerte** fiable | ⚠️ endpoint verrouillé — « à confirmer » |
| Roblox | cookie .ROBLOSECURITY + mot de passe | ✅ fiable | ✅ PUT username — **coûte 1000 Robux/succès** |

Pour Twitch et X, l'API de renommage est bridée par la plateforme : la **surveillance alerte**
de façon fiable dès qu'un nom se libère, mais l'auto-renommage peut échouer (comportement
identique au desktop). Roblox exige le **mot de passe** au moment du snipe (jamais stocké) et
tout changement **réussi** débite **1000 Robux** — un nom déjà pris ne débite rien.

## Check en masse & multi-comptes

- **Check en masse** (écran Snipe → section « 📋 Check en masse ») : colle une liste de noms
  (1 par ligne), règle la concurrence, et obtiens le statut libre/pris de chacun, triés (libres
  d'abord).
- **Multi-comptes Epic** : ajoute plusieurs comptes Epic (bouton « + Compte » → colle un autre
  `authorizationCode`). Des pastilles sous le statut permettent de choisir le compte **actif**
  (celui qui sert au check/snipe) ou d'en retirer un. La migration depuis l'ancien mono-compte
  est automatique.

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

### Rappel avant un drop planifié

Pour un drop dont tu connais l'heure : en mode **« Planifié »**, saisis l'instant puis
**« ⏰ Me rappeler avant le drop »**. Une notification **datée** (`expo-notifications`) est
programmée ~2 min avant — elle se déclenche à l'heure **exacte** même app fermée (contrairement
au burst), et te ramène à temps pour tirer au premier plan avec la précision maximale. Ce rappel
fonctionne aussi en **Expo Go** (notif locale).

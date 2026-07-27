# Snipe Hub

**Bêta.** Un seul logiciel pour tous tes snipers de pseudos : Minecraft, vanity Discord et
Fortnite/Epic réunis dans la même fenêtre, avec une liste de surveillance commune, des alertes et des
mises à jour automatiques.

Roblox, Twitch et X ont leur emplacement prêt, mais leur connexion n'est pas encore terminée.

## L'idée

Tu avais trois applis séparées qui faisaient la même chose sur trois plateformes. Snipe Hub les met
sous une seule interface sans toucher à leurs moteurs : le code de chacun est repris tel quel dans
`platforms/`, et une couche d'adaptateurs leur donne la même forme.

Chaque adaptateur expose les mêmes cinq fonctions — `whoami()`, `login()`, `check(nom)`,
`snipe(options)` et `validName()`. L'interface ne parle qu'à ça, et affiche en direct ce que le moteur
écrit dans sa console.

Les moteurs se chargent à la demande : si l'un d'eux casse, l'appli démarre quand même.

```
gui/          l'interface Electron
adapters/     l'interface commune à chaque plateforme, plus le registre
platforms/    les moteurs, repris tels quels
core/         mise à jour automatique
scripts/      publication des releases
```

## Lancer en développement

```bash
npm start
```

Copie `.env.example` vers `.env` et renseigne `MS_CLIENT_ID` pour Minecraft, `EPIC_CLIENT_ID` et
`EPIC_CLIENT_SECRET` pour Epic. Pour Discord, le token de bot se colle directement dans l'appli.

## Construire et publier

```bash
npm run dist             # installeur NSIS + version portable, dans dist/
npm run publish:update   # empreinte SHA-256 + release GitHub (nécessite gh authentifié)
```

Les mises à jour passent uniquement par les releases GitHub de `saliox/snipe-hub` — aucun serveur à
héberger. Tu peux pointer ailleurs avec `UPDATE_REPO=owner/name` dans `.env`.

## Sécurité

L'appli manipule des tokens Discord et des identifiants de comptes, donc la fenêtre est verrouillée :
bac à sable activé, isolation du contexte, pas d'intégration Node, aucune navigation hors de l'appli,
toutes les permissions du navigateur refusées, et une politique de contenu stricte qui interdit tout
appel réseau depuis l'interface — tout passe par le processus principal.

## Où ça en est

**Ça marche :** l'interface, le tableau de bord, la liste de surveillance commune, le journal en direct,
les mises à jour automatiques, et les trois moteurs Minecraft, Discord et Fortnite via les adaptateurs.

**Ça reste à faire :** finir les connexions plateforme par plateforme, exposer les options avancées de
chaque moteur (proxies pour Minecraft et Fortnite, multi-bots pour Discord), et terminer Roblox, Twitch
et X.

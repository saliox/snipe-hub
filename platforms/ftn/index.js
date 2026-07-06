#!/usr/bin/env node
// CLI du sniper de pseudos Fortnite / Epic Games.
import 'dotenv/config';
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseProxyList, makeProxyPool } from './proxy.js';
import { generateNames, spaceSize } from './generate.js';
import { scoreName, rankNames } from './score.js';
import { bulkCheck, estimateScanMs } from './bulk.js';
import { log, c, fmtDuration } from './util.js';
import {
  loginInteractive, getValidToken, cachedAccount,
  listAccounts, removeAccount, setActive, allFreshTokens,
} from './accounts.js';
import { displayNameStatus, validName, nameChangeEligibility, changeDisplayName } from './epicapi.js';
import { snipe, watchNames } from './sniper.js';
import { setWebhookUrl, testAlert, alertsConfigured } from './alerts.js';
import { listSchedules, addSchedule, removeSchedule, pruneSchedules } from './schedule.js';
import * as history from './history.js';
import { bestOffset } from './ntp.js';
import { runUpdate, maybeNotify } from './update.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

// Parse simple des --flags (--at "..." --burst 8 --monitor).
function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// Lit une ligne au clavier (pour coller l'authorizationCode).
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

function usage() {
  console.log(`
${c.cyan}snipe-ftn${c.reset} — sniper de pseudos Fortnite / Epic Games

${c.yellow}Commandes :${c.reset}
  login                         Se connecter au compte Epic (authorizationCode)
  whoami                        Afficher le compte connecté
  accounts [list|add|use <id>|remove <id>]   Gérer les comptes (multi-comptes)
  check <pseudo>                Vérifier la disponibilité d'un display name
  claim <pseudo>                Changer ton pseudo pour celui-ci MAINTENANT
  gen [options]                 Générer des pseudos candidats (sans réseau)
  scan [options]                Générer + scanner en masse les noms LIBRES
  time                          Mesurer le décalage d'horloge NTP
  snipe <pseudo> --monitor      Surveiller et déclencher dès que libre (recommandé)
  snipe <pseudo> --at <ISO>     Snipe planifié à un instant précis (UTC)
  watch <n1> <n2> … [--file f]  Surveiller PLUSIEURS noms, réclamer le 1er libre
  alert [set <url>|test|clear]  Webhook Discord (alerte quand un nom se libère)
  schedule add <p> --at <ISO>   Planifier un snipe qui SURVIT au redémarrage
  schedule [list|remove <id>|prune]   Gérer les snipes planifiés
  history [--free|--search q|clear]   Historique des noms vus libres/pris
  update [--check]              Mettre à jour l'outil (--check = vérifier seulement)

${c.yellow}Options de snipe :${c.reset}
  --monitor         mode surveillance (poll jusqu'à libre) — mode principal Epic
  --at <ISO>        instant du drop, ex. 2026-07-10T15:00:00Z
  --in <durée>      alternative à --at, ex. 90s, 15m, 2h
  --burst <n>       nb total de requêtes dans la rafale (def 6)
  --volley <n>      requêtes lâchées SIMULTANÉMENT à T0 (def 3)
  --spacing <ms>    espacement des relances après la volée (def 30)
  --lead <ms>       avance de la 1re requête sur le drop (def 40)
  --poll <ms>       intervalle de sondage en monitor (def 1000, adaptatif si --at)
  --connections <n> connexions pré-chauffées (def 3)
  --proxies <file>  fichier .txt de proxies (host:port) pour la détection
  --all-accounts    tirer depuis TOUS les comptes enregistrés en parallèle
  --diag            journal détaillé + résumé de métriques (RTT, 429…)
  --skip-ntp        ne pas synchroniser l'horloge

${c.yellow}Options de gen / scan :${c.reset}
  --mode <m>        random | pronounceable | pattern | dict (def random)
  --length <n>      longueur des noms générés (def 3)
  --charset <c>     alpha | alphanum | full (def alpha)
  --pattern <p>     gabarit : ? = lettre, # = chiffre, * = alphanum, reste littéral
  --count <n>       nb de noms à générer (def 50)
  --og              OG uniquement (lettres, pas de chiffre/underscore)
  --no-repeat       pas de lettre doublée d'affilée (aa, bb…)
  --file <f>        scanner une liste .txt existante (au lieu de générer)
  --proxies <f>     répartir le scan sur des proxies (host:port par ligne)
  --min-score <n>   ne garder que les libres au score ≥ n (scan)
  --out <f>         écrire les résultats dans un fichier
  --rank            (gen) trier par score de désirabilité

${c.yellow}Exemples :${c.reset}
  node src/index.js login
  node src/index.js check Ninja
  node src/index.js gen --mode dict --length 4 --count 30 --rank
  node src/index.js scan --length 3 --charset alpha --count 500 --og --min-score 60
  node src/index.js scan --file mes-noms.txt --proxies proxies.txt --out libres.txt
  node src/index.js snipe MonPseudo --monitor

${c.yellow}Note :${c.reset} le changement de pseudo Epic a un cooldown de 2 semaines ; assure-toi
d'être éligible avant de sniper. Voir README.md.
`);
}

function parseDuration(s) {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 's'];
  return n * mult;
}

// Options de génération depuis les --flags (partagé par gen et scan).
function genOptsFromFlags(f) {
  return {
    mode: f.mode || 'random',
    length: f.length ? Number(f.length) : 3,
    charset: f.charset || 'alpha',
    pattern: f.pattern || '',
    count: f.count ? Number(f.count) : 50,
    exhaustive: !!f.exhaustive,
    filters: { og: !!f.og, noRepeat: !!f['no-repeat'] },
  };
}

const tierColor = (t) => ({ S: c.green, A: c.cyan, B: c.blue, C: c.yellow, D: c.gray }[t] || c.reset);

async function main() {
  try {
    // Avis de mise à jour discret (au plus 1×/24 h, non bloquant). Ignoré pour
    // `update` (qui vérifie déjà) et `snipe` (chemin critique en timing).
    if (cmd !== 'update' && cmd !== 'snipe') await maybeNotify();

    switch (cmd) {
      case 'login':
        await loginInteractive(() => prompt(`  Colle ici l'authorizationCode : `));
        break;

      case 'whoami': {
        const a = cachedAccount();
        if (!a) { log.warn('Aucun compte en cache. Lance : node src/index.js login'); break; }
        log.ok(`${c.green}${a.displayName || '(nom inconnu)'}${c.reset} (${a.accountId})`);
        try {
          const { accessToken, accountId } = await getValidToken();
          const el = await nameChangeEligibility(accessToken, accountId);
          if (el.canUpdate) log.info(`Changement de pseudo : ${c.green}éligible ✓${c.reset}` +
            (el.changes != null ? ` (${el.changes} changement(s) au total)` : ''));
          else log.info(`Changement de pseudo : ${c.yellow}cooldown${c.reset}` +
            (el.availableAt ? ` jusqu'au ${new Date(el.availableAt).toLocaleString('fr-FR')}` : ''));
        } catch { /* hors-ligne ou token absent : on n'affiche que le cache */ }
        break;
      }

      case 'accounts': {
        const sub = argv[1];
        if (sub === 'add') {
          const label = argv.slice(2).join(' ') || undefined;
          await loginInteractive(() => prompt(`  Colle l'authorizationCode du NOUVEAU compte : `), label);
        } else if (sub === 'remove') {
          if (!argv[2]) { log.err('Usage : accounts remove <id>'); break; }
          removeAccount(argv[2]); log.ok('Compte retiré.');
        } else if (sub === 'use') {
          if (!argv[2]) { log.err('Usage : accounts use <id>'); break; }
          setActive(argv[2]); log.ok('Compte actif changé.');
        } else if (sub && sub !== 'list') {
          log.err(`Sous-commande inconnue : ${sub} (list | add | remove <id> | use <id>)`); break;
        }
        const { accounts } = listAccounts();
        if (!accounts.length) { log.warn('Aucun compte. Ajoute-en un : node src/index.js accounts add'); break; }
        log.step(`Comptes enregistrés (${accounts.length})`);
        for (const a of accounts) {
          const mark = a.active ? `${c.green}● actif${c.reset}` : `${c.gray}○     ${c.reset}`;
          log.info(`${mark}  ${c.yellow}${a.displayName || a.label}${c.reset}  ${c.gray}${a.id}${c.reset}`);
        }
        log.info(`${c.gray}Snipe depuis tous : ajoute ${c.reset}--all-accounts${c.gray} à la commande snipe.${c.reset}`);
        break;
      }

      case 'time': {
        log.step('Mesure NTP');
        const o = await bestOffset();
        log.ok(`Offset : ${o.offset >= 0 ? '+' : ''}${o.offset.toFixed(1)} ms via ${o.server} (rtt ${o.rtt.toFixed(0)} ms)`);
        log.info(o.offset >= 0
          ? 'Horloge locale EN RETARD sur le temps réel.'
          : 'Horloge locale EN AVANCE sur le temps réel.');
        break;
      }

      case 'check': {
        const name = argv[1];
        if (!name) { log.err('Usage : check <pseudo>'); break; }
        if (!validName(name)) log.warn('Format inhabituel (Epic : 3-16 caractères) — vérif quand même.');
        log.step(`Disponibilité de ${c.yellow}${name}${c.reset}`);
        try {
          const { accessToken } = await getValidToken();
          const st = await displayNameStatus(name, accessToken);
          if (st.rateLimited) log.warn('API Epic rate-limitée, réessaie.');
          else if (st.free) { log.ok(`${c.green}LIBRE${c.reset}`); history.record(name, 'free'); }
          else if (st.free === false) { log.info(`${c.yellow}PRIS${c.reset} par ${st.displayName} (${st.accountId})`); history.record(name, 'taken'); }
          else log.warn(`Réponse ${st.statusCode}`);
        } catch (e) {
          log.err(`Vérif impossible : ${e.message}`);
        }
        break;
      }

      case 'claim': {
        const name = argv[1];
        if (!name) { log.err('Usage : claim <pseudo>  (change ton pseudo TOUT DE SUITE)'); break; }
        if (!validName(name)) { log.err('Pseudo invalide (Epic : 3-16 caractères).'); break; }
        const { accessToken, accountId, displayName } = await getValidToken();
        try {
          const el = await nameChangeEligibility(accessToken, accountId);
          if (!el.canUpdate) {
            log.err(`Cooldown actif${el.availableAt ? ` jusqu'au ${new Date(el.availableAt).toLocaleString('fr-FR')}` : ''} — changement impossible maintenant.`);
            break;
          }
        } catch { /* éligibilité indéterminée : on tente quand même */ }
        log.step(`Réclamation de ${c.yellow}${name}${c.reset} (compte ${c.green}${displayName || accountId}${c.reset})`);
        const r = await changeDisplayName(name, accessToken, accountId);
        if (r.ok) { log.ok(`${c.green}🎯 Pseudo changé en ${r.name} !${c.reset}`); history.record(name, 'taken'); }
        else log.err(`Échec : ${r.reason}`);
        break;
      }

      case 'gen': {
        const f = flags(argv.slice(1));
        const names = generateNames(genOptsFromFlags(f));
        if (!names.length) { log.warn('Aucun nom généré (vérifie mode/pattern).'); break; }
        const ranked = f.rank ? rankNames(names) : names.map((n) => ({ name: n }));
        for (const r of ranked) {
          const s = r.tier ? ` ${tierColor(r.tier)}[${r.tier} ${r.score}]${c.reset}` : '';
          console.log(`${r.name}${s}`);
        }
        if (f.out) { writeFileSync(f.out, ranked.map((r) => r.name).join('\n') + '\n'); log.ok(`${ranked.length} noms écrits dans ${f.out}`); }
        else log.info(`${ranked.length} noms générés.`);
        break;
      }

      case 'scan': {
        const f = flags(argv.slice(1));
        const { accessToken } = await getValidToken();

        // Source : fichier de noms, ou génération.
        let names;
        if (f.file) {
          try { names = readFileSync(f.file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
          catch (e) { log.err(`Fichier illisible : ${e.message}`); break; }
          log.info(`${names.length} noms chargés depuis ${f.file}.`);
        } else {
          const gopts = genOptsFromFlags(f);
          names = generateNames(gopts);
          log.info(`${names.length} noms générés (mode ${gopts.mode}, longueur ${gopts.length}).`);
        }
        if (!names.length) { log.warn('Rien à scanner.'); break; }

        let pool = null;
        if (f.proxies) {
          try { pool = makeProxyPool(parseProxyList(readFileSync(f.proxies, 'utf8'))); log.info(`${pool.size} proxy(s) chargé(s).`); }
          catch (e) { log.err(`Fichier proxies illisible : ${e.message}`); break; }
        }

        const minInterval = f['min-interval'] ? Number(f['min-interval']) : undefined;
        log.step(`Scan de ${names.length} noms (ETA ~${fmtDuration(estimateScanMs(names.length, minInterval))})`);
        let lastStat = 0;
        const summary = await bulkCheck(names, {
          token: accessToken, proxyPool: pool, minIntervalMs: minInterval,
          onResult: (r) => { history.record(r.name, r.state); if (r.state === 'free') log.ok(`${c.green}LIBRE${c.reset} ${r.name}`); },
          onStats: (s) => {
            const now = Date.now();
            if (now - lastStat < 1000) return;
            lastStat = now;
            const eta = s.etaMs != null ? fmtDuration(s.etaMs) : '?';
            process.stdout.write(`  ${s.done}/${s.total} · ${s.free} libres · ${s.rate.toFixed(1)}/s · ETA ${eta}` +
              (s.proxiesTotal ? ` · proxies ${s.proxiesAlive}/${s.proxiesTotal}` : '') + '   \r');
          },
        });
        if (pool) await pool.close();
        process.stdout.write('\n');

        // Résultats : classe les libres par score, filtre --min-score.
        const minScore = f['min-score'] ? Number(f['min-score']) : 0;
        const ranked = rankNames(summary.freeList).filter((r) => r.score >= minScore);
        console.log('');
        log.ok(`${summary.free} libres / ${summary.checked} vérifiés ` +
          `(${summary.taken} pris, ${summary.errors} erreurs) en ${fmtDuration(summary.elapsedMs)}.`);
        if (ranked.length) {
          log.step(`Meilleurs noms libres${minScore ? ` (score ≥ ${minScore})` : ''} :`);
          for (const r of ranked.slice(0, 40)) {
            console.log(`  ${tierColor(r.tier)}[${r.tier} ${String(r.score).padStart(3)}]${c.reset} ${r.name}`);
          }
          if (ranked.length > 40) log.info(`…et ${ranked.length - 40} autres.`);
        }
        if (f.out && ranked.length) { writeFileSync(f.out, ranked.map((r) => r.name).join('\n') + '\n'); log.ok(`Libres écrits dans ${f.out}`); }
        break;
      }

      case 'snipe': {
        const name = argv[1];
        if (!name) { log.err('Usage : snipe <pseudo> --monitor | --at <ISO>'); break; }
        if (!validName(name)) { log.err('Pseudo invalide (Epic : 3-16 caractères).'); break; }
        const f = flags(argv.slice(2));

        let dropAt;
        if (f.at) {
          dropAt = Date.parse(f.at);
          if (Number.isNaN(dropAt)) { log.err(`Date --at invalide : ${f.at}`); break; }
        } else if (f.in) {
          const ms = parseDuration(f.in);
          if (ms == null) { log.err(`Durée --in invalide : ${f.in}`); break; }
          dropAt = Date.now() + ms;
        }
        if (!f.monitor && !dropAt) {
          log.err('Précise --monitor (surveillance) ou --at <ISO> / --in <durée> (planifié).');
          break;
        }

        let proxyList = null;
        if (f.proxies) {
          try {
            proxyList = parseProxyList(readFileSync(f.proxies, 'utf8'));
            log.info(`${proxyList.length} proxy(s) chargé(s) pour la détection.`);
          } catch (e) { log.err(`Fichier proxies illisible : ${e.message}`); break; }
        }

        const common = {
          name, dropAt,
          monitor: !!f.monitor,
          burst: f.burst ? Number(f.burst) : undefined,
          volley: f.volley ? Number(f.volley) : undefined,
          spacingMs: f.spacing ? Number(f.spacing) : undefined,
          leadMs: f.lead ? Number(f.lead) : undefined,
          pollMs: f.poll ? Number(f.poll) : undefined,
          connections: f.connections ? Number(f.connections) : undefined,
          proxies: proxyList,
          diag: !!f.diag,
          skipNtp: !!f['skip-ntp'],
        };

        // --- Multi-comptes : tire depuis tous les comptes en parallèle ---
        if (f['all-accounts']) {
          const toks = await allFreshTokens();
          if (!toks.length) { log.err('Aucun compte. Ajoute-en avec : node src/index.js accounts add'); break; }
          log.step(`Snipe multi-comptes : ${toks.length} compte(s) → ${c.yellow}${name}${c.reset}`);
          const runs = toks.map((t) =>
            snipe({ ...common, token: t.accessToken, accountId: t.accountId })
              .then((r) => ({ label: t.displayName || t.label, success: !!r.success }))
              .catch((e) => ({ label: t.displayName || t.label, success: false, error: e.message })));
          const results = await Promise.all(runs);
          const winner = results.find((x) => x.success);
          console.log('');
          if (winner) log.ok(`${c.green}🎯 ${name} obtenu par le compte « ${winner.label} » !${c.reset}`);
          else log.err(`Échec multi-comptes pour ${name}.`);
          break;
        }

        // --- Compte unique (actif) ---
        const { accessToken, accountId, displayName } = await getValidToken();
        log.info(`Compte : ${c.green}${displayName || accountId}${c.reset} → cible ${c.yellow}${name}${c.reset}`);
        try {
          const el = await nameChangeEligibility(accessToken, accountId);
          if (el.canUpdate) log.ok('Éligible au changement de pseudo ✓');
          else log.warn(`⚠ Cooldown actif${el.availableAt ? ` jusqu'au ${new Date(el.availableAt).toLocaleString('fr-FR')}` : ''} — ` +
            'le changement échouera tant qu\'il court (la surveillance, elle, continue).');
        } catch (e) { log.info(`(Éligibilité non vérifiable : ${e.message})`); }

        await snipe({ ...common, token: accessToken, accountId });
        break;
      }

      case 'watch': {
        const f = flags(argv.slice(1));
        const { accessToken, accountId, displayName } = await getValidToken();

        let names = f._;
        if (f.file) {
          try { names = readFileSync(f.file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
          catch (e) { log.err(`Fichier illisible : ${e.message}`); break; }
        }
        if (!names.length) { log.err('Usage : watch <nom1> <nom2> …  (ou --file liste.txt)'); break; }

        let proxyList = null;
        if (f.proxies) {
          try { proxyList = parseProxyList(readFileSync(f.proxies, 'utf8')); log.info(`${proxyList.length} proxy(s) chargé(s).`); }
          catch (e) { log.err(`Fichier proxies illisible : ${e.message}`); break; }
        }

        try {
          const el = await nameChangeEligibility(accessToken, accountId);
          if (!el.canUpdate) log.warn(`⚠ Cooldown actif${el.availableAt ? ` jusqu'au ${new Date(el.availableAt).toLocaleString('fr-FR')}` : ''} — le claim échouera, mais la surveillance/alerte continue.`);
        } catch { /* ignore */ }

        await watchNames({
          names, token: accessToken, accountId, displayName,
          burst: f.burst ? Number(f.burst) : undefined,
          volley: f.volley ? Number(f.volley) : undefined,
          spacingMs: f.spacing ? Number(f.spacing) : undefined,
          pollMs: f.poll ? Number(f.poll) : undefined,
          connections: f.connections ? Number(f.connections) : undefined,
          proxies: proxyList,
          diag: !!f.diag,
          skipNtp: !!f['skip-ntp'],
        });
        break;
      }

      case 'alert': {
        const sub = argv[1];
        if (sub === 'set') {
          if (!argv[2]) { log.err('Usage : alert set <url_webhook_discord>'); break; }
          try { setWebhookUrl(argv[2]); log.ok('Webhook Discord enregistré (chiffré au repos).'); }
          catch (e) { log.err(e.message); }
        } else if (sub === 'clear') {
          setWebhookUrl(''); log.ok('Webhook retiré.');
        } else if (sub === 'test') {
          if (!alertsConfigured()) { log.warn('Aucun webhook. Ajoute-en un : alert set <url>'); break; }
          const r = await testAlert();
          if (r.ok) log.ok('Test envoyé ✓ — vérifie ton salon Discord.');
          else log.err(`Échec de l'envoi : ${r.error || 'HTTP ' + r.status}`);
        } else {
          log.info(alertsConfigured()
            ? 'Webhook configuré ✓ (alert test pour vérifier, alert clear pour retirer).'
            : 'Aucun webhook. « alert set <url> » pour recevoir une alerte Discord quand un nom se libère.');
        }
        break;
      }

      case 'schedule': {
        const sub = argv[1];
        if (sub === 'add') {
          const name = argv[2];
          const f = flags(argv.slice(3));
          if (!name || !validName(name)) { log.err('Usage : schedule add <pseudo> --at <ISO> [options]'); break; }
          let dropAt;
          if (f.at) { dropAt = Date.parse(f.at); if (Number.isNaN(dropAt)) { log.err(`--at invalide : ${f.at}`); break; } }
          else if (f.in) { const ms = parseDuration(f.in); if (ms == null) { log.err('--in invalide.'); break; } dropAt = Date.now() + ms; }
          else { log.err('Précise --at <ISO> ou --in <durée>.'); break; }
          if (dropAt < Date.now() + 150_000) log.warn('⚠ Drop très proche (< ~2,5 min) : la tâche planifiée a peu de marge. Préfère « snipe --at » directement.');

          const opts = {
            burst: f.burst ? Number(f.burst) : undefined, volley: f.volley ? Number(f.volley) : undefined,
            spacing: f.spacing ? Number(f.spacing) : undefined, lead: f.lead ? Number(f.lead) : undefined,
            poll: f.poll ? Number(f.poll) : undefined, connections: f.connections ? Number(f.connections) : undefined,
            proxies: f.proxies || undefined, allAccounts: !!f['all-accounts'], diag: !!f.diag, skipNtp: !!f['skip-ntp'],
          };
          try {
            const item = addSchedule({ name, dropAt, opts });
            if (item.registered) log.ok(`Planifié : ${c.yellow}${name}${c.reset} le ${new Date(dropAt).toLocaleString('fr-FR')} (id ${item.id}) — survivra au redémarrage.`);
            else log.warn(`Enregistré (id ${item.id}) mais tâche Windows NON créée : ${item.registerError || '?'}`);
          } catch (e) { log.err(e.message); }
        } else if (sub === 'remove') {
          if (!argv[2]) { log.err('Usage : schedule remove <id>'); break; }
          const it = removeSchedule(argv[2]);
          log.ok(it ? `Planification ${argv[2]} retirée.` : 'Id introuvable.');
        } else if (sub === 'prune') {
          log.ok(`${pruneSchedules()} planification(s) passée(s) nettoyée(s).`);
        } else if (sub && sub !== 'list') {
          log.err(`Sous-commande inconnue : ${sub} (list | add | remove <id> | prune)`); break;
        }
        const items = listSchedules();
        if (!items.length) { log.warn('Aucune planification. Ex : schedule add MonPseudo --at 2026-07-10T15:00:00Z'); break; }
        log.step(`Snipes planifiés (${items.length})`);
        for (const it of items.sort((a, b) => a.dropAt - b.dropAt)) {
          const left = it.dropAt - Date.now();
          const status = left > 0 ? `dans ${fmtDuration(left)}` : 'passé';
          console.log(`  ${c.gray}${it.id}${c.reset}  ${c.yellow}${it.name}${c.reset}  ${new Date(it.dropAt).toLocaleString('fr-FR')}  ${c.gray}(${status})${c.reset}`);
        }
        break;
      }

      case 'history': {
        if (argv[1] === 'clear') { history.clear(); log.ok('Historique vidé.'); break; }
        const f = flags(argv.slice(1));
        if (f.search) {
          const names = history.searchFree(f.search);
          log.step(`Libres vus contenant « ${f.search} » (${names.length})`);
          for (const n of names.slice(0, 60)) console.log(`  ${n}`);
          break;
        }
        if (f.free) {
          const names = history.allFree();
          log.step(`Noms vus LIBRES (${names.length})`);
          for (const n of names.slice(0, 80)) console.log(`  ${n}`);
          if (names.length > 80) log.info(`…et ${names.length - 80} autres.`);
          break;
        }
        const s = history.stats();
        log.ok(`Historique : ${s.total} noms suivis · ${c.green}${s.free} libres${c.reset} · ${s.taken} pris · ${s.everFree} déjà vus libres.`);
        log.info('history --free · history --search <q> · history clear');
        break;
      }

      case 'update': {
        const f = flags(argv.slice(1));
        await runUpdate({ check: !!f.check });
        break;
      }

      case 'help': case '--help': case '-h': case undefined:
        usage();
        break;

      default:
        log.err(`Commande inconnue : ${cmd}`);
        usage();
    }
  } catch (e) {
    log.err(e.message);
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  }
}

main();

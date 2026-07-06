#!/usr/bin/env node
// CLI du sniper d'URL personnalisée (vanity) de serveur Discord.
import 'dotenv/config';
import { log, c, fmtDuration } from './util.js';
import {
  resolveToken, whoami, listGuilds, getVanity, checkVanityFree,
  canManageGuild, canSetVanity, authHeader, validVanity,
} from './discord.js';
import { storeToken, loadToken, clearToken } from './tokenstore.js';
import { snipe } from './sniper.js';
import { bestOffset } from './ntp.js';

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

function usage() {
  console.log(`
${c.cyan}snipe-discord${c.reset} — sniper d'URL personnalisée (vanity) de serveur Discord

${c.yellow}Commandes :${c.reset}
  login <token> [--user]        Enregistrer un token (bot par défaut, --user = compte)
  whoami                        Afficher le compte du token enregistré
  logout                        Effacer le token enregistré
  guilds                        Lister tes serveurs éligibles (+ leur vanity actuelle)
  check <code>                  Vérifier la disponibilité d'un code (anonyme)
  time                          Mesurer le décalage d'horloge NTP
  snipe <code[,code2,…]> --guild <id> --at <ISO>   Snipe planifié
  snipe <code[,code2,…]> --guild <id> --monitor    Surveiller (watchlist)

${c.yellow}Options de snipe :${c.reset}
  --guild <id>      serveur (le tien) où poser la vanity  [obligatoire]
  --at <ISO>        instant du drop, ex. 2026-07-10T15:00:00Z
  --in <durée>      alternative à --at, ex. 90s, 15m, 2h
  --monitor         mode surveillance (watchlist ; poll adaptatif jusqu'à libre)
  --burst <n>       nb de requêtes dans la rafale (def 5)
  --spacing <ms>    espacement entre requêtes (def 40)
  --lead <ms>       avance de la 1re requête sur le drop (def 40)
  --connections <n> connexions pré-chauffées (def 3)
  --interval <ms>   intervalle de poll de base en surveillance (def 1200)
  --skip-ntp        ne pas synchroniser l'horloge

  (multi-bots & webhook : dans l'app GUI. La CLI tire depuis le token enregistré.)

${c.yellow}Exemples :${c.reset}
  node src/index.js login "MTIz...bot.token"
  node src/index.js guilds
  node src/index.js check monsupercode
  node src/index.js snipe monsupercode --guild 123456789012345678 --monitor
  node src/index.js snipe monsupercode --guild 123456789012345678 --at 2026-07-10T15:00:00Z --burst 6
`);
}

function parseDuration(s) {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 's'];
  return n * mult;
}

// Récupère le token enregistré ou lève une erreur claire.
function requireToken() {
  const t = loadToken();
  if (!t?.token) throw new Error('Aucun token. Lance : node src/index.js login <token>');
  return t;
}

async function main() {
  try {
    switch (cmd) {
      case 'login': {
        const raw = argv[1];
        if (!raw) { log.err('Usage : login <token> [--user]'); break; }
        const f = flags(argv.slice(2));
        log.step('Validation du token Discord');
        let info;
        if (f.user) {
          const user = await whoami(raw, 'user');
          info = { token: raw.replace(/^Bot\s+/i, '').trim(), type: 'user', user };
        } else {
          info = await resolveToken(raw); // détecte bot vs user
        }
        storeToken(info);
        const tag = info.user.discriminator && info.user.discriminator !== '0'
          ? `${info.user.username}#${info.user.discriminator}`
          : (info.user.global_name || info.user.username);
        log.ok(`Connecté en tant que ${c.green}${tag}${c.reset} (${info.user.id}) — token ${info.type}.`);
        if (info.type === 'user') log.warn('Token UTILISATEUR : automatiser un compte enfreint les CGU Discord (risque de ban). Préfère un token de BOT.');
        break;
      }

      case 'whoami': {
        const t = loadToken();
        if (!t?.user) { log.warn('Aucun token enregistré. Lance : node src/index.js login <token>'); break; }
        const tag = t.user.discriminator && t.user.discriminator !== '0'
          ? `${t.user.username}#${t.user.discriminator}`
          : (t.user.global_name || t.user.username);
        log.ok(`${c.green}${tag}${c.reset} (${t.user.id}) — token ${t.type}.`);
        break;
      }

      case 'logout':
        clearToken();
        log.ok('Token effacé.');
        break;

      case 'guilds': {
        const t = requireToken();
        log.step('Tes serveurs');
        const guilds = await listGuilds(t.token, t.type);
        if (!guilds.length) { log.warn('Aucun serveur pour ce token.'); break; }
        for (const g of guilds) {
          const manage = canManageGuild(g);
          const eligible = canSetVanity(g);
          const badge = eligible ? `${c.green}[VANITY OK]${c.reset}`
            : manage ? `${c.yellow}[boost<3]${c.reset}`
              : `${c.gray}[pas admin]${c.reset}`;
          let current = '';
          if (eligible) {
            try {
              const v = await getVanity(g.id, t.token, t.type);
              current = v?.code ? ` — vanity actuelle : ${c.cyan}discord.gg/${v.code}${c.reset}` : ' — pas de vanity posée';
            } catch { /* ignore */ }
          }
          console.log(`  ${badge} ${g.name} ${c.gray}(${g.id})${c.reset}${current}`);
        }
        log.info('Tu ne peux poser une vanity que sur un serveur [VANITY OK] (boost niveau 3 / partenaire / vérifié).');
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
        const code = argv[1];
        if (!code) { log.err('Usage : check <code>'); break; }
        if (!validVanity(code)) log.warn('Format inhabituel (2-32 car., a-z 0-9 -) — vérif quand même.');
        log.step(`Disponibilité de ${c.yellow}discord.gg/${code}${c.reset}`);
        const r = await checkVanityFree(code);
        if (r.rateLimited) log.warn(`Rate-limité par Discord${r.retryAfter ? ` (retry ${r.retryAfter}s)` : ''}, réessaie.`);
        else if (r.free) log.ok('LIBRE — réclamable.');
        else if (r.free === false) log.info(`PRIS${r.guild ? ` par « ${r.guild} »` : ''}${r.guildId ? ` (${r.guildId})` : ''}.`);
        else log.warn(`Réponse ${r.statusCode}.`);
        break;
      }

      case 'snipe': {
        const raw = argv[1];
        if (!raw) { log.err('Usage : snipe <code[,code2,…]> --guild <id> --at <ISO> | --monitor'); break; }
        // Watchlist : un ou plusieurs codes séparés par des virgules.
        const codes = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const bad = codes.filter((x) => !validVanity(x));
        if (bad.length) { log.err(`Code(s) invalide(s) : ${bad.join(', ')} (2-32 car., a-z 0-9 -).`); break; }
        const f = flags(argv.slice(2));
        const guildId = f.guild;
        if (!guildId) { log.err('--guild <id> obligatoire (le serveur où poser la vanity).'); break; }

        const t = requireToken();
        // L'API Modify Vanity URL est réservée aux bots : échec garanti sinon.
        if (t.type !== 'bot') {
          log.err('Le snipe de vanity exige un token de BOT — l\'API "Modify Guild Vanity URL" ' +
            'n\'est pas utilisable par un compte utilisateur. Fais : login <token-du-bot>.');
          break;
        }
        // Contrôle d'éligibilité du serveur cible avant de perdre du temps.
        try {
          const guilds = await listGuilds(t.token, t.type);
          const g = guilds.find((x) => x.id === guildId);
          if (!g) log.warn('Ce serveur n\'apparaît pas dans la liste du token (ajoute le bot / vérifie l\'id).');
          else if (!canSetVanity(g)) log.warn(`« ${g.name} » n\'est pas éligible aux vanity (boost niveau 3 requis) — le snipe échouera tant que ce n\'est pas le cas.`);
          else log.info(`Cible : ${c.green}${g.name}${c.reset} → ${c.yellow}${codes.map((x) => 'gg/' + x).join(', ')}${c.reset}`);
        } catch (e) { log.warn(`Vérif serveur ignorée : ${e.message}`); }

        let dropAt;
        if (f.at) {
          dropAt = Date.parse(f.at);
          if (Number.isNaN(dropAt)) { log.err(`Date --at invalide : ${f.at}`); break; }
        } else if (f.in) {
          const ms = parseDuration(f.in);
          if (ms == null) { log.err(`Durée --in invalide : ${f.in}`); break; }
          dropAt = Date.now() + ms;
        }

        await snipe({
          codes,
          guildId,
          bots: [{ auth: authHeader(t.token, t.type), label: t.user?.username || 'bot' }],
          dropAt,
          monitor: !!f.monitor,
          burst: f.burst ? Number(f.burst) : undefined,
          spacingMs: f.spacing ? Number(f.spacing) : undefined,
          leadMs: f.lead ? Number(f.lead) : undefined,
          connections: f.connections ? Number(f.connections) : undefined,
          baseIntervalMs: f.interval ? Number(f.interval) : undefined,
          skipNtp: !!f['skip-ntp'],
        });
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

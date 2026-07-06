#!/usr/bin/env node
// CLI du sniper de pseudos Minecraft.
import 'dotenv/config';
import { log, c, fmtDuration } from './util.js';
import { loginInteractive, getValidToken, cachedProfile } from './auth.js';
import { isNameFree, nameStatus, validName } from './mojang.js';
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
${c.cyan}snipe-mc${c.reset} — sniper de pseudos Minecraft

${c.yellow}Commandes :${c.reset}
  login                         Se connecter au compte Microsoft (device code)
  whoami                        Afficher le compte connecté
  check <pseudo>                Vérifier la disponibilité (public + compte)
  time                          Mesurer le décalage d'horloge NTP
  snipe <pseudo> --at <ISO>     Snipe planifié à un instant précis (UTC)
  snipe <pseudo> --monitor      Surveiller et déclencher dès que libre

${c.yellow}Options de snipe :${c.reset}
  --at <ISO>        instant du drop, ex. 2026-07-10T15:00:00Z
  --in <durée>      alternative à --at, ex. 90s, 15m, 2h
  --monitor         mode surveillance (poll jusqu'à libre)
  --burst <n>       nb de requêtes dans la rafale (def 6)
  --spacing <ms>    espacement entre requêtes (def 30)
  --lead <ms>       avance de la 1re requête sur le drop (def 40)
  --connections <n> connexions pré-chauffées (def 3)
  --skip-ntp        ne pas synchroniser l'horloge

${c.yellow}Exemples :${c.reset}
  node src/index.js login
  node src/index.js check Notch
  node src/index.js snipe Dream --at 2026-07-10T15:00:00Z --burst 8
  node src/index.js snipe Dream --in 45s --spacing 25
`);
}

function parseDuration(s) {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 's'];
  return n * mult;
}

async function main() {
  try {
    switch (cmd) {
      case 'login':
        await loginInteractive();
        break;

      case 'whoami': {
        const p = cachedProfile();
        if (!p) { log.warn('Aucun compte en cache. Lance : node src/index.js login'); break; }
        log.ok(`${c.green}${p.name}${c.reset} (${p.id})`);
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
        if (!validName(name)) log.warn('Format invalide (3-16 car., [A-Za-z0-9_]) — vérif quand même.');
        log.step(`Disponibilité de ${c.yellow}${name}${c.reset}`);
        const pub = await isNameFree(name);
        if (pub.rateLimited) log.warn('API Mojang rate-limitée, réessaie.');
        else if (pub.free) log.ok('API publique Mojang : LIBRE');
        else if (pub.free === false) log.info(`API publique Mojang : PRIS par ${pub.name} (${pub.uuid})`);
        else log.warn(`API publique : réponse ${pub.statusCode}`);

        try {
          const { accessToken } = await getValidToken();
          const st = await nameStatus(name, accessToken);
          const label = { AVAILABLE: `${c.green}AVAILABLE${c.reset}`, DUPLICATE: `${c.yellow}DUPLICATE (pris)${c.reset}`, NOT_ALLOWED: `${c.red}NOT_ALLOWED (bloqué)${c.reset}` }[st] || st;
          log.info(`API compte Minecraft : ${label}`);
        } catch (e) {
          log.warn(`Vérif compte ignorée : ${e.message}`);
        }
        break;
      }

      case 'snipe': {
        const name = argv[1];
        if (!name) { log.err('Usage : snipe <pseudo> --at <ISO> | --monitor'); break; }
        if (!validName(name)) { log.err('Pseudo invalide (3-16 car., [A-Za-z0-9_]).'); break; }
        const f = flags(argv.slice(2));

        const { accessToken, profile } = await getValidToken();
        if (!profile) {
          log.err('Ce compte n\'a pas de profil Java Minecraft : impossible de changer de nom.');
          break;
        }
        log.info(`Compte : ${c.green}${profile.name}${c.reset} → cible ${c.yellow}${name}${c.reset}`);

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
          name,
          token: accessToken,
          // Fournisseur de token frais : getValidToken() rafraîchit via le refresh
          // MS quand le token Minecraft (~24h) a expiré. Utile en surveillance longue.
          getToken: async () => (await getValidToken()).accessToken,
          dropAt,
          monitor: !!f.monitor,
          burst: f.burst ? Number(f.burst) : undefined,
          spacingMs: f.spacing ? Number(f.spacing) : undefined,
          leadMs: f.lead ? Number(f.lead) : undefined,
          connections: f.connections ? Number(f.connections) : undefined,
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

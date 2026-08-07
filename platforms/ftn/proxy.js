// Pool de proxies pour la DÉTECTION (polling) uniquement — jamais pour le tir
// de changement de nom (qui doit partir de ton IP, authentifié et stable).
// Répartir le polling sur plusieurs IP permet de sonder plus vite sans qu'une
// seule IP se fasse rate-limiter (429) par Epic.
import { ProxyAgent } from 'undici';

// Construit des dispatchers undici depuis des lignes "host:port",
// "user:pass@host:port" ou "http://host:port". Ignore vides/commentaires.
export function makeProxyDispatchers(lines) {
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const s = String(raw).trim();
    if (!s || s.startsWith('#')) continue;
    const uri = /^\w+:\/\//.test(s) ? s : `http://${s}`;
    try {
      out.push(new ProxyAgent({
        uri,
        // ⚠️ NE JAMAIS remettre `requestTls: { rejectUnauthorized: false }` ici.
        // Dans undici, `requestTls` s'applique au TLS vers l'ORIGINE (Epic) À TRAVERS le
        // tunnel — pas au lien vers le proxy. Le désactiver laissait n'importe quel proxy
        // de la liste présenter son propre certificat pour epicgames.com et lire le trafic
        // en clair : or ces dispatchers portent l'access token Epic (bulk.js, sniper.js).
        // La tolérance visait le lien VERS le proxy : c'est `proxyTls` (laissé strict ici,
        // aligné sur platforms/mc/proxy.js qui ne désactive rien).
        connectTimeout: 8000,
      }));
    } catch { /* proxy invalide : ignoré */ }
  }
  return out;
}

export async function closeDispatchers(dispatchers) {
  await Promise.all((dispatchers || []).map((d) => d.close().catch(() => {})));
}

// Parse un contenu de fichier .txt en liste de proxies.
export function parseProxyList(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// Pool de proxies à ROTATION + SANTÉ (pour le scan en masse). Éjecte un proxy
// après quelques échecs consécutifs pour ne pas ralentir toute la rotation.
export function makeProxyPool(lines, { ejectAfter = 3 } = {}) {
  const entries = makeProxyDispatchers(lines).map((agent) => ({ agent, fails: 0, dead: false }));
  let i = 0;
  return {
    size: entries.length,
    next() {
      // Round-robin sur les proxies vivants.
      for (let n = 0; n < entries.length; n++) {
        const e = entries[i++ % entries.length];
        if (!e.dead) return e.agent;
      }
      return null; // tous morts
    },
    reward(agent) {
      const e = entries.find((x) => x.agent === agent);
      if (e) e.fails = 0;
    },
    penalize(agent) {
      const e = entries.find((x) => x.agent === agent);
      if (e && ++e.fails >= ejectAfter) e.dead = true;
    },
    aliveCount() { return entries.filter((e) => !e.dead).length; },
    async close() { await closeDispatchers(entries.map((e) => e.agent)); },
  };
}

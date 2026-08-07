// Harnais réseau pour les tests : intercepte undici SANS jamais sortir sur Internet.
//
// Règle dure : `disableNetConnect()` est appelé systématiquement. Une requête non
// interceptée LÈVE au lieu de partir vers la vraie API — sinon un test « qui passe »
// pourrait en réalité taper Mojang ou Epic, et devenir dépendant du réseau, du
// rate-limit, et de l'état réel d'un pseudo.
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

let previous = null;

/**
 * Crée un MockAgent isolé. Les moteurs acceptent tous un `dispatcher` en argument,
 * donc on peut soit le passer explicitement, soit le poser en dispatcher global.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.global=false] pose aussi le mock en dispatcher global
 * @returns {MockAgent}
 */
export function mockNet({ global = false } = {}) {
  const agent = new MockAgent();
  agent.disableNetConnect();              // toute requête non interceptée -> throw
  if (global) {
    previous = getGlobalDispatcher();
    setGlobalDispatcher(agent);
  }
  return agent;
}

/**
 * Referme le mock et vérifie qu'aucun intercepteur déclaré n'est resté inutilisé.
 * Un intercepteur non consommé signifie que le code testé n'a PAS fait la requête
 * attendue — c'est un échec de test, pas un détail.
 */
export async function closeNet(agent) {
  try {
    agent.assertNoPendingInterceptors();
  } finally {
    if (previous) { setGlobalDispatcher(previous); previous = null; }
    await agent.close();
  }
}

/** Raccourci : déclare une réponse JSON pour un GET. */
export function onGet(agent, origin, path, status, body, headers = {}) {
  agent.get(origin).intercept({ path, method: 'GET' })
    .reply(status, body, { headers: { 'content-type': 'application/json', ...headers } });
}

/** Raccourci : déclare une réponse pour n'importe quelle méthode. */
export function on(agent, origin, { path, method = 'GET', body: reqBody }, status, body, headers = {}) {
  const i = { path, method };
  if (reqBody !== undefined) i.body = reqBody;
  agent.get(origin).intercept(i)
    .reply(status, body, { headers: { 'content-type': 'application/json', ...headers } });
}

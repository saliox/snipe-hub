// Parsing des réponses d'API — SANS AUCUN APPEL RÉSEAU RÉEL.
//
// C'est ici que vivaient les bugs les plus coûteux du projet : la logique qui traduit
// une réponse HTTP en verdict « libre / pris / indéterminé ». Un adaptateur faisait
// `!!objet` sur ces retours et annonçait « LIBRE » pour tout le monde.
//
// Toutes les fonctions de check acceptent un `dispatcher` en argument : on injecte
// donc un MockAgent d'undici. `disableNetConnect()` garantit qu'une requête non
// interceptée LÈVE — un test vert ne peut pas avoir tapé la vraie API par accident.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockNet, closeNet } from '../helpers/net.mjs';

import { isNameFree } from '../../platforms/mc/mojang.js';
import { checkAvailable as twitchCheck } from '../../platforms/twitch/twitch.js';
import { checkAvailable as xCheck } from '../../platforms/x/x.js';

let agent;
beforeEach(() => { agent = mockNet(); });
afterEach(async () => { await closeNet(agent); });

const MOJANG = 'https://api.mojang.com';

describe('Mojang — isNameFree', () => {
  const path = (n) => `/users/profiles/minecraft/${encodeURIComponent(n)}`;

  test('404 -> libre', async () => {
    agent.get(MOJANG).intercept({ path: path('zqx482'), method: 'GET' }).reply(404, '');
    assert.deepEqual(await isNameFree('zqx482', agent), { free: true });
  });

  test('200 -> pris, avec uuid et casse réelle', async () => {
    agent.get(MOJANG).intercept({ path: path('notch'), method: 'GET' })
      .reply(200, { id: '069a79f4', name: 'Notch' }, { headers: { 'content-type': 'application/json' } });
    const r = await isNameFree('notch', agent);
    assert.equal(r.free, false);
    assert.equal(r.uuid, '069a79f4');
    assert.equal(r.name, 'Notch');            // Mojang renvoie la casse canonique
  });

  test('429 -> INDÉTERMINÉ (jamais « libre »), retryAfter remonté', async () => {
    agent.get(MOJANG).intercept({ path: path('abc'), method: 'GET' })
      .reply(429, '', { headers: { 'retry-after': '7' } });
    const r = await isNameFree('abc', agent);
    assert.equal(r.free, null, 'un rate-limit ne doit JAMAIS passer pour « libre »');
    assert.equal(r.rateLimited, true);
    assert.equal(r.retryAfter, 7);
  });

  test('429 sans en-tête retry-after -> retryAfter null, toujours indéterminé', async () => {
    agent.get(MOJANG).intercept({ path: path('abc'), method: 'GET' }).reply(429, '');
    const r = await isNameFree('abc', agent);
    assert.equal(r.free, null);
    assert.equal(r.retryAfter, null);
  });

  test('500 -> indéterminé avec le statut, pas une exception', async () => {
    agent.get(MOJANG).intercept({ path: path('abc'), method: 'GET' }).reply(500, 'boom');
    assert.deepEqual(await isNameFree('abc', agent), { free: null, statusCode: 500 });
  });

  test('le nom est encodé dans l\'URL (pas d\'injection de chemin)', async () => {
    // Sans encodeURIComponent, « a/b » sortirait du chemin attendu.
    agent.get(MOJANG).intercept({ path: path('a/b'), method: 'GET' }).reply(404, '');
    assert.deepEqual(await isNameFree('a/b', agent), { free: true });
  });
});

describe('Twitch — checkAvailable (Helix)', () => {
  const HELIX = 'https://api.twitch.tv';
  const path = (n) => `/helix/users?login=${encodeURIComponent(n)}`;

  test('sans jeton -> indéterminé immédiat, AUCUNE requête émise', async () => {
    // Aucun intercepteur déclaré : si le code tentait un appel, disableNetConnect
    // le ferait échouer et assertNoPendingInterceptors resterait vert.
    const r = await twitchCheck('abcd', null, agent);
    assert.equal(r.free, null);
    assert.equal(r.status, 401);
  });

  test('data vide -> libre ; data peuplé -> pris', async () => {
    agent.get(HELIX).intercept({ path: path('abcd'), method: 'GET' })
      .reply(200, { data: [] }, { headers: { 'content-type': 'application/json' } });
    assert.equal((await twitchCheck('abcd', 'tok', agent)).free, true);

    agent.get(HELIX).intercept({ path: path('ninja'), method: 'GET' })
      .reply(200, { data: [{ id: '1', login: 'ninja' }] }, { headers: { 'content-type': 'application/json' } });
    assert.equal((await twitchCheck('ninja', 'tok', agent)).free, false);
  });

  test('429 : Ratelimit-Reset est un TIMESTAMP EPOCH, borné à 60 s', async () => {
    // Le bug corrigé en v0.5.0 : l'epoch était passé tel quel comme un délai en
    // secondes -> setTimeout d'environ 56 ans -> Node le ramène à 1 ms -> la sonde
    // repartait aussitôt et martelait l'API. Ce test verrouille la borne.
    const dans10ans = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
    agent.get(HELIX).intercept({ path: path('abcd'), method: 'GET' })
      .reply(429, '', { headers: { 'ratelimit-reset': String(dans10ans) } });
    const r = await twitchCheck('abcd', 'tok', agent);
    assert.equal(r.free, null);
    assert.equal(r.rateLimited, true);
    assert.ok(r.retryAfter <= 60, `retryAfter doit être borné à 60 s, reçu ${r.retryAfter}`);
    assert.ok(r.retryAfter >= 1, 'et rester positif');
  });

  test('401 (jeton expiré) -> indéterminé, pas « libre »', async () => {
    agent.get(HELIX).intercept({ path: path('abcd'), method: 'GET' }).reply(401, 'Unauthorized');
    const r = await twitchCheck('abcd', 'tok', agent);
    assert.equal(r.free, null);
    assert.equal(r.status, 401);
  });
});

describe('X — checkAvailable', () => {
  const X = 'https://api.twitter.com';
  const path = (n) => `/i/users/username_available.json?username=${encodeURIComponent(n)}`;

  test('valid:true -> libre ; valid:false -> pris', async () => {
    agent.get(X).intercept({ path: path('abcd'), method: 'GET' })
      .reply(200, { valid: true }, { headers: { 'content-type': 'application/json' } });
    assert.equal((await xCheck('abcd', null, agent)).free, true);

    agent.get(X).intercept({ path: path('elon'), method: 'GET' })
      .reply(200, { valid: false, reason: 'taken' }, { headers: { 'content-type': 'application/json' } });
    const r = await xCheck('elon', null, agent);
    assert.equal(r.free, false);
    assert.equal(r.reason, 'taken');
  });

  test('200 SANS champ valid booléen -> indéterminé (schéma changé)', async () => {
    // L'API X est volatile. Un 200 portant une charge d'erreur était conclu
    // « pris » catégoriquement — corrigé en v0.5.0, verrouillé ici.
    agent.get(X).intercept({ path: path('abcd'), method: 'GET' })
      .reply(200, { errors: [{ code: 34, message: 'page does not exist' }] },
        { headers: { 'content-type': 'application/json' } });
    const r = await xCheck('abcd', null, agent);
    assert.equal(r.free, null, 'un schéma inattendu ne doit jamais valoir « pris »');
  });

  test('403 -> indéterminé', async () => {
    agent.get(X).intercept({ path: path('abcd'), method: 'GET' }).reply(403, 'denied');
    assert.equal((await xCheck('abcd', null, agent)).free, null);
  });
});

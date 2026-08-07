// Check en masse — moteur de concurrence + garde anti-fuite d'IP.
//
// Aucun test n'ouvre de connexion : `check` est un stub. Le chemin « proxy valide »
// est délibérément NON testé ici, car il ouvrirait une vraie connexion sortante.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runBulk } from '../../core/bulk.js';

const ok = (free) => async () => ({ free });

describe('runBulk — cas de base', () => {
  test('liste vide -> tableau vide, aucun appel', async () => {
    let calls = 0;
    const r = await runBulk({ names: [], check: async () => { calls++; return { free: true }; } });
    assert.deepEqual(r, []);
    assert.equal(calls, 0);
  });

  test('préserve l\'ORDRE d\'entrée malgré la concurrence', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `n${i}`);
    // Délais décroissants : sans indexation explicite, les résultats sortiraient
    // dans l'ordre d'achèvement, donc à l'envers.
    const r = await runBulk({
      names,
      concurrency: 50,
      check: async (name) => {
        const i = Number(name.slice(1));
        await new Promise((res) => setTimeout(res, (50 - i) % 12));
        return { free: i % 2 === 0 };
      },
    });
    assert.equal(r.length, 50);
    assert.deepEqual(r.map((x) => x.name), names);
    assert.equal(r[0].free, true);
    assert.equal(r[1].free, false);
  });

  test('nettoie et ignore les entrées vides', async () => {
    const r = await runBulk({ names: ['  a  ', '', '   ', 'b'], check: ok(true) });
    assert.deepEqual(r.map((x) => x.name), ['a', 'b']);
  });

  test('un check qui LÈVE -> free:null + error, le scan continue', async () => {
    const r = await runBulk({
      names: ['a', 'boom', 'c'],
      concurrency: 1,
      check: async (n) => { if (n === 'boom') throw new Error('réseau coupé'); return { free: true }; },
    });
    assert.equal(r.length, 3);
    assert.equal(r[1].free, null, 'une erreur ne vaut jamais « libre » ni « pris »');
    assert.match(r[1].error, /réseau coupé/);
    assert.equal(r[2].free, true, 'les noms suivants sont bien traités');
  });

  test('free:null est relayé TEL QUEL (jamais converti en false)', async () => {
    // Le bug historique : `!!` sur le retour transformait « indéterminé » en un
    // verdict ferme. Un nom rate-limité était annoncé comme pris (ou libre).
    const r = await runBulk({ names: ['a'], check: ok(null) });
    assert.equal(r[0].free, null);
  });

  test('onProgress : appelé une fois par nom, done strictement croissant', async () => {
    const seen = [];
    const names = ['a', 'b', 'c', 'd'];
    await runBulk({
      names, concurrency: 2, check: ok(true),
      onProgress: (p) => seen.push(p),
    });
    assert.equal(seen.length, names.length);
    assert.deepEqual(seen.map((p) => p.done), [1, 2, 3, 4]);
    for (const p of seen) assert.equal(p.total, 4);
  });

  test('concurrence > nombre de noms : pas de worker en trop', async () => {
    let maxParallel = 0, cur = 0;
    await runBulk({
      names: ['a', 'b'], concurrency: 100,
      check: async () => {
        maxParallel = Math.max(maxParallel, ++cur);
        await new Promise((r) => setTimeout(r, 5));
        cur--; return { free: true };
      },
    });
    assert.ok(maxParallel <= 2, `au plus 2 en parallèle pour 2 noms, vu ${maxParallel}`);
  });

  test('la concurrence est réellement bornée', async () => {
    let maxParallel = 0, cur = 0;
    await runBulk({
      names: Array.from({ length: 30 }, (_, i) => 'n' + i), concurrency: 4,
      check: async () => {
        maxParallel = Math.max(maxParallel, ++cur);
        await new Promise((r) => setTimeout(r, 3));
        cur--; return { free: true };
      },
    });
    assert.ok(maxParallel <= 4, `plafond de 4 dépassé : ${maxParallel}`);
  });
});

describe('runBulk — anti-fuite d\'IP (garantie de sécurité)', () => {
  test('liste ne produisant AUCUN proxy exploitable -> LÈVE, aucune requête émise', async () => {
    // Seules les lignes vides et les commentaires sont écartés par normalize().
    // Si la liste se réduit à zéro proxy, partir en direct enverrait la vraie IP
    // à l'API alors que l'utilisateur se croit masqué : on refuse BRUYAMMENT.
    let called = false;
    await assert.rejects(
      () => runBulk({
        names: ['a'],
        proxies: ['# que des commentaires', '#encore un'],
        check: async () => { called = true; return { free: true }; },
      }),
      /Aucun proxy valide/,
    );
    assert.equal(called, false, 'aucune requête ne doit partir sans proxy utilisable');
  });

  test('aucun proxy fourni -> direct ASSUMÉ (choix explicite de l\'utilisateur)', async () => {
    const r = await runBulk({ names: ['a'], proxies: [], check: ok(true) });
    assert.equal(r[0].free, true);
  });
});

describe('makeProxyPool — invariants (sans ouvrir de connexion)', () => {
  // Import local : ce module est le cœur de la protection d'IP du check en masse.
  const load = () => import('../../platforms/mc/proxy.js');

  test('ignore les lignes vides et les commentaires', async () => {
    const { makeProxyPool } = await load();
    const pool = makeProxyPool(['', '   ', '# commentaire']);
    assert.equal(pool.size, 0);
    assert.equal(pool.next(), null, 'pool vide -> null, et runBulk transforme ça en refus');
    await pool.close();
  });

  test('round-robin sur les proxies déclarés', async () => {
    const { makeProxyPool } = await load();
    const pool = makeProxyPool(['1.2.3.4:8080', '5.6.7.8:8080']);
    assert.equal(pool.size, 2);
    const a = pool.next(), b = pool.next(), c = pool.next();
    assert.notEqual(a, b, 'deux appels consécutifs doivent alterner');
    assert.equal(a, c, 'et boucler');
    await pool.close();
  });

  test('INVARIANT CRITIQUE : même TOUS les proxies éjectés, next() ne rend jamais null', async () => {
    // C'est ICI que se joue vraiment l'anti-fuite d'IP. Si next() renvoyait null
    // après éjection, runBulk passerait `dispatcher = null` et la requête partirait
    // EN DIRECT, révélant l'IP — silencieusement, en plein scan.
    const { makeProxyPool } = await load();
    const pool = makeProxyPool(['1.2.3.4:8080', '5.6.7.8:8080']);
    for (let i = 0; i < 20; i++) { const a = pool.next(); pool.penalize(a); }
    assert.equal(pool.aliveCount(), 0, 'tous doivent être éjectés après 3 échecs chacun');
    for (let i = 0; i < 5; i++) {
      assert.notEqual(pool.next(), null, 'échouer via proxy, jamais basculer en direct');
    }
    await pool.close();
  });

  test('reward remet un proxy en service', async () => {
    const { makeProxyPool } = await load();
    const pool = makeProxyPool(['1.2.3.4:8080']);
    const a = pool.next();
    pool.penalize(a); pool.penalize(a); pool.penalize(a);
    assert.equal(pool.aliveCount(), 0);
    pool.reward(a);
    assert.equal(pool.aliveCount(), 1, 'un proxy qui répond de nouveau redevient éligible');
    await pool.close();
  });
});

// Déduplication des refresh de jeton Epic (bug C2).
//
// Epic INVALIDE un refresh token dès qu'il est consommé. Deux rafraîchissements
// concurrents sur le même compte échangeaient donc le MÊME token : le second recevait
// un refus, et le compte devenait irrécupérable sans reconnexion manuelle.
// Le cas était facile à déclencher : balayage de watchlist + check + snipe peuvent
// appeler getValidToken() en même temps, et chacun relit le store depuis le disque.
//
// On teste le primitif de déduplication directement : c'est lui qui porte la garantie,
// et il est testable sans réseau ni compte Epic réel.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _dedupe } from '../../platforms/ftn/accounts.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('_dedupe — refresh concurrents', () => {
  test('N appels concurrents sur la MÊME clé -> le travail n\'est fait QU\'UNE fois', async () => {
    let calls = 0;
    const work = async () => { calls++; await tick(20); return 'jeton-frais'; };

    const [a, b, c] = await Promise.all([
      _dedupe('compte-1', work),
      _dedupe('compte-1', work),
      _dedupe('compte-1', work),
    ]);

    assert.equal(calls, 1, 'un seul échange de refresh token, sinon Epic invalide le compte');
    assert.equal(a, 'jeton-frais');
    assert.equal(b, 'jeton-frais');
    assert.equal(c, 'jeton-frais', 'tous les appelants reçoivent le MÊME résultat');
  });

  test('clés DIFFÉRENTES -> travaux indépendants (les comptes ne se bloquent pas)', async () => {
    let calls = 0;
    const work = async () => { calls++; await tick(10); return calls; };
    await Promise.all([_dedupe('compte-a', work), _dedupe('compte-b', work)]);
    assert.equal(calls, 2, 'deux comptes distincts doivent pouvoir se rafraîchir en parallèle');
  });

  test('après résolution, un nouvel appel relance le travail (pas de cache permanent)', async () => {
    let calls = 0;
    const work = async () => { calls++; return calls; };
    assert.equal(await _dedupe('k', work), 1);
    assert.equal(await _dedupe('k', work), 2, 'le jeton expirera : le refresh doit rester possible');
  });

  test('un échec est propagé à TOUS les appelants et ne bloque pas les suivants', async () => {
    let calls = 0;
    const boom = async () => { calls++; await tick(5); throw new Error('refresh refusé'); };

    const p1 = _dedupe('k2', boom);
    const p2 = _dedupe('k2', boom);
    await assert.rejects(() => p1, /refresh refusé/);
    await assert.rejects(() => p2, /refresh refusé/);
    assert.equal(calls, 1, 'un seul essai réseau malgré deux appelants');

    // Le verrou doit être relâché même en cas d'échec, sinon le compte reste
    // définitivement bloqué jusqu'au redémarrage de l'app.
    const ok = await _dedupe('k2', async () => 'ça remarche');
    assert.equal(ok, 'ça remarche');
  });

  test('une fonction qui lève SYNCHRONEMENT ne laisse pas le verrou coincé', async () => {
    await assert.rejects(() => _dedupe('k3', () => { throw new Error('sync'); }), /sync/);
    assert.equal(await _dedupe('k3', async () => 'libre'), 'libre');
  });
});

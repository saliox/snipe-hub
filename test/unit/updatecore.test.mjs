// Comparaison de versions de l'auto-update.
//
// C'est la fonction qui décide si un client télécharge une mise à jour. Une erreur
// ici est invisible (aucun crash) et bloque TOUTE la flotte : soit personne ne se met
// à jour, soit tout le monde réinstalle en boucle la même version.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../../platforms/mc/updatecore.js';

describe('isNewer', () => {
  test('compare NUMÉRIQUEMENT, pas lexicalement', () => {
    // Le piège classique : en tri de chaînes, '0.10.0' < '0.9.0' est vrai.
    // Le jour où le projet atteint 0.10.0, une comparaison lexicale gèlerait
    // définitivement toutes les mises à jour.
    assert.equal(isNewer('0.10.0', '0.9.0'), true);
    assert.equal(isNewer('0.9.0', '0.10.0'), false);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('2.0.0', '10.0.0'), false);
  });

  test('version identique -> pas de mise à jour (anti-boucle de réinstallation)', () => {
    assert.equal(isNewer('0.5.0', '0.5.0'), false);
    assert.equal(isNewer('1.2.3', '1.2.3'), false);
  });

  test('tolère le préfixe v des tags GitHub', () => {
    assert.equal(isNewer('v0.6.0', '0.5.0'), true);
    assert.equal(isNewer('0.6.0', 'v0.5.0'), true);
    assert.equal(isNewer('V0.5.0', 'v0.5.0'), false);
  });

  test('gère les composants manquants (0.6 vs 0.6.0)', () => {
    assert.equal(isNewer('0.6', '0.6.0'), false);
    assert.equal(isNewer('0.6.1', '0.6'), true);
    assert.equal(isNewer('1', '0.9.9'), true);
  });

  test('entrée non numérique -> pas de mise à jour (jamais de faux positif)', () => {
    // parseInt(...) || 0 : une version illisible vaut 0.0.0. Le sens choisi est
    // « dans le doute, ne rien installer » — on verrouille ce comportement.
    assert.equal(isNewer('abc', '0.0.0'), false);
    assert.equal(isNewer('', '0.0.0'), false);
    assert.equal(isNewer(null, '0.0.0'), false);
    assert.equal(isNewer(undefined, '0.0.0'), false);
  });

  test('pré-release : traité comme la version stable (comportement documenté)', () => {
    // parseInt('0-beta') === 0 : les suffixes sont ignorés. Ce n'est pas du semver
    // strict, mais c'est cohérent dans les deux sens — donc pas de boucle.
    assert.equal(isNewer('1.0.0-beta', '1.0.0'), false);
    assert.equal(isNewer('1.0.0', '1.0.0-beta'), false);
  });

  test('cas réel du projet : 0.4.0 -> 0.5.0 détecté, 0.5.0 -> 0.5.0 non', () => {
    assert.equal(isNewer('0.5.0', '0.4.0'), true);
    assert.equal(isNewer('0.5.0', '0.5.0'), false);
  });
});

// util.js — test PARAMÉTRÉ sur les 6 copies.
//
// Les 6 platforms/*/util.js sont des copies volontaires (moteurs autonomes).
// Ce test est le garde-fou qui remplace la factorisation : si une copie diverge,
// il échoue en nommant la plateforme fautive.
//
// ⚠️ NE JAMAIS activer mock.timers dans ce fichier : sleepUntil() fait un busy-wait
// sur Date.now() et se figerait en boucle infinie si l'horloge est gelée.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const PLATFORMS = ['mc', 'discord', 'ftn', 'roblox', 'twitch', 'x'];

for (const pf of PLATFORMS) {
  describe(`util (${pf})`, () => {
    const load = () => import(`../../platforms/${pf}/util.js`);

    test('fmtDuration : format et unités', async () => {
      const { fmtDuration } = await load();
      assert.equal(fmtDuration(0), '0s');
      assert.equal(fmtDuration(999), '0s');
      assert.equal(fmtDuration(1000), '1s');
      assert.equal(fmtDuration(61000), '1m 1s');
      assert.equal(fmtDuration(3600000), '1h 0s');
      // Le trou du milieu : `if (m)` est un test de VÉRITÉ, donc 0 minute est omise
      // alors que l'heure et la seconde sont présentes. Verrouille le format exact.
      assert.equal(fmtDuration(3601000), '1h 1s');
      assert.equal(fmtDuration(90061000), '1j 1h 1m 1s');
    });

    test('fmtDuration : durée négative ramenée à 0', async () => {
      const { fmtDuration } = await load();
      assert.equal(fmtDuration(-5), '0s');
      assert.equal(fmtDuration(-100000), '0s');
    });

    test('stripAnsi retire les séquences de couleur', async () => {
      const { stripAnsi } = await load();
      assert.equal(stripAnsi('\x1b[32mvert\x1b[0m'), 'vert');
      assert.equal(stripAnsi('sans couleur'), 'sans couleur');
      // Ne doit pas laisser d'octet de contrôle résiduel.
      assert.equal(/\x1b/.test(stripAnsi('\x1b[1;31mrouge\x1b[0m')), false);
    });

    test('sleep respecte le délai demandé', async () => {
      const { sleep } = await load();
      const t0 = Date.now();
      await sleep(30);
      assert.ok(Date.now() - t0 >= 25, 'doit attendre au moins ~30 ms');
    });

    test('sleepUntil : cible déjà passée -> retour immédiat', async () => {
      const { sleepUntil } = await load();
      const t0 = Date.now();
      await sleepUntil(Date.now() - 1000);
      assert.ok(Date.now() - t0 < 100, 'ne doit pas attendre pour une cible passée');
    });

    test('sleepUntil : atteint la cible sans la dépasser franchement', async () => {
      const { sleepUntil } = await load();
      const target = Date.now() + 60;
      await sleepUntil(target);
      const drift = Date.now() - target;
      assert.ok(drift >= -5, `ne doit pas rendre la main avant la cible (dérive ${drift} ms)`);
      assert.ok(drift < 80, `dérive excessive : ${drift} ms`);
    });
  });
}

describe('util — cohérence entre les 6 copies', () => {
  test('les 6 exposent exactement la même surface publique', async () => {
    const surfaces = [];
    for (const pf of PLATFORMS) {
      const m = await import(`../../platforms/${pf}/util.js`);
      surfaces.push([pf, Object.keys(m).sort().join(',')]);
    }
    const [, ref] = surfaces[0];
    for (const [pf, s] of surfaces) {
      assert.equal(s, ref, `platforms/${pf}/util.js a divergé (copie synchronisée attendue)`);
    }
  });

  test('fmtDuration donne le MÊME résultat partout (aucune dérive de format)', async () => {
    const cases = [0, 999, 1000, 61000, 3601000, 90061000, -5];
    const outs = [];
    for (const pf of PLATFORMS) {
      const { fmtDuration } = await import(`../../platforms/${pf}/util.js`);
      outs.push([pf, cases.map(fmtDuration).join('|')]);
    }
    const [, ref] = outs[0];
    for (const [pf, o] of outs) assert.equal(o, ref, `fmtDuration de ${pf} a divergé`);
  });
});

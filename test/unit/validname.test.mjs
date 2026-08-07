// Règles de validation de pseudo — 6 plateformes, 6 règles DIFFÉRENTES.
//
// Ces fonctions gardent l'entrée du snipe (adapters/*.js appellent validName avant
// tout appel réseau). Une règle trop permissive = requête garantie perdue ; une règle
// trop stricte = nom valide refusé sans explication.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validName as mcValid } from '../../platforms/mc/mojang.js';
import { validName as ftnValid } from '../../platforms/ftn/epicapi.js';
import { validName as robloxValid } from '../../platforms/roblox/roblox.js';
import { validName as twitchValid } from '../../platforms/twitch/twitch.js';
import { validName as xValid } from '../../platforms/x/x.js';

describe('validName — Minecraft (3-16, alphanumérique + _)', () => {
  test('accepte les cas nominaux', () => {
    for (const n of ['Notch', 'abc', 'a_b_c', 'A'.repeat(16), 'Dream123']) {
      assert.equal(mcValid(n), true, n);
    }
  });
  test('refuse longueur et caractères invalides', () => {
    for (const n of ['ab', 'A'.repeat(17), 'a-b', 'a b', 'héllo', 'a.b', '']) {
      assert.equal(mcValid(n), false, JSON.stringify(n));
    }
  });
  // Les 3 autres plateformes protègent leur regex par String(name || '').
  // Minecraft est la SEULE à passer `name` brut à .test() : null y est coercé en la
  // chaîne 'null' — 4 caractères alphanumériques — donc accepté. undefined -> 'undefined'
  // (9 caractères) également accepté. Le nom part alors vers l'API et l'appel est perdu.
  test('refuse null / undefined / non-chaînes', () => {
    for (const n of [null, undefined, 0, {}, []]) {
      assert.equal(mcValid(n), false, `validName(${JSON.stringify(n)}) doit être false`);
    }
  });
});

describe('validName — Fortnite/Epic (3-16, typé)', () => {
  test('accepte 3 à 16 caractères, quels qu\'ils soient', () => {
    assert.equal(ftnValid('abc'), true);
    assert.equal(ftnValid('a'.repeat(16)), true);
    assert.equal(ftnValid('a b-c'), true);      // Epic tolère espaces/tirets
  });
  test('refuse hors bornes et non-chaînes', () => {
    for (const n of ['ab', 'a'.repeat(17), '', null, undefined, 123]) {
      assert.equal(ftnValid(n), false, JSON.stringify(n));
    }
  });
});

describe('validName — Roblox (3-20, pas de _ en bord ni doublé)', () => {
  test('accepte', () => {
    for (const n of ['abc', 'a_b', 'A'.repeat(20), 'Test_1']) assert.equal(robloxValid(n), true, n);
  });
  test('refuse les underscores en bord ou consécutifs', () => {
    for (const n of ['_abc', 'abc_', 'a__b', 'ab', 'A'.repeat(21), 'a-b', null, undefined]) {
      assert.equal(robloxValid(n), false, JSON.stringify(n));
    }
  });
});

describe('validName — Twitch (4-25)', () => {
  test('accepte', () => {
    for (const n of ['abcd', 'a_b_c', 'A'.repeat(25)]) assert.equal(twitchValid(n), true, n);
  });
  test('refuse', () => {
    for (const n of ['abc', 'A'.repeat(26), 'a-b', null, undefined, '']) {
      assert.equal(twitchValid(n), false, JSON.stringify(n));
    }
  });
});

describe('validName — X (4-15)', () => {
  test('accepte', () => {
    for (const n of ['abcd', 'a_bc', 'A'.repeat(15)]) assert.equal(xValid(n), true, n);
  });
  test('refuse', () => {
    for (const n of ['abc', 'A'.repeat(16), 'a-b', null, undefined, '']) {
      assert.equal(xValid(n), false, JSON.stringify(n));
    }
  });
});

// Coffres chiffrés des 6 moteurs — test PARAMÉTRÉ.
//
// Les 6 platforms/*/securebox.js sont des copies. Une seule (mc) a reçu le garde
// anti-perte-de-sel. Ce fichier existe précisément pour CHIFFRER cette divergence :
// tant que le lot « coffres » n'est pas passé, le cas « sel supprimé » sort ROUGE
// sur 5 plateformes sur 6. C'est le garde-fou qui remplace la factorisation, puisque
// les moteurs doivent rester autonomes (copies synchronisées, pas de module commun).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, cleanupTmp } from '../helpers/tmpdir.mjs';

const PLATFORMS = ['mc', 'discord', 'ftn', 'roblox', 'twitch', 'x'];

after(cleanupTmp);

for (const pf of PLATFORMS) {
  describe(`securebox (${pf})`, () => {
    const load = async () => import(`../../platforms/${pf}/securebox.js`);
    // Un dossier neuf par cas : les coffres partagent un sel PAR FICHIER, donc deux
    // cas dans le même dossier se contamineraient.
    const box = (name = 'v.enc') => path.join(tmpdir(`sb-${pf}-`), name);

    test('aller-retour : objet imbriqué restitué à l\'identique', async () => {
      const { saveEncrypted, loadEncrypted } = await load();
      const f = box();
      const obj = { token: 'abc', n: 42, nested: { list: [1, 2, 3], flag: true }, accent: 'éàü' };
      saveEncrypted(f, obj);
      assert.deepEqual(loadEncrypted(f), obj);
    });

    test('première initialisation (aucun sel) : génère sans lever', async () => {
      const { saveEncrypted, loadEncrypted } = await load();
      const f = box();
      assert.equal(fs.existsSync(f + '.salt'), false);
      saveEncrypted(f, { a: 1 });                       // ne doit PAS lever
      assert.equal(fs.existsSync(f + '.salt'), true);
      assert.deepEqual(loadEncrypted(f), { a: 1 });
    });

    test('fichier absent -> null (jamais connecté)', async () => {
      const { loadEncrypted } = await load();
      assert.equal(loadEncrypted(box('absent.enc')), null);
    });

    test('fichier tronqué (< 28 o : iv+tag) -> null', async () => {
      const { loadEncrypted } = await load();
      const f = box();
      fs.writeFileSync(f, Buffer.alloc(20, 7));
      assert.equal(loadEncrypted(f), null);
    });

    test('ciphertext altéré d\'un octet -> null (le tag GCM rejette)', async () => {
      const { saveEncrypted, loadEncrypted } = await load();
      const f = box();
      saveEncrypted(f, { secret: 'ne doit pas sortir' });
      const buf = fs.readFileSync(f);
      buf[buf.length - 1] ^= 0xff;                      // corrompt le dernier octet
      fs.writeFileSync(f, buf);
      assert.equal(loadEncrypted(f), null);
    });

    // ---- LE cas qui distingue les 6 copies ----
    test('sel supprimé alors que le .enc existe -> null SANS régénérer le sel', async () => {
      const { saveEncrypted, loadEncrypted } = await load();
      const f = box();
      saveEncrypted(f, { refreshToken: 'irremplaçable' });
      fs.rmSync(f + '.salt');

      assert.equal(loadEncrypted(f), null, 'doit renvoyer null, pas des données fausses');
      // Le point critique : régénérer le sel rend le .enc DÉFINITIVEMENT indéchiffrable,
      // en silence. L'utilisateur voit « non connecté » sans aucune cause, et un éventuel
      // sel de secours restauré ensuite ne servira plus à rien.
      assert.equal(
        fs.existsSync(f + '.salt'), false,
        `[${pf}] le sel a été RÉGÉNÉRÉ : les données chiffrées sont perdues définitivement. `
        + 'Porter le garde keyFor(saltPath, hasCiphertext) + SALT_MISSING de platforms/mc/securebox.js.',
      );
    });
  });
}

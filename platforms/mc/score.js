// Score de désirabilité d'un pseudo (0-100) : plus court, sans chiffre, sans _,
// mot du dico ou prononçable = meilleur. Sert à classer les libres trouvés.
import { isDictWord } from './generate.js';

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
const LEN_SCORE = { 3: 50, 4: 40, 5: 30, 6: 22, 7: 15, 8: 9 };

// Heuristique « prononçable » : pas de gros amas de consonnes (>2 d'affilée).
function pronounceable(lower) {
  let run = 0;
  for (const ch of lower) {
    if (!/[a-z]/.test(ch)) return false;
    run = VOWELS.has(ch) ? 0 : run + 1;
    if (run >= 3) return false;
  }
  return true;
}

export function scoreName(name) {
  const n = String(name);
  const lower = n.toLowerCase();
  const len = n.length;
  const lettersOnly = /^[a-z]+$/.test(lower);

  let s = LEN_SCORE[len] ?? (len >= 9 ? 4 : 0);
  if (!/[0-9]/.test(n)) s += 15;            // pas de chiffre
  if (!/_/.test(n)) s += 10;                // pas d'underscore
  if (lettersOnly && isDictWord(lower)) s += 40; // vrai mot
  else if (lettersOnly && pronounceable(lower)) s += 14; // prononçable
  if (!/(.)\1/.test(lower)) s += 5;         // pas de doublon adjacent

  const score = Math.max(0, Math.min(100, Math.round(s)));
  const tier = score >= 85 ? 'S' : score >= 68 ? 'A' : score >= 50 ? 'B' : score >= 32 ? 'C' : 'D';
  return { name: n, score, tier };
}

// Classe une liste de pseudos par score décroissant.
export function rankNames(names) {
  return names.map(scoreName).sort((a, b) => b.score - a.score || a.name.length - b.name.length);
}

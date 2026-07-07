// Registre des plateformes du hub. Les moteurs sont chargés à la DEMANDE (import dynamique) :
// un moteur cassé ou une dépendance manquante n'empêche pas l'app de démarrer.
export const PLATFORMS = [
  { id: 'mc',      label: 'Minecraft',        emoji: '🟩', ready: true,  load: () => import('./mc.js') },
  { id: 'discord', label: 'Discord vanity',   emoji: '💬', ready: true,  load: () => import('./discord.js') },
  { id: 'ftn',     label: 'Fortnite / Epic',  emoji: '🎮', ready: true,  load: () => import('./ftn.js') },
  // Roblox : repassé en « bientôt » tant que le login n'est pas finalisé — le flux
  // actuel collecte un mot de passe en clair pour un adaptateur non abouti (risque
  // inutile). Le loader reste en place pour réactiver d'un flip quand ce sera prêt.
  { id: 'roblox',  label: 'Roblox',           emoji: '🟥', ready: false, soon: true, needs: 'Login Roblox en finalisation — bientôt disponible.', load: () => import('./roblox.js') },
  { id: 'twitch',  label: 'Twitch',           emoji: '🟪', ready: true,  load: () => import('./twitch.js') },
  { id: 'x',       label: 'X (Twitter)',      emoji: '𝕏',  ready: true,  load: () => import('./x.js') },
];

const cache = {};

export function listPlatforms() {
  return PLATFORMS.map(({ id, label, emoji, ready, soon }) => ({ id, label, emoji, ready: !!ready, soon: !!soon }));
}

// Métadonnées d'une plateforme (utile pour afficher un placeholder informatif
// pour les plateformes « bientôt », sans charger d'adaptateur).
export function platformMeta(id) {
  const p = PLATFORMS.find((x) => x.id === id);
  return p ? { id: p.id, label: p.label, emoji: p.emoji, ready: !!p.ready, soon: !!p.soon, needs: p.needs || '' } : null;
}

// Charge (et met en cache) l'adaptateur d'une plateforme prête. Renvoie null si indisponible.
export async function getAdapter(id) {
  const p = PLATFORMS.find((x) => x.id === id);
  if (!p || !p.ready || !p.load) return null;
  if (!cache[id]) {
    const mod = await p.load();
    cache[id] = { ...mod.default, id, label: p.label, emoji: p.emoji };
  }
  return cache[id];
}

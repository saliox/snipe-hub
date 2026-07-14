// Thème sombre, calqué sur l'identité « Snipe Hub » (rouge/noir) du desktop.
export const theme = {
  bg: '#0d0d10',
  bg2: '#131318',
  card: '#16161c',
  cardBorder: '#26262f',
  text: '#e8e8ee',
  muted: '#8a8a99',
  faint: '#5a5a68',
  accent: '#ff6b6f',
  accentDark: '#8B0000',
  green: '#3fb950',
  yellow: '#e3b341',
  red: '#f85149',
  purple: '#8b5cf6',
  blue: '#4f9dff',
  radius: 14,
  radiusSm: 10,
  space: 14,
};

// Couleurs par niveau de log.
export const logColor = {
  step: theme.accent,
  info: theme.muted,
  ok: theme.green,
  warn: theme.yellow,
  err: theme.red,
};

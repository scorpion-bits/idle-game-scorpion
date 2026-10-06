// Tema visual: paleta fria e dessaturada, com poucos acentos suaves.

// As fontes "Grotesk" (títulos) e "Body" (texto) são as do site; fora dele caem para as do sistema.
export const FONT_DISPLAY = '"Grotesk", "Segoe UI", system-ui, sans-serif';
export const FONT_BODY = '"Body", "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';
export const FONT = FONT_BODY;

const channel = (c, shift) => (c >> shift) & 0xff;
const pack = (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

export function darken(color, f) {
  return pack(channel(color, 16) * (1 - f), channel(color, 8) * (1 - f), channel(color, 0) * (1 - f));
}

export function lighten(color, f) {
  const up = (v) => v + (255 - v) * f;
  return pack(up(channel(color, 16)), up(channel(color, 8)), up(channel(color, 0)));
}

export const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;

// Cores: os mesmos tokens do site (ink-*, cyan, mint, amber, indigo, violet), um pouco
// clareados nos tons escuros para manter contraste sobre os painéis.
export const C = {
  bg: 0x080e16,
  panel: 0x0c141f,       // gavetas e janelas
  card: 0x111c2a,        // cartões
  deep: 0x05090f,        // áreas mais fundas
  text: 0xeef5fb,
  dim: 0x9db2c6,
  faint: 0x55697d,

  accent: 0x6ad8fe,      // ciano da marca
  click: 0x6ad8fe,
  prod: 0x7ee2a8,
  luck: 0xffc46b,
  eco: 0x7c8bf8,
  evo: 0xa57bf8,
  good: 0x7ee2a8,
  warn: 0xffc46b,
  bad: 0xff8a8a,
};

export const T = {
  text: hex(C.text),
  dim: hex(C.dim),
  faint: hex(C.faint),
  accent: hex(C.accent),
  good: hex(C.good),
  warn: hex(C.warn),
  bad: hex(C.bad),
  evo: hex(C.evo),
};

// Tema visual: paleta fria e dessaturada, com poucos acentos suaves.

export const FONT = '"Segoe UI", Inter, system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';

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

export const C = {
  bg: 0x0a0f1e,
  panel: 0x111832,       // gavetas e janelas
  card: 0x172042,        // cartões
  deep: 0x070b18,        // áreas mais fundas
  text: 0xe8eefc,
  dim: 0x93a3c4,
  faint: 0x5d6c8e,

  accent: 0x8ab4ff,      // azul suave
  click: 0x7cc7ff,
  prod: 0x7bd8a8,
  luck: 0xf2c98a,
  eco: 0x8f9bff,
  evo: 0xb48cff,
  good: 0x7bd8a8,
  warn: 0xf2c98a,
  bad: 0xf08a8a,
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

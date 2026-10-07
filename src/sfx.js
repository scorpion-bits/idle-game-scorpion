// Efeitos sonoros sintetizados com Web Audio (sem arquivos de áudio).
// O áudio só pode começar depois de um gesto do jogador: chame `unlockAudio()` num clique/toque.
import { settings } from './settings.js';

let ctx = null;
let master = null;
const lastPlayed = {};

export function unlockAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.connect(ctx.destination);
  applyVolume();
}

export const getAudioContext = () => ctx;

export function applyVolume() {
  if (master) master.gain.value = settings.sound ? settings.volume * 0.7 : 0;
}

const ready = () => ctx && ctx.state === 'running' && settings.sound && settings.volume > 0;

// evita metralhar o mesmo som (ex.: cliques muito rápidos)
const throttled = (name, ms) => {
  const now = performance.now();
  if (now - (lastPlayed[name] ?? -1e9) < ms) return true;
  lastPlayed[name] = now;
  return false;
};

// Um "bip" com envelope: ataque curto e queda exponencial; a frequência pode deslizar de `freq` até `to`.
function tone({ freq, to = freq, dur = 0.15, type = 'sine', gain = 0.2, delay = 0, attack = 0.004 }) {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

// Ruído filtrado (para "sopros" e estalos suaves).
function noise({ dur = 0.2, from = 400, to = 4000, gain = 0.08, delay = 0, q = 1 }) {
  const t0 = ctx.currentTime + delay;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, t0);
  filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
}

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);   // número MIDI -> Hz

export const sfx = {
  // clique no cubo: bip curto com altura levemente variável + "toc" grave
  click() {
    if (!ready() || throttled('click', 35)) return;
    const f = 520 + Math.random() * 120;
    tone({ freq: f, to: f * 1.5, dur: 0.09, type: 'triangle', gain: 0.16 });
    tone({ freq: 140, to: 70, dur: 0.1, type: 'sine', gain: 0.18 });
  },
  // compra de upgrade ou melhoria: duas notas subindo
  buy() {
    if (!ready() || throttled('buy', 50)) return;
    tone({ freq: NOTE(72), dur: 0.12, type: 'triangle', gain: 0.15 });
    tone({ freq: NOTE(79), dur: 0.2, type: 'triangle', gain: 0.15, delay: 0.07 });
  },
  // tentativa de compra sem bits suficientes
  deny() {
    if (!ready() || throttled('deny', 120)) return;
    tone({ freq: 190, to: 140, dur: 0.14, type: 'square', gain: 0.07 });
  },
  // upgrade subiu de nível: arpejo
  levelUp() {
    if (!ready()) return;
    [72, 76, 79, 84].forEach((n, i) => tone({ freq: NOTE(n), dur: 0.22, type: 'triangle', gain: 0.14, delay: i * 0.07 }));
  },
  // habilidade comprada: "cristal" cintilante
  skill() {
    if (!ready() || throttled('skill', 60)) return;
    tone({ freq: NOTE(84), dur: 0.35, type: 'sine', gain: 0.14 });
    tone({ freq: NOTE(91), dur: 0.5, type: 'sine', gain: 0.1, delay: 0.05 });
    noise({ dur: 0.25, from: 3000, to: 8000, gain: 0.03 });
  },
  // conquista: sino
  achievement() {
    if (!ready() || throttled('achievement', 150)) return;
    tone({ freq: NOTE(79), dur: 0.7, type: 'sine', gain: 0.14 });
    tone({ freq: NOTE(79) * 2.76, dur: 0.4, type: 'sine', gain: 0.05 });
    tone({ freq: NOTE(86), dur: 0.8, type: 'sine', gain: 0.1, delay: 0.1 });
  },
  // bit dourado aparece: brilho agudo
  goldenSpawn() {
    if (!ready()) return;
    [88, 93, 97].forEach((n, i) => tone({ freq: NOTE(n), dur: 0.25, type: 'sine', gain: 0.07, delay: i * 0.06 }));
  },
  // bit dourado coletado
  goldenCollect() {
    if (!ready()) return;
    [76, 83, 88, 95].forEach((n, i) => tone({ freq: NOTE(n), dur: 0.3, type: 'triangle', gain: 0.12, delay: i * 0.05 }));
    noise({ dur: 0.4, from: 2000, to: 7000, gain: 0.04 });
  },
  // frenesi / impulso ativado: sopro subindo
  boost() {
    if (!ready()) return;
    noise({ dur: 0.5, from: 300, to: 3500, gain: 0.07, q: 0.8 });
    tone({ freq: 220, to: 660, dur: 0.45, type: 'sawtooth', gain: 0.05 });
  },
  // evolução (prestígio): varredura grande + acorde
  prestige() {
    if (!ready()) return;
    noise({ dur: 1.1, from: 200, to: 6000, gain: 0.09, q: 0.7 });
    [60, 67, 72, 79].forEach((n, i) => tone({ freq: NOTE(n), dur: 1.1, type: 'sine', gain: 0.11, delay: 0.3 + i * 0.05 }));
  },
  // janelas e gavetas
  open() {
    if (!ready() || throttled('open', 80)) return;
    tone({ freq: 330, to: 520, dur: 0.14, type: 'sine', gain: 0.07 });
  },
  close() {
    if (!ready() || throttled('close', 80)) return;
    tone({ freq: 520, to: 300, dur: 0.14, type: 'sine', gain: 0.07 });
  },
  tick() {
    if (!ready() || throttled('tick', 40)) return;
    tone({ freq: 880, dur: 0.045, type: 'triangle', gain: 0.07 });
  },
};

// vibração curta no celular (se disponível e ligada)
export function haptic(ms = 8) {
  if (settings.haptics && navigator.vibrate) navigator.vibrate(ms);
}

// Motor de animações simples: interpola propriedades numéricas de objetos Pixi.
// Propriedades aceitas: x, y, alpha, rotation e "scale" (uniforme).

export const ease = {
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  linear: (t) => t,
};

const running = [];

const read = (target, key) => (key === 'scale' ? target.scale.x : target[key]);
const write = (target, key, value) => {
  if (key === 'scale') target.scale.set(value);
  else target[key] = value;
};

// Anima `to` (ex.: { alpha: 1, y: 10 }) em `ms` milissegundos. Uma nova animação da mesma
// propriedade no mesmo objeto cancela a anterior.
export function tween(target, to, ms = 300, { ease: fn = ease.out, delay = 0, onDone } = {}) {
  const keys = Object.keys(to);
  for (let i = running.length - 1; i >= 0; i--) {
    if (running[i].target === target && keys.includes(running[i].key)) running.splice(i, 1);
  }
  keys.forEach((key, idx) => {
    running.push({
      target, key, from: read(target, key), to: to[key], ms, fn, t: -delay,
      onDone: idx === 0 ? onDone : undefined,
    });
  });
}

export function cancelTweens(target) {
  for (let i = running.length - 1; i >= 0; i--) {
    if (running[i].target === target) running.splice(i, 1);
  }
}

// Chamar uma vez por frame, com o tempo em milissegundos.
export function updateTweens(dt) {
  for (let i = running.length - 1; i >= 0; i--) {
    const a = running[i];
    if (a.target.destroyed) {
      running.splice(i, 1);
      continue;
    }
    a.t += dt;
    if (a.t < 0) continue;
    const p = Math.min(1, a.t / a.ms);
    write(a.target, a.key, a.from + (a.to - a.from) * a.fn(p));
    if (p >= 1) {
      running.splice(i, 1);
      a.onDone?.();
    }
  }
}

// Pequeno "pop": cresce rápido e volta com um leve repique.
export function pop(target, amount = 1.06) {
  target.scale.set(amount);
  tween(target, { scale: 1 }, 380, { ease: ease.back });
}

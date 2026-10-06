import { Application, Assets, Sprite, Text, Container, Graphics } from 'pixi.js';

const app = new Application();
await app.init({ background: '#0b1020', resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

// ---------- Estado ----------
const SAVE_KEY = 'scorpion-bits-idle-v1';
const OFFLINE_CAP_S = 8 * 3600; // no máximo 8h de ganho offline

let bits = 0;
let totalBits = 0;
let resetting = false;

const upgrades = [
  { id: 'mouse',  name: 'Teclado Mecânico', baseCost: 50,    click: 1,   owned: 0 },
  { id: 'intern', name: 'Estagiário',       baseCost: 15,    bps: 0.1,  owned: 0 },
  { id: 'junior', name: 'Dev Júnior',       baseCost: 100,   bps: 1,    owned: 0 },
  { id: 'lab',    name: 'Game Lab',         baseCost: 1100,  bps: 8,    owned: 0 },
  { id: 'studio', name: 'Estúdio',          baseCost: 12000, bps: 47,   owned: 0 },
];

// ---------- Lógica ----------
function costOf(u) {
  return Math.ceil(u.baseCost * 1.15 ** u.owned);
}

function getBps() {
  return upgrades.reduce((sum, u) => sum + u.owned * (u.bps || 0), 0);
}

function getBitsPerClick() {
  return 1 + upgrades.reduce((sum, u) => sum + u.owned * (u.click || 0), 0);
}

function earn(amount) {
  bits += amount;
  totalBits += amount;
}

function format(n) {
  if (n < 1000) return Math.floor(n).toString();
  const units = ['K', 'M', 'B', 'T'];
  let i = -1;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return n.toFixed(2) + units[i];
}

function buy(u) {
  const cost = costOf(u);
  if (bits < cost) return;
  bits -= cost;
  u.owned++;
  refreshShop();
  save();
}

// ---------- Save / Load ----------
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      bits,
      totalBits,
      owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
      lastSave: Date.now(),
    }));
  } catch {
    // localStorage pode estar bloqueado; o jogo segue sem salvar
  }
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    bits = Number.isFinite(d.bits) ? d.bits : 0;
    totalBits = Number.isFinite(d.totalBits) ? d.totalBits : 0;
    for (const u of upgrades) u.owned = d.owned?.[u.id] ?? 0;
    return d.lastSave ?? null;
  } catch {
    return null;
  }
}

const lastSave = load();

// ---------- Cubo ----------
const texture = await Assets.load(`${import.meta.env.BASE_URL}assets/cube.png`);
const cube = new Sprite(texture);
cube.anchor.set(0.5);

const baseScale = 300 / texture.height;
cube.scale.set(baseScale);
cube.eventMode = 'static';
cube.cursor = 'pointer';
app.stage.addChild(cube);

// ---------- Textos ----------
const counter = new Text({
  text: '0 bits',
  style: { fill: '#eef5fb', fontSize: 48, fontFamily: 'Arial', fontWeight: 'bold' },
});
counter.anchor.set(0.5, 0);
app.stage.addChild(counter);

const bpsText = new Text({
  text: '0 bits/s',
  style: { fill: '#7ee2a8', fontSize: 22, fontFamily: 'Arial' },
});
bpsText.anchor.set(0.5, 0);
app.stage.addChild(bpsText);

const resetBtn = new Text({
  text: 'Resetar jogo',
  style: { fill: '#55697d', fontSize: 14, fontFamily: 'Arial' },
});
resetBtn.eventMode = 'static';
resetBtn.cursor = 'pointer';
resetBtn.on('pointerdown', () => {
  if (confirm('Apagar todo o progresso?')) {
    resetting = true;
    try { localStorage.removeItem(SAVE_KEY); } catch { /* sem localStorage */ }
    location.reload();
  }
});
app.stage.addChild(resetBtn);

// ---------- Loja ----------
const shop = new Container();
app.stage.addChild(shop);

const buttons = [];

upgrades.forEach((u, i) => {
  const btn = new Container();
  btn.y = i * 80;

  const bg = new Graphics()
    .roundRect(0, 0, 260, 70, 12)
    .fill(0x1a2440)
    .stroke({ width: 2, color: 0x6ad8fe });

  const title = new Text({
    text: '',
    style: { fill: '#eef5fb', fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold' },
  });
  title.position.set(12, 8);

  const info = new Text({
    text: '',
    style: { fill: '#b4c6d7', fontSize: 14, fontFamily: 'Arial' },
  });
  info.position.set(12, 38);

  btn.addChild(bg, title, info);
  btn.eventMode = 'static';
  btn.cursor = 'pointer';
  btn.on('pointerdown', () => buy(u));

  shop.addChild(btn);
  buttons.push({ u, btn, title, info });
});

function refreshShop() {
  for (const { u, title, info } of buttons) {
    const effect = u.click ? `+${u.click}/clique` : `+${u.bps}/s`;
    title.text = `${u.name} (${u.owned})`;
    info.text = `Custo: ${format(costOf(u))} · ${effect}`;
  }
}
refreshShop();

// ---------- Layout ----------
let cubeBaseY = 0;

function layout() {
  cubeBaseY = app.screen.height / 2;
  cube.x = app.screen.width / 2;
  counter.position.set(app.screen.width / 2, 30);
  bpsText.position.set(app.screen.width / 2, 90);
  shop.position.set(Math.max(10, app.screen.width - 290), 120);
  resetBtn.position.set(16, app.screen.height - 30);
}
layout();
app.renderer.on('resize', layout);

// ---------- Efeitos ----------
const floaters = [];
const particles = [];

function spawnFloatingText(x, y, message, opts = {}) {
  const { fill = '#6ad8fe', size = 32, duration = 800, speed = 0.08 } = opts;
  const text = new Text({
    text: message,
    style: { fill, fontSize: size, fontWeight: 'bold', fontFamily: 'Arial' },
  });
  text.anchor.set(0.5);
  text.position.set(x, y);
  app.stage.addChild(text);
  floaters.push({ text, life: 0, duration, speed });
}

function spawnParticles(x, y) {
  for (let i = 0; i < 8; i++) {
    const g = new Graphics()
      .circle(0, 0, 3 + Math.random() * 3)
      .fill(i % 2 ? 0x6ad8fe : 0x8b5cf6);
    g.position.set(x, y);
    app.stage.addChild(g);

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.1 + Math.random() * 0.25;
    particles.push({ g, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0 });
  }
}

const PARTICLE_LIFE = 500;

// ---------- Clique ----------
cube.on('pointerdown', (event) => {
  const gain = getBitsPerClick();
  earn(gain);

  cube.scale.set(baseScale * 0.9);
  const jitter = (Math.random() - 0.5) * 40;
  spawnFloatingText(event.global.x + jitter, event.global.y, `+${format(gain)}`);
  spawnParticles(event.global.x, event.global.y);
});

// ---------- Progresso offline ----------
if (lastSave) {
  const elapsed = Math.min((Date.now() - lastSave) / 1000, OFFLINE_CAP_S);
  const gain = getBps() * elapsed;
  if (gain >= 1) {
    earn(gain);
    spawnFloatingText(
      app.screen.width / 2,
      app.screen.height / 2 - 220,
      `Bem-vindo de volta! +${format(gain)} bits`,
      { fill: '#ffc46b', size: 26, duration: 4000, speed: 0.01 },
    );
  }
}

// ---------- Game loop ----------
app.ticker.add((ticker) => {
  const dt = ticker.deltaMS;

  earn(getBps() * (dt / 1000));

  counter.text = `${format(bits)} bits`;
  bpsText.text = `${getBps().toFixed(1)} bits/s`;

  for (const { u, btn } of buttons) {
    btn.alpha = bits >= costOf(u) ? 1 : 0.5;
  }

  // cubo: volta ao tamanho normal e flutua
  const s = cube.scale.x + (baseScale - cube.scale.x) * Math.min(1, dt * 0.015);
  cube.scale.set(s);
  cube.y = cubeBaseY + Math.sin(performance.now() / 500) * 6;

  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life += dt;
    f.text.y -= dt * f.speed;
    f.text.alpha = 1 - f.life / f.duration;
    if (f.life >= f.duration) {
      app.stage.removeChild(f.text);
      f.text.destroy();
      floaters.splice(i, 1);
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    p.g.x += p.vx * dt;
    p.g.y += p.vy * dt;
    p.g.alpha = 1 - p.life / PARTICLE_LIFE;
    if (p.life >= PARTICLE_LIFE) {
      app.stage.removeChild(p.g);
      p.g.destroy();
      particles.splice(i, 1);
    }
  }
});

// ---------- Auto-save ----------
setInterval(save, 10000);
window.addEventListener('beforeunload', () => { if (!resetting) save(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !resetting) save();
});

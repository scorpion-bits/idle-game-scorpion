import { Application, Assets, Sprite, Text, Container, Graphics } from 'pixi.js';

const app = new Application();
await app.init({ background: '#0b1020', resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

// ---------- Constantes ----------
const SAVE_KEY = 'scorpion-bits-idle-v1';
const OFFLINE_CAP_S = 8 * 3600;      // no máximo 8h de ganho offline
const CHIP_BONUS = 0.05;             // +5% de produção por chip
const ACHIEVEMENT_BONUS = 0.02;      // +2% de produção por conquista
const FRENZY_MS = 30000;             // duração do Frenesi
const FRENZY_MULT = 7;               // multiplicador do Frenesi
const GOLDEN_MIN_MS = 60000;         // intervalo entre bits dourados
const GOLDEN_MAX_MS = 120000;
const GOLDEN_LIFE_MS = 12000;        // quanto tempo o bit dourado fica na tela
const CHIP_DIVISOR = 1e5;            // runBits necessários para o 1º chip

// ---------- Estado ----------
let bits = 0;
let totalBits = 0;   // total de todos os tempos
let runBits = 0;     // total desta "vida" (zera ao evoluir)
let clicks = 0;
let goldenClicks = 0;
let chips = 0;
let prestiges = 0;
let frenzyLeft = 0;
let resetting = false;

const unlocked = new Set();  // ids de conquistas
const bought = new Set();    // ids de melhorias compradas

const upgrades = [
  { id: 'mouse',  name: 'Teclado Mecânico',  baseCost: 50,    click: 1,   owned: 0 },
  { id: 'intern', name: 'Estagiário',        baseCost: 15,    bps: 0.1,  owned: 0 },
  { id: 'junior', name: 'Dev Júnior',        baseCost: 100,   bps: 1,    owned: 0 },
  { id: 'server', name: 'Servidor Dedicado', baseCost: 1100,  bps: 8,    owned: 0 },
  { id: 'studio', name: 'Estúdio',           baseCost: 12000, bps: 47,   owned: 0 },
];

// Melhorias: compra única, multiplicam um upgrade. Aparecem quando você tem `req` unidades do alvo.
const improvements = [
  { id: 'coffee',   name: 'Café Forte',       desc: 'Estagiários 2x',          cost: 200,    target: 'intern', mult: 2, req: 1 },
  { id: 'switches', name: 'Switches Premium', desc: 'Teclado Mecânico 2x',     cost: 500,    target: 'mouse',  mult: 2, req: 1 },
  { id: 'mentor',   name: 'Mentoria',         desc: 'Devs Júnior 2x',          cost: 1000,   target: 'junior', mult: 2, req: 1 },
  { id: 'coffee2',  name: 'Café Expresso',    desc: 'Estagiários 2x',          cost: 5000,   target: 'intern', mult: 2, req: 10 },
  { id: 'cloud',    name: 'Cloud Premium',    desc: 'Servidores 2x',           cost: 11000,  target: 'server', mult: 2, req: 1 },
  { id: 'mentor2',  name: 'Pair Programming', desc: 'Devs Júnior 2x',          cost: 25000,  target: 'junior', mult: 2, req: 10 },
  { id: 'ide',      name: 'IDE Turbo',        desc: 'Estúdios 2x',             cost: 120000, target: 'studio', mult: 2, req: 1 },
];

// ---------- Lógica ----------
const byId = (id) => upgrades.find((u) => u.id === id);

function costOf(u) {
  return Math.ceil(u.baseCost * 1.15 ** u.owned);
}

// multiplicador vindo das melhorias compradas para este upgrade
function multFor(u) {
  return improvements.reduce((m, imp) => (bought.has(imp.id) && imp.target === u.id ? m * imp.mult : m), 1);
}

// bônus permanente: chips + conquistas
function globalMult() {
  return (1 + CHIP_BONUS * chips) * (1 + ACHIEVEMENT_BONUS * unlocked.size);
}

function getBps() {
  const base = upgrades.reduce((sum, u) => sum + u.owned * (u.bps || 0) * multFor(u), 0);
  return base * globalMult() * (frenzyLeft > 0 ? FRENZY_MULT : 1);
}

function getBitsPerClick() {
  const base = 1 + upgrades.reduce((sum, u) => sum + u.owned * (u.click || 0) * multFor(u), 0);
  return base * globalMult();
}

function totalOwned() {
  return upgrades.reduce((sum, u) => sum + u.owned, 0);
}

function pendingChips() {
  return Math.floor(Math.sqrt(runBits / CHIP_DIVISOR));
}

function earn(amount) {
  bits += amount;
  totalBits += amount;
  runBits += amount;
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
  refreshImprovements();
  save();
}

function buyImprovement(imp) {
  if (bought.has(imp.id) || bits < imp.cost) return;
  bits -= imp.cost;
  bought.add(imp.id);
  refreshShop();
  refreshImprovements();
  save();
}

// ---------- Conquistas ----------
const achievements = [
  { id: 'c1',    name: 'Primeiro clique',        desc: 'Clique no cubo',           test: () => clicks >= 1 },
  { id: 'c100',  name: 'Dedo ágil',              desc: '100 cliques',              test: () => clicks >= 100 },
  { id: 'c1000', name: 'Mão de aço',             desc: '1.000 cliques',            test: () => clicks >= 1000 },
  { id: 'b1k',   name: 'Primeiros bits',         desc: '1K bits no total',         test: () => totalBits >= 1e3 },
  { id: 'b100k', name: 'Pequena software house', desc: '100K bits no total',       test: () => totalBits >= 1e5 },
  { id: 'b10m',  name: 'Referência no mercado',  desc: '10M bits no total',        test: () => totalBits >= 1e7 },
  { id: 'u10',   name: 'Time formado',           desc: 'Tenha 10 upgrades',        test: () => totalOwned() >= 10 },
  { id: 'u50',   name: 'Empresa grande',         desc: 'Tenha 50 upgrades',        test: () => totalOwned() >= 50 },
  { id: 'p10',   name: 'Fábrica de bits',        desc: '10 bits por segundo',      test: () => getBps() >= 10 },
  { id: 'p100',  name: 'Linha de montagem',      desc: '100 bits por segundo',     test: () => getBps() >= 100 },
  { id: 'g1',    name: 'Bit dourado',            desc: 'Pegue um bit dourado',     test: () => goldenClicks >= 1 },
  { id: 'pr1',   name: 'Evolução',               desc: 'Evolua pela primeira vez', test: () => prestiges >= 1 },
];

function checkAchievements() {
  for (const a of achievements) {
    if (!unlocked.has(a.id) && a.test()) {
      unlocked.add(a.id);
      toast(`Conquista: ${a.name}`, '#ffc46b');
      refreshAchievements();
      save();
    }
  }
}

// ---------- Save / Load ----------
const num = (v) => (Number.isFinite(v) ? v : 0);

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      bits, totalBits, runBits, clicks, goldenClicks, chips, prestiges,
      owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
      bought: [...bought],
      unlocked: [...unlocked],
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
    bits = num(d.bits);
    totalBits = num(d.totalBits);
    runBits = num(d.runBits ?? d.totalBits);
    clicks = num(d.clicks);
    goldenClicks = num(d.goldenClicks);
    chips = num(d.chips);
    prestiges = num(d.prestiges);
    for (const u of upgrades) {
      // saves antigos chamavam o "Servidor Dedicado" de "lab"
      u.owned = num(d.owned?.[u.id] ?? (u.id === 'server' ? d.owned?.lab : 0));
    }
    for (const id of d.bought ?? []) bought.add(id);
    for (const id of d.unlocked ?? []) unlocked.add(id);
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

const metaText = new Text({
  text: '',
  style: { fill: '#b4c6d7', fontSize: 15, fontFamily: 'Arial' },
});
metaText.anchor.set(0.5, 0);
app.stage.addChild(metaText);

const frenzyText = new Text({
  text: '',
  style: { fill: '#ffc46b', fontSize: 20, fontFamily: 'Arial', fontWeight: 'bold' },
});
frenzyText.anchor.set(0.5, 0);
app.stage.addChild(frenzyText);

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

// ---------- Loja de upgrades (direita) ----------
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
    const per = (u.click || u.bps) * multFor(u);
    const effect = u.click ? `+${+per.toFixed(1)}/clique` : `+${+per.toFixed(1)}/s`;
    title.text = `${u.name} (${u.owned})`;
    info.text = `Custo: ${format(costOf(u))} · ${effect}`;
  }
}

// ---------- Melhorias (esquerda) ----------
const perks = new Container();
app.stage.addChild(perks);

const perksTitle = new Text({
  text: 'Melhorias',
  style: { fill: '#eef5fb', fontSize: 20, fontFamily: 'Arial', fontWeight: 'bold' },
});
perks.addChild(perksTitle);

const perkButtons = [];

for (const imp of improvements) {
  const btn = new Container();

  const bg = new Graphics()
    .roundRect(0, 0, 260, 58, 12)
    .fill(0x1a2440)
    .stroke({ width: 2, color: 0x8b5cf6 });

  const title = new Text({
    text: imp.name,
    style: { fill: '#eef5fb', fontSize: 16, fontFamily: 'Arial', fontWeight: 'bold' },
  });
  title.position.set(12, 7);

  const info = new Text({
    text: `${imp.desc} · Custo: ${format(imp.cost)}`,
    style: { fill: '#b4c6d7', fontSize: 13, fontFamily: 'Arial' },
  });
  info.position.set(12, 32);

  btn.addChild(bg, title, info);
  btn.eventMode = 'static';
  btn.cursor = 'pointer';
  btn.on('pointerdown', () => buyImprovement(imp));
  btn.visible = false;

  perks.addChild(btn);
  perkButtons.push({ imp, btn });
}

const MAX_PERKS_SHOWN = 5;

function refreshImprovements() {
  const available = improvements
    .filter((imp) => !bought.has(imp.id) && byId(imp.target).owned >= imp.req)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, MAX_PERKS_SHOWN);

  perkButtons.forEach(({ imp, btn }) => {
    const slot = available.indexOf(imp);
    btn.visible = slot !== -1;
    if (slot !== -1) btn.y = 34 + slot * 66;
  });
  perksTitle.text = available.length ? 'Melhorias' : '';
}

// ---------- Evolução / prestígio (embaixo) ----------
const prestigeBtn = new Container();
const prestigeBg = new Graphics()
  .roundRect(0, 0, 320, 44, 12)
  .fill(0x2a1a55)
  .stroke({ width: 2, color: 0x8b5cf6 });
const prestigeLabel = new Text({
  text: '',
  style: { fill: '#eef5fb', fontSize: 16, fontFamily: 'Arial', fontWeight: 'bold' },
});
prestigeLabel.anchor.set(0.5);
prestigeLabel.position.set(160, 22);
prestigeBtn.addChild(prestigeBg, prestigeLabel);
prestigeBtn.eventMode = 'static';
prestigeBtn.cursor = 'pointer';
prestigeBtn.visible = false;
prestigeBtn.on('pointerdown', prestige);
app.stage.addChild(prestigeBtn);

function prestige() {
  const gain = pendingChips();
  if (gain < 1) return;
  const ok = confirm(
    `Evoluir agora?\n\nVocê ganha ${gain} chip(s) (+${Math.round(gain * CHIP_BONUS * 100)}% de produção, permanente).\n` +
    'Seus bits, upgrades e melhorias serão reiniciados. Chips e conquistas ficam.',
  );
  if (!ok) return;

  chips += gain;
  prestiges++;
  bits = 0;
  runBits = 0;
  for (const u of upgrades) u.owned = 0;
  bought.clear();
  refreshShop();
  refreshImprovements();
  toast(`Evolução! +${gain} chip(s)`, '#8b5cf6');
  checkAchievements();
  save();
}

// ---------- Painel de conquistas ----------
const achButton = new Text({
  text: '',
  style: { fill: '#ffc46b', fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold' },
});
achButton.anchor.set(0.5, 0);
achButton.eventMode = 'static';
achButton.cursor = 'pointer';
app.stage.addChild(achButton);

const ACH_W = 480;
const ACH_ROW = 28;
const ACH_H = 64 + achievements.length * ACH_ROW;

const achPanel = new Container();
achPanel.visible = false;
achPanel.eventMode = 'static';
achPanel.cursor = 'pointer';
achPanel.addChild(
  new Graphics()
    .roundRect(0, 0, ACH_W, ACH_H, 16)
    .fill({ color: 0x0f1730, alpha: 0.97 })
    .stroke({ width: 2, color: 0xffc46b }),
);

const achTitle = new Text({
  text: '',
  style: { fill: '#ffc46b', fontSize: 22, fontFamily: 'Arial', fontWeight: 'bold' },
});
achTitle.position.set(20, 14);
achPanel.addChild(achTitle);

const achRows = achievements.map((a, i) => {
  const row = new Text({
    text: '',
    style: { fill: '#55697d', fontSize: 15, fontFamily: 'Arial' },
  });
  row.position.set(20, 52 + i * ACH_ROW);
  achPanel.addChild(row);
  return { a, row };
});

function refreshAchievements() {
  achButton.text = `Conquistas ${unlocked.size}/${achievements.length}`;
  achTitle.text = `Conquistas (+${Math.round(unlocked.size * ACHIEVEMENT_BONUS * 100)}% de produção)`;
  for (const { a, row } of achRows) {
    const done = unlocked.has(a.id);
    row.text = `${done ? '[x]' : '[ ]'} ${a.name} — ${a.desc}`;
    row.style.fill = done ? '#7ee2a8' : '#7d94aa';
  }
}

const toggleAchievements = () => { achPanel.visible = !achPanel.visible; };
achButton.on('pointerdown', toggleAchievements);
achPanel.on('pointerdown', toggleAchievements);
app.stage.addChild(achPanel);

// ---------- Layout ----------
let cubeBaseY = 0;

function layout() {
  const { width, height } = app.screen;
  cubeBaseY = height / 2;
  cube.x = width / 2;
  counter.position.set(width / 2, 30);
  bpsText.position.set(width / 2, 90);
  metaText.position.set(width / 2, 120);
  frenzyText.position.set(width / 2, 146);
  shop.position.set(Math.max(10, width - 290), 120);
  perks.position.set(16, 120);
  achButton.position.set(width / 2, height - 100);
  prestigeBtn.position.set(width / 2 - 160, height - 60);
  resetBtn.position.set(16, height - 30);
  achPanel.position.set((width - ACH_W) / 2, Math.max(10, (height - ACH_H) / 2));
}
layout();
app.renderer.on('resize', layout);

// ---------- Efeitos ----------
const floaters = [];
const particles = [];

function spawnFloatingText(x, y, message, opts = {}) {
  const { fill = '#6ad8fe', size = 32, duration = 800, speed = 0.08, isToast = false } = opts;
  const text = new Text({
    text: message,
    style: { fill, fontSize: size, fontWeight: 'bold', fontFamily: 'Arial' },
  });
  text.anchor.set(0.5);
  text.position.set(x, y);
  // entra logo abaixo do painel de conquistas, que fica sempre na frente
  app.stage.addChildAt(text, app.stage.getChildIndex(achPanel));
  floaters.push({ text, life: 0, duration, speed, isToast });
}

// avisos no topo do cubo; vários avisos ao mesmo tempo ficam empilhados
function toast(message, fill = '#ffc46b') {
  const stacked = floaters.filter((f) => f.isToast).length;
  spawnFloatingText(app.screen.width / 2, app.screen.height / 2 - 200 + stacked * 34, message, {
    fill, size: 26, duration: 3500, speed: 0.01, isToast: true,
  });
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

// ---------- Bit dourado ----------
let golden = null;
let goldenTimer = GOLDEN_MIN_MS + Math.random() * (GOLDEN_MAX_MS - GOLDEN_MIN_MS);

function spawnGolden() {
  if (golden) return;
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.tint = 0xffc46b;
  sprite.scale.set(80 / texture.height);

  // evita as colunas de lojas quando a tela é larga o bastante
  const minX = Math.min(330, app.screen.width * 0.2);
  const maxX = Math.max(minX + 1, app.screen.width - 330);
  const minY = 170;
  const maxY = Math.max(minY + 1, app.screen.height - 130);
  sprite.position.set(minX + Math.random() * (maxX - minX), minY + Math.random() * (maxY - minY));

  sprite.eventMode = 'static';
  sprite.cursor = 'pointer';
  sprite.on('pointerdown', collectGolden);
  app.stage.addChild(sprite);
  golden = { sprite, life: 0 };
}

function removeGolden() {
  if (!golden) return;
  app.stage.removeChild(golden.sprite);
  golden.sprite.destroy();
  golden = null;
}

function collectGolden() {
  if (!golden) return;
  goldenClicks++;
  if (Math.random() < 0.5) {
    frenzyLeft = FRENZY_MS;
    toast(`Frenesi! Produção x${FRENZY_MULT} por ${FRENZY_MS / 1000}s`, '#ffc46b');
  } else {
    const gain = Math.min(bits * 0.15, getBps() * 900) + 13;
    earn(gain);
    toast(`Sorte! +${format(gain)} bits`, '#ffc46b');
  }
  spawnParticles(golden.sprite.x, golden.sprite.y);
  removeGolden();
  checkAchievements();
  save();
}

// ---------- Clique ----------
cube.on('pointerdown', (event) => {
  const gain = getBitsPerClick();
  earn(gain);
  clicks++;

  cube.scale.set(baseScale * 0.9);
  const jitter = (Math.random() - 0.5) * 40;
  spawnFloatingText(event.global.x + jitter, event.global.y, `+${format(gain)}`);
  spawnParticles(event.global.x, event.global.y);
});

// ---------- Estado inicial da interface ----------
refreshShop();
refreshImprovements();
refreshAchievements();

// ---------- Progresso offline ----------
if (lastSave) {
  const elapsed = Math.min((Date.now() - lastSave) / 1000, OFFLINE_CAP_S);
  const gain = getBps() * elapsed;
  if (gain >= 1) {
    earn(gain);
    toast(`Bem-vindo de volta! +${format(gain)} bits`, '#ffc46b');
  }
}

// ---------- Game loop ----------
let achTimer = 0;

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS;

  earn(getBps() * (dt / 1000));

  // Frenesi
  if (frenzyLeft > 0) frenzyLeft = Math.max(0, frenzyLeft - dt);
  frenzyText.text = frenzyLeft > 0
    ? `Frenesi x${FRENZY_MULT}: ${Math.ceil(frenzyLeft / 1000)}s`
    : '';

  // Bit dourado: aparece de tempos em tempos e some se ninguém clicar
  if (golden) {
    golden.life += dt;
    golden.sprite.alpha = 0.65 + 0.35 * Math.sin(golden.life / 150);
    golden.sprite.rotation = Math.sin(golden.life / 400) * 0.2;
    if (golden.life >= GOLDEN_LIFE_MS) removeGolden();
  } else {
    goldenTimer -= dt;
    if (goldenTimer <= 0) {
      spawnGolden();
      goldenTimer = GOLDEN_MIN_MS + Math.random() * (GOLDEN_MAX_MS - GOLDEN_MIN_MS);
    }
  }

  // Conquistas: checadas a cada meio segundo
  achTimer += dt;
  if (achTimer >= 500) {
    achTimer = 0;
    checkAchievements();
  }

  // Textos
  counter.text = `${format(bits)} bits`;
  bpsText.text = `${getBps().toFixed(1)} bits/s`;
  metaText.text = chips > 0
    ? `Chips: ${chips} (+${Math.round(chips * CHIP_BONUS * 100)}%)`
    : '';

  const pending = pendingChips();
  prestigeBtn.visible = pending >= 1;
  prestigeLabel.text = `Evoluir: +${pending} chip(s)`;

  for (const { u, btn } of buttons) {
    btn.alpha = bits >= costOf(u) ? 1 : 0.5;
  }
  for (const { imp, btn } of perkButtons) {
    if (btn.visible) btn.alpha = bits >= imp.cost ? 1 : 0.5;
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

// ---------- Ganchos de depuração (somente em `npm run dev`) ----------
if (import.meta.env.DEV) {
  window.__idle = {
    earn, spawnGolden, collectGolden, prestige, checkAchievements, pendingChips,
    get state() {
      return { bits, runBits, clicks, chips, prestiges, frenzyLeft, unlocked: [...unlocked], bought: [...bought], bps: getBps(), perClick: getBitsPerClick(), golden: !!golden };
    },
  };
}

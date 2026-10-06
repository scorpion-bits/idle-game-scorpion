import { Application, Assets, Sprite, Container, Graphics, Rectangle } from 'pixi.js';
import { UPGRADE_DEFS, makeImprovements } from './data.js';
import {
  SKILLS, BRANCHES, RING_R0, RING_STEP, spokeAngle, branchStart, twistAt, newMods, computeMods,
} from './skills.js';
import {
  txt, hex, darken, lighten, drawSlab, makeSlabButton, createScroll, createDock,
} from './ui.js';

const app = new Application();
await app.init({
  background: '#0b1020',
  resizeTo: window,
  antialias: true,
  resolution: Math.min(window.devicePixelRatio || 1, 2.5),
  autoDensity: true,
});
app.canvas.style.touchAction = 'none';
document.body.appendChild(app.canvas);

// ---------- Constantes ----------
const SAVE_KEY = 'scorpion-bits-idle-v1';
const BASE_OFFLINE_H = 8;            // horas de ganho offline (habilidades aumentam)
const GROWTH = 1.15;                 // custo cresce 15% por unidade
const LEVEL_SIZE = 10;               // a barra do upgrade enche a cada 10 unidades...
const LEVEL_BASE_BONUS = 0.2;        // ...e ao encher ele sobe de nível: +20% de produção
const CHIP_BONUS = 0.05;             // +5% de produção por chip
const ACHIEVEMENT_BONUS = 0.02;      // +2% de produção por conquista
const FRENZY_MS = 30000;
const FRENZY_MULT = 7;
const GOLDEN_MIN_MS = 60000;
const GOLDEN_MAX_MS = 120000;
const GOLDEN_LIFE_MS = 12000;
const CHIP_DIVISOR = 1e5;            // runBits necessários para o 1º chip
const BUY_MODES = [1, 10, 100, 'max'];
const ISO = 1;                       // achatamento vertical da mandala (1 = círculo; 0.58 = chão isométrico)

// ---------- Estado ----------
let bits = 0;
let totalBits = 0;   // total de todos os tempos
let runBits = 0;     // total desta "vida" (zera ao evoluir)
let clicks = 0;
let goldenClicks = 0;
let chips = 0;
let prestiges = 0;
let abilityUses = 0;
let playMs = 0;
let frenzyLeft = 0;
let buyMode = 1;
let resetting = false;
let savedUi = null;
let uiMoved = false;                // true quando o último gesto foi um arrasto (não um toque)
const touchUi = window.matchMedia('(pointer: coarse)').matches;

const unlocked = new Set();     // ids de conquistas
const bought = new Set();       // ids de melhorias
const skillsOwned = new Set();  // ids de habilidades
let mods = newMods();

const upgrades = UPGRADE_DEFS.map((d) => ({ ...d, owned: 0 }));
const improvements = makeImprovements();
const clickUpgrades = upgrades.filter((u) => u.kind === 'click');
const genUpgrades = upgrades.filter((u) => u.kind === 'gen');
const byId = (id) => upgrades.find((u) => u.id === id);

// Impulsos: habilidades ativas com recarga (como em Clicker Heroes / Tap Titans)
const abilityDefs = [
  { id: 'rage',      name: 'Fúria',     desc: 'Cliques x10 · 15s',   dur: 15000, cd: 120000 },
  { id: 'overclock', name: 'Overclock', desc: 'Produção x3 · 20s',   dur: 20000, cd: 180000 },
  { id: 'sprint',    name: 'Sprint',    desc: '+10 min de bits',   dur: 0,     cd: 300000 },
];
const abilities = Object.fromEntries(abilityDefs.map((a) => [a.id, { act: 0, cd: 0 }]));

// ---------- Lógica ----------
function recomputeMods() {
  mods = computeMods(skillsOwned);
}

const levelOf = (u) => Math.floor(u.owned / LEVEL_SIZE);
const levelMult = (u) => (1 + LEVEL_BASE_BONUS + mods.levelBonus) ** levelOf(u);

function improvementsMult(u) {
  let m = 1;
  for (const imp of improvements) {
    if (imp.target === u.id && bought.has(imp.id)) m *= imp.mult;
  }
  return m;
}

const unitMult = (u) => improvementsMult(u) * levelMult(u) * (mods.gen[u.id] ?? 1);

function globalMult() {
  return (1 + (CHIP_BONUS + mods.chipBonus) * chips) * (1 + ACHIEVEMENT_BONUS * unlocked.size);
}

function baseBps() {
  let sum = 0;
  for (const u of genUpgrades) sum += u.owned * u.bps * unitMult(u);
  return sum;
}

const frenzyMult = () => FRENZY_MULT + mods.frenzyAdd;

function getBps() {
  return baseBps() * globalMult() * mods.prodMult
    * (frenzyLeft > 0 ? frenzyMult() : 1)
    * (abilities.overclock.act > 0 ? 3 : 1);
}

function getBitsPerClick() {
  let flat = 1;
  for (const u of clickUpgrades) flat += u.owned * u.click * unitMult(u);
  const base = flat * mods.clickMult + baseBps() * mods.clickBps;
  return base * globalMult() * (abilities.rage.act > 0 ? 10 : 1);
}

const totalOwned = () => upgrades.reduce((sum, u) => sum + u.owned, 0);
const pendingChips = () => Math.floor(Math.sqrt(runBits / CHIP_DIVISOR));

function earn(amount) {
  bits += amount;
  totalBits += amount;
  runBits += amount;
}

function format(n) {
  if (n < 1000) return Math.floor(n).toString();
  const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx'];
  let i = -1;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return n.toFixed(2) + units[i];
}

// valores pequenos com decimais (0.1/s), grandes abreviados
const rate = (x) => (x < 1000 ? String(+x.toFixed(1)) : format(x));

// ---- custo e modos de compra (1x, 10x, 100x, Máx) ----
const unitCost = (u) => u.baseCost * mods.costMult * GROWTH ** u.owned;
const costFor = (u, n) => Math.ceil((unitCost(u) * (GROWTH ** n - 1)) / (GROWTH - 1));

function maxAffordable(u) {
  const first = unitCost(u);
  if (!(bits >= first)) return 0;
  let n = Math.floor(Math.log(1 + (bits * (GROWTH - 1)) / first) / Math.log(GROWTH));
  n = Math.min(n, 5000);
  while (n > 0 && costFor(u, n) > bits) n--;
  while (n < 5000 && costFor(u, n + 1) <= bits) n++;
  return n;
}

function planBuy(u) {
  if (buyMode === 'max') {
    const n = maxAffordable(u);
    return n >= 1 ? { n, cost: costFor(u, n), ok: true } : { n: 1, cost: costFor(u, 1), ok: false };
  }
  const cost = costFor(u, buyMode);
  return { n: buyMode, cost, ok: bits >= cost };
}

function buy(u) {
  const { n, cost, ok } = planBuy(u);
  if (!ok) return;
  const before = levelOf(u);
  bits -= cost;
  u.owned += n;
  const after = levelOf(u);
  if (after > before) {
    toast(`${u.name} subiu para o nível ${after}! (+${Math.round((LEVEL_BASE_BONUS + mods.levelBonus) * 100)}%)`, '#7ee2a8');
  }
  updateShop();
  updatePerks();
  save();
}

function buyImprovement(imp) {
  if (bought.has(imp.id) || bits < imp.cost) return;
  bits -= imp.cost;
  bought.add(imp.id);
  updateShop();
  updatePerks();
  save();
}

// ---------- Nível do jogador e pontos de habilidade ----------
function playerLevel() {
  return totalBits < 1000 ? 0 : Math.floor(Math.log(totalBits / 1000) / Math.log(1.6)) + 1;
}

function levelProgress() {
  if (totalBits < 1000) return totalBits / 1000;
  const lv = playerLevel();
  const from = 1000 * 1.6 ** (lv - 1);
  const to = 1000 * 1.6 ** lv;
  return (totalBits - from) / (to - from);
}

const skillPointsTotal = () => playerLevel() + chips;
const skillPointsSpent = () => SKILLS.reduce((sum, s) => sum + (skillsOwned.has(s.id) ? s.cost : 0), 0);
const skillPointsFree = () => skillPointsTotal() - skillPointsSpent();

// ---------- Conquistas ----------
const achievements = [
  { id: 'c1',     name: 'Primeiro clique',        desc: 'Clique no cubo',            test: () => clicks >= 1 },
  { id: 'c100',   name: 'Dedo ágil',              desc: '100 cliques',               test: () => clicks >= 100 },
  { id: 'c1000',  name: 'Mão de aço',             desc: '1.000 cliques',             test: () => clicks >= 1000 },
  { id: 'c10000', name: 'Tendinite',              desc: '10.000 cliques',            test: () => clicks >= 10000 },
  { id: 'b1k',    name: 'Primeiros bits',         desc: '1K bits no total',          test: () => totalBits >= 1e3 },
  { id: 'b100k',  name: 'Pequena software house', desc: '100K bits no total',        test: () => totalBits >= 1e5 },
  { id: 'b10m',   name: 'Referência no mercado',  desc: '10M bits no total',         test: () => totalBits >= 1e7 },
  { id: 'b1b',    name: 'Unicórnio',              desc: '1B bits no total',          test: () => totalBits >= 1e9 },
  { id: 'b1t',    name: 'Império digital',        desc: '1T bits no total',          test: () => totalBits >= 1e12 },
  { id: 'u10',    name: 'Time formado',           desc: 'Tenha 10 upgrades',         test: () => totalOwned() >= 10 },
  { id: 'u50',    name: 'Empresa grande',         desc: 'Tenha 50 upgrades',         test: () => totalOwned() >= 50 },
  { id: 'u100',   name: 'Multinacional',          desc: 'Tenha 100 upgrades',        test: () => totalOwned() >= 100 },
  { id: 'u250',   name: 'Conglomerado',           desc: 'Tenha 250 upgrades',        test: () => totalOwned() >= 250 },
  { id: 'p10',    name: 'Fábrica de bits',        desc: '10 bits por segundo',       test: () => getBps() >= 10 },
  { id: 'p100',   name: 'Linha de montagem',      desc: '100 bits por segundo',      test: () => getBps() >= 100 },
  { id: 'p10k',   name: 'Usina de dados',         desc: '10K bits por segundo',      test: () => getBps() >= 1e4 },
  { id: 'p1m',    name: 'Rio de bits',            desc: '1M bits por segundo',       test: () => getBps() >= 1e6 },
  { id: 'g1',     name: 'Bit dourado',            desc: 'Pegue um bit dourado',      test: () => goldenClicks >= 1 },
  { id: 'g10',    name: 'Caçador de ouro',        desc: 'Pegue 10 bits dourados',    test: () => goldenClicks >= 10 },
  { id: 'pr1',    name: 'Evolução',               desc: 'Evolua pela primeira vez',  test: () => prestiges >= 1 },
  { id: 'pr5',    name: 'Reencarnação',           desc: 'Evolua 5 vezes',            test: () => prestiges >= 5 },
  { id: 'lv10',   name: 'Veterano',               desc: 'Chegue ao nível 10',        test: () => playerLevel() >= 10 },
  { id: 'lv25',   name: 'Lenda viva',             desc: 'Chegue ao nível 25',        test: () => playerLevel() >= 25 },
  { id: 'sk10',   name: 'Aprendiz',               desc: 'Compre 10 habilidades',     test: () => skillsOwned.size >= 10 },
  { id: 'sk50',   name: 'Mestre das árvores',     desc: 'Compre 50 habilidades',     test: () => skillsOwned.size >= 50 },
  { id: 'ab1',    name: 'Hora do impulso',        desc: 'Use um impulso',            test: () => abilityUses >= 1 },
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
      bits, totalBits, runBits, clicks, goldenClicks, chips, prestiges, abilityUses, playMs, buyMode,
      owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
      bought: [...bought],
      unlocked: [...unlocked],
      skills: [...skillsOwned],
      abilities,
      ui: { l: leftDock.state(), r: rightDock.state() },
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
    abilityUses = num(d.abilityUses);
    playMs = num(d.playMs);
    if (BUY_MODES.includes(d.buyMode)) buyMode = d.buyMode;
    for (const u of upgrades) u.owned = num(d.owned?.[u.id]);
    for (const id of d.bought ?? []) if (improvements.some((i) => i.id === id)) bought.add(id);
    for (const id of d.unlocked ?? []) unlocked.add(id);
    for (const id of d.skills ?? []) if (SKILLS.some((s) => s.id === id)) skillsOwned.add(id);
    recomputeMods();
    savedUi = d.ui ?? null;

    const last = d.lastSave ?? null;
    const away = last ? Date.now() - last : 0;
    for (const a of abilityDefs) {
      const s = d.abilities?.[a.id];
      if (s) {
        abilities[a.id].act = Math.max(0, num(s.act) - away);
        abilities[a.id].cd = Math.max(0, num(s.cd) - away);
      }
    }
    return last;
  } catch {
    return null;
  }
}

const lastSave = load();

// ---------- Cenário isométrico: chão em grade e plataforma sob o cubo ----------
const deco = new Graphics();
app.stage.addChild(deco);

let decoFrenzy = false;
let cubeSize = 300;
let cubeBaseY = 0;

function drawDeco() {
  const { width: W, height: H } = app.screen;
  deco.clear();

  // grade isométrica (linhas com inclinação 2:1)
  const step = 70;
  for (let c = -W / 2; c <= H; c += step) deco.moveTo(0, c).lineTo(W, c + W / 2);
  for (let c = 0; c <= H + W / 2; c += step) deco.moveTo(0, c).lineTo(W, c - W / 2);
  deco.stroke({ width: 1, color: 0x6ad8fe, alpha: 0.05 });

  // plataforma sob o cubo
  const cx = W / 2;
  const cy = cubeBaseY + cubeSize * 0.46;
  const rx = cubeSize * 0.72;
  const ry = rx / 2;
  const t = Math.max(8, cubeSize * 0.055);
  const edge = decoFrenzy ? 0xffc46b : 0x6ad8fe;

  deco.ellipse(cx, cy + t + 14, rx + 40, ry + 24).fill({ color: edge, alpha: decoFrenzy ? 0.14 : 0.06 });
  deco.poly([cx - rx, cy, cx, cy + ry, cx, cy + ry + t, cx - rx, cy + t]).fill(0x0c1428);
  deco.poly([cx + rx, cy, cx, cy + ry, cx, cy + ry + t, cx + rx, cy + t]).fill(0x070d1c);
  deco.poly([cx, cy - ry, cx + rx, cy, cx, cy + ry, cx - rx, cy])
    .fill(0x111b38).stroke({ width: 2, color: edge, alpha: 0.55 });
  deco.poly([cx, cy - ry * 0.62, cx + rx * 0.62, cy, cx, cy + ry * 0.62, cx - rx * 0.62, cy])
    .stroke({ width: 1, color: edge, alpha: 0.25 });
}

// ---------- Cubo ----------
const texture = await Assets.load(`${import.meta.env.BASE_URL}assets/cube.png`);
const cube = new Sprite(texture);
cube.anchor.set(0.5);

let baseScale = cubeSize / texture.height;
cube.scale.set(baseScale);
cube.eventMode = 'static';
cube.cursor = 'pointer';
app.stage.addChild(cube);

// ---------- Textos do topo ----------
const counter = txt('0 bits', '#eef5fb', 48, true);
counter.anchor.set(0.5, 0);
app.stage.addChild(counter);

const bpsText = txt('0 bits/s', '#7ee2a8', 22);
bpsText.anchor.set(0.5, 0);
app.stage.addChild(bpsText);

const metaText = txt('', '#b4c6d7', 15);
metaText.anchor.set(0.5, 0);
app.stage.addChild(metaText);

const xpBar = new Graphics();
app.stage.addChild(xpBar);

const frenzyText = txt('', '#ffc46b', 20, true);
frenzyText.anchor.set(0.5, 0);
app.stage.addChild(frenzyText);

const resetBtn = txt('Resetar jogo', '#55697d', 14);
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

// ---------- Gavetas laterais ----------
const PANEL_W = 300;
const PAGE_W = PANEL_W - 28;
const CARD_W = PAGE_W - 14;
const DEPTH = 4;

const rightDock = createDock({ side: 'right', panelW: PANEL_W });
const leftDock = createDock({ side: 'left', panelW: PANEL_W });
app.stage.addChild(leftDock.root, rightDock.root);

// ---- Direita: seletor de modo de compra (x1 / x10 / x100 / Máx) ----
const modeBar = new Container();
const modeButtons = BUY_MODES.map((mode, i) => {
  const btn = makeSlabButton(60, 26, 0x16203a, 0x3a4a63, { depth: 3, cut: 6 });
  btn.x = i * 68;
  const label = txt(mode === 'max' ? 'Máx' : `x${mode}`, '#eef5fb', 14, true);
  label.anchor.set(0.5);
  label.position.set(30, 13);
  btn.addChild(label);
  btn.on('pointertap', () => setBuyMode(mode));
  modeBar.addChild(btn);
  return { mode, btn };
});
rightDock.setHeader(modeBar, 40);

function setBuyMode(mode) {
  buyMode = mode;
  paintModeButtons();
  updateShop();
  save();
}

function paintModeButtons() {
  for (const { mode, btn } of modeButtons) {
    const on = mode === buyMode;
    btn.paint({ face: on ? 0x5b3fc4 : 0x16203a, edge: on ? 0x8b5cf6 : 0x3a4a63 });
  }
}

// ---- Direita: páginas Clique e Produção ----
const clickPage = createScroll(PAGE_W);
const prodPage = createScroll(PAGE_W);
const shopButtons = [];

for (const u of upgrades) {
  const H = 76;
  const accent = u.kind === 'click' ? 0x6ad8fe : 0x7ee2a8;
  const btn = makeSlabButton(CARD_W, H, 0x182244, accent, { depth: DEPTH, cut: 9, edgeAlpha: 0.8 });

  const title = txt('', '#eef5fb', 15, true);
  title.position.set(14, 8);
  const lvlText = txt('', '#7ee2a8', 12, true);
  lvlText.anchor.set(1, 0);
  lvlText.position.set(CARD_W - 14, 10);
  const cost = txt('', '#eef5fb', 14);
  cost.position.set(14, 30);
  const info = txt('', '#9fb3c8', 13);
  info.position.set(14, 48);
  const bar = new Graphics();

  btn.addChild(title, lvlText, cost, info, bar);
  btn.on('pointertap', () => { if (!uiMoved) buy(u); });

  (u.kind === 'click' ? clickPage : prodPage).add(btn, H + DEPTH);
  shopButtons.push({ u, btn, title, lvlText, cost, info, bar });
}

rightDock.addTab('Clique', clickPage, 0x6ad8fe);
rightDock.addTab('Produção', prodPage, 0x7ee2a8);

function updateShop() {
  for (const { u, btn, title, lvlText, cost, info, bar } of shopButtons) {
    const plan = planBuy(u);
    const per = (u.click ?? u.bps) * unitMult(u) * (u.click ? mods.clickMult : 1);
    const perText = u.click ? `+${rate(per)}/clique` : `+${rate(per)}/s`;

    title.text = u.name;
    lvlText.text = `x${u.owned} · Nv ${levelOf(u)}`;
    cost.text = `Comprar +${plan.n}: ${format(plan.cost)}`;
    info.text = `${perText} cada · nível: ${u.owned % LEVEL_SIZE}/${LEVEL_SIZE}`;
    btn.alpha = plan.ok ? 1 : 0.55;

    // barra de nível: enche a cada unidade, ao completar 10 o upgrade sobe de nível
    const fill = (u.owned % LEVEL_SIZE) / LEVEL_SIZE;
    const bw = CARD_W - 28;
    bar.clear()
      .roundRect(14, 66, bw, 5, 2).fill(0x0b1020)
      .roundRect(14, 66, Math.max(fill > 0 ? 4 : 0, bw * fill), 5, 2).fill(0x7ee2a8);
  }
}

// ---- Esquerda: páginas Melhorias e Estatísticas ----
const perksPage = createScroll(PAGE_W);
const perkButtons = [];

for (const imp of improvements) {
  const H = 58;
  const btn = makeSlabButton(CARD_W, H, 0x1b1f45, 0x8b5cf6, { depth: DEPTH, cut: 9, edgeAlpha: 0.8 });
  const title = txt(imp.name, '#eef5fb', 15, true);
  title.position.set(14, 8);
  const info = txt(`Dobra a produção · Custo: ${format(imp.cost)}`, '#9fb3c8', 13);
  info.position.set(14, 33);
  btn.addChild(title, info);
  btn.visible = false;
  btn.on('pointertap', () => { if (!uiMoved) buyImprovement(imp); });
  perksPage.add(btn, H + DEPTH);
  perkButtons.push({ imp, btn });
}

const perksEmpty = txt('Compre upgrades para liberar\nnovas melhorias.', '#7d94aa', 14);
perksEmpty.style.lineHeight = 20;
perksEmpty.position.set(4, 6);

const statsPage = createScroll(PAGE_W);
const statsText = txt('', '#b4c6d7', 14);
statsText.style.lineHeight = 22;
statsPage.add(statsText, 180);

leftDock.addTab('Melhorias', perksPage, 0x8b5cf6);
leftDock.addTab('Estatísticas', statsPage, 0xffc46b);

const costOfItem = (container) => perkButtons.find(({ btn }) => btn === container).imp.cost;
let perksSignature = '';

function updatePerks() {
  let count = 0;
  for (const { imp, btn } of perkButtons) {
    const show = !bought.has(imp.id) && byId(imp.target).owned >= imp.req;
    btn.visible = show;
    if (show) count++;
  }
  const signature = perkButtons.map(({ btn }) => (btn.visible ? 1 : 0)).join('');
  if (signature !== perksSignature) {
    perksSignature = signature;
    perksPage.items.sort((a, b) => costOfItem(a.c) - costOfItem(b.c));
    perksPage.relayout();
  }
  leftDock.setLabel(0, count ? `Melhorias (${count})` : 'Melhorias');
}

function updateStats() {
  const mins = Math.floor(playMs / 60000);
  statsText.text = [
    `Cliques: ${format(clicks)}`,
    `Bits dourados: ${goldenClicks}`,
    `Bits (esta vida): ${format(runBits)}`,
    `Bits (total): ${format(totalBits)}`,
    `Evoluções: ${prestiges}`,
    `Upgrades comprados: ${totalOwned()}`,
    `Habilidades: ${skillsOwned.size}/${SKILLS.length}`,
    `Conquistas: ${unlocked.size}/${achievements.length}`,
    `Tempo de jogo: ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}min`,
  ].join('\n');
}

// ---------- Impulsos (habilidades ativas) ----------
const abilityButtons = abilityDefs.map((a) => {
  const btn = makeSlabButton(160, 46, 0x2a2410, 0xffc46b, { depth: DEPTH, cut: 9, edgeAlpha: 0.85 });
  const name = txt(a.name, '#eef5fb', 15, true);
  name.position.set(12, 5);
  const status = txt('', '#b4c6d7', 13);
  status.position.set(12, 25);
  btn.addChild(name, status);
  btn.on('pointertap', () => useAbility(a));
  app.stage.addChild(btn);
  return { a, btn, name, status };
});

function useAbility(a) {
  const s = abilities[a.id];
  if (s.cd > 0) return;
  if (a.id === 'sprint') {
    const gain = getBps() * 600;
    if (gain < 1) {
      toast('Você precisa de produção para usar o Sprint', '#ff8a8a');
      return;
    }
    earn(gain);
    toast(`Sprint! +${format(gain)} bits`, '#ffc46b');
  } else {
    s.act = a.dur;
  }
  s.cd = a.cd * mods.abilityCd;
  abilityUses++;
  checkAchievements();
  save();
}

function updateAbilities() {
  for (const { a, btn, status } of abilityButtons) {
    const s = abilities[a.id];
    if (s.act > 0) {
      status.text = `Ativo: ${Math.ceil(s.act / 1000)}s`;
      status.style.fill = '#7ee2a8';
      btn.alpha = 1;
    } else if (s.cd > 0) {
      const sec = Math.ceil(s.cd / 1000);
      status.text = `Recarga: ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      status.style.fill = '#7d94aa';
      btn.alpha = 0.5;
    } else {
      status.text = a.desc;
      status.style.fill = '#b4c6d7';
      btn.alpha = 1;
    }
  }
}

// ---------- Botões de baixo: Conquistas, Habilidades, Evoluir ----------
function bottomButton(face, edge, color) {
  const btn = makeSlabButton(160, 40, face, edge, { depth: DEPTH, cut: 9 });
  const label = txt('', color, 15, true);
  label.anchor.set(0.5);
  label.position.set(80, 20);
  btn.addChild(label);
  app.stage.addChild(btn);
  return { btn, label };
}

const { btn: achButton, label: achLabel } = bottomButton(0x2a2410, 0xffc46b, '#ffc46b');
const { btn: skillButton, label: skillLabel } = bottomButton(0x10253a, 0x6ad8fe, '#6ad8fe');
const { btn: prestigeBtn, label: prestigeLabel } = bottomButton(0x2a1a55, 0x8b5cf6, '#eef5fb');

function prestige() {
  const gain = pendingChips();
  if (gain < 1) {
    toast('Ainda não dá para evoluir: ganhe mais bits', '#ff8a8a');
    return;
  }
  const ok = confirm(
    `Evoluir agora?\n\nVocê ganha ${gain} chip(s): +${Math.round(gain * (CHIP_BONUS + mods.chipBonus) * 100)}% de produção e ${gain} ponto(s) de habilidade, permanentes.\n` +
    'Seus bits, upgrades e melhorias serão reiniciados. Chips, conquistas e habilidades ficam.',
  );
  if (!ok) return;

  chips += gain;
  prestiges++;
  bits = 0;
  runBits = 0;
  for (const u of upgrades) u.owned = 0;
  bought.clear();
  updateShop();
  updatePerks();
  toast(`Evolução! +${gain} chip(s)`, '#8b5cf6');
  checkAchievements();
  save();
}
prestigeBtn.on('pointertap', prestige);

// ---------- Painel de conquistas (rolável; 2 colunas em telas largas) ----------
const achPanel = new Container();
achPanel.visible = false;
achPanel.eventMode = 'static';
const achBg = new Graphics();
achPanel.addChild(achBg);
const achTitle = txt('', '#ffc46b', 20, true);
achPanel.addChild(achTitle);
const achScroll = createScroll(800);
achPanel.addChild(achScroll.root);

const achRows = achievements.map((a) => {
  const row = txt('', '#7d94aa', 14);
  achScroll.content.addChild(row);
  return { a, row };
});

const achClose = makeSlabButton(84, 30, 0x2a2410, 0xffc46b, { depth: 3, cut: 7 });
const achCloseLabel = txt('Fechar', '#ffc46b', 14, true);
achCloseLabel.anchor.set(0.5);
achCloseLabel.position.set(42, 15);
achClose.addChild(achCloseLabel);
achPanel.addChild(achClose);

let achW = 860;

function layoutAch() {
  const { width, height } = app.screen;
  const narrow = width < 760;
  const w = Math.min(860, width - (narrow ? 12 : 24));
  const cols = w >= 700 ? 2 : 1;
  const colW = (w - 48) / cols;
  const rowH = narrow ? 26 : 28;
  const perCol = Math.ceil(achievements.length / cols);
  const contentH = perCol * rowH + 8;
  const viewH = Math.min(contentH, height - (narrow ? 12 : 24) - 84);
  const h = 70 + viewH + 14;
  achW = w;

  drawSlab(achBg, w, h, { face: 0x0f1730, edge: 0xffc46b, depth: 6, cut: 20 });
  achTitle.position.set(22, narrow ? 12 : 16);
  achTitle.style.fontSize = narrow ? 16 : 20;
  achClose.position.set(w - 84 - 18, 14);

  achRows.forEach(({ row }, i) => {
    row.style.fontSize = narrow ? 12 : 14;
    row.style.wordWrap = true;
    row.style.wordWrapWidth = colW - 8;
    row.position.set(Math.floor(i / perCol) * colW, (i % perCol) * rowH);
  });
  achScroll.root.position.set(24, 58);
  achScroll.resize(viewH, w - 48);
  achScroll.contentH = contentH;   // as linhas ficam direto no conteúdo (sem itens empilhados)
  achScroll.scrollBy(0);
  achPanel.position.set((width - w) / 2, Math.max(6, (height - h) / 2));
}

function refreshAchievements() {
  achLabel.text = `Conquistas ${unlocked.size}/${achievements.length}`;
  achTitle.text = `Conquistas (+${Math.round(unlocked.size * ACHIEVEMENT_BONUS * 100)}% de produção)`;
  for (const { a, row } of achRows) {
    const done = unlocked.has(a.id);
    row.text = `${done ? '[x]' : '[ ]'} ${a.name} — ${a.desc}`;
    row.style.fill = done ? '#7ee2a8' : '#7d94aa';
  }
}

// ---------- Árvore de habilidades: mandala isométrica ----------
const NODE_S = 17;                         // tamanho do cubo de cada nó
let TREE_HEAD = 60;
let TREE_FOOT = 52;
const R_MAX = RING_R0 + 9 * RING_STEP;
const HINT_WIDE = 'Arraste para mover · roda do mouse: zoom · clique em um nó brilhante para comprar';
const HINT_TOUCH = 'Arraste · pinça: zoom · toque 2x no nó para comprar';

const tree = new Container();
tree.visible = false;
tree.eventMode = 'static';

const treeBg = new Graphics();
const treeViewport = new Container();
const treeMask = new Graphics();
const world = new Container();
const decorG = new Graphics();
const linkG = new Graphics();
const nodeLayer = new Container();
world.addChild(decorG, linkG, nodeLayer);
treeViewport.addChild(world);
treeViewport.mask = treeMask;

const treeTitle = txt('Árvore de Habilidades', '#eef5fb', 21, true);
treeTitle.position.set(22, 11);

const pointsChip = makeSlabButton(170, 30, 0x16203a, 0x6ad8fe, { depth: 3, cut: 7 });
pointsChip.eventMode = 'none';
const pointsText = txt('', '#eef5fb', 15, true);
pointsText.anchor.set(0.5);
pointsText.position.set(85, 15);
pointsChip.addChild(pointsText);
pointsChip.labelObj = pointsText;

const treeRespec = makeSlabButton(138, 30, 0x16203a, 0x3a4a63, { depth: 3, cut: 7 });
const respecLabel = txt('Redistribuir', '#9fb3c8', 14, true);
respecLabel.anchor.set(0.5);
respecLabel.position.set(69, 15);
treeRespec.addChild(respecLabel);
treeRespec.labelObj = respecLabel;

const treeClose = makeSlabButton(92, 30, 0x2a2410, 0xffc46b, { depth: 3, cut: 7 });
const closeLabel = txt('Fechar', '#ffc46b', 14, true);
closeLabel.anchor.set(0.5);
closeLabel.position.set(46, 15);
treeClose.addChild(closeLabel);
treeClose.labelObj = closeLabel;

function smallButton(w, label, face, edge, color) {
  const b = makeSlabButton(w, 28, face, edge, { depth: 3, cut: 7 });
  const t = txt(label, color, 15, true);
  t.anchor.set(0.5);
  t.position.set(w / 2, 14);
  b.addChild(t);
  b.labelObj = t;
  return b;
}
const zoomOut = smallButton(34, '-', 0x16203a, 0x3a4a63, '#eef5fb');
const zoomIn = smallButton(34, '+', 0x16203a, 0x3a4a63, '#eef5fb');
const zoomFit = smallButton(108, 'Centralizar', 0x16203a, 0x3a4a63, '#9fb3c8');

function fitButton(btn, w, h) {
  btn.paint({ w, h });
  btn.labelObj.position.set(w / 2, h / 2);
}

const legend = new Container();
const legendItems = BRANCHES.map((b, i) => {
  const dot = new Graphics();
  dot.poly([0, -6, 7, -2.5, 0, 1, -7, -2.5]).fill(lighten(b.color, 0.25));
  dot.poly([-7, -2.5, 0, 1, 0, 9, -7, 5.5]).fill(b.color);
  dot.poly([7, -2.5, 0, 1, 0, 9, 7, 5.5]).fill(darken(b.color, 0.4));
  const label = txt('', hex(b.color), 13, true);
  label.position.set(14, -8);
  const item = new Container();
  item.addChild(dot, label);
  item.x = i * 128;
  legend.addChild(item);
  return { b, label };
});

const hintText = txt(touchUi ? HINT_TOUCH : HINT_WIDE, '#55697d', 12);

// cartão de informações do nó (perto do cubo sob o mouse)
const tip = new Container();
tip.visible = false;
tip.eventMode = 'none';
const tipBg = new Graphics();
const tipTag = txt('', '#ffffff', 11, true);
const tipName = txt('', '#eef5fb', 17, true);
const tipDesc = txt('', '#b4c6d7', 13);
tipDesc.style.wordWrap = true;
tipDesc.style.wordWrapWidth = 232;
tipDesc.style.lineHeight = 18;
const tipStatus = txt('', '#6ad8fe', 13, true);
const tipLine = new Graphics();
tip.addChild(tipBg, tipLine, tipTag, tipName, tipDesc, tipStatus);

tree.addChild(treeBg, treeViewport, treeMask, treeTitle, pointsChip, treeRespec, treeClose, legend, hintText, zoomOut, zoomIn, zoomFit, tip);

// projeção: plano do chão achatado (isométrico)
const project = (x, y) => ({ x, y: y * ISO });

function drawCube(g, s, height, top, left, right, edge, edgeAlpha = 0.9) {
  const k = 0.87 * s;
  const h = height;
  g.poly([0, -s - h, k, -s / 2 - h, 0, -h, -k, -s / 2 - h]).fill(top);
  g.poly([-k, -s / 2 - h, 0, -h, 0, s, -k, s / 2]).fill(left);
  g.poly([k, -s / 2 - h, 0, -h, 0, s, k, s / 2]).fill(right);
  g.poly([0, -s - h, k, -s / 2 - h, k, s / 2, 0, s, -k, s / 2, -k, -s / 2 - h])
    .stroke({ width: 1.4, color: edge, alpha: edgeAlpha });
}

// ponto no chão da mandala (raio r, ângulo a) já projetado
const polar = (r, a) => project(Math.cos(a) * r, Math.sin(a) * r);

// decoração fixa da mandala: setores em espiral, anéis e núcleo
function drawMandalaDecor() {
  decorG.clear();
  const outer = R_MAX + 40;
  const SAMPLES = 28;

  BRANCHES.forEach((b, i) => {
    const a0 = branchStart(i);
    const a1 = branchStart(i + 1);
    const edge = (a) => {
      const pts = [];
      for (let n = 0; n <= SAMPLES; n++) {
        const r = (outer * n) / SAMPLES;
        pts.push(polar(r, a + twistAt(r)));
      }
      return pts;
    };
    const e0 = edge(a0);
    const e1 = edge(a1);
    const arc = [];
    for (let n = 0; n <= 12; n++) {
      const a = a0 + ((a1 - a0) * n) / 12;
      arc.push(polar(outer, a + twistAt(outer)));
    }
    const flat = [...e0, ...arc, ...e1.reverse()].flatMap((q) => [q.x, q.y]);
    decorG.poly(flat).fill({ color: b.color, alpha: 0.05 });

    decorG.moveTo(e0[0].x, e0[0].y);
    for (const q of e0) decorG.lineTo(q.x, q.y);
    decorG.stroke({ width: 1.5, color: b.color, alpha: 0.28 });
  });

  for (let t = 0; t < 10; t++) {
    const r = RING_R0 + t * RING_STEP;
    decorG.ellipse(0, 0, r, r * ISO).stroke({ width: 1, color: 0x6ad8fe, alpha: t % 3 === 2 ? 0.16 : 0.08 });
  }
  decorG.ellipse(0, 0, outer, outer * ISO).stroke({ width: 2, color: 0x6ad8fe, alpha: 0.22 });
  decorG.ellipse(0, 0, RING_R0 - 34, (RING_R0 - 34) * ISO).stroke({ width: 1, color: 0xeef5fb, alpha: 0.16 });

  // núcleo: disco isométrico
  const cr = 42;
  decorG.ellipse(0, 12, cr, cr * 0.55).fill(0x070d1c);
  decorG.ellipse(0, 0, cr, cr * 0.55).fill(0x16203a).stroke({ width: 2, color: 0xeef5fb, alpha: 0.8 });
}

drawMandalaDecor();

BRANCHES.forEach((b, i) => {
  const mid = (branchStart(i) + branchStart(i + 1)) / 2;
  const r = R_MAX + 66;
  const p = polar(r, mid + twistAt(r));
  const label = txt(b.name.toUpperCase(), hex(b.color), 28, true);
  label.anchor.set(0.5);
  label.position.set(p.x, p.y);
  nodeLayer.addChild(label);
});

const coreLabel = txt('NÚCLEO', '#eef5fb', 10, true);
coreLabel.anchor.set(0.5);
coreLabel.position.set(0, 2);
nodeLayer.addChild(coreLabel);

// nós (cubos isométricos), ordenados por profundidade
const nodeViews = new Map();
let treeDragMoved = false;
let hoverId = null;
let selectedId = null;

const sortedSkills = [...SKILLS].sort((a, b) => a.y - b.y);
for (const s of sortedSkills) {
  const p = project(s.x, s.y);
  const node = new Container();
  node.position.set(p.x, p.y);

  const ring = new Graphics();   // aro pulsante quando dá para comprar
  ring.ellipse(0, NODE_S * 0.55, NODE_S * 1.5, NODE_S * 0.85).stroke({ width: 2, color: BRANCHES[s.branch].color });
  ring.visible = false;
  const glow = new Graphics();
  const g = new Graphics();
  const cost = txt(String(s.cost), '#eef5fb', 11, true);
  cost.anchor.set(0.5);
  node.addChild(glow, ring, g, cost);

  node.eventMode = 'static';
  node.cursor = 'pointer';
  const grow = touchUi ? 1.3 : 1;
  node.hitArea = new Rectangle(-NODE_S * 0.9 * grow, -NODE_S * 1.45 * grow, NODE_S * 1.8 * grow, NODE_S * 2.3 * grow);
  node.on('pointertap', () => {
    if (treeDragMoved) return;
    // no toque, o 1º toque mostra o cartão e o 2º compra
    if (touchUi && selectedId !== s.id) {
      selectNode(s);
      return;
    }
    buySkill(s);
  });
  node.on('pointerover', () => {
    if (touchUi) return;
    hoverId = s.id;
    drawNode(s);
    showTip(s);
  });
  node.on('pointerout', () => {
    if (touchUi) return;
    hoverId = null;
    drawNode(s);
    tip.visible = false;
  });
  nodeLayer.addChild(node);
  nodeViews.set(s.id, { node, g, glow, ring, cost });
}

function clearSelection() {
  const old = selectedId;
  selectedId = null;
  hoverId = null;
  tip.visible = false;
  if (old) drawNode(SKILLS.find((x) => x.id === old));
}

function selectNode(s) {
  const old = selectedId;
  selectedId = s.id;
  hoverId = s.id;
  if (old) drawNode(SKILLS.find((x) => x.id === old));
  drawNode(s);
  showTip(s);
}

function skillState(s) {
  if (skillsOwned.has(s.id)) return 'owned';
  if (s.req && !skillsOwned.has(s.req)) return 'locked';
  return skillPointsFree() >= s.cost ? 'buyable' : 'available';
}

function drawNode(s) {
  const { g, glow, ring, cost } = nodeViews.get(s.id);
  const base = BRANCHES[s.branch].color;
  const state = skillState(s);
  const hot = hoverId === s.id;
  g.clear();
  glow.clear();
  ring.visible = state === 'buyable';
  cost.visible = state !== 'owned';

  if (state === 'owned') {
    glow.ellipse(0, NODE_S * 0.5, NODE_S * 2, NODE_S * 1.1).fill({ color: base, alpha: 0.22 });
    drawCube(g, NODE_S, 11, lighten(base, 0.35), base, darken(base, 0.4), 0xffffff, hot ? 1 : 0.75);
  } else if (state === 'locked') {
    drawCube(g, NODE_S, 2, 0x1a2540, 0x121b30, 0x0c1324, hot ? 0x6a7a93 : 0x2a3a52, 0.9);
  } else {
    const lift = state === 'buyable' ? 6 : 3;
    const f = state === 'buyable' ? 1 : 0.55;
    drawCube(
      g, NODE_S, lift,
      lighten(darken(base, 1 - f), 0.1), darken(base, 1 - f * 0.75), darken(base, 1 - f * 0.45),
      hot ? 0xffffff : base, 0.95,
    );
  }
  cost.position.set(0, -NODE_S / 2 - (state === 'owned' ? 11 : state === 'buyable' ? 6 : 2));
  cost.alpha = state === 'locked' ? 0.35 : 1;
}

function refreshTree() {
  pointsText.text = app.screen.width < 760 ? `Pontos: ${skillPointsFree()}` : `Pontos livres: ${skillPointsFree()}`;

  linkG.clear();
  for (const s of SKILLS) {
    const from = s.req ? SKILLS.find((x) => x.id === s.req) : { x: 0, y: 0 };
    const a = project(from.x, from.y);
    const b = project(s.x, s.y);
    const on = skillsOwned.has(s.id);
    linkG.moveTo(a.x, a.y).lineTo(b.x, b.y)
      .stroke({ width: on ? 4 : 2, color: on ? BRANCHES[s.branch].color : 0x2a3a52, alpha: on ? 0.85 : 0.7 });
  }
  // arco no anel ligando as duas trilhas do mesmo ramo (forma o "rendado" da mandala)
  for (const s of SKILLS) {
    if (s.lane !== 0) continue;
    const mate = SKILLS.find((x) => x.branch === s.branch && x.lane === 1 && x.tier === s.tier);
    const on = skillsOwned.has(s.id) && skillsOwned.has(mate.id);
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const q = polar(s.r, s.angle + ((mate.angle - s.angle) * i) / n);
      if (i === 0) linkG.moveTo(q.x, q.y);
      else linkG.lineTo(q.x, q.y);
    }
    linkG.stroke({ width: on ? 3 : 1.5, color: on ? BRANCHES[s.branch].color : 0x2a3a52, alpha: on ? 0.8 : 0.5 });
  }
  for (const s of SKILLS) drawNode(s);

  for (const { b, label } of legendItems) {
    const mine = SKILLS.filter((s) => s.branch === BRANCHES.indexOf(b));
    const own = mine.filter((s) => skillsOwned.has(s.id)).length;
    label.text = `${b.name} ${own}/${mine.length}`;
  }
}

function showTip(s) {
  const base = BRANCHES[s.branch].color;
  const state = skillState(s);
  const req = s.req ? SKILLS.find((x) => x.id === s.req) : null;

  tipTag.text = `${BRANCHES[s.branch].name.toUpperCase()} · NÍVEL ${s.tier + 1}/10`;
  tipTag.style.fill = hex(lighten(base, 0.2));
  tipName.text = s.name;
  tipDesc.text = s.desc;

  if (state === 'owned') {
    tipStatus.text = 'Comprada';
    tipStatus.style.fill = '#7ee2a8';
  } else if (state === 'locked') {
    tipStatus.text = `Requer: ${req.name}`;
    tipStatus.style.fill = '#ffc46b';
  } else if (state === 'buyable') {
    tipStatus.text = `${touchUi ? 'Toque de novo para comprar' : 'Clique para comprar'} · ${s.cost} ponto${s.cost > 1 ? 's' : ''}`;
    tipStatus.style.fill = '#6ad8fe';
  } else {
    tipStatus.text = `Faltam ${s.cost - skillPointsFree()} ponto(s) · custa ${s.cost}`;
    tipStatus.style.fill = '#ff8a8a';
  }

  const W = 262;
  tipTag.position.set(16, 12);
  tipName.position.set(16, 28);
  tipDesc.position.set(16, 56);
  const sepY = 56 + tipDesc.height + 10;
  tipLine.clear().moveTo(16, sepY).lineTo(W - 16, sepY).stroke({ width: 1, color: 0xffffff, alpha: 0.1 });
  tipStatus.position.set(16, sepY + 9);
  const H = sepY + 9 + 18 + 12;

  drawSlab(tipBg, W, H, { face: 0x0c1430, edge: base, depth: 4, cut: 12 });
  tipBg.rect(0, 12, 4, H - 24).fill(base);

  // posição ao lado do cubo, dentro da área visível
  const p = project(s.x, s.y);
  const sx = world.x + p.x * world.scale.x;
  const sy = world.y + p.y * world.scale.y;
  const { w, h } = treeSize;
  let x;
  let y;
  if (w < 700) {
    // celular: o cartão fica acima (ou abaixo) do nó, sem cobri-lo
    x = Math.max(8, Math.min(w - W - 8, sx - W / 2));
    y = sy - H - 46 >= TREE_HEAD + 6 ? sy - H - 46 : sy + 34;
    y = Math.min(h - TREE_FOOT - H - 6, Math.max(TREE_HEAD + 6, y));
  } else {
    x = sx + 34;
    if (x + W > w - 8) x = sx - 34 - W;
    x = Math.max(8, Math.min(w - W - 8, x));
    y = Math.min(h - TREE_FOOT - H - 8, Math.max(TREE_HEAD + 8, sy - H / 2));
  }
  tip.position.set(x, y);
  tip.visible = true;
}

function buySkill(s) {
  const state = skillState(s);
  if (state === 'owned') return;
  if (state !== 'buyable') {
    showTip(s);
    return;
  }
  skillsOwned.add(s.id);
  recomputeMods();
  refreshTree();
  showTip(s);
  updateShop();
  checkAchievements();
  save();
}

treeRespec.on('pointertap', () => {
  skillsOwned.clear();
  recomputeMods();
  refreshTree();
  updateShop();
  save();
});

let treeSize = { w: 900, h: 600 };

function layoutTree() {
  const narrow = app.screen.width < 760;
  const compact = narrow || app.screen.height < 520;
  TREE_HEAD = narrow ? 98 : compact ? 52 : 60;
  TREE_FOOT = narrow ? 92 : 52;
  const margin = narrow ? 12 : 24;
  const w = Math.min(1180, app.screen.width - margin);
  const h = Math.min(narrow ? 2000 : 740, app.screen.height - margin);
  treeSize = { w, h };
  tree.position.set((app.screen.width - w) / 2, (app.screen.height - h) / 2);
  tree.hitArea = new Rectangle(0, 0, w, h);

  drawSlab(treeBg, w, h, { face: 0x0a1124, edge: 0x2c4a66, depth: 6, cut: 24 });
  treeBg.rect(8, TREE_HEAD, w - 16, h - TREE_HEAD - TREE_FOOT).fill(0x070c1a);
  treeMask.clear().rect(8, TREE_HEAD, w - 16, h - TREE_HEAD - TREE_FOOT).fill(0xffffff);

  if (narrow) {
    // cabeçalho em duas linhas: título + dica, depois pontos / refazer / fechar
    treeTitle.style.fontSize = 18;
    treeTitle.position.set(14, 8);
    hintText.style.fontSize = 11;
    hintText.style.wordWrap = true;
    hintText.style.wordWrapWidth = w - 28;
    hintText.position.set(14, 32);
    respecLabel.text = 'Refazer';
    fitButton(treeClose, 74, 32);
    fitButton(treeRespec, 90, 32);
    fitButton(pointsChip, 116, 32);
    treeClose.position.set(w - 12 - 74, 60);
    treeRespec.position.set(w - 12 - 74 - 8 - 90, 60);
    pointsChip.position.set(w - 12 - 74 - 8 - 90 - 8 - 116, 60);

    // legenda em 3 colunas x 2 linhas e botões de zoom embaixo
    const colW = Math.floor((w - 24) / 3);
    legendItems.forEach(({ label }, i) => {
      const item = label.parent;
      item.x = (i % 3) * colW;
      item.y = Math.floor(i / 3) * 22;
      label.style.fontSize = 11;
    });
    legend.position.set(14, h - TREE_FOOT + 20);
    fitButton(zoomFit, 84, 30);
    fitButton(zoomIn, 38, 30);
    fitButton(zoomOut, 38, 30);
    zoomFit.labelObj.text = 'Ajustar';
    const by = h - 40;
    zoomFit.position.set(w - 12 - 84, by);
    zoomIn.position.set(w - 12 - 84 - 8 - 38, by);
    zoomOut.position.set(w - 12 - 84 - 8 - 38 - 6 - 38, by);
    return;
  }

  treeTitle.style.fontSize = 21;
  treeTitle.position.set(22, compact ? 6 : 11);
  hintText.style.fontSize = 12;
  hintText.style.wordWrap = false;
  hintText.position.set(24, compact ? 32 : 38);
  respecLabel.text = 'Redistribuir';
  fitButton(treeClose, 92, 30);
  fitButton(treeRespec, 138, 30);
  fitButton(pointsChip, 170, 30);
  treeClose.position.set(w - 92 - 20, compact ? 10 : 15);
  treeRespec.position.set(w - 92 - 138 - 32, compact ? 10 : 15);
  pointsChip.position.set(w - 92 - 138 - 170 - 44, compact ? 10 : 15);

  const legendStep = Math.min(128, Math.floor((w - 34 - 214) / 5));
  legendItems.forEach(({ label }, i) => {
    label.parent.x = i * legendStep;
    label.parent.y = 0;
    label.style.fontSize = legendStep < 120 ? 12 : 13;
  });
  legend.position.set(34, h - TREE_FOOT / 2 + 4);
  fitButton(zoomFit, 108, 28);
  fitButton(zoomIn, 34, 28);
  fitButton(zoomOut, 34, 28);
  zoomFit.labelObj.text = 'Centralizar';
  const by = h - TREE_FOOT + 12;
  zoomFit.position.set(w - 24 - 108, by);
  zoomIn.position.set(w - 24 - 108 - 8 - 34, by);
  zoomOut.position.set(w - 24 - 108 - 8 - 34 - 6 - 34, by);
}

function resetTreeView() {
  const { w, h } = treeSize;
  const viewH = h - TREE_HEAD - TREE_FOOT;
  const extentW = (R_MAX + 100) * 2;
  const extentH = (R_MAX + 100) * 2 * ISO;
  const fit = Math.min((w - 40) / extentW, (viewH - 10) / extentH);
  // em telas estreitas a árvore inteira ficaria minúscula: começa mais perto do núcleo
  world.scale.set(w < 700 ? Math.max(fit, 0.6) : fit);
  world.position.set(w / 2, TREE_HEAD + viewH / 2);
}

function zoomBy(factor) {
  const { w, h } = treeSize;
  const cx = w / 2;
  const cy = TREE_HEAD + (h - TREE_HEAD - TREE_FOOT) / 2;
  const old = world.scale.x;
  const next = Math.min(2.2, Math.max(0.2, old * factor));
  world.position.set(cx - (cx - world.x) * (next / old), cy - (cy - world.y) * (next / old));
  world.scale.set(next);
  tip.visible = false;
}
zoomIn.on('pointertap', () => zoomBy(1.25));
zoomOut.on('pointertap', () => zoomBy(1 / 1.25));
zoomFit.on('pointertap', () => resetTreeView());

// arrastar para mover (1 dedo) e pinça para dar zoom (2 dedos)
let drag = null;
let pinch = null;
const pointers = new Map();

const pointerDist = () => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
};
const pointerMid = () => {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

tree.on('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
  treeDragMoved = false;
  if (pointers.size === 1) {
    drag = { sx: e.global.x, sy: e.global.y, wx: world.x, wy: world.y };
  } else if (pointers.size === 2) {
    drag = null;
    const mid = pointerMid();
    const sc = world.scale.x;
    pinch = {
      dist: pointerDist(),
      scale: sc,
      // ponto do mundo que está sob o centro da pinça
      px: (mid.x - tree.x - world.x) / sc,
      py: (mid.y - tree.y - world.y) / sc,
    };
  }
});
app.stage.eventMode = 'static';
app.stage.hitArea = app.screen;
app.stage.on('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });

  if (pinch && pointers.size >= 2) {
    treeDragMoved = true;
    tip.visible = false;
    const next = Math.min(2.2, Math.max(0.2, pinch.scale * (pointerDist() / pinch.dist)));
    const mid = pointerMid();
    world.scale.set(next);
    world.position.set(mid.x - tree.x - pinch.px * next, mid.y - tree.y - pinch.py * next);
    return;
  }
  if (!drag) return;
  const dx = e.global.x - drag.sx;
  const dy = e.global.y - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 6) {
    treeDragMoved = true;
    tip.visible = false;
  }
  world.position.set(drag.wx + dx, drag.wy + dy);
});
const endDrag = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    // sobrou um dedo: continua arrastando a partir da posição atual
    const [rest] = [...pointers.values()];
    drag = { sx: rest.x, sy: rest.y, wx: world.x, wy: world.y };
  } else if (pointers.size === 0) {
    drag = null;
  }
};
app.stage.on('pointerup', endDrag);
app.stage.on('pointerupoutside', endDrag);
app.stage.on('pointercancel', endDrag);

treeClose.on('pointertap', () => toggleTree(false));

function toggleTree(open = !tree.visible) {
  tree.visible = open;
  clearSelection();
  pointers.clear();
  drag = null;
  pinch = null;
  if (open) {
    achPanel.visible = false;
    layoutTree();
    resetTreeView();
    refreshTree();
  }
}

function toggleAchievements(open = !achPanel.visible) {
  achPanel.visible = open;
  if (open) {
    tree.visible = false;
    tip.visible = false;
    layoutAch();
  }
}

achButton.on('pointertap', () => toggleAchievements());
achClose.on('pointertap', () => toggleAchievements(false));
skillButton.on('pointertap', () => toggleTree());

app.stage.addChild(achPanel, tree);

// ---------- Rolagem: roda do mouse (desktop) e arrasto (toque) ----------
const canvasPoint = (e) => {
  const rect = app.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};

// qual área rolável está sob o ponto (gaveta ativa ou painel de conquistas)
function scrollTargetAt(px, py) {
  if (tree.visible) return null;
  if (achPanel.visible) {
    const inside = px >= achPanel.x && px <= achPanel.x + achW && py >= achPanel.y && py <= achPanel.y + achScroll.viewH + 84;
    return inside ? achScroll : null;
  }
  for (const dock of [leftDock, rightDock]) {
    if (dock.hit(px, py)) return dock.activePage() ?? null;
  }
  return null;
}

app.canvas.addEventListener('wheel', (e) => {
  const { x: px, y: py } = canvasPoint(e);

  if (tree.visible) {
    e.preventDefault();
    const lx = px - tree.x;
    const ly = py - tree.y;
    const old = world.scale.x;
    const next = Math.min(2.2, Math.max(0.2, old * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    world.position.set(lx - (lx - world.x) * (next / old), ly - (ly - world.y) * (next / old));
    world.scale.set(next);
    tip.visible = false;
    return;
  }
  const target = scrollTargetAt(px, py);
  if (target) {
    e.preventDefault();
    target.scrollBy(e.deltaY);
  }
}, { passive: false });

// toque: arrastar o dedo rola a lista; um arrasto nunca vira clique em botão
let touchScroll = null;
app.canvas.addEventListener('pointerdown', (e) => {
  uiMoved = false;
  if (e.pointerType === 'mouse') return;
  const { x, y } = canvasPoint(e);
  const target = scrollTargetAt(x, y);
  touchScroll = target ? { target, y: e.clientY, moved: 0 } : null;
});
app.canvas.addEventListener('pointermove', (e) => {
  if (!touchScroll) return;
  const dy = touchScroll.y - e.clientY;
  touchScroll.y = e.clientY;
  touchScroll.moved += Math.abs(dy);
  if (touchScroll.moved > 8) uiMoved = true;
  if (uiMoved) touchScroll.target.scrollBy(dy);
});
for (const type of ['pointerup', 'pointercancel']) {
  app.canvas.addEventListener(type, () => { touchScroll = null; });
}

// ---------- Layout ----------

// 'desktop' | 'portrait' (celular em pé) | 'landscape' (celular deitado, tela baixa)
let layoutMode = 'desktop';
let hudBottom = 160;
let ctrlTop = 0;
let xpLayout = { y: 126, w: 240 };

function fitAbility({ btn, name, status }, w, h, compact) {
  btn.paint({ w, h });
  name.style.fontSize = compact ? 12 : 15;
  status.style.fontSize = compact ? 11 : 13;
  name.position.set(10, compact ? 3 : 5);
  status.position.set(10, compact ? 19 : 25);
}

function fitBottom({ btn, label }, w, h, fontSize) {
  btn.paint({ w, h });
  label.style.fontSize = fontSize;
  label.position.set(w / 2, h / 2);
}

function layout() {
  const { width, height } = app.screen;
  const portrait = width < 760;
  const landscape = !portrait && height < 520;
  layoutMode = portrait ? 'portrait' : landscape ? 'landscape' : 'desktop';
  const cx = width / 2;

  // ----- HUD -----
  if (portrait) {
    counter.style.fontSize = 38; counter.position.set(cx, 8);
    bpsText.style.fontSize = 18; bpsText.position.set(cx, 52);
    metaText.style.fontSize = 12; metaText.position.set(cx, 76);
    frenzyText.style.fontSize = 15; frenzyText.position.set(cx, 108);
    xpLayout = { y: 94, w: Math.min(220, width - 40) };
    hudBottom = 128;
  } else if (landscape) {
    counter.style.fontSize = 30; counter.position.set(cx, 4);
    bpsText.style.fontSize = 16; bpsText.position.set(cx, 38);
    metaText.style.fontSize = 12; metaText.position.set(cx, 58);
    frenzyText.style.fontSize = 14; frenzyText.position.set(cx, 86);
    xpLayout = { y: 76, w: 200 };
    hudBottom = 104;
  } else {
    counter.style.fontSize = 48; counter.position.set(cx, 14);
    bpsText.style.fontSize = 22; bpsText.position.set(cx, 72);
    metaText.style.fontSize = 15; metaText.position.set(cx, 100);
    frenzyText.style.fontSize = 20; frenzyText.position.set(cx, 140);
    xpLayout = { y: 126, w: 240 };
    hudBottom = 160;
  }

  // ----- Controles de baixo -----
  const abs = abilityButtons;
  const bts = [
    { btn: achButton, label: achLabel },
    { btn: skillButton, label: skillLabel },
    { btn: prestigeBtn, label: prestigeLabel },
  ];
  if (portrait) {
    const pad = 10;
    const gap = 8;
    const w3 = Math.floor((width - pad * 2 - gap * 2) / 3);
    const rowB = height - 46 - pad;
    const rowA = rowB - 48 - gap - 4;
    abs.forEach((ab, i) => { fitAbility(ab, w3, 48, true); ab.btn.position.set(pad + i * (w3 + gap), rowA); });
    bts.forEach((bt, i) => { fitBottom(bt, w3, 46, 12); bt.btn.position.set(pad + i * (w3 + gap), rowB); });
    ctrlTop = rowA - 8;
  } else if (landscape) {
    const gap = 6;
    const w6 = Math.min(128, Math.floor((width - 20 - gap * 5) / 6));
    const rowW = w6 * 6 + gap * 5;
    const x0 = (width - rowW) / 2;
    const row = height - 40 - 8;
    abs.forEach((ab, i) => { fitAbility(ab, w6, 40, true); ab.btn.position.set(x0 + i * (w6 + gap), row); });
    bts.forEach((bt, i) => { fitBottom(bt, w6, 40, 12); bt.btn.position.set(x0 + (i + 3) * (w6 + gap), row); });
    ctrlTop = row - 8;
  } else {
    abs.forEach((ab, i) => { fitAbility(ab, 160, 46, false); ab.btn.position.set(cx - 250 + i * 170, height - 118); });
    bts.forEach((bt, i) => { fitBottom(bt, 160, 40, 15); bt.btn.position.set(cx - 250 + i * 170, height - 62); });
    ctrlTop = height - 124;
  }

  // ----- Cubo: ocupa o espaço livre entre o HUD e os controles -----
  const avail = ctrlTop - hudBottom;
  cubeSize = Math.max(90, Math.min(300, (avail - 24) / 1.32, width * 0.66));
  baseScale = cubeSize / texture.height;
  const total = cubeSize * 1.32 + 16;
  cubeBaseY = hudBottom + Math.max(0, (avail - total) / 2) + cubeSize * 0.5;
  cube.x = cx;

  // ----- Gavetas laterais -----
  const top = portrait ? 56 : landscape ? 8 : 96;
  // em pé, as 4 abas (2 de cada lado, escalonadas) precisam caber acima dos controles
  const fitH = Math.floor((ctrlTop - top - 92) / 4);
  const handleH = portrait ? Math.max(70, Math.min(104, fitH)) : landscape ? 84 : 124;
  const labelSize = landscape || (portrait && handleH < 96) ? 12 : portrait ? 14 : 15;
  leftDock.configure({ handleH, handleTop: portrait ? 24 : landscape ? 12 : 24, labelSize });
  // em celular em pé as abas dos dois lados não podem se sobrepor: a direita fica mais embaixo
  rightDock.configure({
    handleH,
    handleTop: portrait ? 24 + 2 * (handleH + 12) + 20 : landscape ? 12 : 24,
    labelSize,
  });
  const dockBottom = portrait || landscape ? ctrlTop - 6 : height - 14;
  leftDock.layout(width, height, top, dockBottom);
  rightDock.layout(width, height, top, dockBottom);

  resetBtn.style.fontSize = portrait || landscape ? 11 : 14;
  resetBtn.position.set(portrait || landscape ? 10 : 16, portrait || landscape ? 6 : height - 26);

  drawDeco();
  if (achPanel.visible) layoutAch();
  if (tree.visible) layoutTree();
}

// com pouca largura só uma gaveta pode ficar aberta (senão uma cobre a outra)
const exclusiveDocks = () => app.screen.width < 980;
for (const [dock, other] of [[leftDock, rightDock], [rightDock, leftDock]]) {
  const select = dock.select;
  dock.select = (i) => {
    select(i);
    if (dock.open && exclusiveDocks() && other.open) {
      other.open = false;
      other.paint();
    }
  };
}

// ---------- Efeitos ----------
const floaters = [];
const particles = [];

function spawnFloatingText(x, y, message, opts = {}) {
  const { fill = '#6ad8fe', size = 32, duration = 800, speed = 0.08, isToast = false } = opts;
  const text = txt(message, fill, size, true);
  text.style.wordWrap = true;
  text.style.wordWrapWidth = Math.max(160, app.screen.width - 24);
  text.style.align = 'center';
  text.anchor.set(0.5);
  text.position.set(x, y);
  // entra logo abaixo dos painéis, que ficam sempre na frente
  app.stage.addChildAt(text, app.stage.getChildIndex(achPanel));
  floaters.push({ text, life: 0, duration, speed, isToast });
}

// avisos perto do cubo; vários ao mesmo tempo ficam empilhados
function toast(message, fill = '#ffc46b') {
  const stacked = floaters.filter((f) => f.isToast).length;
  const size = layoutMode === 'desktop' ? 24 : 17;
  spawnFloatingText(app.screen.width / 2, hudBottom + 8 + stacked * (size + 8), message, {
    fill, size, duration: 3500, speed: 0.01, isToast: true,
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
const nextGoldenDelay = () =>
  (GOLDEN_MIN_MS + Math.random() * (GOLDEN_MAX_MS - GOLDEN_MIN_MS)) * mods.goldenFreq;
let goldenTimer = nextGoldenDelay();

function spawnGolden() {
  if (golden) return;
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.tint = 0xffc46b;
  sprite.scale.set(80 / texture.height);

  // evita as gavetas laterais (no celular elas ficam recolhidas)
  const side = layoutMode === 'desktop' ? PANEL_W + 70 : 40;
  const minX = side;
  const maxX = Math.max(minX + 1, app.screen.width - side);
  const minY = hudBottom + 20;
  const maxY = Math.max(minY + 1, ctrlTop - 40);
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
    frenzyLeft = FRENZY_MS * mods.frenzyDur;
    toast(`Frenesi! Produção x${frenzyMult()} por ${Math.round(frenzyLeft / 1000)}s`, '#ffc46b');
  } else {
    const gain = (Math.min(bits * 0.15, getBps() * 900) + 13) * mods.luckyMult;
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
// em telas estreitas as gavetas começam recolhidas para não cobrir o cubo
const narrow = app.screen.width < 1100 || app.screen.height < 520;
rightDock.restore(savedUi?.r ?? { open: !narrow, active: 1 });
leftDock.restore(savedUi?.l ?? { open: !narrow, active: 0 });
paintModeButtons();
updateShop();
updatePerks();
updateStats();
updateAbilities();
refreshAchievements();
refreshTree();
layout();
app.renderer.on('resize', layout);

// ---------- Progresso offline ----------
if (lastSave) {
  const capS = (BASE_OFFLINE_H + mods.offlineH) * 3600;
  const elapsed = Math.min((Date.now() - lastSave) / 1000, capS);
  const gain = getBps() * elapsed;
  if (gain >= 1) {
    earn(gain);
    toast(`Bem-vindo de volta! +${format(gain)} bits`, '#ffc46b');
  }
}

// ---------- Game loop ----------
let slowTimer = 0;
let achTimer = 0;
let perksEmptyShown = false;

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS;
  playMs += dt;

  earn(getBps() * (dt / 1000));

  leftDock.update(dt);
  rightDock.update(dt);

  // Frenesi e impulsos
  if (frenzyLeft > 0) frenzyLeft = Math.max(0, frenzyLeft - dt);
  for (const s of Object.values(abilities)) {
    if (s.act > 0) s.act = Math.max(0, s.act - dt);
    if (s.cd > 0) s.cd = Math.max(0, s.cd - dt);
  }
  frenzyText.text = frenzyLeft > 0
    ? `Frenesi x${frenzyMult()}: ${Math.ceil(frenzyLeft / 1000)}s`
    : '';
  if ((frenzyLeft > 0) !== decoFrenzy) {
    decoFrenzy = frenzyLeft > 0;
    drawDeco();
  }

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
      goldenTimer = nextGoldenDelay();
    }
  }

  // Conquistas: checadas a cada meio segundo
  achTimer += dt;
  if (achTimer >= 500) {
    achTimer = 0;
    checkAchievements();
  }

  // Textos principais
  counter.text = `${format(bits)} bits`;
  bpsText.text = `${rate(getBps())} bits/s`;
  const chipPct = Math.round(chips * (CHIP_BONUS + mods.chipBonus) * 100);
  metaText.text = `Nível ${playerLevel()} · Pontos: ${skillPointsFree()} · Chips: ${chips} (+${chipPct}%)`;

  // Interface que não precisa atualizar a cada frame
  slowTimer += dt;
  if (slowTimer >= 150) {
    slowTimer = 0;
    updateShop();
    updatePerks();
    updateStats();
    updateAbilities();
    if (tree.visible) refreshTree();

    const empty = !perkButtons.some(({ btn }) => btn.visible);
    if (empty !== perksEmptyShown) {
      perksEmptyShown = empty;
      if (empty) perksPage.root.addChild(perksEmpty);
      else perksPage.root.removeChild(perksEmpty);
    }

    const { y: xy, w } = xpLayout;
    const p = Math.min(1, Math.max(0, levelProgress()));
    xpBar.clear()
      .roundRect(app.screen.width / 2 - w / 2, xy, w, 6, 3).fill(0x16203a)
      .roundRect(app.screen.width / 2 - w / 2, xy, Math.max(4, w * p), 6, 3).fill(0x6ad8fe);

    const pending = pendingChips();
    prestigeLabel.text = `Evoluir: +${pending} chip(s)`;
    prestigeBtn.alpha = pending >= 1 ? 1 : 0.45;
    skillLabel.text = `Habilidades (${skillPointsFree()})`;
    for (const { imp, btn } of perkButtons) {
      if (btn.visible) btn.alpha = bits >= imp.cost ? 1 : 0.55;
    }
  }

  // aros dos nós que dá para comprar pulsam
  if (tree.visible) {
    const pulse = 0.45 + 0.45 * Math.sin(performance.now() / 280);
    for (const { ring } of nodeViews.values()) if (ring.visible) ring.alpha = pulse;
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
    earn, spawnGolden, collectGolden, prestige, checkAchievements, pendingChips, setBuyMode,
    buySkill, toggleTree, useAbility, SKILLS, leftDock, rightDock,
    skillToScreen: (sk) => {
      const p = project(sk.x, sk.y);
      return { x: tree.x + world.x + p.x * world.scale.x, y: tree.y + world.y + p.y * world.scale.y };
    },
    get state() {
      return {
        bits, runBits, totalBits, clicks, chips, prestiges, frenzyLeft, buyMode,
        level: playerLevel(), sp: skillPointsFree(),
        unlocked: [...unlocked], bought: [...bought], skills: [...skillsOwned],
        owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
        bps: getBps(), perClick: getBitsPerClick(), golden: !!golden,
        docks: { l: leftDock.state(), r: rightDock.state() },
        layoutMode,
      };
    },
  };
}

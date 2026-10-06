import { Application, Assets, Sprite, Text, Container, Graphics, Rectangle } from 'pixi.js';
import { UPGRADE_DEFS, makeImprovements } from './data.js';
import { SKILLS, BRANCHES, newMods, computeMods } from './skills.js';

const app = new Application();
await app.init({ background: '#0b1020', resizeTo: window, antialias: true });
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
  { id: 'rage',      name: 'Fúria',     desc: 'Cliques x10 por 15s',          dur: 15000, cd: 120000 },
  { id: 'overclock', name: 'Overclock', desc: 'Produção x3 por 20s',          dur: 20000, cd: 180000 },
  { id: 'sprint',    name: 'Sprint',    desc: '+10 min de produção',        dur: 0,     cd: 300000 },
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
  if (after > before) toast(`${u.name} subiu para o nível ${after}! (+${Math.round((LEVEL_BASE_BONUS + mods.levelBonus) * 100)}%)`, '#7ee2a8');
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

// ---------- Cubo ----------
const texture = await Assets.load(`${import.meta.env.BASE_URL}assets/cube.png`);
const cube = new Sprite(texture);
cube.anchor.set(0.5);

const baseScale = 300 / texture.height;
cube.scale.set(baseScale);
cube.eventMode = 'static';
cube.cursor = 'pointer';
app.stage.addChild(cube);

// ---------- Helpers de interface ----------
const FONT = 'Arial';
const txt = (text, fill, size, bold = false) => new Text({
  text,
  style: { fill, fontSize: size, fontFamily: FONT, fontWeight: bold ? 'bold' : 'normal' },
});

function makeButton(w, h, fill, stroke) {
  const c = new Container();
  const bg = new Graphics().roundRect(0, 0, w, h, 10).fill(fill).stroke({ width: 2, color: stroke });
  c.addChild(bg);
  c.eventMode = 'static';
  c.cursor = 'pointer';
  return c;
}

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

// ---------- Coluna rolável com abas (seções) recolhíveis ----------
const SECTION_HEADER_H = 30;

function createColumn(width) {
  const root = new Container();
  const content = new Container();
  const maskG = new Graphics();
  const scrollbar = new Graphics();
  root.addChild(content, maskG, scrollbar);
  content.mask = maskG;

  const col = { root, width, viewH: 300, scrollY: 0, contentH: 0, sections: [] };

  col.addSection = (title) => {
    const header = new Container();
    header.addChild(
      new Graphics()
        .roundRect(0, 0, width - 12, SECTION_HEADER_H, 10)
        .fill(0x16203a)
        .stroke({ width: 1, color: 0x3a4a63 }),
    );
    const label = txt('', '#eef5fb', 15, true);
    label.position.set(12, 6);
    header.addChild(label);
    header.eventMode = 'static';
    header.cursor = 'pointer';

    const body = new Container();
    content.addChild(header, body);

    const sec = { title, extra: '', collapsed: false, header, body, items: [] };
    sec.paint = () => {
      label.text = `${sec.collapsed ? '[+]' : '[-]'} ${sec.title}${sec.extra ? `  ${sec.extra}` : ''}`;
    };
    sec.add = (c, h) => {
      body.addChild(c);
      sec.items.push({ c, h });
      return c;
    };
    sec.paint();
    header.on('pointertap', () => {
      sec.collapsed = !sec.collapsed;
      sec.paint();
      col.relayout();
    });
    col.sections.push(sec);
    return sec;
  };

  col.relayout = () => {
    let y = 0;
    for (const sec of col.sections) {
      sec.header.y = y;
      y += SECTION_HEADER_H + 6;
      sec.body.visible = !sec.collapsed;
      if (!sec.collapsed) {
        sec.body.y = y;
        let yy = 0;
        for (const it of sec.items) {
          if (!it.c.visible) continue;
          it.c.y = yy;
          yy += it.h + 6;
        }
        y += yy;
      }
      y += 8;
    }
    col.contentH = y;
    col.scrollBy(0);
  };

  col.scrollBy = (dy) => {
    const max = Math.max(0, col.contentH - col.viewH);
    col.scrollY = Math.min(max, Math.max(0, col.scrollY + dy));
    content.y = -col.scrollY;
    scrollbar.clear();
    if (max > 0) {
      const thumbH = Math.max(30, (col.viewH * col.viewH) / col.contentH);
      const thumbY = (col.scrollY / max) * (col.viewH - thumbH);
      scrollbar.roundRect(width - 5, thumbY, 4, thumbH, 2).fill({ color: 0x6ad8fe, alpha: 0.5 });
    }
  };

  col.resize = (x, y, viewH) => {
    root.position.set(x, y);
    col.viewH = viewH;
    maskG.clear().rect(0, 0, width, viewH).fill(0xffffff);
    col.relayout();
  };

  col.contains = (px, py) =>
    px >= root.x && px <= root.x + width && py >= root.y && py <= root.y + col.viewH;

  return col;
}

const COL_W = 280;
const BTN_W = COL_W - 12;
const leftCol = createColumn(COL_W);
const rightCol = createColumn(COL_W);
app.stage.addChild(leftCol.root, rightCol.root);

// ---------- Seletor de modo de compra (1x / 10x / 100x / Máx) ----------
const modeBar = new Container();
const modeButtons = BUY_MODES.map((mode, i) => {
  const btn = makeButton(62, 28, 0x16203a, 0x3a4a63);
  btn.x = i * 67;
  const label = txt(mode === 'max' ? 'Máx' : `x${mode}`, '#eef5fb', 15, true);
  label.anchor.set(0.5);
  label.position.set(31, 14);
  btn.addChild(label);
  btn.on('pointertap', () => setBuyMode(mode));
  modeBar.addChild(btn);
  return { mode, btn };
});
app.stage.addChild(modeBar);

function setBuyMode(mode) {
  buyMode = mode;
  paintModeButtons();
  updateShop();
  save();
}

function paintModeButtons() {
  for (const { mode, btn } of modeButtons) {
    btn.getChildAt(0).clear()
      .roundRect(0, 0, 62, 28, 10)
      .fill(mode === buyMode ? 0x5b3fc4 : 0x16203a)
      .stroke({ width: 2, color: mode === buyMode ? 0x8b5cf6 : 0x3a4a63 });
  }
}

// ---------- Seções da direita: Clique e Produção ----------
const clickSection = rightCol.addSection('Clique');
const prodSection = rightCol.addSection('Produção');
const shopButtons = [];

for (const u of upgrades) {
  const BTN_H = 76;
  const btn = makeButton(BTN_W, BTN_H, 0x1a2440, u.kind === 'click' ? 0x6ad8fe : 0x7ee2a8);

  const title = txt('', '#eef5fb', 17, true);
  title.position.set(12, 6);
  const lvlText = txt('', '#7ee2a8', 13, true);
  lvlText.anchor.set(1, 0);
  lvlText.position.set(BTN_W - 12, 9);
  const cost = txt('', '#eef5fb', 14);
  cost.position.set(12, 29);
  const info = txt('', '#b4c6d7', 13);
  info.position.set(12, 47);
  const bar = new Graphics();

  btn.addChild(title, lvlText, cost, info, bar);
  btn.on('pointertap', () => buy(u));

  (u.kind === 'click' ? clickSection : prodSection).add(btn, BTN_H);
  shopButtons.push({ u, btn, title, lvlText, cost, info, bar });
}

function updateShop() {
  for (const { u, btn, title, lvlText, cost, info, bar } of shopButtons) {
    const plan = planBuy(u);
    const per = (u.click ?? u.bps) * unitMult(u) * (u.click ? mods.clickMult : 1);
    const perText = u.click ? `+${rate(per)}/clique` : `+${rate(per)}/s`;

    title.text = `${u.name} (${u.owned})`;
    lvlText.text = `Nv ${levelOf(u)}`;
    cost.text = `Comprar +${plan.n}: ${format(plan.cost)}`;
    info.text = `${perText} cada · nível: ${u.owned % LEVEL_SIZE}/${LEVEL_SIZE}`;
    btn.alpha = plan.ok ? 1 : 0.55;

    // barra de nível: enche a cada unidade, ao completar 10 o upgrade sobe de nível
    const fill = (u.owned % LEVEL_SIZE) / LEVEL_SIZE;
    bar.clear()
      .roundRect(12, 66, BTN_W - 24, 5, 2).fill(0x0b1020)
      .roundRect(12, 66, Math.max(fill > 0 ? 4 : 0, (BTN_W - 24) * fill), 5, 2).fill(0x7ee2a8);
  }
  clickSection.extra = '';
  prodSection.extra = '';
}

// ---------- Seções da esquerda: Melhorias e Estatísticas ----------
const perksSection = leftCol.addSection('Melhorias');
const perkButtons = [];

for (const imp of improvements) {
  const BTN_H = 58;
  const btn = makeButton(BTN_W, BTN_H, 0x1a2440, 0x8b5cf6);
  const title = txt(imp.name, '#eef5fb', 16, true);
  title.position.set(12, 7);
  const info = txt(`${imp.desc} · Custo: ${format(imp.cost)}`, '#b4c6d7', 13);
  info.position.set(12, 32);
  btn.addChild(title, info);
  btn.visible = false;
  btn.on('pointertap', () => buyImprovement(imp));
  perksSection.add(btn, BTN_H);
  perkButtons.push({ imp, btn });
}

let perksSignature = '';

function updatePerks() {
  let count = 0;
  for (const { imp, btn } of perkButtons) {
    const show = !bought.has(imp.id) && byId(imp.target).owned >= imp.req;
    btn.visible = show;
    if (show) count++;
  }
  // ordena por custo: reordena os itens da seção quando o conjunto visível muda
  const signature = perkButtons.map(({ btn }) => (btn.visible ? 1 : 0)).join('');
  if (signature !== perksSignature) {
    perksSignature = signature;
    perksSection.items.sort((a, b) => costOfItem(a.c) - costOfItem(b.c));
    leftCol.relayout();
  }
  perksSection.extra = count ? `(${count})` : '';
  perksSection.paint();
}

const costOfItem = (container) => perkButtons.find(({ btn }) => btn === container).imp.cost;

const statsSection = leftCol.addSection('Estatísticas');
const statsText = txt('', '#b4c6d7', 14);
statsText.style.lineHeight = 20;
statsSection.add(statsText, 130);

function updateStats() {
  const mins = Math.floor(playMs / 60000);
  statsText.text = [
    `Cliques: ${format(clicks)}`,
    `Bits dourados: ${goldenClicks}`,
    `Bits (esta vida): ${format(runBits)}`,
    `Bits (total): ${format(totalBits)}`,
    `Evoluções: ${prestiges}`,
    `Tempo de jogo: ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}min`,
  ].join('\n');
}

// ---------- Impulsos (habilidades ativas) ----------
const abilityButtons = abilityDefs.map((a) => {
  const btn = makeButton(160, 48, 0x1a2440, 0xffc46b);
  const name = txt(a.name, '#eef5fb', 15, true);
  name.position.set(10, 5);
  const status = txt('', '#b4c6d7', 13);
  status.position.set(10, 26);
  btn.addChild(name, status);
  btn.on('pointertap', () => useAbility(a));
  app.stage.addChild(btn);
  return { a, btn, status };
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
const achButton = makeButton(160, 40, 0x2a2410, 0xffc46b);
const achLabel = txt('', '#ffc46b', 15, true);
achLabel.anchor.set(0.5);
achLabel.position.set(80, 20);
achButton.addChild(achLabel);

const skillButton = makeButton(160, 40, 0x10253a, 0x6ad8fe);
const skillLabel = txt('', '#6ad8fe', 15, true);
skillLabel.anchor.set(0.5);
skillLabel.position.set(80, 20);
skillButton.addChild(skillLabel);

const prestigeBtn = makeButton(160, 40, 0x2a1a55, 0x8b5cf6);
const prestigeLabel = txt('', '#eef5fb', 15, true);
prestigeLabel.anchor.set(0.5);
prestigeLabel.position.set(80, 20);
prestigeBtn.addChild(prestigeLabel);

app.stage.addChild(achButton, skillButton, prestigeBtn);

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

// ---------- Painel de conquistas ----------
const ACH_COLS = 2;
const ACH_ROWS = Math.ceil(achievements.length / ACH_COLS);
const ACH_COL_W = 400;
const ACH_ROW_H = 28;
const ACH_W = ACH_COLS * ACH_COL_W + 40;
const ACH_H = 70 + ACH_ROWS * ACH_ROW_H;

const achPanel = new Container();
achPanel.visible = false;
achPanel.eventMode = 'static';
achPanel.cursor = 'pointer';
achPanel.addChild(
  new Graphics()
    .roundRect(0, 0, ACH_W, ACH_H, 16)
    .fill(0x0f1730)
    .stroke({ width: 2, color: 0xffc46b }),
);
const achTitle = txt('', '#ffc46b', 22, true);
achTitle.position.set(20, 14);
achPanel.addChild(achTitle);

const achRows = achievements.map((a, i) => {
  const row = txt('', '#7d94aa', 14);
  row.position.set(20 + Math.floor(i / ACH_ROWS) * ACH_COL_W, 56 + (i % ACH_ROWS) * ACH_ROW_H);
  achPanel.addChild(row);
  return { a, row };
});

function refreshAchievements() {
  achLabel.text = `Conquistas ${unlocked.size}/${achievements.length}`;
  achTitle.text = `Conquistas (+${Math.round(unlocked.size * ACHIEVEMENT_BONUS * 100)}% de produção) · toque para fechar`;
  for (const { a, row } of achRows) {
    const done = unlocked.has(a.id);
    row.text = `${done ? '[x]' : '[ ]'} ${a.name} — ${a.desc}`;
    row.style.fill = done ? '#7ee2a8' : '#7d94aa';
  }
}

// ---------- Árvore de habilidades ----------
const NODE_R = 20;
const TREE_HEAD = 56;
const TREE_FOOT = 64;

const tree = new Container();
tree.visible = false;
tree.eventMode = 'static';

const treeBg = new Graphics();
const treeViewport = new Container();
const treeMask = new Graphics();
const world = new Container();
const linkG = new Graphics();
const nodeLayer = new Container();
world.addChild(linkG, nodeLayer);
treeViewport.addChild(world);
treeViewport.mask = treeMask;

const treeTitle = txt('', '#eef5fb', 20, true);
treeTitle.position.set(20, 14);
const treeClose = txt('[ Fechar ]', '#ffc46b', 16, true);
treeClose.eventMode = 'static';
treeClose.cursor = 'pointer';
const treeRespec = txt('[ Redistribuir pontos ]', '#6ad8fe', 16, true);
treeRespec.eventMode = 'static';
treeRespec.cursor = 'pointer';
const treeInfo = txt('Arraste para mover, role para dar zoom. Clique em um nó disponível para comprar.', '#b4c6d7', 15);
treeInfo.style.wordWrap = true;

tree.addChild(treeBg, treeViewport, treeMask, treeTitle, treeClose, treeRespec, treeInfo);

// núcleo e nomes dos ramos
const coreNode = new Graphics().circle(0, 0, 34).fill(0x16203a).stroke({ width: 4, color: 0xeef5fb });
const coreLabel = txt('Núcleo', '#eef5fb', 14, true);
coreLabel.anchor.set(0.5);
nodeLayer.addChild(coreNode, coreLabel);

BRANCHES.forEach((b, i) => {
  const theta = -Math.PI / 2 + (i * 2 * Math.PI) / BRANCHES.length;
  const label = txt(b.name, `#${b.color.toString(16).padStart(6, '0')}`, 20, true);
  label.anchor.set(0.5);
  label.position.set(Math.cos(theta) * 78, Math.sin(theta) * 78);
  nodeLayer.addChild(label);
});

const nodeViews = new Map();
let treeDragMoved = false;

for (const s of SKILLS) {
  const node = new Container();
  node.position.set(s.x, s.y);
  const g = new Graphics();
  const cost = txt(String(s.cost), '#eef5fb', 15, true);
  cost.anchor.set(0.5);
  node.addChild(g, cost);
  node.eventMode = 'static';
  node.cursor = 'pointer';
  node.on('pointertap', () => { if (!treeDragMoved) buySkill(s); });
  node.on('pointerover', () => {
    const state = skillsOwned.has(s.id) ? 'comprada' : `custa ${s.cost} ponto(s)`;
    treeInfo.text = `${BRANCHES[s.branch].name} · ${s.name} — ${s.desc} (${state})`;
  });
  node.on('pointerout', () => { treeInfo.text = 'Arraste para mover, role para dar zoom. Clique em um nó disponível para comprar.'; });
  nodeLayer.addChild(node);
  nodeViews.set(s.id, { g, cost });
}

function skillState(s) {
  if (skillsOwned.has(s.id)) return 'owned';
  if (s.req && !skillsOwned.has(s.req)) return 'locked';
  return skillPointsFree() >= s.cost ? 'buyable' : 'available';
}

function refreshTree() {
  treeTitle.text = `Árvore de Habilidades · Pontos livres: ${skillPointsFree()} (nível ${playerLevel()} + ${chips} chips)`;

  linkG.clear();
  for (const s of SKILLS) {
    const from = s.req ? SKILLS.find((x) => x.id === s.req) : { x: 0, y: 0 };
    const active = skillsOwned.has(s.id);
    linkG.moveTo(from.x, from.y).lineTo(s.x, s.y)
      .stroke({ width: active ? 5 : 3, color: active ? BRANCHES[s.branch].color : 0x2a3a52, alpha: active ? 0.9 : 0.8 });
  }

  for (const s of SKILLS) {
    const { g, cost } = nodeViews.get(s.id);
    const color = BRANCHES[s.branch].color;
    const state = skillState(s);
    g.clear();
    if (state === 'owned') g.circle(0, 0, NODE_R).fill(color).stroke({ width: 3, color: 0xffffff });
    else if (state === 'locked') g.circle(0, 0, NODE_R).fill(0x0f1730).stroke({ width: 2, color: 0x3a4a63 });
    else g.circle(0, 0, NODE_R).fill(0x16203a).stroke({ width: 3, color, alpha: state === 'buyable' ? 1 : 0.5 });
    cost.visible = state !== 'owned';
    cost.alpha = state === 'locked' ? 0.4 : 1;
  }
}

function buySkill(s) {
  const state = skillState(s);
  if (state === 'owned') return;
  if (state === 'locked') {
    treeInfo.text = 'Compre primeiro a habilidade anterior da mesma trilha.';
    return;
  }
  if (state === 'available') {
    treeInfo.text = `Pontos insuficientes: ${s.name} custa ${s.cost}.`;
    return;
  }
  skillsOwned.add(s.id);
  recomputeMods();
  refreshTree();
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

let treeSize = { w: 800, h: 600 };

function layoutTree() {
  const w = Math.min(1000, app.screen.width - 20);
  const h = Math.min(700, app.screen.height - 20);
  treeSize = { w, h };
  tree.position.set((app.screen.width - w) / 2, (app.screen.height - h) / 2);
  tree.hitArea = new Rectangle(0, 0, w, h);

  treeBg.clear()
    .roundRect(0, 0, w, h, 16).fill(0x0b1226).stroke({ width: 2, color: 0x6ad8fe })
    .rect(0, TREE_HEAD, w, h - TREE_HEAD - TREE_FOOT).fill({ color: 0x080d1c });
  treeMask.clear().rect(0, TREE_HEAD, w, h - TREE_HEAD - TREE_FOOT).fill(0xffffff);

  treeClose.position.set(w - treeClose.width - 20, 16);
  treeRespec.position.set(w - treeClose.width - treeRespec.width - 44, 16);
  treeInfo.style.wordWrapWidth = w - 40;
  treeInfo.position.set(20, h - TREE_FOOT + 10);
}

function resetTreeView() {
  const { w, h } = treeSize;
  // escala que mostra quase a árvore inteira (as pontas dos ramos ficam para o arrastar/zoom)
  const viewH = h - TREE_HEAD - TREE_FOOT;
  world.scale.set(Math.min(w, viewH) / 2 / 720);
  world.position.set(w / 2, TREE_HEAD + viewH / 2 + viewH * 0.06);
}

// arrastar para mover
let drag = null;
tree.on('pointerdown', (e) => {
  drag = { sx: e.global.x, sy: e.global.y, wx: world.x, wy: world.y };
  treeDragMoved = false;
});
app.stage.eventMode = 'static';
app.stage.hitArea = app.screen;
app.stage.on('pointermove', (e) => {
  if (!drag) return;
  const dx = e.global.x - drag.sx;
  const dy = e.global.y - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 5) treeDragMoved = true;
  world.position.set(drag.wx + dx, drag.wy + dy);
});
const endDrag = () => { drag = null; };
app.stage.on('pointerup', endDrag);
app.stage.on('pointerupoutside', endDrag);

treeClose.on('pointertap', () => toggleTree(false));

function toggleTree(open = !tree.visible) {
  tree.visible = open;
  if (open) {
    achPanel.visible = false;
    layoutTree();
    resetTreeView();
    refreshTree();
  }
}

function toggleAchievements(open = !achPanel.visible) {
  achPanel.visible = open;
  if (open) tree.visible = false;
}

achButton.on('pointertap', () => toggleAchievements());
achPanel.on('pointertap', () => toggleAchievements(false));
skillButton.on('pointertap', () => toggleTree());

app.stage.addChild(achPanel, tree);

// ---------- Rolagem e zoom com a roda do mouse ----------
app.canvas.addEventListener('wheel', (e) => {
  const rect = app.canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;

  if (tree.visible) {
    e.preventDefault();
    const lx = px - tree.x;
    const ly = py - tree.y;
    const old = world.scale.x;
    const next = Math.min(1.6, Math.max(0.25, old * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    world.position.set(lx - (lx - world.x) * (next / old), ly - (ly - world.y) * (next / old));
    world.scale.set(next);
    return;
  }
  for (const col of [leftCol, rightCol]) {
    if (col.contains(px, py)) {
      e.preventDefault();
      col.scrollBy(e.deltaY);
      return;
    }
  }
}, { passive: false });

// ---------- Layout ----------
let cubeBaseY = 0;

function layout() {
  const { width, height } = app.screen;
  cubeBaseY = height / 2;
  cube.x = width / 2;
  counter.position.set(width / 2, 14);
  bpsText.position.set(width / 2, 72);
  metaText.position.set(width / 2, 100);
  frenzyText.position.set(width / 2, 140);

  leftCol.resize(10, 110, height - 110 - 40);
  rightCol.resize(Math.max(10, width - COL_W - 10), 148, height - 148 - 12);
  modeBar.position.set(Math.max(10, width - COL_W - 10), 112);

  const row1 = height - 118;
  abilityButtons.forEach(({ btn }, i) => btn.position.set(width / 2 - 250 + i * 170, row1));
  const row2 = height - 62;
  achButton.position.set(width / 2 - 250, row2);
  skillButton.position.set(width / 2 - 80, row2);
  prestigeBtn.position.set(width / 2 + 90, row2);

  resetBtn.position.set(16, height - 26);
  achPanel.position.set((width - ACH_W) / 2, Math.max(10, (height - ACH_H) / 2));
  if (tree.visible) layoutTree();
}

// ---------- Efeitos ----------
const floaters = [];
const particles = [];

function spawnFloatingText(x, y, message, opts = {}) {
  const { fill = '#6ad8fe', size = 32, duration = 800, speed = 0.08, isToast = false } = opts;
  const text = new Text({
    text: message,
    style: { fill, fontSize: size, fontWeight: 'bold', fontFamily: FONT },
  });
  text.anchor.set(0.5);
  text.position.set(x, y);
  // entra logo abaixo dos painéis, que ficam sempre na frente
  app.stage.addChildAt(text, app.stage.getChildIndex(achPanel));
  floaters.push({ text, life: 0, duration, speed, isToast });
}

// avisos perto do cubo; vários ao mesmo tempo ficam empilhados
function toast(message, fill = '#ffc46b') {
  const stacked = floaters.filter((f) => f.isToast).length;
  spawnFloatingText(app.screen.width / 2, app.screen.height / 2 - 200 + stacked * 32, message, {
    fill, size: 24, duration: 3500, speed: 0.01, isToast: true,
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

  // evita as colunas de lojas
  const minX = COL_W + 40;
  const maxX = Math.max(minX + 1, app.screen.width - COL_W - 40);
  const minY = 180;
  const maxY = Math.max(minY + 1, app.screen.height - 150);
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

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS;
  playMs += dt;

  earn(getBps() * (dt / 1000));

  // Frenesi e impulsos
  if (frenzyLeft > 0) frenzyLeft = Math.max(0, frenzyLeft - dt);
  for (const s of Object.values(abilities)) {
    if (s.act > 0) s.act = Math.max(0, s.act - dt);
    if (s.cd > 0) s.cd = Math.max(0, s.cd - dt);
  }
  frenzyText.text = frenzyLeft > 0
    ? `Frenesi x${frenzyMult()}: ${Math.ceil(frenzyLeft / 1000)}s`
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

    const w = 240;
    const p = Math.min(1, Math.max(0, levelProgress()));
    xpBar.clear()
      .roundRect(app.screen.width / 2 - w / 2, 126, w, 6, 3).fill(0x16203a)
      .roundRect(app.screen.width / 2 - w / 2, 126, Math.max(4, w * p), 6, 3).fill(0x6ad8fe);

    const pending = pendingChips();
    prestigeLabel.text = `Evoluir: +${pending} chip(s)`;
    prestigeBtn.alpha = pending >= 1 ? 1 : 0.45;
    skillLabel.text = `Habilidades (${skillPointsFree()})`;
    for (const { imp, btn } of perkButtons) {
      if (btn.visible) btn.alpha = bits >= imp.cost ? 1 : 0.55;
    }
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
    buySkill, toggleTree, useAbility, SKILLS,
    skillToScreen: (sk) => ({
      x: tree.x + world.x + sk.x * world.scale.x,
      y: tree.y + world.y + sk.y * world.scale.y,
    }),
    get state() {
      return {
        bits, runBits, totalBits, clicks, chips, prestiges, frenzyLeft, buyMode,
        level: playerLevel(), sp: skillPointsFree(),
        unlocked: [...unlocked], bought: [...bought], skills: [...skillsOwned],
        owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
        bps: getBps(), perClick: getBitsPerClick(), golden: !!golden,
      };
    },
  };
}

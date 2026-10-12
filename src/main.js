import { Application, Assets, Sprite, Container, Graphics, Rectangle, ColorMatrixFilter } from 'pixi.js';
import { UPGRADE_DEFS, makeImprovements } from './data.js';
import {
  SKILLS, BRANCHES, RING_R0, RING_STEP, spokeAngle, branchStart, twistAt, newMods, computeMods,
} from './skills.js';
import {
  C, T, txt, hex, darken, lighten, drawCard, makeButton, createScroll, createDock,
} from './ui.js';
import { tween, ease, updateTweens, cancelTweens } from './anim.js';
import { settings, setSetting, onSettingsChange } from './settings.js';
import { sfx, unlockAudio, applyVolume, haptic } from './sfx.js';
import {
  CHALLENGES, CHALLENGE_MIN_LEVEL, RESEARCH, PROJECTS, MANAGERS, MANAGER_SPEND, SKINS, MARKET,
  ASCEND_MIN_CHIPS, ascendGain, coreMult, computeFx, makeMissions, dayKey, pickMarketEvent, fmtTime,
  MISSION_TYPES,
} from './features.js';
import { startMusic, stopMusic, updateMusicVolume, musicState } from './music.js';

// as fontes do site precisam estar prontas antes de criar qualquer texto no Pixi
await Promise.all([
  document.fonts?.load('600 16px "Grotesk"'),
  document.fonts?.load('400 14px "Body"'),
]).catch(() => {});

const app = new Application();
await app.init({
  background: '#080e16',
  resizeTo: window,
  antialias: true,
  resolution: Math.min(window.devicePixelRatio || 1, 2.5),
  autoDensity: true,
});
app.canvas.style.touchAction = 'none';
document.body.appendChild(app.canvas);

// ---------- Constantes ----------
const SAVE_KEY = 'scorpion-bits-idle-v1';
// ---- Balanceamento (ver scripts/balance-sim.mjs: simula o ritmo do jogo para testar mudanças) ----
const BASE_OFFLINE_H = 8;            // horas de ganho offline (habilidades aumentam)
const OFFLINE_RATE = 0.5;            // fração da produção que rende com o jogo fechado
const MAX_SP_PER_PRESTIGE = 5;       // pontos de habilidade que uma evolução pode dar, no máximo
const CHIP_CURVE = 0.85;             // retorno decrescente: o bônus dos chips cresce com chips^0.85
const LEVEL_XP_BASE = 1.8;           // cada nível do jogador exige 1,8x mais bits que o anterior
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
const CHIP_DIVISOR = 1e5;            // runBits necessários para o 1º chip (chips = raiz cúbica)
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
let prestigeSP = 0;   // pontos de habilidade vindos de evoluções (no máx. MAX_SP_PER_PRESTIGE cada)
let migrationNote = null;
// ---- Estúdio: mecânicas extras (ver features.js) ----
let fragments = 0;        // moeda dos bits dourados e missões (compra visuais)
let cores = 0;            // núcleos da Ascensão
let ascensions = 0;
let missionsClaimed = 0;
const research = { done: new Set(), active: null };
let projects = {};        // id -> { state: 'running' | 'done', endsAt }
const managers = { hired: new Set(), off: new Set(), master: true };
let skinId = 'padrao';
const skinsOwned = new Set(['padrao']);
let challenge = null;
const challengesDone = new Set();
let daily = { date: '', counters: {}, missions: [] };
let fx = { prod: 1, click: 1, cost: 1, offlineH: 0, golden: 1, frenzyDur: 1, lucky: 1 };
const market = { kind: null, mult: 1, endsAt: 0, label: '', nextAt: Date.now() + 240000 };
let proposal = null;
const combo = { meter: 0, last: 0 };
const skinDef = () => SKINS.find((k) => k.id === skinId) ?? SKINS[0];
const accentNow = () => skinDef().rim;
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
  return (1 + chipBoost()) * (1 + ACHIEVEMENT_BONUS * unlocked.size);
}

function baseBps() {
  let sum = 0;
  for (const u of genUpgrades) sum += u.owned * u.bps * unitMult(u);
  return sum;
}

const frenzyMult = () => FRENZY_MULT + mods.frenzyAdd;

function getBps() {
  return baseBps() * globalMult() * mods.prodMult * fx.prod * marketMult()
    * (frenzyLeft > 0 ? frenzyMult() : 1)
    * (abilities.overclock.act > 0 ? 3 : 1);
}

function getBitsPerClick() {
  let flat = 1;
  for (const u of clickUpgrades) flat += u.owned * u.click * unitMult(u);
  const base = flat * mods.clickMult + baseBps() * mods.clickBps;
  if (ruleId() === 'nocl') return 0;
  return base * globalMult() * fx.click * comboMult() * (abilities.rage.act > 0 ? 10 : 1);
}

const totalOwned = () => upgrades.reduce((sum, u) => sum + u.owned, 0);
// bônus de produção dos chips (com retorno decrescente, para a evolução não virar uma bola de neve)
const chipBoostFor = (n) => (CHIP_BONUS + mods.chipBonus) * n ** CHIP_CURVE;
const chipBoost = () => chipBoostFor(chips);
const pendingChips = () => Math.floor(Math.cbrt(runBits / CHIP_DIVISOR));

function earn(amount) {
  bits += amount;
  totalBits += amount;
  runBits += amount;
  if (challenge) challenge.bits += amount;
  daily.counters.earn = (daily.counters.earn ?? 0) + amount;
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
const unitCost = (u) => u.baseCost * mods.costMult * fx.cost * (ruleId() === 'cost2' ? 2 : 1) * GROWTH ** u.owned;
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
  if (!challengeAllows(u)) {
    toast('Desafio: limite de 3 tipos de upgrade', '#ff8a8a');
    sfx.deny();
    return;
  }
  const { n, cost, ok } = planBuy(u);
  if (!ok) {
    sfx.deny();
    return;
  }
  sfx.buy();
  const before = levelOf(u);
  bits -= cost;
  u.owned += n;
  trackDaily('buy', n);
  const after = levelOf(u);
  if (after > before) {
    sfx.levelUp();
    toast(`${u.name} subiu para o nível ${after}! (+${Math.round((LEVEL_BASE_BONUS + mods.levelBonus) * 100)}%)`, '#7ee2a8');
  }
  updateShop();
  updatePerks();
  save();
}

function buyImprovement(imp) {
  if (bought.has(imp.id)) return;
  if (ruleId() === 'noimp') {
    toast('Desafio: melhorias bloqueadas', '#ff8a8a');
    sfx.deny();
    return;
  }
  if (bits < imp.cost) {
    sfx.deny();
    return;
  }
  sfx.buy();
  bits -= imp.cost;
  bought.add(imp.id);
  updateShop();
  updatePerks();
  save();
}

// ---------- Nível do jogador e pontos de habilidade ----------
function playerLevel() {
  return totalBits < 1000 ? 0 : Math.floor(Math.log(totalBits / 1000) / Math.log(LEVEL_XP_BASE)) + 1;
}

function levelProgress() {
  if (totalBits < 1000) return totalBits / 1000;
  const lv = playerLevel();
  const from = 1000 * LEVEL_XP_BASE ** (lv - 1);
  const to = 1000 * LEVEL_XP_BASE ** lv;
  return (totalBits - from) / (to - from);
}

const skillPointsTotal = () => playerLevel() + prestigeSP;
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
  { id: 'ch1',    name: 'Regras novas',           desc: 'Vença um desafio',          test: () => challengesDone.size >= 1 },
  { id: 'ch6',    name: 'Sem desculpas',          desc: 'Vença todos os desafios',   test: () => challengesDone.size >= CHALLENGES.length },
  { id: 'rs1',    name: 'Laboratório',            desc: 'Conclua uma pesquisa',      test: () => research.done.size >= 1 },
  { id: 'rs6',    name: 'Centro de pesquisa',     desc: 'Conclua 6 pesquisas',       test: () => research.done.size >= 6 },
  { id: 'pj1',    name: 'Lançamento!',            desc: 'Lance um jogo',             test: () => projectsDone().size >= 1 },
  { id: 'pj5',    name: 'Catálogo completo',      desc: 'Lance os 5 jogos',          test: () => projectsDone().size >= PROJECTS.length },
  { id: 'mg1',    name: 'Chefe',                  desc: 'Contrate um gerente',       test: () => managers.hired.size >= 1 },
  { id: 'mi3',    name: 'Rotina em dia',          desc: 'Cumpra 3 missões diárias',  test: () => missionsClaimed >= 3 },
  { id: 'as1',    name: 'Ascensão',               desc: 'Ascenda pela primeira vez', test: () => ascensions >= 1 },
];

function checkAchievements() {
  for (const a of achievements) {
    if (!unlocked.has(a.id) && a.test()) {
      unlocked.add(a.id);
      sfx.achievement();
      toast(`Conquista: ${a.name}`, '#ffc46b');
      refreshAchievements();
      save();
    }
  }
}

// ---------- Mecânicas do Estúdio (lógica) ----------
// Desafios, pesquisa, projetos, gerentes, missões, mercado, combo, visuais e ascensão.
// A interface delas fica na janela "Estúdio" (mais abaixo); aqui só estado e regras.
const challengeRule = () => (challenge ? CHALLENGES.find((c) => c.id === challenge.id) : null);
const ruleId = () => challenge?.id ?? null;

const projectsDone = () => new Set(Object.keys(projects).filter((id) => projects[id].state === 'done'));

function recomputeFx() {
  fx = computeFx({
    researchDone: research.done,
    projectsDone: projectsDone(),
    challengesDone,
    cores,
  });
}

const marketMult = () => (market.endsAt > Date.now() ? market.mult : 1);
const comboMult = () => 1 + combo.meter / 100;

function trackDaily(type, n = 1) {
  daily.counters[type] = (daily.counters[type] ?? 0) + n;
}

const freshCounters = () => ({ clicks: 0, golden: 0, buy: 0, earn: 0, impulse: 0, research: 0, combo: 0 });

function ensureDaily() {
  const key = dayKey();
  if (daily.date === key) return;
  daily = { date: key, counters: freshCounters(), missions: makeMissions(key, getBps()) };
}

// ---- Desafios ----
function challengeAllows(u) {
  if (ruleId() === 'three' && u.kind === 'gen' && u.owned === 0 && genUpgrades.filter((g) => g.owned > 0).length >= 3) {
    return false;
  }
  return true;
}

function startChallenge(id) {
  const def = CHALLENGES.find((c) => c.id === id);
  if (!def || challenge) return;
  if (playerLevel() < CHALLENGE_MIN_LEVEL) {
    toast(`Desafios liberam no nível ${CHALLENGE_MIN_LEVEL}`, '#ff8a8a');
    sfx.deny();
    return;
  }
  const ok = confirm(
    `Iniciar "${def.name}"?\n\n${def.rule}\nMeta: juntar ${format(def.goal)} bits.` +
    `${def.limitS ? `\nTempo: ${Math.round(def.limitS / 60)} minutos.` : ''}\n\n` +
    'Sua corrida atual fica guardada e volta quando o desafio terminar.',
  );
  if (!ok) return;

  challenge = {
    id,
    bits: 0,
    startedAt: Date.now(),
    snapshot: {
      bits, runBits,
      owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
      bought: [...bought],
    },
  };
  bits = 0;
  runBits = 0;
  for (const u of upgrades) u.owned = 0;
  bought.clear();
  frenzyLeft = 0;
  market.endsAt = 0;
  proposal = null;
  sfx.boost();
  toast(`Desafio: ${def.name}`, '#ffc46b');
  updateShop();
  updatePerks();
  save();
}

function endChallenge(success, why = '') {
  if (!challenge) return;
  const def = challengeRule();
  const snap = challenge.snapshot;
  bits = snap.bits;
  runBits = snap.runBits;
  for (const u of upgrades) u.owned = snap.owned[u.id] ?? 0;
  bought.clear();
  for (const id of snap.bought) bought.add(id);
  challenge = null;
  if (success) {
    challengesDone.add(def.id);
    recomputeFx();
    sfx.achievement();
    toast(`Desafio concluído: ${def.name} (+${Math.round(def.reward * 100)}% de produção)`, '#7ee2a8');
  } else {
    sfx.deny();
    toast(`Desafio encerrado${why ? `: ${why}` : ''}`, '#ff8a8a');
  }
  updateShop();
  updatePerks();
  checkAchievements();
  save();
}

function tickChallenge() {
  if (!challenge) return;
  const def = challengeRule();
  if (challenge.bits >= def.goal) endChallenge(true);
  else if (def.limitS && (Date.now() - challenge.startedAt) / 1000 > def.limitS) endChallenge(false, 'o tempo acabou');
}

// ---- Pesquisa (um projeto por vez, em tempo real) ----
function startResearch(id) {
  const r = RESEARCH.find((x) => x.id === id);
  if (!r || research.active || research.done.has(id)) return;
  if (bits < r.cost) {
    sfx.deny();
    return;
  }
  bits -= r.cost;
  research.active = { id, endsAt: Date.now() + r.time * 1000 };
  sfx.buy();
  toast(`Pesquisa iniciada: ${r.name}`, '#6ad8fe');
  save();
}

function tickResearch() {
  if (!research.active || Date.now() < research.active.endsAt) return;
  const r = RESEARCH.find((x) => x.id === research.active.id);
  research.done.add(r.id);
  research.active = null;
  recomputeFx();
  trackDaily('research');
  sfx.levelUp();
  toast(`Pesquisa concluída: ${r.name} (${r.desc})`, '#7ee2a8');
  checkAchievements();
  save();
}

// ---- Projetos: lançar um jogo ----
function startProject(id) {
  const p = PROJECTS.find((x) => x.id === id);
  if (!p || projects[id]) return;
  if (bits < p.cost) {
    sfx.deny();
    return;
  }
  bits -= p.cost;
  projects[id] = { state: 'running', endsAt: Date.now() + p.time * 1000 };
  sfx.buy();
  toast(`Produção iniciada: ${p.name}`, '#6ad8fe');
  save();
}

function tickProjects() {
  for (const p of PROJECTS) {
    const st = projects[p.id];
    if (!st || st.state !== 'running' || Date.now() < st.endsAt) continue;
    st.state = 'done';
    recomputeFx();
    sfx.achievement();
    toast(`${p.name} foi lançado! Produção +${Math.round(p.mult * 100)}%`, '#7ee2a8');
    checkAchievements();
    save();
  }
}

// ---- Gerentes ----
function hireManager(id) {
  const m = MANAGERS.find((x) => x.id === id);
  if (!m || managers.hired.has(id)) return;
  if (playerLevel() < m.level || bits < m.cost) {
    sfx.deny();
    return;
  }
  bits -= m.cost;
  managers.hired.add(id);
  sfx.buy();
  toast(`${m.name} contratado`, '#7ee2a8');
  checkAchievements();
  save();
}

// compra uma unidade sem barulho (usado pelos gerentes)
function buyQuiet(u) {
  if (!challengeAllows(u)) return false;
  const c = costFor(u, 1);
  if (c > bits * MANAGER_SPEND) return false;
  bits -= c;
  u.owned += 1;
  trackDaily('buy');
  return true;
}

function tickManagers() {
  if (!managers.master) return;
  let bought1 = false;
  for (const m of MANAGERS) {
    if (!managers.hired.has(m.id) || managers.off.has(m.id)) continue;
    const u = byId(m.id);
    for (let i = 0; i < 10 && buyQuiet(u); i++) bought1 = true;
  }
  if (bought1) updateShop();
}

// ---- Missões diárias ----
const missionProgress = (m) => Math.min(m.target, daily.counters[m.type] ?? 0);

function claimMission(i) {
  const m = daily.missions[i];
  if (!m || m.claimed || missionProgress(m) < m.target) return;
  m.claimed = true;
  const gift = Math.max(1000, getBps() * 600);
  earn(gift);
  fragments += 2;
  daily.claimedTotal = (daily.claimedTotal ?? 0) + 1;
  missionsClaimed++;
  sfx.achievement();
  toast(`Missão cumprida! +${format(gift)} bits e +2 fragmentos`, '#ffc46b');
  checkAchievements();
  save();
}

// ---- Eventos de mercado ----
function openProposal(kind) {
  const expiresAt = Date.now() + MARKET.proposalS * 1000;
  if (kind === 'crash') {
    const pct = Math.round((1 - MARKET.crash.mult) * 100);
    proposal = {
      kind, title: 'Crise no mercado', expiresAt, fallback: 'b',
      text: `Se nada for feito, os bits/s caem ${pct}% por ${MARKET.crash.durS}s. Um seguro custa ${Math.round(MARKET.crash.insurance * 100)}% dos seus bits.`,
      a: { label: 'Pagar seguro', run: () => { bits -= bits * MARKET.crash.insurance; toast('Seguro pago: a crise passou batido', '#7ee2a8'); } },
      b: { label: 'Enfrentar', run: () => { setMarket('crash', MARKET.crash.mult, MARKET.crash.durS, `Crise: bits/s −${pct}%`); toast(`Crise! Bits/s −${pct}% por ${MARKET.crash.durS}s`, '#ff8a8a'); sfx.deny(); } },
    };
  } else if (kind === 'invest') {
    proposal = {
      kind, title: 'Proposta de investidor', expiresAt, fallback: 'b',
      text: `Invista ${Math.round(MARKET.invest.share * 100)}% dos seus bits: ${Math.round(MARKET.invest.winChance * 100)}% de chance de receber o dobro de volta.`,
      a: {
        label: 'Investir',
        run: () => {
          const stake = bits * MARKET.invest.share;
          if (stake < 1) { toast('Poucos bits para investir', '#ff8a8a'); return; }
          bits -= stake;
          if (Math.random() < MARKET.invest.winChance) {
            earn(stake * MARKET.invest.payout);
            sfx.goldenCollect();
            toast(`Deu certo! O investimento rendeu ${format(stake * MARKET.invest.payout)} bits`, '#7ee2a8');
          } else {
            sfx.deny();
            toast(`O investimento deu errado: −${format(stake)} bits`, '#ff8a8a');
          }
        },
      },
      b: { label: 'Recusar', run: () => {} },
    };
  } else {
    proposal = {
      kind: 'fan', title: 'Fã generoso', expiresAt, fallback: 'a',
      text: 'Um fã quer retribuir o carinho. Escolha o presente.',
      a: { label: `${MARKET.fan.minutesOfProduction} min de bits`, run: () => { const g = Math.max(1000, getBps() * 60 * MARKET.fan.minutesOfProduction); earn(g); sfx.goldenCollect(); toast(`Presente: +${format(g)} bits`, '#ffc46b'); } },
      b: { label: `${MARKET.fan.fragments} fragmentos`, run: () => { fragments += MARKET.fan.fragments; sfx.goldenCollect(); toast(`Presente: +${MARKET.fan.fragments} fragmentos`, '#ffc46b'); } },
    };
  }
  sfx.goldenSpawn();
}

function setMarket(kind, mult, durS, label) {
  market.kind = kind;
  market.mult = mult;
  market.endsAt = Date.now() + durS * 1000;
  market.label = label;
}

function resolveProposal(choice) {
  if (!proposal) return;
  const p = proposal;
  proposal = null;
  (choice === 'a' ? p.a : p.b).run();
  updateShop();
  save();
}

function scheduleMarket() {
  market.nextAt = Date.now() + (MARKET.minGapS + Math.random() * (MARKET.maxGapS - MARKET.minGapS)) * 1000;
}

function tickMarket() {
  const now = Date.now();
  if (market.endsAt && now >= market.endsAt) {
    market.endsAt = 0;
    market.kind = null;
    market.mult = 1;
    toast('O mercado voltou ao normal', '#9db2c6');
  }
  if (proposal && now >= proposal.expiresAt) resolveProposal(proposal.fallback);
  if (challenge || proposal || market.endsAt || playerLevel() < 6 || now < market.nextAt) return;
  scheduleMarket();
  const kind = pickMarketEvent();
  if (kind === 'boom') {
    const pct = Math.round((MARKET.boom.mult - 1) * 100);
    setMarket('boom', MARKET.boom.mult, MARKET.boom.durS, `Boom de mercado: bits/s +${pct}%`);
    sfx.boost();
    toast(`Boom de mercado! Bits/s +${pct}% por ${MARKET.boom.durS}s`, '#7ee2a8');
  } else {
    openProposal(kind);
  }
}

// ---- Combo de cliques ----
function comboClick() {
  combo.last = performance.now();
  const was = combo.meter;
  combo.meter = Math.min(100, combo.meter + 7);
  if (was < 100 && combo.meter >= 100) trackDaily('combo', 1);
}

function tickCombo(dt) {
  if (combo.meter > 0 && performance.now() - combo.last > 650) {
    combo.meter = Math.max(0, combo.meter - 28 * (dt / 1000));
  }
}

// ---- Ascensão: a segunda camada de evolução ----
function ascend() {
  const gain = ascendGain(chips);
  if (challenge) {
    toast('Termine o desafio antes de ascender', '#ff8a8a');
    sfx.deny();
    return;
  }
  if (chips < ASCEND_MIN_CHIPS || gain < 1) {
    toast(`Ascensão libera com ${ASCEND_MIN_CHIPS} chips`, '#ff8a8a');
    sfx.deny();
    return;
  }
  const next = cores + gain;
  const ok = confirm(
    `Ascender agora?\n\nVocê troca seus ${chips} chips por ${gain} núcleo(s).\n` +
    `Bônus de produção: ×${coreMult(cores).toFixed(2)} → ×${coreMult(next).toFixed(2)}, permanente.\n\n` +
    'Reinicia: bits, upgrades, melhorias e chips. Ficam: habilidades e pontos, conquistas, pesquisa, projetos, desafios, gerentes e visuais.',
  );
  if (!ok) return;

  sfx.prestige();
  haptic(40);
  cores = next;
  ascensions++;
  chips = 0;
  bits = 0;
  runBits = 0;
  for (const u of upgrades) u.owned = 0;
  bought.clear();
  recomputeFx();
  updateShop();
  updatePerks();
  toast(`Ascensão! +${gain} núcleo(s)`, '#a57bf8');
  checkAchievements();
  save();
}

// ---- Visuais ----
const skinUnlocked = (s) => skinsOwned.has(s.id) || (s.project && projectsDone().has(s.project));

function buyOrEquipSkin(id) {
  const s = SKINS.find((x) => x.id === id);
  if (!s) return;
  if (!skinUnlocked(s)) {
    if (fragments < s.cost) {
      sfx.deny();
      return;
    }
    fragments -= s.cost;
    skinsOwned.add(id);
    sfx.achievement();
  }
  skinId = id;
  sfx.tick();
  applySkin();
  save();
}


// ---------- Save / Load ----------
const num = (v) => (Number.isFinite(v) ? v : 0);

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      bits, totalBits, runBits, clicks, goldenClicks, chips, prestiges, prestigeSP, abilityUses, playMs, buyMode,
      owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
      bought: [...bought],
      unlocked: [...unlocked],
      skills: [...skillsOwned],
      abilities,
      fragments, cores, ascensions, missionsClaimed,
      research: { done: [...research.done], active: research.active },
      projects,
      managers: { hired: [...managers.hired], off: [...managers.off], master: managers.master },
      skin: { id: skinId, owned: [...skinsOwned] },
      challenge,
      challengesDone: [...challengesDone],
      daily,
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
    // saves antigos davam 1 ponto por chip; agora cada evolução dá no máximo MAX_SP_PER_PRESTIGE
    prestigeSP = d.prestigeSP === undefined
      ? Math.min(chips, MAX_SP_PER_PRESTIGE * prestiges)
      : num(d.prestigeSP);
    abilityUses = num(d.abilityUses);
    playMs = num(d.playMs);
    if (BUY_MODES.includes(d.buyMode)) buyMode = d.buyMode;
    for (const u of upgrades) u.owned = num(d.owned?.[u.id]);
    for (const id of d.bought ?? []) if (improvements.some((i) => i.id === id)) bought.add(id);
    for (const id of d.unlocked ?? []) unlocked.add(id);
    for (const id of d.skills ?? []) if (SKILLS.some((s) => s.id === id)) skillsOwned.add(id);
    recomputeMods();
    fragments = num(d.fragments);
    cores = num(d.cores);
    ascensions = num(d.ascensions);
    missionsClaimed = num(d.missionsClaimed);
    for (const id of d.research?.done ?? []) if (RESEARCH.some((r) => r.id === id)) research.done.add(id);
    if (d.research?.active && RESEARCH.some((r) => r.id === d.research.active.id)) research.active = d.research.active;
    for (const p of PROJECTS) if (d.projects?.[p.id]) projects[p.id] = d.projects[p.id];
    for (const id of d.managers?.hired ?? []) if (MANAGERS.some((m) => m.id === id)) managers.hired.add(id);
    for (const id of d.managers?.off ?? []) managers.off.add(id);
    managers.master = d.managers?.master !== false;
    for (const id of d.skin?.owned ?? []) if (SKINS.some((k) => k.id === id)) skinsOwned.add(id);
    if (SKINS.some((k) => k.id === d.skin?.id)) skinId = d.skin.id;
    if (d.challenge && CHALLENGES.some((c) => c.id === d.challenge.id) && d.challenge.snapshot) challenge = d.challenge;
    for (const id of d.challengesDone ?? []) if (CHALLENGES.some((c) => c.id === id)) challengesDone.add(id);
    if (d.daily?.date) daily = d.daily;
    recomputeFx();
    // se o jogador tinha gasto mais pontos do que agora tem direito, devolve todos (ele refaz a árvore)
    if (skillPointsSpent() > skillPointsTotal()) {
      skillsOwned.clear();
      recomputeMods();
      migrationNote = 'Rebalanceamos os pontos de habilidade: suas habilidades foram devolvidas para você redistribuir.';
    }
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
ensureDaily();

// ---------- Cenário: fundo suave, partículas flutuantes e pedestal ----------

const bgG = new Graphics();
const moteLayer = new Container();
const pedestal = new Graphics();
const ripples = new Graphics();
const halo = new Graphics();
app.stage.addChild(bgG, moteLayer, pedestal, ripples, halo);
// camadas só decorativas: não podem engolir cliques (no Pixi, todo objeto visível sob o ponteiro
// bloqueia o que está atrás quando o palco é interativo)
for (const layer of [bgG, moteLayer, pedestal, ripples, halo]) layer.eventMode = 'none';

// camadas que só mudam de vez em quando: guardadas como textura em vez de redesenhadas todo quadro
function refreshCache(g) {
  if (g.isCachedAsTexture) g.updateCacheTexture();
  else g.cacheAsTexture({ antialias: true });
}

let decoFrenzy = false;
let cubeSize = 300;
let cubeBaseY = 0;
let ped = { cx: 0, cy: 0, rx: 200 };

function drawBackground() {
  const { width: W, height: H } = app.screen;
  bgG.clear();
  // brilho suave atrás do cubo (camadas translúcidas formam um degradê)
  for (let i = 0; i < 10; i++) {
    const k = 1 - i / 10;
    bgG.ellipse(W / 2, cubeBaseY, W * 0.62 * k + 80, H * 0.55 * k + 80).fill({ color: 0x1c4a68, alpha: 0.018 });
  }
  // grade isométrica quase invisível
  const step = 72;
  for (let c = -W / 2; c <= H; c += step) bgG.moveTo(0, c).lineTo(W, c + W / 2);
  for (let c = 0; c <= H + W / 2; c += step) bgG.moveTo(0, c).lineTo(W, c - W / 2);
  bgG.stroke({ width: 1, color: 0xffffff, alpha: 0.018 });
  refreshCache(bgG);
}

function drawPedestal() {
  const { width: W } = app.screen;
  const cx = W / 2;
  const cy = cubeBaseY + cubeSize * 0.47;
  const rx = cubeSize * 0.74;
  const ry = rx * 0.5;
  const t = Math.max(7, cubeSize * 0.045);
  const rim = decoFrenzy ? C.warn : accentNow();
  ped = { cx, cy, rx };

  pedestal.clear();
  pedestal.ellipse(cx, cy + t + 12, rx * 1.12, ry * 1.18).fill({ color: 0x000000, alpha: 0.3 });
  pedestal.ellipse(cx, cy + t, rx, ry).fill(0x070d14);
  pedestal.ellipse(cx, cy, rx, ry).fill(0x0f1a28).stroke({ width: 1.5, color: rim, alpha: 0.3 });
  pedestal.ellipse(cx, cy, rx * 0.74, ry * 0.74).stroke({ width: 1, color: rim, alpha: 0.1 });
  pedestal.ellipse(cx, cy, rx * 0.46, ry * 0.46).stroke({ width: 1, color: rim, alpha: 0.07 });
  refreshCache(pedestal);
}

function drawHalo() {
  const color = decoFrenzy ? C.warn : accentNow();
  halo.clear();
  for (let i = 1; i <= 8; i++) {
    halo.circle(0, 0, cubeSize * (0.28 + i * 0.075)).fill({ color, alpha: 0.012 });
  }
  refreshCache(halo);
}

// partículas flutuando devagar (aceleram e esquentam durante o Frenesi)
const moteTexture = app.renderer.generateTexture(new Graphics().circle(0, 0, 4).fill(0xffffff));
const motesData = Array.from({ length: 34 }, () => {
  const sprite = new Sprite(moteTexture);
  sprite.anchor.set(0.5);
  moteLayer.addChild(sprite);
  return {
    sprite, x: Math.random(), y: Math.random(), s: 0.8 + Math.random() * 1.8,
    v: 6 + Math.random() * 14, ph: Math.random() * 6.28, a: 0.15 + Math.random() * 0.35,
  };
});

function updateMotes(dt) {
  moteLayer.visible = settings.motion;
  if (!settings.motion) return;
  const { width: W, height: H } = app.screen;
  const mul = frenzyLeft > 0 ? 2.4 : 1;
  const now = performance.now();
  const tint = frenzyLeft > 0 ? C.warn : accentNow();
  for (const m of motesData) {
    m.y -= (m.v * mul * dt) / 1000 / H;
    if (m.y < -0.02) {
      m.y = 1.02;
      m.x = Math.random();
    }
    m.sprite.position.set(m.x * W + Math.sin(now / 1800 + m.ph) * 10, m.y * H);
    m.sprite.scale.set(m.s / 4);
    m.sprite.tint = tint;
    m.sprite.alpha = m.a * (0.6 + 0.4 * Math.sin(now / 700 + m.ph));
  }
}

// ondas que se espalham pelo pedestal a cada clique
const rippleList = [];
const addRipple = (strength = 1) => { if (settings.motion) rippleList.push({ t: 0, s: strength }); };

function updateRipples(dt) {
  ripples.clear();
  for (let i = rippleList.length - 1; i >= 0; i--) {
    const r = rippleList[i];
    r.t += dt;
    const p = r.t / 1100;
    if (p >= 1) {
      rippleList.splice(i, 1);
      continue;
    }
    const k = 0.3 + 0.85 * ease.out(p);
    ripples.ellipse(ped.cx, ped.cy, ped.rx * k, ped.rx * k * 0.5)
      .stroke({ width: 2, color: decoFrenzy ? C.warn : accentNow(), alpha: (1 - p) * 0.35 * r.s });
  }
}

// ---------- Cubo ----------
const CUBE_URL = import.meta.env.VITE_CUBE_URL || `${import.meta.env.BASE_URL}assets/cube.png`;
const texture = await Assets.load(CUBE_URL);
const cube = new Sprite(texture);
cube.anchor.set(0.5);

let baseScale = cubeSize / texture.height;
const cubeFx = { kick: 1, intro: 1 };   // fatores que multiplicam a escala base
cube.scale.set(baseScale);
cube.eventMode = 'static';
cube.cursor = 'pointer';
app.stage.addChild(cube);

// ---------- Textos do topo ----------
let shownBits = bits;

const counter = txt('0 bits', T.text, 46, true);
counter.anchor.set(0.5, 0);
app.stage.addChild(counter);

const bpsText = txt('0 bits/s', T.good, 20);
bpsText.anchor.set(0.5, 0);
app.stage.addChild(bpsText);

const metaText = txt('', T.dim, 14);
metaText.anchor.set(0.5, 0);
app.stage.addChild(metaText);

const xpBar = new Graphics();
app.stage.addChild(xpBar);

const frenzyText = txt('', T.warn, 18, true);
frenzyText.anchor.set(0.5, 0);
app.stage.addChild(frenzyText);
for (const el of [counter, bpsText, metaText, frenzyText, xpBar]) el.eventMode = 'none';

function resetGame() {
  if (!confirm('Apagar todo o progresso?')) return;
  resetting = true;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* sem localStorage */ }
  location.reload();
}

// ---------- Gavetas laterais ----------
const PANEL_W = 300;
const PAGE_W = PANEL_W - 28;
const CARD_W = PAGE_W - 6;

const rightDock = createDock({ side: 'right', panelW: PANEL_W });
const leftDock = createDock({ side: 'left', panelW: PANEL_W });
app.stage.addChild(leftDock.root, rightDock.root);

// ---- Direita: seletor de modo de compra (x1 / x10 / x100 / Máx) ----
const modeBar = new Container();
const MODE_W = Math.floor((PAGE_W - 3 * 6) / 4);
const modeButtons = BUY_MODES.map((mode, i) => {
  const btn = makeButton(MODE_W, 28, { tint: C.accent, radius: 14, alpha: 0.05 });
  btn.x = i * (MODE_W + 6);
  const label = txt(mode === 'max' ? 'Máx' : `x${mode}`, T.text, 13, true);
  label.anchor.set(0.5);
  label.position.set(MODE_W / 2, 14);
  btn.addChild(label);
  btn.on('pointertap', () => setBuyMode(mode));
  modeBar.addChild(btn);
  return { mode, btn };
});
rightDock.setHeader(modeBar, 40);

function setBuyMode(mode) {
  sfx.tick();
  buyMode = mode;
  paintModeButtons();
  updateShop();
  save();
}

function paintModeButtons() {
  for (const { mode, btn } of modeButtons) btn.setActive(mode === buyMode);
}

// ---- Direita: páginas Clique e Produção ----
const clickPage = createScroll(PAGE_W);
const prodPage = createScroll(PAGE_W);
const shopButtons = [];

for (const u of upgrades) {
  const H = 74;
  const accent = u.kind === 'click' ? C.click : C.prod;
  const wrap = new Container();
  const btn = makeButton(CARD_W, H, { tint: accent, radius: 14, alpha: 0.06 });

  const stripe = new Graphics().roundRect(0, 16, 3, H - 32, 1.5).fill(accent);
  const title = txt('', T.text, 15, true);
  title.position.set(16, 9);
  const lvlText = txt('', hex(accent), 12, true);
  lvlText.anchor.set(1, 0);
  lvlText.position.set(CARD_W - 14, 11);
  const cost = txt('', T.text, 13);
  cost.position.set(16, 31);
  const info = txt('', T.dim, 12);
  info.position.set(16, 48);
  const bar = new Graphics();

  btn.addChild(stripe, title, lvlText, cost, info, bar);
  btn.on('pointertap', () => { if (!uiMoved) buy(u); });
  wrap.addChild(btn);

  (u.kind === 'click' ? clickPage : prodPage).add(wrap, H);
  shopButtons.push({ u, wrap, btn, title, lvlText, cost, info, bar, accent, shown: 0, target: 0 });
}

rightDock.addTab('Clique', clickPage, C.click);
rightDock.addTab('Produção', prodPage, C.prod);

function drawLevelBar(item) {
  const bw = CARD_W - 32;
  item.bar.clear()
    .roundRect(16, 65, bw, 4, 2).fill({ color: 0xffffff, alpha: 0.07 })
    .roundRect(16, 65, Math.max(item.shown > 0.005 ? 4 : 0, bw * item.shown), 4, 2).fill(item.accent);
}

function updateShop() {
  for (const item of shopButtons) {
    const { u, btn, title, lvlText, cost, info } = item;
    const plan = planBuy(u);
    const per = (u.click ?? u.bps) * unitMult(u) * (u.click ? mods.clickMult : 1);
    const perText = u.click ? `+${rate(per)}/clique` : `+${rate(per)}/s`;

    title.text = u.name;
    lvlText.text = `x${u.owned} · Nv ${levelOf(u)}`;
    cost.text = `Comprar +${plan.n} · ${format(plan.cost)}`;
    info.text = `${perText} cada · nível ${u.owned % LEVEL_SIZE}/${LEVEL_SIZE}`;
    btn.alpha = plan.ok ? 1 : 0.5;
    item.target = (u.owned % LEVEL_SIZE) / LEVEL_SIZE;
  }
}

// a barra de nível desliza até o valor novo (e recomeça suave ao subir de nível)
function animateBars(dt) {
  for (const item of shopButtons) {
    if (item.target < item.shown - 0.3) item.shown = 0;
    const diff = item.target - item.shown;
    if (Math.abs(diff) > 0.002) {
      item.shown += diff * (1 - Math.exp(-dt / 110));
      drawLevelBar(item);
    } else if (item.shown !== item.target) {
      item.shown = item.target;
      drawLevelBar(item);
    }
  }
}

// ---- Esquerda: páginas Melhorias e Estatísticas ----
const perksPage = createScroll(PAGE_W);
const perkButtons = [];

for (const imp of improvements) {
  const H = 56;
  const wrap = new Container();
  const btn = makeButton(CARD_W, H, { tint: C.evo, radius: 14, alpha: 0.06 });
  const stripe = new Graphics().roundRect(0, 14, 3, H - 28, 1.5).fill(C.evo);
  const title = txt(imp.name, T.text, 14, true);
  title.position.set(16, 8);
  const info = txt(`Dobra a produção · ${format(imp.cost)}`, T.dim, 12);
  info.position.set(16, 31);
  btn.addChild(stripe, title, info);
  btn.on('pointertap', () => { if (!uiMoved) buyImprovement(imp); });
  wrap.addChild(btn);
  wrap.visible = false;
  perksPage.add(wrap, H);
  perkButtons.push({ imp, wrap, btn });
}

const perksEmpty = txt('Compre upgrades para liberar\nnovas melhorias.', T.faint, 13);
perksEmpty.style.lineHeight = 20;
perksEmpty.position.set(4, 6);

const statsPage = createScroll(PAGE_W);
const statsText = txt('', T.dim, 13);
statsText.style.lineHeight = 24;
statsPage.add(statsText, 220);

leftDock.addTab('Melhorias', perksPage, C.evo);
leftDock.addTab('Estatísticas', statsPage, C.luck);

const costOfItem = (container) => perkButtons.find(({ wrap }) => wrap === container).imp.cost;
let perksSignature = '';

function updatePerks() {
  let count = 0;
  for (const { imp, wrap } of perkButtons) {
    const show = !bought.has(imp.id) && byId(imp.target).owned >= imp.req;
    wrap.visible = show;
    if (show) count++;
  }
  const signature = perkButtons.map(({ wrap }) => (wrap.visible ? 1 : 0)).join('');
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
    `Evoluções: ${prestiges} · Ascensões: ${ascensions}`,
    `Núcleos: ${cores} · Fragmentos: ${fragments}`,
    `Desafios: ${challengesDone.size}/${CHALLENGES.length} · Pesquisas: ${research.done.size}/${RESEARCH.length}`,
    `Jogos lançados: ${projectsDone().size}/${PROJECTS.length} · Missões: ${missionsClaimed}`,
    `Upgrades comprados: ${totalOwned()}`,
    `Habilidades: ${skillsOwned.size}/${SKILLS.length}`,
    `Conquistas: ${unlocked.size}/${achievements.length}`,
    `Tempo de jogo: ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}min`,
  ].join('\n');
}

// ---------- Impulsos (habilidades ativas) ----------
const abilityButtons = abilityDefs.map((a) => {
  const btn = makeButton(160, 46, { tint: C.warn, radius: 14, alpha: 0.07 });
  const name = txt(a.name, T.text, 14, true);
  name.position.set(12, 5);
  const status = txt('', T.dim, 12);
  status.position.set(12, 25);
  const prog = new Graphics();
  btn.addChild(name, status, prog);
  btn.on('pointertap', () => useAbility(a));
  app.stage.addChild(btn);
  return { a, btn, name, status, prog };
});

function useAbility(a) {
  const s = abilities[a.id];
  if (ruleId() === 'nogold') {
    toast('Desafio: impulsos bloqueados', '#ff8a8a');
    sfx.deny();
    return;
  }
  if (s.cd > 0) {
    sfx.deny();
    return;
  }
  sfx.boost();
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
    toast(`${a.name} ativada`, '#ffc46b');
  }
  s.cd = a.cd * mods.abilityCd;
  abilityUses++;
  trackDaily('impulse');
  addRipple(1.4);
  checkAchievements();
  save();
}

function updateAbilities() {
  for (const { a, btn, status } of abilityButtons) {
    const s = abilities[a.id];
    if (s.act > 0) {
      status.text = `Ativo · ${Math.ceil(s.act / 1000)}s`;
      status.style.fill = T.good;
      btn.alpha = 1;
    } else if (s.cd > 0) {
      const sec = Math.ceil(s.cd / 1000);
      status.text = `Recarga · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      status.style.fill = T.faint;
      btn.alpha = 0.55;
    } else {
      status.text = a.desc;
      status.style.fill = T.dim;
      btn.alpha = 1;
    }
  }
}

// barra fina no rodapé do botão: tempo ativo (verde) ou recarga (âmbar), fluida a cada frame
function updateAbilityBars() {
  for (const ab of abilityButtons) {
    const s = abilities[ab.a.id];
    const { w, h } = ab.btn.btn;
    ab.prog.clear();
    if (s.act > 0) {
      ab.prog.roundRect(12, h - 8, (w - 24) * (s.act / ab.a.dur), 3, 1.5).fill(C.good);
    } else if (s.cd > 0) {
      const total = ab.a.cd * mods.abilityCd;
      ab.prog.roundRect(12, h - 8, (w - 24) * (1 - s.cd / total), 3, 1.5).fill({ color: C.warn, alpha: 0.7 });
    }
  }
}

// ---------- Botões de baixo: Conquistas, Habilidades, Evoluir ----------
function bottomButton(tint, color) {
  const btn = makeButton(160, 40, { tint, radius: 14, alpha: 0.08 });
  const label = txt('', color, 14, true);
  label.anchor.set(0.5);
  label.position.set(80, 20);
  btn.addChild(label);
  app.stage.addChild(btn);
  return { btn, label };
}

const { btn: achButton, label: achLabel } = bottomButton(C.warn, T.warn);
const { btn: skillButton, label: skillLabel } = bottomButton(C.accent, T.accent);
const { btn: prestigeBtn, label: prestigeLabel } = bottomButton(C.evo, T.text);

function prestige() {
  if (challenge) {
    toast('Termine o desafio antes de evoluir', '#ff8a8a');
    sfx.deny();
    return;
  }
  const gain = pendingChips();
  if (gain < 1) {
    toast('Ainda não dá para evoluir: ganhe mais bits', '#ff8a8a');
    return;
  }
  const spGain = Math.min(MAX_SP_PER_PRESTIGE, gain);
  const boostNow = Math.round(chipBoostFor(chips) * 100);
  const boostAfter = Math.round(chipBoostFor(chips + gain) * 100);
  const ok = confirm(
    `Evoluir agora?\n\nVocê ganha ${gain} chip(s): o bônus de produção vai de +${boostNow}% para +${boostAfter}%, permanente.\n` +
    `Também ganha ${spGain} ponto(s) de habilidade (máximo de ${MAX_SP_PER_PRESTIGE} por evolução).\n` +
    'Seus bits, upgrades e melhorias serão reiniciados. Chips, conquistas e habilidades ficam.',
  );
  if (!ok) return;

  sfx.prestige();
  haptic(30);
  chips += gain;
  prestigeSP += spGain;
  prestiges++;
  bits = 0;
  runBits = 0;
  for (const u of upgrades) u.owned = 0;
  bought.clear();
  updateShop();
  updatePerks();
  addRipple(2);
  toast(`Evolução! +${gain} chip(s) e +${spGain} ponto(s) de habilidade`, '#a57bf8');
  checkAchievements();
  save();
}
prestigeBtn.on('pointertap', prestige);

// ---------- Janelas (conquistas e árvore): fundo escurece e o painel desliza com fade ----------
const dim = new Graphics();
dim.eventMode = 'static';
dim.alpha = 0;
dim.visible = false;
dim.on('pointertap', () => closeModals());

function showModal(panel) {
  const { width: W, height: H } = app.screen;
  dim.clear().rect(0, 0, W, H).fill(0x03060b);
  dim.visible = true;
  sfx.open();
  document.body.classList.add('modal-open');
  tween(dim, { alpha: 0.62 }, 260);
  const y = panel.y;
  panel.visible = true;
  panel.alpha = 0;
  panel.y = y + 20;
  tween(panel, { alpha: 1, y }, 340);
}

function hideModal(panel) {
  sfx.close();
  document.body.classList.remove('modal-open');
  tween(dim, { alpha: 0 }, 220, { onDone: () => { if (!tree.visible && !achPanel.visible && !settingsPanel.visible && !studioPanel.visible) dim.visible = false; } });
  const y = panel.y;
  tween(panel, { alpha: 0, y: y + 12 }, 220, {
    onDone: () => {
      panel.visible = false;
      panel.y = y;
    },
  });
}

function closeModals() {
  if (tree.visible) toggleTree(false);
  if (achPanel.visible) toggleAchievements(false);
  if (settingsPanel.visible) toggleSettings(false);
  if (studioPanel.visible) toggleStudio(false);
}

// ---------- Painel de conquistas (rolável; 2 colunas em telas largas) ----------
const achPanel = new Container();
achPanel.visible = false;
achPanel.eventMode = 'static';
const achBg = new Graphics();
achPanel.addChild(achBg);
const achTitle = txt('', T.text, 19, true);
achPanel.addChild(achTitle);
const achScroll = createScroll(800);
achPanel.addChild(achScroll.root);

const achRows = achievements.map((a) => {
  const row = new Container();
  const dot = new Graphics();
  const label = txt('', T.faint, 14);
  label.position.set(22, -1);
  row.addChild(dot, label);
  achScroll.content.addChild(row);
  return { a, row, dot, label };
});

const achClose = makeButton(84, 30, { tint: C.warn, radius: 15, alpha: 0.08 });
const achCloseLabel = txt('Fechar', T.warn, 13, true);
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
  const rowH = narrow ? 28 : 30;
  const perCol = Math.ceil(achievements.length / cols);
  const contentH = perCol * rowH + 8;
  const viewH = Math.min(contentH, height - (narrow ? 12 : 24) - 84);
  const h = 70 + viewH + 14;
  achW = w;

  drawCard(achBg, w, h, { fill: C.panel, fillAlpha: 0.98, radius: 24 });
  achTitle.position.set(24, narrow ? 18 : 20);
  achTitle.style.fontSize = narrow ? 16 : 19;
  achClose.position.set(w - 84 - 20, 16);

  achRows.forEach(({ row, label }, i) => {
    label.style.fontSize = narrow ? 12 : 14;
    label.style.wordWrap = true;
    label.style.wordWrapWidth = colW - 36;
    row.position.set(Math.floor(i / perCol) * colW, (i % perCol) * rowH);
  });
  achScroll.root.position.set(24, 62);
  achScroll.resize(viewH, w - 48);
  achScroll.contentH = contentH;   // as linhas ficam direto no conteúdo (sem itens empilhados)
  achScroll.scrollBy(0);
  achPanel.position.set((width - w) / 2, Math.max(6, (height - h) / 2));
}

function refreshAchievements() {
  achLabel.text = `Conquistas ${unlocked.size}/${achievements.length}`;
  achTitle.text = `Conquistas · +${Math.round(unlocked.size * ACHIEVEMENT_BONUS * 100)}% de produção`;
  for (const { a, dot, label } of achRows) {
    const done = unlocked.has(a.id);
    label.text = `${a.name} — ${a.desc}`;
    label.style.fill = done ? T.text : T.faint;
    dot.clear().circle(7, 9, 5.5);
    if (done) dot.fill(C.good);
    else dot.stroke({ width: 1.5, color: C.faint, alpha: 0.7 });
  }
}

// ---------- Árvore de habilidades: mandala ----------
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

const treeTitle = txt('Árvore de Habilidades', T.text, 20, true);
treeTitle.position.set(22, 11);

function labeledButton(w, h, label, tint, color, size = 13, alpha = 0.08) {
  const b = makeButton(w, h, { tint, radius: h / 2, alpha });
  const t = txt(label, color, size, true);
  t.anchor.set(0.5);
  t.position.set(w / 2, h / 2);
  b.addChild(t);
  b.labelObj = t;
  return b;
}

function fitButton(btn, w, h) {
  btn.paint({ w, h, radius: h / 2 });
  btn.labelObj.position.set(w / 2, h / 2);
}

const pointsChip = labeledButton(170, 30, '', C.accent, T.text, 14, 0.1);
pointsChip.eventMode = 'none';
const pointsText = pointsChip.labelObj;
const treeRespec = labeledButton(138, 30, 'Redistribuir', C.dim ?? C.accent, T.dim, 13, 0.05);
const respecLabel = treeRespec.labelObj;
const treeClose = labeledButton(92, 30, 'Fechar', C.warn, T.warn, 13);
const zoomOut = labeledButton(34, 28, '-', C.accent, T.text, 15, 0.05);
const zoomIn = labeledButton(34, 28, '+', C.accent, T.text, 15, 0.05);
const zoomFit = labeledButton(108, 28, 'Centralizar', C.accent, T.dim, 12, 0.05);

const legend = new Container();
const legendItems = BRANCHES.map((b) => {
  const dot = new Graphics();
  dot.poly([0, -6, 7, -2.5, 0, 1, -7, -2.5]).fill(lighten(b.color, 0.25));
  dot.poly([-7, -2.5, 0, 1, 0, 9, -7, 5.5]).fill(b.color);
  dot.poly([7, -2.5, 0, 1, 0, 9, 7, 5.5]).fill(darken(b.color, 0.4));
  const label = txt('', hex(b.color), 13, true);
  label.position.set(14, -8);
  const item = new Container();
  item.addChild(dot, label);
  legend.addChild(item);
  return { b, label };
});

const hintText = txt(touchUi ? HINT_TOUCH : HINT_WIDE, T.faint, 12);

// cartão de informações do nó (perto do cubo sob o mouse/dedo)
const tip = new Container();
tip.visible = false;
tip.eventMode = 'none';
const tipBg = new Graphics();
const tipTag = txt('', '#ffffff', 11, true);
tipTag.style.letterSpacing = 0.6;
const tipName = txt('', T.text, 17, true);
const tipDesc = txt('', T.dim, 13);
tipDesc.style.wordWrap = true;
tipDesc.style.wordWrapWidth = 232;
tipDesc.style.lineHeight = 18;
const tipStatus = txt('', T.accent, 13, true);
const tipLine = new Graphics();
tip.addChild(tipBg, tipLine, tipTag, tipName, tipDesc, tipStatus);

tree.addChild(treeBg, treeViewport, treeMask, treeTitle, pointsChip, treeRespec, treeClose, legend, hintText, zoomOut, zoomIn, zoomFit, tip);

// projeção do chão da mandala (1 = círculo)
const project = (x, y) => ({ x, y: y * ISO });

function drawCube(g, s, height, top, left, right, edge, edgeAlpha = 0.9) {
  const k = 0.87 * s;
  const h = height;
  g.poly([0, -s - h, k, -s / 2 - h, 0, -h, -k, -s / 2 - h]).fill(top);
  g.poly([-k, -s / 2 - h, 0, -h, 0, s, -k, s / 2]).fill(left);
  g.poly([k, -s / 2 - h, 0, -h, 0, s, k, s / 2]).fill(right);
  g.poly([0, -s - h, k, -s / 2 - h, k, s / 2, 0, s, -k, s / 2, -k, -s / 2 - h])
    .stroke({ width: 1.2, color: edge, alpha: edgeAlpha });
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
    decorG.poly(flat).fill({ color: b.color, alpha: 0.035 });

    decorG.moveTo(e0[0].x, e0[0].y);
    for (const q of e0) decorG.lineTo(q.x, q.y);
    decorG.stroke({ width: 1.2, color: b.color, alpha: 0.18 });
  });

  for (let t = 0; t < 10; t++) {
    const r = RING_R0 + t * RING_STEP;
    decorG.ellipse(0, 0, r, r * ISO).stroke({ width: 1, color: 0xffffff, alpha: t % 3 === 2 ? 0.07 : 0.035 });
  }
  decorG.ellipse(0, 0, outer, outer * ISO).stroke({ width: 1.5, color: 0xffffff, alpha: 0.1 });
  decorG.ellipse(0, 0, RING_R0 - 34, (RING_R0 - 34) * ISO).stroke({ width: 1, color: 0xffffff, alpha: 0.08 });

  // núcleo: disco suave
  const cr = 42;
  decorG.ellipse(0, 10, cr, cr * 0.55).fill(0x05090f);
  decorG.ellipse(0, 0, cr, cr * 0.55).fill(0x111c2a).stroke({ width: 1.5, color: 0xffffff, alpha: 0.35 });
}

drawMandalaDecor();

BRANCHES.forEach((b, i) => {
  const mid = (branchStart(i) + branchStart(i + 1)) / 2;
  const r = R_MAX + 66;
  const p = polar(r, mid + twistAt(r));
  const label = txt(b.name.toUpperCase(), hex(b.color), 26, true);
  label.style.letterSpacing = 3;
  label.alpha = 0.85;
  label.anchor.set(0.5);
  label.position.set(p.x, p.y);
  nodeLayer.addChild(label);
});

const coreLabel = txt('NÚCLEO', T.dim, 10, true);
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
  ring.ellipse(0, NODE_S * 0.55, NODE_S * 1.5, NODE_S * 0.85).stroke({ width: 1.5, color: BRANCHES[s.branch].color });
  ring.visible = false;
  const glow = new Graphics();
  const g = new Graphics();
  const cost = txt(String(s.cost), T.text, 11, true);
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
    hideTip();
  });
  nodeLayer.addChild(node);
  nodeViews.set(s.id, { node, g, glow, ring, cost, owned: false, phase: Math.random() * 6.28 });
}

function clearSelection() {
  const old = selectedId;
  selectedId = null;
  hoverId = null;
  hideTip();
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
  const view = nodeViews.get(s.id);
  const { g, glow, ring, cost } = view;
  const base = BRANCHES[s.branch].color;
  const state = skillState(s);
  const hot = hoverId === s.id;
  view.owned = state === 'owned';
  g.clear();
  glow.clear();
  ring.visible = state === 'buyable';
  cost.visible = state !== 'owned';

  if (state === 'owned') {
    glow.ellipse(0, NODE_S * 0.5, NODE_S * 2, NODE_S * 1.1).fill({ color: base, alpha: 0.2 });
    drawCube(g, NODE_S, 11, lighten(base, 0.3), base, darken(base, 0.38), 0xffffff, hot ? 0.9 : 0.45);
  } else if (state === 'locked') {
    drawCube(g, NODE_S, 2, 0x14202e, 0x0f1823, 0x0b121b, hot ? 0x8aa0b8 : 0x2a3b4e, 0.9);
  } else {
    const lift = state === 'buyable' ? 6 : 3;
    const f = state === 'buyable' ? 1 : 0.55;
    drawCube(
      g, NODE_S, lift,
      lighten(darken(base, 1 - f), 0.1), darken(base, 1 - f * 0.75), darken(base, 1 - f * 0.45),
      hot ? 0xffffff : base, 0.9,
    );
  }
  cost.position.set(0, -NODE_S / 2 - (state === 'owned' ? 11 : state === 'buyable' ? 6 : 2));
  cost.alpha = state === 'locked' ? 0.35 : 1;
}

// efeito ao comprar: o cubo "pula" e uma onda se espalha
function popNode(s) {
  const view = nodeViews.get(s.id);
  view.node.scale.set(1.5);
  tween(view.node, { scale: 1 }, 460, { ease: ease.back });
  const burst = new Graphics().circle(0, 0, 20).stroke({ width: 2, color: BRANCHES[s.branch].color });
  burst.position.set(view.node.x, view.node.y);
  nodeLayer.addChild(burst);
  tween(burst, { scale: 3.2, alpha: 0 }, 650, { onDone: () => burst.destroy() });
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
      .stroke({ width: on ? 3 : 1.5, color: on ? BRANCHES[s.branch].color : 0x2a3b4e, alpha: on ? 0.8 : 0.55 });
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
    linkG.stroke({ width: on ? 2.5 : 1.2, color: on ? BRANCHES[s.branch].color : 0x2a3b4e, alpha: on ? 0.7 : 0.4 });
  }
  for (const s of SKILLS) drawNode(s);

  for (const { b, label } of legendItems) {
    const mine = SKILLS.filter((s) => s.branch === BRANCHES.indexOf(b));
    const own = mine.filter((s) => skillsOwned.has(s.id)).length;
    label.text = `${b.name} ${own}/${mine.length}`;
  }
}

function hideTip() {
  tween(tip, { alpha: 0 }, 120, { onDone: () => { tip.visible = false; } });
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
    tipStatus.style.fill = T.good;
  } else if (state === 'locked') {
    tipStatus.text = `Requer: ${req.name}`;
    tipStatus.style.fill = T.warn;
  } else if (state === 'buyable') {
    tipStatus.text = `${touchUi ? 'Toque de novo para comprar' : 'Clique para comprar'} · ${s.cost} ponto${s.cost > 1 ? 's' : ''}`;
    tipStatus.style.fill = T.accent;
  } else {
    tipStatus.text = `Faltam ${s.cost - skillPointsFree()} ponto(s) · custa ${s.cost}`;
    tipStatus.style.fill = T.bad;
  }

  const W = 262;
  tipTag.position.set(18, 14);
  tipName.position.set(18, 30);
  tipDesc.position.set(18, 58);
  const sepY = 58 + tipDesc.height + 10;
  tipLine.clear().moveTo(18, sepY).lineTo(W - 18, sepY).stroke({ width: 1, color: 0xffffff, alpha: 0.08 });
  tipStatus.position.set(18, sepY + 10);
  const H = sepY + 10 + 18 + 14;

  drawCard(tipBg, W, H, { fill: C.panel, fillAlpha: 0.98, radius: 14, accent: base });

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
  if (!tip.visible) {
    tip.alpha = 0;
    tip.visible = true;
  }
  // sempre reanima: cancela um "esconder" pendente do nó anterior
  tween(tip, { alpha: 1 }, 140);
}

function buySkill(s) {
  const state = skillState(s);
  if (state === 'owned') return;
  if (state !== 'buyable') {
    if (state === 'available') sfx.deny();
    showTip(s);
    return;
  }
  sfx.skill();
  skillsOwned.add(s.id);
  recomputeMods();
  refreshTree();
  popNode(s);
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

  drawCard(treeBg, w, h, { fill: C.panel, fillAlpha: 0.98, radius: 24 });
  treeBg.roundRect(8, TREE_HEAD, w - 16, h - TREE_HEAD - TREE_FOOT, 16).fill({ color: C.deep, alpha: 0.85 });
  treeMask.clear().roundRect(8, TREE_HEAD, w - 16, h - TREE_HEAD - TREE_FOOT, 16).fill(0xffffff);

  if (narrow) {
    // cabeçalho em duas linhas: título + dica, depois pontos / refazer / fechar
    treeTitle.style.fontSize = 18;
    treeTitle.position.set(16, 10);
    hintText.style.fontSize = 11;
    hintText.style.wordWrap = true;
    hintText.style.wordWrapWidth = w - 32;
    hintText.position.set(16, 34);
    respecLabel.text = 'Refazer';
    fitButton(treeClose, 74, 32);
    fitButton(treeRespec, 90, 32);
    fitButton(pointsChip, 116, 32);
    treeClose.position.set(w - 12 - 74, 58);
    treeRespec.position.set(w - 12 - 74 - 8 - 90, 58);
    pointsChip.position.set(w - 12 - 74 - 8 - 90 - 8 - 116, 58);

    // legenda em 3 colunas x 2 linhas e botões de zoom embaixo
    const colW = Math.floor((w - 24) / 3);
    legendItems.forEach(({ label }, i) => {
      const item = label.parent;
      item.x = (i % 3) * colW;
      item.y = Math.floor(i / 3) * 22;
      label.style.fontSize = 11;
    });
    legend.position.set(16, h - TREE_FOOT + 20);
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

  treeTitle.style.fontSize = 20;
  treeTitle.position.set(24, compact ? 8 : 12);
  hintText.style.fontSize = 12;
  hintText.style.wordWrap = false;
  hintText.position.set(24, compact ? 33 : 38);
  respecLabel.text = 'Redistribuir';
  fitButton(treeClose, 92, 30);
  fitButton(treeRespec, 138, 30);
  fitButton(pointsChip, 170, 30);
  treeClose.position.set(w - 92 - 20, compact ? 10 : 15);
  treeRespec.position.set(w - 92 - 138 - 30, compact ? 10 : 15);
  pointsChip.position.set(w - 92 - 138 - 170 - 40, compact ? 10 : 15);

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

function resetTreeView(animate = false) {
  const { w, h } = treeSize;
  const viewH = h - TREE_HEAD - TREE_FOOT;
  const extentW = (R_MAX + 100) * 2;
  const extentH = (R_MAX + 100) * 2 * ISO;
  const fit = Math.min((w - 40) / extentW, (viewH - 10) / extentH);
  // em telas estreitas a árvore inteira ficaria minúscula: começa mais perto do núcleo
  const scale = w < 700 ? Math.max(fit, 0.6) : fit;
  const x = w / 2;
  const y = TREE_HEAD + viewH / 2;
  if (animate) {
    tween(world, { scale, x, y }, 360, { ease: ease.inOut });
  } else {
    cancelTweens(world);
    world.scale.set(scale);
    world.position.set(x, y);
  }
}

function zoomBy(factor) {
  const { w, h } = treeSize;
  const cx = w / 2;
  const cy = TREE_HEAD + (h - TREE_HEAD - TREE_FOOT) / 2;
  const old = world.scale.x;
  const next = Math.min(2.2, Math.max(0.2, old * factor));
  hideTip();
  tween(world, {
    scale: next,
    x: cx - (cx - world.x) * (next / old),
    y: cy - (cy - world.y) * (next / old),
  }, 240);
}
zoomIn.on('pointertap', () => zoomBy(1.3));
zoomOut.on('pointertap', () => zoomBy(1 / 1.3));
zoomFit.on('pointertap', () => resetTreeView(true));

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
  cancelTweens(world);
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
  clearSelection();
  pointers.clear();
  drag = null;
  pinch = null;
  if (open) {
    if (achPanel.visible) {
      cancelTweens(achPanel);
      achPanel.visible = false;
    }
    if (settingsPanel.visible) {
      cancelTweens(settingsPanel);
      settingsPanel.visible = false;
    }
    if (studioPanel.visible) {
      cancelTweens(studioPanel);
      studioPanel.visible = false;
    }
    cancelTweens(tree);
    tree.alpha = 1;
    layoutTree();
    resetTreeView();
    refreshTree();
    showModal(tree);
  } else if (tree.visible) {
    hideModal(tree);
  }
}

function toggleAchievements(open = !achPanel.visible) {
  if (open) {
    if (tree.visible) {
      cancelTweens(tree);
      tree.visible = false;
    }
    if (settingsPanel.visible) {
      cancelTweens(settingsPanel);
      settingsPanel.visible = false;
    }
    if (studioPanel.visible) {
      cancelTweens(studioPanel);
      studioPanel.visible = false;
    }
    cancelTweens(achPanel);
    layoutAch();
    showModal(achPanel);
  } else if (achPanel.visible) {
    hideModal(achPanel);
  }
}

achButton.on('pointertap', () => toggleAchievements());
achClose.on('pointertap', () => toggleAchievements(false));
skillButton.on('pointertap', () => toggleTree());

// ---------- Configurações ----------
const settingsPanel = new Container();
settingsPanel.visible = false;
settingsPanel.eventMode = 'static';
const setBg = new Graphics();
const setTitle = txt('Configurações', T.text, 19, true);
const setClose = labeledButton(84, 30, 'Fechar', C.warn, T.warn, 13);
settingsPanel.addChild(setBg, setTitle, setClose);
setClose.on('pointertap', () => toggleSettings(false));

// interruptor: a bolinha desliza e a trilha muda de cor
function makeSwitch(get, set) {
  const c = new Container();
  const track = new Graphics();
  const knob = new Graphics().circle(0, 0, 9).fill(0xffffff);
  knob.y = 12;
  c.addChild(track, knob);
  c.eventMode = 'static';
  c.cursor = 'pointer';
  c.hitArea = new Rectangle(-8, -8, 60, 40);
  c.paint = (animate = true) => {
    const on = get();
    track.clear().roundRect(0, 0, 44, 24, 12)
      .fill({ color: on ? C.good : 0xffffff, alpha: on ? 0.55 : 0.12 });
    if (animate) tween(knob, { x: on ? 32 : 12 }, 160);
    else knob.x = on ? 32 : 12;
  };
  c.on('pointertap', () => {
    set(!get());
    c.paint();
    sfx.tick();
  });
  c.paint(false);
  return c;
}

const settingRows = [];
const SLIDER_W = 300;

function addToggleRow(label, hint, key, onSet) {
  const title = txt(label, T.text, 15);
  const sub = txt(hint, T.faint, 12);
  const sw = makeSwitch(() => settings[key], (v) => { setSetting(key, v); onSet?.(v); });
  settingsPanel.addChild(title, sub, sw);
  settingRows.push({ type: 'toggle', title, sub, sw, height: 56 });
}

// slider arrastável (0..1) ligado a uma configuração
function addSliderRow(label, key, onChange, previewSound = false) {
  const title = txt(label, T.text, 15);
  const value = txt('', T.dim, 13);
  const track = new Container();
  const bar = new Graphics();
  const knob = new Graphics().circle(0, 0, 10).fill(0xffffff);
  track.addChild(bar, knob);
  track.eventMode = 'static';
  track.cursor = 'pointer';
  track.hitArea = new Rectangle(-12, -16, SLIDER_W + 24, 32);
  settingsPanel.addChild(title, value, track);

  const row = { type: 'slider', title, value, track, height: 76 };
  row.paint = () => {
    const v = settings[key];
    bar.clear()
      .roundRect(0, -2, SLIDER_W, 4, 2).fill({ color: 0xffffff, alpha: 0.14 })
      .roundRect(0, -2, Math.max(4, SLIDER_W * v), 4, 2).fill(C.accent);
    knob.x = SLIDER_W * v;
    value.text = `${Math.round(v * 100)}%`;
  };
  let dragging = false;
  const setFrom = (gx) => {
    const lx = track.toLocal({ x: gx, y: 0 }).x;
    setSetting(key, Math.min(1, Math.max(0, lx / SLIDER_W)));
    onChange?.();
    row.paint();
  };
  track.on('pointerdown', (e) => {
    dragging = true;
    unlockAudio();
    setFrom(e.global.x);
  });
  app.stage.on('pointermove', (e) => { if (dragging) setFrom(e.global.x); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (previewSound) sfx.click();
  };
  app.stage.on('pointerup', end);
  app.stage.on('pointerupoutside', end);
  settingRows.push(row);
}

addToggleRow('Efeitos sonoros', 'Cliques, compras e conquistas', 'sound', (v) => { if (v) unlockAudio(); applyVolume(); });
addSliderRow('Volume dos efeitos', 'volume', applyVolume, true);
addToggleRow('Música', 'Trilha de fundo em loop', 'music', (v) => {
  if (v) {
    unlockAudio();
    startMusic();
  } else {
    stopMusic();
  }
});
addSliderRow('Volume da música', 'musicVolume', updateMusicVolume);
addToggleRow('Animações e partículas', 'Ondas e partículas decorativas', 'motion');
addToggleRow('Vibração', 'Toques curtos no celular', 'haptics');

const resetRow = labeledButton(340, 38, 'Apagar progresso e recomeçar', C.bad, T.bad, 13);
settingsPanel.addChild(resetRow);
resetRow.on('pointertap', resetGame);

function layoutSettings() {
  const { width, height } = app.screen;
  const w = Math.min(420, width - 24);
  for (const r of settingRows) r.paint?.();   // atualiza textos antes de medir
  let y = 64;
  for (const r of settingRows) {
    if (r.type === 'toggle') {
      r.title.position.set(24, y + 8);
      r.sub.position.set(24, y + 30);
      r.sw.position.set(w - 24 - 44, y + 14);
    } else {
      r.title.position.set(24, y + 8);
      r.value.position.set(w - 24 - r.value.width, y + 9);
      r.track.scale.x = (w - 48 - 20) / SLIDER_W;
      r.track.position.set(24 + 10, y + 50);
    }
    y += r.height;
  }
  y += 8;
  fitButton(resetRow, w - 48, 38);
  resetRow.position.set(24, y);
  y += 38 + 22;
  const h = y;

  drawCard(setBg, w, h, { fill: C.panel, fillAlpha: 0.98, radius: 24 });
  setTitle.position.set(24, 20);
  setClose.position.set(w - 84 - 20, 16);
  // em telas baixas (celular deitado) o painel encolhe para caber
  const fit = Math.min(1, (height - 16) / h);
  settingsPanel.scale.set(fit);
  settingsPanel.position.set((width - w * fit) / 2, (height - h * fit) / 2);
  for (const r of settingRows) r.sw?.paint(false);
}

function toggleSettings(open = !settingsPanel.visible) {
  if (open) {
    if (tree.visible) {
      cancelTweens(tree);
      tree.visible = false;
    }
    if (achPanel.visible) {
      cancelTweens(achPanel);
      achPanel.visible = false;
    }
    if (studioPanel.visible) {
      cancelTweens(studioPanel);
      studioPanel.visible = false;
    }
    cancelTweens(settingsPanel);
    layoutSettings();
    showModal(settingsPanel);
  } else if (settingsPanel.visible) {
    hideModal(settingsPanel);
  }
}

// botão de engrenagem (canto superior direito); gira ao passar o mouse
const gearBtn = makeButton(36, 36, { tint: C.accent, radius: 18, alpha: 0.06 });
const gearIcon = new Graphics();
gearIcon.circle(0, 0, 7.5).stroke({ width: 3, color: 0xeef5fb, alpha: 0.9 });
for (let i = 0; i < 8; i++) {
  const a = (i * Math.PI) / 4;
  gearIcon.moveTo(Math.cos(a) * 8.5, Math.sin(a) * 8.5).lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
}
gearIcon.stroke({ width: 3.2, color: 0xeef5fb, alpha: 0.9 });
gearIcon.circle(0, 0, 2.5).fill({ color: 0xeef5fb, alpha: 0.9 });
gearIcon.position.set(18, 18);
gearBtn.addChild(gearIcon);
gearBtn.on('pointerover', () => tween(gearIcon, { rotation: Math.PI / 2 }, 600));
gearBtn.on('pointerout', () => tween(gearIcon, { rotation: 0 }, 600));
gearBtn.on('pointertap', () => toggleSettings());
app.stage.addChild(gearBtn);

onSettingsChange((key) => {
  if (key === 'sound' || key === 'volume') applyVolume();
});

// ---------- Estúdio: janela com as mecânicas extras ----------
const STUDIO_TABS = ['Desafios', 'Pesquisa', 'Jogos', 'Missões', 'Mercado', 'Gerentes', 'Visuais', 'Ascensão'];
const stIndex = Object.fromEntries(STUDIO_TABS.map((n, i) => [n, i]));
let studioTab = 0;
let stW = 520;

const studioPanel = new Container();
studioPanel.visible = false;
studioPanel.eventMode = 'static';
const stBg = new Graphics();
const stTitle = txt('Estúdio', T.text, 19, true);
const stClose = labeledButton(84, 30, 'Fechar', C.warn, T.warn, 13);
const stInfo = txt('', T.dim, 12);
stInfo.style.wordWrap = true;
stInfo.eventMode = 'none';
const stScroll = createScroll(460);
const stPills = STUDIO_TABS.map((name, i) => {
  const b = labeledButton(100, 28, name, C.accent, T.dim, 12, 0.05);
  b.on('pointertap', () => { if (!uiMoved) setStudioTab(i); });
  return b;
});
studioPanel.addChild(stBg, stTitle, stClose, ...stPills, stInfo, stScroll.root);
stClose.on('pointertap', () => toggleStudio(false));

const studioRows = [];

// cada linha: { get() -> {title, sub, right, rc, p, accent, dim, on}, tap() }
function addStudioRow(tab, spec) {
  const c = new Container();
  const bg = new Graphics();
  const bar = new Graphics();
  const title = txt('', T.text, 14, true);
  title.position.set(16, 9);
  const sub = txt('', T.dim, 11.5);
  sub.style.wordWrap = true;
  sub.position.set(16, 29);
  const right = txt('', T.accent, 13, true);
  right.anchor.set(1, 0);
  c.addChild(bg, bar, title, sub, right);
  c.eventMode = 'static';
  c.cursor = 'pointer';
  c.on('pointertap', () => {
    if (uiMoved || !spec.tap) return;
    spec.tap();
    refreshStudio();
  });
  c.visible = stIndex[tab] === studioTab;
  stScroll.add(c, 64);
  studioRows.push({ tab: stIndex[tab], c, bg, bar, title, sub, right, spec, key: '', w: 440, h: 64 });
}

const pct = (x) => `${Math.round(x * 100)}%`;
const ago = (t) => fmtTime((t - Date.now()) / 1000);

// ----- Desafios -----
for (const def of CHALLENGES) {
  addStudioRow('Desafios', {
    get() {
      const done = challengesDone.has(def.id);
      const active = challenge?.id === def.id;
      const locked = playerLevel() < CHALLENGE_MIN_LEVEL;
      let sub = `${def.rule} Meta: ${format(def.goal)} bits · prêmio: +${pct(def.reward)} de produção${def.limitS ? ` · ${def.limitS / 60} min` : ''}`;
      let p = null;
      if (active) {
        p = challenge.bits / def.goal;
        sub = `${def.rule} ${format(challenge.bits)} / ${format(def.goal)} bits${def.limitS ? ` · restam ${fmtTime(def.limitS - (Date.now() - challenge.startedAt) / 1000)}` : ''}`;
      }
      return {
        title: def.name + (done ? '  ✓' : ''), sub, p,
        right: active ? 'Desistir' : done ? 'Feito' : locked ? `Nv ${CHALLENGE_MIN_LEVEL}` : challenge ? '—' : 'Iniciar',
        rc: active ? T.bad : done ? T.good : locked || challenge ? T.faint : T.warn,
        accent: done ? C.good : active ? C.warn : null, dim: !active && (locked || !!challenge) && !done,
      };
    },
    tap() {
      if (challenge?.id === def.id) {
        if (confirm('Desistir do desafio? Sua corrida de antes volta, sem o prêmio.')) endChallenge(false, 'você desistiu');
      } else if (challengesDone.has(def.id)) {
        toast('Esse desafio já foi vencido', '#9db2c6');
      } else if (challenge) {
        toast('Termine ou abandone o desafio atual', '#ff8a8a');
      } else {
        startChallenge(def.id);
      }
    },
  });
}

// ----- Pesquisa -----
for (const r of RESEARCH) {
  addStudioRow('Pesquisa', {
    get() {
      const done = research.done.has(r.id);
      const active = research.active?.id === r.id;
      const busy = !!research.active && !active;
      const afford = bits >= r.cost;
      return {
        title: r.name + (done ? '  ✓' : ''),
        sub: `${r.desc} · leva ${fmtTime(r.time)}`,
        p: active ? 1 - (research.active.endsAt - Date.now()) / (r.time * 1000) : null,
        right: done ? 'Feito' : active ? ago(research.active.endsAt) : format(r.cost),
        rc: done ? T.good : active ? T.accent : afford && !busy ? T.warn : T.faint,
        accent: done ? C.good : active ? C.accent : null, dim: busy && !done,
      };
    },
    tap() {
      if (research.done.has(r.id)) return;
      if (research.active) toast('Uma pesquisa por vez', '#ff8a8a');
      else startResearch(r.id);
    },
  });
}

// ----- Jogos (projetos) -----
for (const p of PROJECTS) {
  addStudioRow('Jogos', {
    get() {
      const st = projects[p.id];
      const done = st?.state === 'done';
      const running = st?.state === 'running';
      return {
        title: p.name + (done ? '  ✓ lançado' : ''),
        sub: `${p.desc} Produção +${pct(p.mult)} e visual do cubo · leva ${fmtTime(p.time)}`,
        p: running ? 1 - (st.endsAt - Date.now()) / (p.time * 1000) : null,
        right: done ? 'Lançado' : running ? ago(st.endsAt) : format(p.cost),
        rc: done ? T.good : running ? T.accent : bits >= p.cost ? T.warn : T.faint,
        accent: done ? C.good : running ? C.accent : null,
      };
    },
    tap() { if (!projects[p.id]) startProject(p.id); },
  });
}

// ----- Missões -----
for (let i = 0; i < 3; i++) {
  addStudioRow('Missões', {
    get() {
      const m = daily.missions[i];
      if (!m) return { title: '—', sub: '' };
      const label = MISSION_TYPES[m.type].label(m.type === 'earn' ? format(m.target) : m.target);
      const prog = missionProgress(m);
      const ready = prog >= m.target;
      return {
        title: label + (m.claimed ? '  ✓' : ''),
        sub: `${m.type === 'earn' ? format(prog) : Math.floor(prog)} / ${m.type === 'earn' ? format(m.target) : m.target} · prêmio: bits e 2 fragmentos`,
        p: m.claimed ? null : prog / m.target,
        right: m.claimed ? 'Feito' : ready ? 'Resgatar' : '',
        rc: m.claimed ? T.good : T.warn,
        accent: m.claimed ? C.good : ready ? C.warn : null, dim: false,
      };
    },
    tap() { claimMission(i); },
  });
}

// ----- Mercado -----
addStudioRow('Mercado', {
  get() {
    const on = market.endsAt > Date.now();
    return {
      title: on ? market.label : proposal ? proposal.title : 'Mercado estável',
      sub: on ? `Termina em ${ago(market.endsAt)}` : proposal ? 'Decida no cartão que apareceu na tela.' : 'De tempos em tempos acontece algo: booms, crises, investidores e fãs.',
      right: on ? ago(market.endsAt) : '',
      rc: market.mult >= 1 ? T.good : T.bad,
      accent: on ? (market.mult >= 1 ? C.good : C.bad) : null,
    };
  },
});
addStudioRow('Mercado', {
  get() {
    return {
      title: 'Como funciona',
      sub: `A cada ${Math.round(MARKET.minGapS / 60)}–${Math.round(MARKET.maxGapS / 60)} min (a partir do nível 6) chega um evento. Algumas propostas pedem uma escolha em ${MARKET.proposalS}s; se você não responder, vale a opção segura.`,
    };
  },
});

// ----- Gerentes -----
addStudioRow('Gerentes', {
  get() {
    return {
      title: 'Gerentes automáticos',
      sub: `Compram upgrades sozinhos quando o custo é até ${pct(MANAGER_SPEND)} dos seus bits.`,
      right: managers.master ? 'Ligado' : 'Desligado',
      rc: managers.master ? T.good : T.faint,
      accent: managers.master ? C.good : null,
    };
  },
  tap() { managers.master = !managers.master; sfx.tick(); save(); },
});
for (const m of MANAGERS) {
  addStudioRow('Gerentes', {
    get() {
      const hired = managers.hired.has(m.id);
      const off = managers.off.has(m.id);
      const locked = playerLevel() < m.level;
      return {
        title: m.name,
        sub: hired ? `Compra ${byId(m.id).name} automaticamente. Toque para ligar/desligar.` : `Contrata-se uma vez. Libera no nível ${m.level}.`,
        right: hired ? (off ? 'Desligado' : 'Ligado') : locked ? `Nv ${m.level}` : format(m.cost),
        rc: hired ? (off ? T.faint : T.good) : locked ? T.faint : bits >= m.cost ? T.warn : T.faint,
        accent: hired && !off ? C.good : null, dim: !hired && locked,
      };
    },
    tap() {
      if (managers.hired.has(m.id)) {
        if (managers.off.has(m.id)) managers.off.delete(m.id);
        else managers.off.add(m.id);
        sfx.tick();
        save();
      } else {
        hireManager(m.id);
      }
    },
  });
}

// ----- Visuais -----
for (const s of SKINS) {
  addStudioRow('Visuais', {
    get() {
      const owned = skinUnlocked(s);
      const proj = s.project ? PROJECTS.find((p) => p.id === s.project) : null;
      return {
        title: s.name,
        sub: owned ? 'Cor do cubo e do pedestal.' : proj ? `Lance o jogo ${proj.name} para liberar.` : `Custa ${s.cost} fragmentos (vêm dos bits dourados e das missões).`,
        right: skinId === s.id ? 'Em uso' : owned ? 'Usar' : proj ? 'Bloqueado' : `${s.cost} fr.`,
        rc: skinId === s.id ? T.good : owned ? T.accent : !proj && fragments >= s.cost ? T.warn : T.faint,
        accent: s.rim, on: skinId === s.id, dim: !owned && (!!proj || fragments < s.cost),
      };
    },
    tap() {
      const s0 = s;
      if (!skinUnlocked(s0) && s0.project) toast('Lance o jogo para liberar esse visual', '#9db2c6');
      else buyOrEquipSkin(s0.id);
    },
  });
}

// ----- Ascensão -----
addStudioRow('Ascensão', {
  get() {
    return {
      title: `Núcleos: ${cores} · produção ×${coreMult(cores).toFixed(2)}`,
      sub: `Você ascendeu ${ascensions} vez(es). Cada núcleo vale mais que um chip, e fica para sempre.`,
      accent: C.evo,
    };
  },
});
addStudioRow('Ascensão', {
  get() {
    const gain = ascendGain(chips);
    const ok = chips >= ASCEND_MIN_CHIPS && gain >= 1;
    return {
      title: 'Ascender',
      sub: ok
        ? `Troca seus ${chips} chips por ${gain} núcleo(s): ×${coreMult(cores).toFixed(2)} → ×${coreMult(cores + gain).toFixed(2)}. Reinicia bits, upgrades e chips.`
        : `Precisa de ${ASCEND_MIN_CHIPS} chips (você tem ${chips}). Evolua várias vezes para juntar.`,
      right: ok ? `+${gain} núcleo(s)` : `${chips}/${ASCEND_MIN_CHIPS}`,
      rc: ok ? T.warn : T.faint, accent: ok ? C.evo : null, dim: !ok,
    };
  },
  tap() { ascend(); },
});

const STUDIO_INFO = [
  () => `Regras especiais com prêmio permanente. Libera no nível ${CHALLENGE_MIN_LEVEL}. Sua corrida fica guardada enquanto você joga.`,
  () => 'Um projeto por vez, em tempo real: continua rodando com o jogo fechado.',
  () => 'Lance os jogos da Scorpion Bits: bônus de produção e visuais novos para o cubo.',
  () => `Fragmentos: ${fragments} · as missões mudam todo dia.`,
  () => `Eventos de mercado${market.endsAt > Date.now() ? ': ' + market.label : ''}.`,
  () => `Contrate gerentes para automatizar as compras. Gerentes ativos: ${[...managers.hired].filter((id) => !managers.off.has(id)).length}/${MANAGERS.length}.`,
  () => `Fragmentos: ${fragments} · mudam só a cor, sem efeito na produção.`,
  () => `Segunda camada de evolução. Chips agora: ${chips}.`,
];

function refreshStudio() {
  stInfo.text = STUDIO_INFO[studioTab]();
  for (const r of studioRows) {
    if (r.tab !== studioTab) continue;
    const s = r.spec.get();
    const key = [s.title, s.sub, s.right, s.rc, s.accent, s.on, s.dim, r.w].join('|');
    if (key !== r.key) {
      r.key = key;
      r.title.text = s.title;
      r.sub.text = s.sub ?? '';
      r.right.text = s.right ?? '';
      r.right.style.fill = s.rc ?? T.accent;
      const a = s.dim ? 0.5 : 1;
      r.title.alpha = r.sub.alpha = r.right.alpha = a;
      drawCard(r.bg, r.w, r.h, { fill: C.card, shadow: false, radius: 12, accent: s.accent ?? null, borderAlpha: s.on ? 0.22 : 0.07 });
    }
    r.bar.clear();
    if (s.p !== null && s.p !== undefined) {
      const p = Math.min(1, Math.max(0, s.p));
      r.bar.roundRect(16, r.h - 9, r.w - 32, 3, 1.5).fill({ color: 0xffffff, alpha: 0.08 })
        .roundRect(16, r.h - 9, Math.max(3, (r.w - 32) * p), 3, 1.5).fill(C.accent);
    }
  }
  stPills.forEach((b, i) => b.setActive(i === studioTab));
}

function setStudioTab(i) {
  if (i === studioTab) return;
  studioTab = i;
  sfx.tick();
  for (const r of studioRows) r.c.visible = r.tab === i;
  stScroll.scrollY = 0;
  layoutStudio();
  refreshStudio();
  stScroll.playIn(1);
}

function layoutStudio() {
  const { width, height } = app.screen;
  const narrow = width < 760;
  const w = Math.min(520, width - (narrow ? 12 : 24));
  const rowW = w - 48;
  stW = w;
  const rowH = narrow ? 80 : 64;
  const perRow = 4;
  const gap = 6;
  const pillW = Math.floor((rowW - gap * (perRow - 1)) / perRow);
  const pillsTop = 58;
  stPills.forEach((b, i) => {
    fitButton(b, pillW, 28);
    b.labelObj.style.fontSize = narrow ? 11 : 12;
    b.position.set(24 + (i % perRow) * (pillW + gap), pillsTop + Math.floor(i / perRow) * 34);
  });
  const infoTop = pillsTop + 74;
  stInfo.style.wordWrapWidth = rowW;
  stInfo.position.set(24, infoTop);
  stInfo.text = STUDIO_INFO[studioTab]();
  const scrollTop = infoTop + Math.max(18, stInfo.height) + 8;

  for (const r of studioRows) {
    r.w = rowW;
    r.h = rowH;
    r.key = '';
    r.sub.style.wordWrapWidth = rowW - 32 - (narrow ? 70 : 96);
    r.right.position.set(rowW - 14, 10);
    r.c.hitArea = new Rectangle(0, 0, rowW, rowH);
  }
  for (const it of stScroll.items) it.h = rowH;
  stScroll.width = rowW;
  stScroll.relayout();
  const maxView = height - (narrow ? 12 : 24) - scrollTop - 16;
  const viewH = Math.max(100, Math.min(stScroll.contentH, 470, maxView));
  const h = scrollTop + viewH + 16;
  drawCard(stBg, w, h, { fill: C.panel, fillAlpha: 0.98, radius: 24 });
  stTitle.position.set(24, narrow ? 18 : 20);
  stTitle.style.fontSize = narrow ? 16 : 19;
  stClose.position.set(w - 84 - 20, 16);
  stScroll.root.position.set(24, scrollTop);
  stScroll.resize(viewH, rowW);
  stScroll.studioTop = scrollTop;
  stH = h;
  studioPanel.position.set((width - w) / 2, Math.max(6, (height - h) / 2));
  refreshStudio();
}
let stH = 400;

function toggleStudio(open = !studioPanel.visible) {
  if (open) {
    for (const p of [tree, achPanel, settingsPanel]) {
      if (p.visible) { cancelTweens(p); p.visible = false; }
    }
    cancelTweens(studioPanel);
    layoutStudio();
    showModal(studioPanel);
    stScroll.playIn(1);
  } else if (studioPanel.visible) {
    hideModal(studioPanel);
  }
}

// botão do Estúdio (ao lado da engrenagem) com um ponto de aviso
const studioBtn = makeButton(36, 36, { tint: C.accent, radius: 18, alpha: 0.06 });
const studioIcon = new Graphics();
studioIcon.poly([0, -10, 9, -5, 0, 0, -9, -5]).fill(0xeef5fb);
studioIcon.poly([-9, -5, 0, 0, 0, 10, -9, 5]).fill({ color: 0xeef5fb, alpha: 0.55 });
studioIcon.poly([9, -5, 0, 0, 0, 10, 9, 5]).fill({ color: 0xeef5fb, alpha: 0.3 });
studioIcon.position.set(18, 18);
studioBtn.addChild(studioIcon);
studioBtn.on('pointertap', () => toggleStudio());
const studioDot = new Graphics().circle(0, 0, 4.5).fill(C.warn);
studioDot.position.set(30, 6);
studioDot.visible = false;
studioBtn.addChild(studioDot);
app.stage.addChild(studioBtn);

function updateStudioDot() {
  studioDot.visible = !!proposal || daily.missions.some((m) => !m.claimed && missionProgress(m) >= m.target);
}

// ---------- Proposta de mercado (cartão flutuante) ----------
const propCard = new Container();
propCard.visible = false;
const propBg = new Graphics();
const propTitle = txt('', T.text, 15, true);
const propText = txt('', T.dim, 12);
propText.style.wordWrap = true;
const propBarG = new Graphics();
const propA = labeledButton(150, 32, '', C.good, T.good, 13, 0.1);
const propB = labeledButton(150, 32, '', C.warn, T.warn, 13, 0.1);
propCard.addChild(propBg, propTitle, propText, propBarG, propA, propB);
propA.on('pointertap', () => { if (!uiMoved) resolveProposal('a'); });
propB.on('pointertap', () => { if (!uiMoved) resolveProposal('b'); });
app.stage.addChild(propCard);
let shownProposal = null;
let propW = 340;
let propH = 150;

function layoutProposal() {
  const { width, height } = app.screen;
  propW = Math.min(360, width - 20);
  propText.style.wordWrapWidth = propW - 32;
  propTitle.position.set(16, 12);
  propText.position.set(16, 36);
  const textBottom = 36 + propText.height;
  const bw = Math.floor((propW - 32 - 10) / 2);
  fitButton(propA, bw, 32);
  fitButton(propB, bw, 32);
  propA.position.set(16, textBottom + 12);
  propB.position.set(16 + bw + 10, textBottom + 12);
  propH = textBottom + 12 + 32 + 20;
  drawCard(propBg, propW, propH, { fill: C.panel, fillAlpha: 0.97, radius: 18, borderAlpha: 0.14 });
  propCard.x = (width - propW) / 2;
  propCard.y = Math.max(hudBottom + 8, ctrlTop - propH - 34);
}

function updateProposal() {
  if (proposal !== shownProposal) {
    shownProposal = proposal;
    if (proposal) {
      propTitle.text = proposal.title;
      propText.text = proposal.text;
      propA.labelObj.text = proposal.a.label;
      propB.labelObj.text = proposal.b.label;
      layoutProposal();
      propCard.visible = true;
      propCard.alpha = 0;
      const y = propCard.y;
      propCard.y = y + 16;
      tween(propCard, { alpha: 1, y }, 320);
    } else {
      propCard.visible = false;
    }
  }
  if (proposal) {
    const left = Math.max(0, (proposal.expiresAt - Date.now()) / (MARKET.proposalS * 1000));
    propBarG.clear().roundRect(16, propH - 12, propW - 32, 3, 1.5).fill({ color: 0xffffff, alpha: 0.08 })
      .roundRect(16, propH - 12, Math.max(2, (propW - 32) * left), 3, 1.5).fill(C.warn);
  }
}

// ---------- HUD extra: combo e linha de status ----------
const statusText = txt('', T.warn, 12, true);
statusText.anchor.set(0.5, 0);
const comboText = txt('', T.accent, 13, true);
comboText.anchor.set(0.5, 0);
const comboBar = new Graphics();
app.stage.addChild(statusText, comboText, comboBar);
for (const el of [statusText, comboText, comboBar]) el.eventMode = 'none';
let comboShown = -1;

function updateHud() {
  const rem = (t) => ago(t);
  let line = '';
  let color = T.warn;
  if (challenge) {
    const def = challengeRule();
    line = `Desafio · ${def.name} · ${format(challenge.bits)} / ${format(def.goal)}`;
    if (def.limitS) line += ` · ${fmtTime(def.limitS - (Date.now() - challenge.startedAt) / 1000)}`;
  } else if (market.endsAt > Date.now()) {
    line = `${market.label} · ${rem(market.endsAt)}`;
    color = market.mult >= 1 ? T.good : T.bad;
  }
  statusText.text = line;
  statusText.style.fill = color;

  const m = Math.round(combo.meter);
  if (m !== comboShown) {
    comboShown = m;
    comboText.text = m >= 1 ? `Combo ×${comboMult().toFixed(2)}` : '';
    comboBar.clear();
    if (m >= 1) {
      const w = 140;
      const x = app.screen.width / 2 - w / 2;
      const y = ctrlTop - 6;
      comboBar.roundRect(x, y, w, 4, 2).fill({ color: 0xffffff, alpha: 0.08 })
        .roundRect(x, y, Math.max(4, w * (m / 100)), 4, 2).fill(m >= 100 ? C.warn : C.accent);
    }
  }
}

// ---------- Visuais: cor do cubo (filtro de matiz) e do pedestal ----------
const skinFilter = new ColorMatrixFilter();

function paintSkinFilter(cycleDeg = 0) {
  const s = skinDef();
  skinFilter.reset();
  skinFilter.hue(s.cycle ? cycleDeg : s.hue, false);
  if (s.saturate) skinFilter.saturate(s.saturate, true);
  if (s.gray) skinFilter.greyscale(0.5, true);
}

function applySkin() {
  const s = skinDef();
  if (!s.hue && !s.saturate && !s.gray && !s.cycle) {
    cube.filters = null;
  } else {
    paintSkinFilter(0);
    cube.filters = [skinFilter];
  }
  drawPedestal();
  drawHalo();
}


app.stage.addChild(dim, achPanel, tree, settingsPanel, studioPanel);

// ---------- Avisos (toasts): pílulas suaves que descem e somem ----------
const toastLayer = new Container();
toastLayer.eventMode = 'none';
app.stage.addChild(toastLayer);
const toasts = [];

function toast(message, fill = '#ffc46b') {
  const dotColor = parseInt(fill.slice(1), 16);
  const size = layoutMode === 'desktop' ? 14 : 13;
  const label = txt(message, T.text, size, true);
  label.style.wordWrap = true;
  label.style.wordWrapWidth = Math.max(160, app.screen.width - 90);
  const h = Math.round(label.height + 18);
  const w = Math.round(label.width + 44);
  const c = new Container();
  const bg = new Graphics();
  drawCard(bg, w, h, { fill: C.panel, fillAlpha: 0.95, radius: h / 2, borderAlpha: 0.1 });
  bg.circle(18, h / 2, 4).fill(dotColor);
  label.position.set(32, 9);
  c.addChild(bg, label);
  c.alpha = 0;
  c.x = (app.screen.width - w) / 2;
  c.y = hudBottom - 10;
  toastLayer.addChild(c);

  toasts.push({ c, w, h, life: 0 });
  // no máximo 4 ao mesmo tempo: o mais antigo sai logo
  if (toasts.length > 4) toasts[0].life = Math.max(toasts[0].life, 2900);
}

function updateToasts(dt) {
  let y = hudBottom + 4;
  for (let i = 0; i < toasts.length; i++) {
    const t = toasts[i];
    t.life += dt;
    const fadeIn = Math.min(1, t.life / 260);
    const fadeOut = t.life > 2900 ? Math.max(0, 1 - (t.life - 2900) / 420) : 1;
    t.c.alpha = ease.out(fadeIn) * fadeOut;
    t.c.x = (app.screen.width - t.w) / 2;
    t.c.y += (y - t.c.y) * (1 - Math.exp(-dt / 90));
    y += t.h + 8;
    if (t.life >= 3320) {
      toastLayer.removeChild(t.c);
      t.c.destroy({ children: true });
      toasts.splice(i, 1);
      i--;
    }
  }
}

// ---------- Rolagem: roda do mouse (desktop) e arrasto (toque) ----------
const canvasPoint = (e) => {
  const rect = app.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};

// qual área rolável está sob o ponto (gaveta ativa ou painel de conquistas)
function scrollTargetAt(px, py) {
  if (tree.visible || settingsPanel.visible) return null;
  if (studioPanel.visible) {
    const top = studioPanel.y + (stScroll.studioTop ?? 150);
    const inside = px >= studioPanel.x && px <= studioPanel.x + stW && py >= top && py <= top + stScroll.viewH;
    return inside ? stScroll : null;
  }
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
    cancelTweens(world);
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
  unlockAudio();
  startMusic();
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
  name.style.fontSize = compact ? 12 : 14;
  status.style.fontSize = compact ? 10 : 12;
  name.position.set(compact ? 10 : 12, compact ? 4 : 5);
  status.position.set(compact ? 10 : 12, compact ? 20 : 25);
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
    counter.style.fontSize = 36; counter.position.set(cx, 8);
    bpsText.style.fontSize = 17; bpsText.position.set(cx, 52);
    metaText.style.fontSize = 12; metaText.position.set(cx, 76);
    frenzyText.style.fontSize = 14; frenzyText.position.set(cx, 108);
    statusText.position.set(cx, 126);
    xpLayout = { y: 94, w: Math.min(220, width - 40) };
    hudBottom = 146;
  } else if (landscape) {
    counter.style.fontSize = 28; counter.position.set(cx, 4);
    bpsText.style.fontSize = 15; bpsText.position.set(cx, 38);
    metaText.style.fontSize = 12; metaText.position.set(cx, 58);
    frenzyText.style.fontSize = 13; frenzyText.position.set(cx, 86);
    statusText.position.set(cx, 102);
    xpLayout = { y: 76, w: 200 };
    hudBottom = 120;
  } else {
    counter.style.fontSize = 46; counter.position.set(cx, 14);
    bpsText.style.fontSize = 20; bpsText.position.set(cx, 72);
    metaText.style.fontSize = 14; metaText.position.set(cx, 100);
    frenzyText.style.fontSize = 18; frenzyText.position.set(cx, 140);
    statusText.position.set(cx, 164);
    xpLayout = { y: 126, w: 240 };
    hudBottom = 180;
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
    bts.forEach((bt, i) => { fitBottom(bt, 160, 40, 14); bt.btn.position.set(cx - 250 + i * 170, height - 62); });
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
  const labelSize = landscape || (portrait && handleH < 96) ? 12 : portrait ? 13 : 14;
  leftDock.configure({ handleH, handleTop: portrait ? 24 : landscape ? 12 : 24, labelSize });
  // em celular em pé as abas dos dois lados não podem se sobrepor: a direita fica mais embaixo
  rightDock.configure({
    handleH,
    handleTop: portrait ? 24 + 2 * (handleH + 10) + 20 : landscape ? 12 : 24,
    labelSize,
  });
  const dockBottom = portrait || landscape ? ctrlTop - 6 : height - 14;
  leftDock.layout(width, height, top, dockBottom);
  rightDock.layout(width, height, top, dockBottom);

  gearBtn.position.set(width - 36 - (portrait ? 10 : 16), portrait || landscape ? 8 : 14);
  studioBtn.position.set(gearBtn.x - 44, gearBtn.y);
  comboText.position.set(cx, ctrlTop - 24);
  comboShown = -1;
  if (proposal) layoutProposal();
  if (studioPanel.visible) layoutStudio();

  drawBackground();
  drawPedestal();
  drawHalo();
  if (achPanel.visible) layoutAch();
  if (tree.visible) layoutTree();
  if (dim.visible) dim.clear().rect(0, 0, width, height).fill(0x03060b);
}

// com pouca largura só uma gaveta pode ficar aberta (senão uma cobre a outra)
const exclusiveDocks = () => app.screen.width < 980;
for (const [dock, other] of [[leftDock, rightDock], [rightDock, leftDock]]) {
  const select = dock.select;
  dock.select = (i) => {
    select(i);
    if (dock.open) sfx.tick();
    else sfx.close();
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
  const { fill = T.accent, size = 22, duration = 900, speed = 0.06 } = opts;
  const text = txt(message, fill, size, true);
  text.anchor.set(0.5);
  text.eventMode = 'none';
  text.position.set(x, y);
  text.scale.set(0.7);
  tween(text, { scale: 1 }, 260, { ease: ease.back });
  // entra logo abaixo das janelas, que ficam sempre na frente
  app.stage.addChildAt(text, app.stage.getChildIndex(dim));
  floaters.push({ text, life: 0, duration, speed });
}

function spawnParticles(x, y) {
  if (!settings.motion) return;
  for (let i = 0; i < 7; i++) {
    const g = new Graphics()
      .circle(0, 0, 2 + Math.random() * 2.5)
      .fill(i % 2 ? C.accent : C.evo);
    g.eventMode = 'none';
    g.position.set(x, y);
    app.stage.addChildAt(g, app.stage.getChildIndex(dim));

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.06 + Math.random() * 0.16;
    particles.push({ g, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0 });
  }
}

const PARTICLE_LIFE = 650;

// ---------- Bit dourado ----------
let golden = null;
const nextGoldenDelay = () =>
  (GOLDEN_MIN_MS + Math.random() * (GOLDEN_MAX_MS - GOLDEN_MIN_MS)) * mods.goldenFreq * fx.golden;
let goldenTimer = nextGoldenDelay();

function spawnGolden() {
  if (golden || ruleId() === 'nogold') return;
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.tint = C.warn;
  const goldenScale = 80 / texture.height;
  sprite.scale.set(0.01);
  tween(sprite, { scale: goldenScale }, 420, { ease: ease.back });

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
  app.stage.addChildAt(sprite, app.stage.getChildIndex(dim));
  golden = { sprite, life: 0 };
  sfx.goldenSpawn();
}

function removeGolden() {
  if (!golden) return;
  const { sprite } = golden;
  golden = null;
  tween(sprite, { scale: 0.01, alpha: 0 }, 260, { onDone: () => sprite.destroy() });
}

function collectGolden() {
  if (!golden) return;
  goldenClicks++;
  fragments++;
  trackDaily('golden');
  sfx.goldenCollect();
  haptic(15);
  if (Math.random() < 0.5) {
    sfx.boost();
    frenzyLeft = FRENZY_MS * mods.frenzyDur * fx.frenzyDur;
    toast(`Frenesi! Produção x${frenzyMult()} por ${Math.round(frenzyLeft / 1000)}s`, '#ffc46b');
  } else {
    const gain = (Math.min(bits * 0.15, getBps() * 900) + 13) * mods.luckyMult * fx.lucky;
    earn(gain);
    toast(`Sorte! +${format(gain)} bits`, '#ffc46b');
  }
  spawnParticles(golden.sprite.x, golden.sprite.y);
  addRipple(1.6);
  removeGolden();
  checkAchievements();
  save();
}

// ---------- Clique ----------
cube.on('pointerdown', (event) => {
  const gain = getBitsPerClick();
  earn(gain);
  clicks++;
  trackDaily('clicks');
  comboClick();

  sfx.click();
  haptic(6);
  cubeFx.kick = 0.92;
  counter.scale.set(1.035);
  tween(counter, { scale: 1 }, 200);
  addRipple();
  const jitter = (Math.random() - 0.5) * 40;
  spawnFloatingText(event.global.x + jitter, event.global.y - 10, `+${format(gain)}`);
  spawnParticles(event.global.x, event.global.y);
});

// ---------- Estado inicial da interface ----------
// em telas estreitas as gavetas começam recolhidas para não cobrir o cubo
const narrow = app.screen.width < 1100 || app.screen.height < 520;
rightDock.restore(savedUi?.r ?? { open: !narrow, active: 1 });
leftDock.restore(savedUi?.l ?? { open: !narrow, active: 0 });
paintModeButtons();
updateShop();
for (const item of shopButtons) { item.shown = item.target; drawLevelBar(item); }
updatePerks();
updateStats();
updateAbilities();
refreshAchievements();
refreshTree();
layout();
applySkin();
app.renderer.on('resize', layout);
for (const dock of [leftDock, rightDock]) dock.activePage()?.playIn(dock.side === 'right' ? 1 : -1);

// ---------- Entrada suave ao abrir o jogo ----------
function intro() {
  if (!settings.motion) return;
  const rise = (obj, dy, delay) => {
    const y = obj.y;
    obj.alpha = 0;
    obj.y = y + dy;
    tween(obj, { alpha: 1, y }, 650, { delay });
  };
  rise(counter, 14, 80);
  rise(bpsText, 14, 160);
  rise(metaText, 14, 240);
  abilityButtons.forEach(({ btn }, i) => rise(btn, 22, 320 + i * 70));
  [achButton, skillButton, prestigeBtn].forEach((btn, i) => rise(btn, 22, 520 + i * 70));
  for (const dock of [leftDock, rightDock]) {
    dock.root.alpha = 0;
    tween(dock.root, { alpha: 1 }, 700, { delay: 400 });
  }
  cubeFx.intro = 0.82;
  cube.alpha = 0;
  tween(cube, { alpha: 1 }, 700);
  tween(cubeFx, { intro: 1 }, 900, { ease: ease.back });
}
intro();

// tela de carregamento da página do site (ver vite.config.js): some com fade
const boot = document.getElementById('boot');
if (boot) {
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 800);
}

// ---------- Aviso de rebalanceamento (saves antigos) ----------
if (migrationNote) toast(migrationNote, '#ffc46b');

// ---------- Progresso offline ----------
if (lastSave) {
  const capS = (BASE_OFFLINE_H + mods.offlineH + fx.offlineH) * 3600;
  const elapsed = Math.min((Date.now() - lastSave) / 1000, capS);
  const gain = getBps() * elapsed * OFFLINE_RATE;
  if (gain >= 1) {
    earn(gain);
    toast(`Bem-vindo de volta! +${format(gain)} bits`, '#ffc46b');
  }
}

// ---------- Game loop ----------
let slowTimer = 0;
let studioTimer = 0;
let hudTimer = 0;
let achTimer = 0;
let perksEmptyShown = false;

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS;
  playMs += dt;

  updateTweens(dt);
  earn(getBps() * (dt / 1000));

  // mecânicas do Estúdio
  studioTimer += dt;
  if (studioTimer >= 1000) {
    studioTimer = 0;
    ensureDaily();
    tickChallenge();
    tickResearch();
    tickProjects();
    tickManagers();
  }
  tickMarket();
  tickCombo(dt);
  updateProposal();
  updateHud();
  if (skinDef().cycle) paintSkinFilter((performance.now() / 30) % 360);
  hudTimer += dt;
  if (hudTimer >= 250) {
    hudTimer = 0;
    updateStudioDot();
    if (studioPanel.visible) refreshStudio();
  }

  leftDock.update(dt);
  rightDock.update(dt);

  // Frenesi e impulsos
  if (frenzyLeft > 0) frenzyLeft = Math.max(0, frenzyLeft - dt);
  for (const s of Object.values(abilities)) {
    if (s.act > 0) s.act = Math.max(0, s.act - dt);
    if (s.cd > 0) s.cd = Math.max(0, s.cd - dt);
  }
  frenzyText.text = frenzyLeft > 0
    ? `Frenesi x${frenzyMult()} · ${Math.ceil(frenzyLeft / 1000)}s`
    : '';
  if ((frenzyLeft > 0) !== decoFrenzy) {
    decoFrenzy = frenzyLeft > 0;
    drawPedestal();
    drawHalo();
  }

  // Bit dourado: aparece de tempos em tempos e some se ninguém clicar
  if (golden) {
    golden.life += dt;
    golden.sprite.alpha = 0.7 + 0.3 * Math.sin(golden.life / 220);
    golden.sprite.rotation = Math.sin(golden.life / 500) * 0.15;
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

  // Textos principais: o contador "rola" até o valor real
  shownBits += (bits - shownBits) * (1 - Math.exp(-dt / 70));
  if (Math.abs(bits - shownBits) < 0.5) shownBits = bits;
  counter.text = `${format(shownBits)} bits`;
  bpsText.text = `${rate(getBps())} bits/s`;
  const chipPct = Math.round(chipBoost() * 100);
  metaText.text = `Nível ${playerLevel()} · Pontos ${skillPointsFree()} · Chips ${chips} (+${chipPct}%)`;

  // Interface que não precisa atualizar a cada frame
  slowTimer += dt;
  if (slowTimer >= 150) {
    slowTimer = 0;
    updateShop();
    updatePerks();
    updateStats();
    updateAbilities();
    if (tree.visible) refreshTree();

    const empty = !perkButtons.some(({ wrap }) => wrap.visible);
    if (empty !== perksEmptyShown) {
      perksEmptyShown = empty;
      if (empty) perksPage.root.addChild(perksEmpty);
      else perksPage.root.removeChild(perksEmpty);
    }

    const { y: xy, w } = xpLayout;
    const p = Math.min(1, Math.max(0, levelProgress()));
    xpBar.clear()
      .roundRect(app.screen.width / 2 - w / 2, xy, w, 4, 2).fill({ color: 0xffffff, alpha: 0.08 })
      .roundRect(app.screen.width / 2 - w / 2, xy, Math.max(4, w * p), 4, 2).fill(C.accent);

    const pending = pendingChips();
    prestigeLabel.text = `Evoluir · +${pending} chip(s)`;
    prestigeBtn.alpha = pending >= 1 ? 1 : 0.5;
    skillLabel.text = `Habilidades (${skillPointsFree()})`;
    for (const { imp, wrap, btn } of perkButtons) {
      if (wrap.visible) btn.alpha = bits >= imp.cost ? 1 : 0.5;
    }
  }

  animateBars(dt);
  updateAbilityBars();
  updateToasts(dt);
  updateMotes(dt);
  updateRipples(dt);

  // nós da árvore: aros pulsam e as torres respiram
  if (tree.visible) {
    const now = performance.now();
    const pulse = 0.4 + 0.4 * Math.sin(now / 320);
    for (const v of nodeViews.values()) {
      if (v.ring.visible) v.ring.alpha = pulse;
      if (v.owned) v.glow.alpha = 0.75 + 0.25 * Math.sin(now / 700 + v.phase);
    }
  }

  // cubo: volta ao tamanho normal, "respira" e flutua; o halo acompanha
  const breathe = !settings.motion ? 1 : 1 + 0.012 * Math.sin(performance.now() / 900);
  cubeFx.kick += (1 - cubeFx.kick) * Math.min(1, dt * 0.012);
  cube.scale.set(baseScale * cubeFx.kick * cubeFx.intro * breathe);
  cube.y = cubeBaseY + (!settings.motion ? 0 : Math.sin(performance.now() / 700) * 6);
  halo.position.set(cube.x, cube.y);
  halo.alpha = 0.8 + (!settings.motion ? 0 : 0.2 * Math.sin(performance.now() / 1300));

  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life += dt;
    f.text.y -= dt * f.speed;
    f.text.alpha = Math.min(1, 1 - (f.life / f.duration) ** 2);
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
    p.vx *= 0.985;
    p.vy *= 0.985;
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
    sfx, settings, musicState, toggleSettings, earn, spawnGolden, collectGolden, prestige, checkAchievements, pendingChips, setBuyMode,
    toggleStudio, setStudioTab, startChallenge, endChallenge, startResearch, startProject, hireManager, claimMission,
    openProposal, resolveProposal, ascend, buyOrEquipSkin, comboClick, tickMarket, tickResearch, tickProjects,
    studioRows, stPills, studioBtn,
    get ext() {
      return {
        fragments, cores, ascensions, challenge, challengesDone: [...challengesDone], research: { done: [...research.done], active: research.active },
        projects, managers: { hired: [...managers.hired] }, skinId, daily, fx, market, proposal: !!proposal, combo: { ...combo },
        setBits: (v) => { bits = v; totalBits = Math.max(totalBits, v); runBits = Math.max(runBits, v); },
        setChips: (v) => { chips = v; },
        setCores: (v) => { cores = v; recomputeFx(); },
        addFragments: (v) => { fragments += v; },
        setTotal: (v) => { totalBits = v; },
        expireResearch: () => { if (research.active) research.active.endsAt = 0; },
        expireProject: (id) => { if (projects[id]) projects[id].endsAt = 0; },
        forceMarket: () => { market.nextAt = 0; },
        addCounter: (t, n) => { daily.counters[t] = (daily.counters[t] ?? 0) + n; },
      };
    },
    buySkill, toggleTree, toggleAchievements, useAbility, SKILLS, leftDock, rightDock,
    hitObj: (x, y) => app.renderer.events.rootBoundary.hitTest(x, y),
    hit: (x, y) => {
      const t = app.renderer.events.rootBoundary.hitTest(x, y);
      if (!t) return 'nada';
      const chain = [];
      for (let o = t; o && chain.length < 6; o = o.parent) chain.push(`${o.constructor.name}[${o.eventMode}${o.label ? ':' + o.label : ''}]`);
      return chain.join(' < ');
    },
    skillToScreen: (sk) => {
      const p = project(sk.x, sk.y);
      return { x: tree.x + world.x + p.x * world.scale.x, y: tree.y + world.y + p.y * world.scale.y };
    },
    get state() {
      return {
        bits, runBits, totalBits, clicks, chips, prestiges, frenzyLeft, buyMode,
        level: playerLevel(), sp: skillPointsFree(), spTotal: skillPointsTotal(), prestigeSP,
        unlocked: [...unlocked], bought: [...bought], skills: [...skillsOwned],
        owned: Object.fromEntries(upgrades.map((u) => [u.id, u.owned])),
        bps: getBps(), perClick: getBitsPerClick(), golden: !!golden,
        docks: { l: leftDock.state(), r: rightDock.state() },
        layoutMode,
        modal: tree.visible ? 'tree' : achPanel.visible ? 'ach' : settingsPanel.visible ? 'settings' : studioPanel.visible ? 'studio' : null,
      };
    },
  };
}

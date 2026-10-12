// Dados e regras puras das mecânicas do "Estúdio": desafios, pesquisa, projetos (jogos),
// gerentes, missões diárias, eventos de mercado, visuais (skins) e ascensão.
// Nada aqui depende do Pixi nem do estado do jogo: o main.js decide quando chamar.
import { UPGRADE_DEFS } from './data.js';

// ---------------------------------------------------------------- DESAFIOS --
// Uma rodada especial: a corrida atual é guardada, o jogador recomeça do zero com uma regra
// e precisa juntar `goal` bits. Ao vencer, ganha o bônus permanente e a corrida de antes volta.
export const CHALLENGES = [
  { id: 'nocl',   name: 'Mãos para trás',     rule: 'Clicar no cubo não rende bits.',                        goal: 5e6,  reward: 0.08 },
  { id: 'noimp',  name: 'Sem atalhos',        rule: 'Melhorias bloqueadas: só upgrades.',                     goal: 5e8,  reward: 0.10 },
  { id: 'three',  name: 'Time enxuto',        rule: 'No máximo 3 tipos de upgrade de produção.',              goal: 2e8,  reward: 0.10 },
  { id: 'cost2',  name: 'Crise orçamentária', rule: 'Todos os upgrades custam o dobro.',                      goal: 1e9,  reward: 0.12 },
  { id: 'nogold', name: 'Sem sorte',          rule: 'Sem bits dourados e sem impulsos.',                      goal: 3e8,  reward: 0.10 },
  { id: 'rush',   name: 'Contra o relógio',   rule: 'Você tem 15 minutos reais.',                             goal: 3e7,  reward: 0.12, limitS: 900 },
];
export const CHALLENGE_MIN_LEVEL = 8;

// --------------------------------------------------------------- PESQUISA --
// Um projeto por vez, com tempo real (continua com o jogo fechado). Bônus permanentes.
const min = 60;
const hour = 3600;
export const RESEARCH = [
  { id: 'r1',  name: 'Documentação',           desc: 'Produção +3%',                cost: 5e4,  time: 3 * min,   fx: { prod: 0.03 } },
  { id: 'r2',  name: 'Revisão de código',      desc: 'Upgrades 3% mais baratos',    cost: 5e5,  time: 10 * min,  fx: { cost: -0.03 } },
  { id: 'r3',  name: 'Atalhos de teclado',     desc: 'Cliques +10%',                cost: 3e6,  time: 20 * min,  fx: { click: 0.10 } },
  { id: 'r4',  name: 'Servidores melhores',    desc: 'Produção +5%',                cost: 2e7,  time: 45 * min,  fx: { prod: 0.05 } },
  { id: 'r5',  name: 'Café premium',           desc: 'Bits dourados 10% mais rápidos', cost: 1e8, time: 90 * min, fx: { golden: -0.10 } },
  { id: 'r6',  name: 'Backup na nuvem',        desc: '+2h de ganho offline',        cost: 6e8,  time: 2 * hour,  fx: { offlineH: 2 } },
  { id: 'r7',  name: 'Automação de testes',    desc: 'Produção +6%',                cost: 4e9,  time: 3 * hour,  fx: { prod: 0.06 } },
  { id: 'r8',  name: 'Mentoria',               desc: 'Upgrades 4% mais baratos',    cost: 3e10, time: 4 * hour,  fx: { cost: -0.04 } },
  { id: 'r9',  name: 'Playtest',               desc: 'Frenesi dura 25% mais',       cost: 2e11, time: 5 * hour,  fx: { frenzyDur: 0.25 } },
  { id: 'r10', name: 'Pipeline de entrega',    desc: 'Produção +8%',                cost: 2e12, time: 6 * hour,  fx: { prod: 0.08 } },
  { id: 'r11', name: 'Engine própria',         desc: 'Cliques +15%',                cost: 2e13, time: 8 * hour,  fx: { click: 0.15 } },
  { id: 'r12', name: 'Publicação multiplataforma', desc: 'Produção +10%',           cost: 2e14, time: 10 * hour, fx: { prod: 0.10 } },
];

// ---------------------------------------------------------------- PROJETOS --
// "Lançar um jogo": projetos longos com os jogos reais da Scorpion Bits.
// Gastam bits + tempo e dão um multiplicador de produção permanente e um visual para o cubo.
export const PROJECTS = [
  { id: 'tirania',  name: 'Tirania',       desc: 'Ação 2D em pixel art. Resgate provisões e enfrente o rei.', cost: 2e6,  time: 15 * min,  mult: 0.10, skin: 'tirania' },
  { id: 'astrodash', name: 'AstroDash',    desc: 'Pilote entre meteoros num jogo rápido e direto.',            cost: 1e9,  time: 1 * hour,  mult: 0.15, skin: 'astrodash' },
  { id: 'tower',    name: 'Tower Defence', desc: 'Defesa de torres com árvore de habilidades e crafting.',     cost: 5e11, time: 3 * hour,  mult: 0.20, skin: 'tower' },
  { id: 'sitis',    name: 'Sitis',         desc: 'Ação top-down: Iris sobe da dungeon gastando a própria água.', cost: 2e13, time: 6 * hour, mult: 0.30, skin: 'sitis' },
  { id: 'noir',     name: 'Projeto noir',  desc: 'Investigação noir, em pixel art. Ainda em planejamento.',    cost: 1e15, time: 12 * hour, mult: 0.40, skin: 'noir' },
];

// ---------------------------------------------------------------- GERENTES --
// Um gerente por upgrade de produção: compra unidades sozinho quando sobra bits.
// Libera por nível do jogador; contrata-se uma vez (vale para sempre).
const GENS = UPGRADE_DEFS.filter((d) => d.kind === 'gen');
export const MANAGERS = GENS.map((g, i) => ({
  id: g.id,
  name: `Gerente de ${g.name}`,
  cost: g.baseCost * 250,
  level: 6 + i * 3,
}));
export const MANAGER_SPEND = 0.25;   // só compra se o custo for até 25% dos bits (sobra para melhorias)

// ----------------------------------------------------------------- VISUAIS --
// Só estética: giram a cor do cubo (filtro de matiz) e trocam a cor do aro do pedestal.
// `cost` em fragmentos (dos bits dourados); `project` = desbloqueia ao lançar o jogo.
export const SKINS = [
  { id: 'padrao',    name: 'Padrão',      hue: 0,    rim: 0x6ad8fe, cost: 0 },
  { id: 'ambar',     name: 'Âmbar',       hue: -160, rim: 0xffc46b, cost: 6 },
  { id: 'menta',     name: 'Menta',       hue: -50,  rim: 0x7ee2a8, cost: 6 },
  { id: 'violeta',   name: 'Violeta',     hue: 70,   rim: 0xa57bf8, cost: 10 },
  { id: 'rosa',      name: 'Rosa',        hue: 125,  rim: 0xff8ad8, cost: 10 },
  { id: 'arcoiris',  name: 'Arco-íris',   hue: 0,    rim: 0xffffff, cost: 40, cycle: true },
  { id: 'tirania',   name: 'Tirania',     hue: 150,  rim: 0xff6b6b, cost: 0, project: 'tirania' },
  { id: 'astrodash', name: 'AstroDash',   hue: 40,   rim: 0x9aa7ff, cost: 0, project: 'astrodash' },
  { id: 'tower',     name: 'Tower Defence', hue: -100, rim: 0x8fd18f, cost: 0, project: 'tower' },
  { id: 'sitis',     name: 'Sitis',       hue: -20,  rim: 0x6bd6ff, cost: 0, project: 'sitis', saturate: 0.2 },
  { id: 'noir',      name: 'Noir',        hue: 0,    rim: 0xdfe7ef, cost: 0, project: 'noir', gray: true },
];

// ---------------------------------------------------------------- MISSÕES --
// Três missões por dia, sorteadas pela data (todo mundo vê as mesmas no mesmo dia).
export const MISSION_TYPES = {
  clicks:   { label: (n) => `Clique ${n} vezes no cubo`,            targets: [300, 600, 1000] },
  golden:   { label: (n) => `Pegue ${n} bits dourados`,             targets: [2, 3, 5] },
  buy:      { label: (n) => `Compre ${n} upgrades`,                 targets: [40, 80, 140] },
  earn:     { label: (n) => `Junte ${n} bits hoje`,                 targets: [1] },   // alvo calculado pela produção
  impulse:  { label: (n) => `Use ${n} impulsos`,                    targets: [2, 3, 4] },
  research: { label: (n) => `Conclua ${n} pesquisa${n > 1 ? 's' : ''}`, targets: [1] },
  combo:    { label: () => 'Chegue ao combo máximo',                targets: [1] },
};

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function makeMissions(key, bpsNow) {
  const rand = seeded(hashString(key));
  const pool = Object.keys(MISSION_TYPES);
  const picked = [];
  while (picked.length < 3) {
    const t = pool[Math.floor(rand() * pool.length)];
    if (!picked.includes(t)) picked.push(t);
  }
  return picked.map((type) => {
    const def = MISSION_TYPES[type];
    let target = def.targets[Math.floor(rand() * def.targets.length)];
    if (type === 'earn') target = Math.max(5e4, Math.round(bpsNow * 1800));
    return { type, target, claimed: false };
  });
}

// ------------------------------------------------------- EVENTOS DE MERCADO --
export const MARKET = {
  minGapS: 240,
  maxGapS: 420,
  proposalS: 40,           // tempo para decidir
  boom: { mult: 1.5, durS: 90 },
  crash: { mult: 0.7, durS: 60, insurance: 0.10 },
  invest: { share: 0.20, winChance: 0.55, payout: 2 },
  fan: { minutesOfProduction: 10, fragments: 3 },
  weights: [['boom', 35], ['crash', 20], ['invest', 25], ['fan', 20]],
};

export function pickMarketEvent(rand = Math.random) {
  const total = MARKET.weights.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [kind, w] of MARKET.weights) {
    r -= w;
    if (r <= 0) return kind;
  }
  return 'boom';
}

// --------------------------------------------------------------- ASCENSÃO --
export const ASCEND_MIN_CHIPS = 50;
export const ascendGain = (chips) => Math.floor(Math.sqrt(chips / 50));
export const coreMult = (cores) => 1 + 0.3 * cores ** 0.9;

// ---------------------------------------------------------- BÔNUS JUNTOS --
// Junta todos os bônus permanentes das mecânicas novas em um objeto só.
export function computeFx({ researchDone, projectsDone, challengesDone, cores }) {
  const fx = { prod: 1, click: 1, cost: 1, offlineH: 0, golden: 1, frenzyDur: 1, lucky: 1 };
  let prodAdd = 0, clickAdd = 0, costAdd = 0, goldenAdd = 0, frenzyAdd = 0;
  for (const r of RESEARCH) {
    if (!researchDone.has(r.id)) continue;
    prodAdd += r.fx.prod ?? 0;
    clickAdd += r.fx.click ?? 0;
    costAdd += r.fx.cost ?? 0;
    goldenAdd += r.fx.golden ?? 0;
    frenzyAdd += r.fx.frenzyDur ?? 0;
    fx.offlineH += r.fx.offlineH ?? 0;
  }
  fx.prod = 1 + prodAdd;
  fx.click = 1 + clickAdd;
  fx.cost = Math.max(0.5, 1 + costAdd);
  fx.golden = Math.max(0.5, 1 + goldenAdd);
  fx.frenzyDur = 1 + frenzyAdd;
  for (const p of PROJECTS) if (projectsDone.has(p.id)) fx.prod *= 1 + p.mult;
  for (const c of CHALLENGES) if (challengesDone.has(c.id)) fx.prod *= 1 + c.reward;
  fx.prod *= coreMult(cores);
  return fx;
}

export function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  if (m > 0) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${sec}s`;
}

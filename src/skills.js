// Árvore de habilidades: 5 ramos x 2 trilhas x 10 níveis = 100 habilidades.
// Cada habilidade só depende da anterior da mesma trilha (a primeira liga no núcleo).
import { UPGRADE_DEFS } from './data.js';

const GENS = UPGRADE_DEFS.filter((d) => d.kind === 'gen');

export const BRANCHES = [
  { id: 'click', name: 'Clique',    color: 0x6ad8fe },
  { id: 'prod',  name: 'Produção',  color: 0x7ee2a8 },
  { id: 'luck',  name: 'Sorte',     color: 0xffc46b },
  { id: 'eco',   name: 'Economia',  color: 0x5b6bf5 },
  { id: 'evo',   name: 'Evolução',  color: 0x8b5cf6 },
];

// Todos os efeitos das habilidades somam em um único objeto de "modificadores".
export function newMods() {
  return {
    clickMult: 1,    // multiplica os bits por clique
    clickBps: 0,     // cada clique rende também X% do bits/s
    prodMult: 1,     // multiplica a produção total
    gen: {},         // multiplicador por upgrade: { server: 2, ... }
    goldenFreq: 1,   // fator no intervalo do bit dourado (menor = mais frequente)
    frenzyDur: 1,    // fator na duração do Frenesi
    frenzyAdd: 0,    // soma ao multiplicador do Frenesi
    luckyMult: 1,    // fator no bônus de Sorte
    costMult: 1,     // fator no custo dos upgrades
    offlineH: 0,     // horas extras de ganho offline
    abilityCd: 1,    // fator no tempo de recarga dos impulsos
    chipBonus: 0,    // soma ao bônus de cada chip
    levelBonus: 0,   // soma ao bônus de cada nível de upgrade
  };
}

const tierCost = (t) => (t < 3 ? 1 : t < 6 ? 2 : t < 9 ? 3 : 5);

// Cada trilha: 10 nomes, uma descrição e o efeito (t = nível 0..9 dentro da trilha).
const LANES = [
  // ----- Clique -----
  {
    names: ['Dedo Firme', 'Mouse Gamer Pro', 'Macro Simples', 'Clique Duplo', 'Reflexo Rápido',
      'Punho de Aço', 'Auto-Clicker', 'Clique Crítico', 'Mestre do Mouse', 'Lenda do Clique'],
    desc: () => 'Cliques +20%',
    apply: (m) => { m.clickMult *= 1.2; },
  },
  {
    names: ['Motivação', 'Foco', 'Ritmo', 'Sincronia', 'Fluxo',
      'Concentração', 'Ressonância', 'Harmonia', 'Maestria', 'Transcendência'],
    desc: (t) => `Cada clique rende +${t + 1}% do seu bits/s`,
    apply: (m, t) => { m.clickBps += 0.01 * (t + 1); },
  },
  // ----- Produção -----
  {
    names: ['Café Grátis', 'Teclado Novo', 'Dois Monitores', 'Cadeira Ergonômica', 'Scrum',
      'Kanban', 'CI/CD', 'DevOps', 'Automação Total', 'Singularidade'],
    desc: () => 'Produção total +10%',
    apply: (m) => { m.prodMult *= 1.1; },
  },
  {
    names: ['Bootcamp', 'Mentoria Sênior', 'Escalonamento', 'Estúdio Premium', 'Pesquisa Aplicada',
      'Supercomputação', 'Rede Neural', 'Qubits Estáveis', 'Superinteligência', 'Dobra Dimensional'],
    desc: (t) => `${GENS[t].name} produz 2x`,
    apply: (m, t) => { m.gen[GENS[t].id] = (m.gen[GENS[t].id] ?? 1) * 2; },
  },
  // ----- Sorte -----
  {
    names: ['Trevo de Quatro Folhas', 'Ferradura', 'Pé de Coelho', 'Estrela Cadente', 'Moeda da Sorte',
      'Dados Viciados', 'Aposta Certa', 'Cassino Estelar', 'Destino', 'Fortuna Infinita'],
    desc: () => 'Bits dourados aparecem 8% mais rápido',
    apply: (m) => { m.goldenFreq *= 0.92; },
  },
  {
    names: ['Frenesi Longo', 'Euforia', 'Bolada', 'Frenesi Duradouro', 'Frenesi Intenso',
      'Jackpot', 'Frenesi Prolongado', 'Êxtase', 'Mega Jackpot', 'Frenesi Eterno'],
    desc: (t) => ['Frenesi dura 20% mais', 'Frenesi +1x de multiplicador', 'Bônus de Sorte +30%'][t % 3],
    apply: (m, t) => {
      if (t % 3 === 0) m.frenzyDur *= 1.2;
      else if (t % 3 === 1) m.frenzyAdd += 1;
      else m.luckyMult *= 1.3;
    },
  },
  // ----- Economia -----
  {
    names: ['Cupom', 'Black Friday', 'Atacado', 'Negociação', 'Fornecedor Fixo',
      'Importação', 'Contrato Anual', 'Monopólio', 'Subsídio', 'Economia de Escala'],
    desc: () => 'Upgrades 3% mais baratos',
    apply: (m) => { m.costMult *= 0.97; },
  },
  {
    names: ['Modo Noturno', 'Recarga Rápida', 'Servidor 24h', 'Energia Limpa', 'Backup Diário',
      'Resfriamento', 'Nuvem Global', 'Overclock Seguro', 'Data Center Offshore', 'Relógio Quântico'],
    desc: (t) => (t % 2 === 0 ? '+3h de ganho offline' : 'Impulsos recarregam 10% mais rápido'),
    apply: (m, t) => {
      if (t % 2 === 0) m.offlineH += 3;
      else m.abilityCd *= 0.9;
    },
  },
  // ----- Evolução -----
  {
    names: ['Chip Básico', 'Chip Duplo', 'Circuito', 'Placa-Mãe', 'Processador',
      'Núcleo', 'Matriz', 'Cristal', 'Wafer Perfeito', 'Chip Supremo'],
    desc: () => 'Cada chip rende +1% de produção',
    apply: (m) => { m.chipBonus += 0.01; },
  },
  {
    names: ['Aprendizado', 'Prática', 'Experiência', 'Veterania', 'Especialista',
      'Mestria', 'Iluminação', 'Sabedoria', 'Sagacidade', 'Onisciência'],
    desc: () => 'Bônus de nível dos upgrades +2%',
    apply: (m) => { m.levelBonus += 0.02; },
  },
];

// ---- Geração dos 100 nós: mandala com 10 anéis (nível) x 10 braços (5 ramos x 2 trilhas) ----
// Os braços fazem uma leve espiral: cada anel gira TWIST radianos em relação ao anterior.
export const RING_R0 = 96;       // raio do 1º anel
export const RING_STEP = 46;     // distância entre anéis
export const TWIST = 0.08;       // giro por anel (rad)
const SPOKES = LANES.length;     // 10 braços, igualmente espaçados

export const spokeAngle = (k) => -Math.PI / 2 + ((k + 0.5) * 2 * Math.PI) / SPOKES;
export const branchStart = (b) => -Math.PI / 2 + (b * 2 * Math.PI) / BRANCHES.length;
// giro acumulado até o raio r (0 dentro do 1º anel)
export const twistAt = (r) => Math.max(0, (r - RING_R0) / RING_STEP) * TWIST;

export const SKILLS = LANES.flatMap((lane, laneIndex) => {
  const branch = Math.floor(laneIndex / 2);

  return lane.names.map((name, t) => {
    const r = RING_R0 + t * RING_STEP;
    const angle = spokeAngle(laneIndex) + twistAt(r);
    return {
      id: `${BRANCHES[branch].id}-${laneIndex % 2}-${t}`,
      branch,
      lane: laneIndex % 2,
      tier: t,
      name,
      desc: lane.desc(t),
      cost: tierCost(t),
      req: t > 0 ? `${BRANCHES[branch].id}-${laneIndex % 2}-${t - 1}` : null,
      r,
      angle,
      x: Math.cos(angle) * r,   // posição "no chão" (antes da projeção)
      y: Math.sin(angle) * r,
      apply: (m) => lane.apply(m, t),
    };
  });
});

export function computeMods(owned) {
  const m = newMods();
  for (const s of SKILLS) if (owned.has(s.id)) s.apply(m);
  return m;
}

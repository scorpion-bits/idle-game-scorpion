// Definições de upgrades (dados puros, sem Pixi nem estado do jogo).
//
// kind: 'click' = soma bits por clique | 'gen' = gera bits por segundo
// baseCost cresce 15% a cada unidade comprada (ver GROWTH em main.js)

export const UPGRADE_DEFS = [
  // ----- Clique -----
  { id: 'mouse',  kind: 'click', name: 'Teclado Mecânico',    baseCost: 50,    click: 1 },
  { id: 'mouse2', kind: 'click', name: 'Mouse Gamer',         baseCost: 600,   click: 8 },
  { id: 'mouse3', kind: 'click', name: 'Mesa Digitalizadora', baseCost: 7000,  click: 60 },
  { id: 'mouse4', kind: 'click', name: 'Interface Neural',    baseCost: 80000, click: 450 },

  // ----- Produção -----
  { id: 'intern', kind: 'gen', name: 'Estagiário',          baseCost: 15,     bps: 0.1 },
  { id: 'junior', kind: 'gen', name: 'Dev Júnior',          baseCost: 100,    bps: 1 },
  { id: 'senior', kind: 'gen', name: 'Dev Sênior',          baseCost: 1100,   bps: 8 },
  { id: 'server', kind: 'gen', name: 'Servidor Dedicado',   baseCost: 12000,  bps: 47 },
  { id: 'studio', kind: 'gen', name: 'Estúdio',             baseCost: 130000, bps: 260 },
  { id: 'rnd',    kind: 'gen', name: 'Centro de P&D',       baseCost: 1.4e6,  bps: 1400 },
  { id: 'dc',     kind: 'gen', name: 'Data Center',         baseCost: 2e7,    bps: 7800 },
  { id: 'quantum', kind: 'gen', name: 'Computador Quântico', baseCost: 3.3e8, bps: 44000 },
  { id: 'agi',    kind: 'gen', name: 'IA Geral',            baseCost: 5.1e9,  bps: 260000 },
  { id: 'portal', kind: 'gen', name: 'Portal Multiverso',   baseCost: 7.5e10, bps: 1.6e6 },
];

// Melhorias: cada upgrade ganha 4 melhorias de compra única (x2), liberadas com 1, 10, 25 e 50 unidades.
const IMPROVEMENT_TIERS = [
  { req: 1,  costFactor: 8 },
  { req: 10, costFactor: 80 },
  { req: 25, costFactor: 800 },
  { req: 50, costFactor: 8000 },
];
const ROMAN = ['I', 'II', 'III', 'IV'];

export function makeImprovements() {
  return UPGRADE_DEFS.flatMap((def) =>
    IMPROVEMENT_TIERS.map((tier, i) => ({
      id: `${def.id}_${i}`,
      name: `${def.name} ${ROMAN[i]}`,
      desc: `${def.name} 2x`,
      cost: def.baseCost * tier.costFactor,
      target: def.id,
      mult: 2,
      req: tier.req,
    })),
  );
}

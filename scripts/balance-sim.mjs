// Simulador de ritmo (balanceamento). Roda um jogador "bot" que só joga idle (cerca de 4 cliques/s),
// compra sempre o melhor custo-benefício e evolui quando compensa, e mostra o progresso em 1h...24h.
//
//   node scripts/balance-sim.mjs
//
// Para testar uma mudança, edite os parâmetros em PRESETS (ou crie outro) e compare as colunas.
// Mantenha estes valores iguais às constantes de balanceamento no topo de src/main.js.
// Ignora habilidades e conquistas (que só aceleram um pouco), então use para COMPARAR, não como tempo exato.
import { UPGRADE_DEFS, makeImprovements } from '../src/data.js';

const GEN = UPGRADE_DEFS.filter((d) => d.kind === 'gen');
const IMPS = makeImprovements().filter((i) => GEN.some((g) => g.id === i.target));

const PRESETS = {
  'ANTES (sqrt, 1 PH por chip)': {
    chipFn: (run) => Math.sqrt(run / 1e5), chipCurve: (c) => c, levelBase: 1.6,
    spFromPrestige: (chips) => chips,
  },
  'ATUAL (cbrt, máx. 5 PH por evolução)': {
    chipFn: (run) => Math.cbrt(run / 1e5), chipCurve: (c) => c ** 0.85, levelBase: 1.8,
    spFromPrestige: (_chips, sumCapped) => sumCapped, spCap: 5,
  },
};

function run(P, hours = 24) {
  let bits = 0, runBits = 0, total = 0, chips = 0, cappedSP = 0, prestiges = 0, sinceP = 0;
  let owned = Object.fromEntries(GEN.map((g) => [g.id, 0]));
  let bought = new Set();
  const out = {};

  const unitMult = (g) => {
    let m = 1;
    for (const i of IMPS) if (i.target === g.id && bought.has(i.id)) m *= 2;
    return m * 1.2 ** Math.floor(owned[g.id] / 10);
  };
  const boost = () => 1 + 0.05 * P.chipCurve(chips);
  const bps = () => GEN.reduce((s, g) => s + owned[g.id] * g.bps * unitMult(g), 0) * boost();
  const level = () => (total < 1000 ? 0 : Math.floor(Math.log(total / 1000) / Math.log(P.levelBase)) + 1);
  const sp = () => level() + P.spFromPrestige(chips, cappedSP);
  const pending = () => Math.floor(P.chipFn(runBits));

  const bestBuy = () => {
    const b0 = bps();
    let best = null;
    for (const g of GEN) {
      owned[g.id]++;
      const d = bps() - b0;
      owned[g.id]--;
      const c = g.baseCost * 1.15 ** owned[g.id];
      if (d > 0 && (!best || c / d < best.r)) best = { r: c / d, c, buy: () => { bits -= c; owned[g.id]++; } };
    }
    for (const i of IMPS) {
      if (bought.has(i.id) || owned[i.target] < i.req) continue;
      bought.add(i.id);
      const d = bps() - b0;
      bought.delete(i.id);
      if (d > 0 && (!best || i.cost / d < best.r)) best = { r: i.cost / d, c: i.cost, buy: () => { bits -= i.cost; bought.add(i.id); } };
    }
    return best;
  };

  const marks = [1, 2, 4, 8, 16, 24].filter((h) => h <= hours);
  let next = 0;
  const DT = 2;
  for (let t = 0; t <= hours * 3600; t += DT) {
    const gain = (bps() + 4 * boost()) * DT;
    bits += gain; runBits += gain; total += gain; sinceP += DT;
    for (let b = bestBuy(), n = 0; b && bits >= b.c && n < 50; b = bestBuy(), n++) b.buy();
    const pend = pending();
    if (pend >= Math.max(3, Math.ceil(chips * 0.5)) && sinceP > 300) {
      chips += pend;
      cappedSP += Math.min(P.spCap ?? Infinity, pend);
      prestiges++;
      bits = runBits = sinceP = 0;
      owned = Object.fromEntries(GEN.map((g) => [g.id, 0]));
      bought = new Set();
    }
    if (marks[next] !== undefined && t >= marks[next] * 3600) {
      out[`${marks[next]}h`] = { 'bits totais': total.toExponential(1), evoluções: prestiges, chips, 'pontos (PH)': sp(), nível: level() };
      next++;
    }
  }
  return out;
}

const TREE_COST = 230;   // custo total das 100 habilidades (ver tierCost em src/skills.js)
for (const [name, P] of Object.entries(PRESETS)) {
  console.log(`\n=== ${name}   (a árvore inteira custa ${TREE_COST} PH)`);
  console.table(run(P));
}

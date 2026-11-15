/**
 * Medição real da peça e resultado reajustado.
 *
 * Ao sair da impressão (Em produção → Acabamento/Inspeção), o usuário informa o peso real de
 * 1 peça e a purga (descarte) do lote. Com isso o sistema mostra, lado a lado:
 *   - Previsto: o orçamento como foi fechado;
 *   - Realizado: o consumo e o tempo reais registrados na conclusão;
 *   - Reajustado: o mesmo orçamento recalculado com o peso e a purga reais — o custo que a peça
 *     realmente tem — e o preço sugerido com ele, para acertar os próximos orçamentos.
 * Não é obrigatório: para não informar, o usuário marca "Não informar desta vez".
 */
import type { DB, ID, OrderPurge, ProductionOrder, QuoteInput } from './types';
import { dropOrderPurges, filamentColor, purgeKey, syncOrderPurges } from './purges';
import { D, Decimal, cents, sum } from './money';
import { BusinessError, assert, audit, byId, nowISO } from './core';
import { compareOrder, moveOrderStatus, orderBaseInput } from './production';
import { evaluateQuote, resolveParams } from './quotes';
import { analyzeAtPrice } from './pricing';

export interface MeasureInput {
  pieceWeightG: number | null; purgeG: number | null; skip: boolean;
  /** Purga por cor (v1.29). Quando informada, `purgeG` é a soma. */
  purges?: OrderPurge[];
}

/** Registra a medição e (se ainda estiver imprimindo) leva o pedido para acabamento/inspeção. */
export function recordMeasurement(db: DB, orderId: ID, m: MeasureInput, to: 'aguardando_acabamento' | 'em_inspecao' = 'aguardando_acabamento') {
  const o = byId(db.orders, orderId, 'Ordem');
  assert(['em_producao', 'aguardando_acabamento', 'em_inspecao'].includes(o.status), 'Só é possível medir peças que estão sendo produzidas.');
  if (m.skip) {
    o.measured = { pieceWeightG: null, purgeG: null, skipped: true, at: nowISO() };
    dropOrderPurges(db, o.id);
  } else {
    if (m.pieceWeightG === null || !(m.pieceWeightG > 0)) throw new BusinessError('Informe o peso real de 1 peça (em gramas) ou marque "Não informar desta vez".');
    const purges = (m.purges ?? []).map((p) => ({ ...p, color: p.color.trim(), g: Math.round((p.g || 0) * 100) / 100 })).filter((p) => p.g !== 0);
    if (purges.some((p) => p.g < 0) || (m.purgeG !== null && m.purgeG < 0)) throw new BusinessError('A purga não pode ser negativa.');
    if (purges.some((p) => !p.color)) throw new BusinessError('Informe a cor de cada purga.');
    // Uma linha por cor (somando se repetiu a cor).
    const byColor = new Map<string, OrderPurge>();
    for (const p of purges) { const k = purgeKey(p.color); const cur = byColor.get(k); byColor.set(k, cur ? { ...cur, g: cur.g + p.g } : p); }
    const list = [...byColor.values()];
    const purgeG = m.purges ? list.reduce((s, p) => s + p.g, 0) : m.purgeG ?? 0;
    o.measured = { pieceWeightG: m.pieceWeightG, purgeG, skipped: false, at: nowISO(), ...(m.purges ? { purges: list } : {}) };
    syncOrderPurges(db, o.id, m.purges ? list : []);
  }
  if (o.status === 'em_producao') moveOrderStatus(db, o.id, to);
  audit(db, 'Medição da peça', m.skip ? `${o.number}: não informada` : `${o.number}: ${m.pieceWeightG} g por peça, purga ${o.measured.purgeG ?? 0} g${o.measured.purges?.length ? ` (${o.measured.purges.map((p) => `${p.color} ${p.g} g`).join(', ')})` : ''}`);
}

/** Cores de filamento do pedido (para pedir a purga por cor). */
export function orderFilamentColors(db: DB, o: ProductionOrder): { materialId: ID; color: string }[] {
  const out = new Map<string, { materialId: ID; color: string }>();
  for (const pm of o.plannedMaterials) {
    const mid = pm.materialId ?? db.lots.find((l) => l.id === pm.lotId)?.materialId;
    const c = filamentColor(db, mid);
    if (mid && c && !out.has(purgeKey(c))) out.set(purgeKey(c), { materialId: mid, color: c });
  }
  return [...out.values()];
}

/**
 * Purga real do pedido, por cor e total: gramas e % sobre o filamento daquela cor (peças + purga).
 * Filamento da cor: o consumo real da conclusão; antes de concluir, o previsto do pedido + a purga.
 * Compara com o % previsto no orçamento (perda %, quando o consumo é só da peça).
 */
export function orderPurgeReport(db: DB, o: ProductionOrder) {
  const m = usable(o);
  if (!m || !m.purges?.length) return null;
  const used = new Map<string, number>();
  const add = (materialId: ID | undefined, g: number) => {
    const mat = materialId ? db.materials.find((x) => x.id === materialId) : undefined;
    if (!mat || mat.unit !== 'g' || !mat.filament) return;
    const k = purgeKey(mat.filament.color ?? '');
    used.set(k, (used.get(k) ?? 0) + g);
  };
  if (o.actual) {
    o.actual.materials.forEach((x) => add(db.lots.find((l) => l.id === x.lotId)?.materialId, x.qty));
  } else {
    o.plannedMaterials.forEach((x) => add(x.materialId ?? db.lots.find((l) => l.id === x.lotId)?.materialId, x.qty));
    for (const p of m.purges) used.set(purgeKey(p.color), (used.get(purgeKey(p.color)) ?? 0) + p.g);
  }
  const rows = m.purges.map((p) => {
    const base = used.get(purgeKey(p.color)) ?? 0;
    return { color: p.color, purgeG: p.g, filamentG: base, pct: base > 0 ? D(p.g).div(base).times(100) : null };
  });
  const purgeG = rows.reduce((s, r) => s + r.purgeG, 0);
  const filamentG = [...used.values()].reduce((s, g) => s + g, 0);
  let plannedPct: Decimal | null = null;
  try {
    const { input } = orderBaseInput(db, o);
    plannedPct = input.consumptionBasis === 'peca' && input.wastePct ? D(input.wastePct) : null;
  } catch { plannedPct = null; }
  return { rows, purgeG, filamentG, pct: filamentG > 0 ? D(purgeG).div(filamentG).times(100) : null, plannedPct, basis: o.actual ? 'realizado' as const : 'previsto' as const };
}

const usable = (o: ProductionOrder) => (o.measured && !o.measured.skipped && (o.measured.pieceWeightG ?? 0) > 0 ? o.measured : null);

/** Filamento previsto para 1 peça no orçamento (com a perda %, quando o consumo é só da peça). */
export function plannedFilamentPerUnit(input: QuoteInput): Decimal {
  const base = sum(input.materials.map((m) => D(m.qtyPerUnit)));
  return input.consumptionBasis === 'peca' && input.wastePct ? base.times(D(1).plus(D(input.wastePct).div(100))) : base;
}

/** Filamento real de 1 peça medido: peso + parte da purga do lote. */
export function measuredFilamentPerUnit(o: ProductionOrder): Decimal | null {
  const m = usable(o);
  if (!m) return null;
  return D(m.pieceWeightG!).plus(D(m.purgeG ?? 0).div(Math.max(1, o.qtyPlanned)));
}

/** Total de filamento medido do pedido (peso × quantidade + purga): ponto de partida da conclusão. */
export function measuredFilamentTotal(o: ProductionOrder): Decimal | null {
  const m = usable(o);
  return m ? D(m.pieceWeightG!).times(o.qtyPlanned).plus(m.purgeG ?? 0) : null;
}

export interface ResultColumn {
  filamentPerUnitG: Decimal | null;
  unitCost: Decimal | null;
  totalCost: Decimal | null;
  /** Receita líquida do pedido (valor − taxas do canal). */
  netRevenue: Decimal | null;
  result: Decimal | null;
  marginPct: Decimal | null;
}

/** Previsto × Realizado × Reajustado de um pedido, e o preço sugerido com o peso real. */
export function orderResult(db: DB, o: ProductionOrder) {
  const { input, params } = orderBaseInput(db, o);
  const p = params ?? resolveParams(db, input);
  const qty = Math.max(1, input.quantity);
  let ev;
  try { ev = evaluateQuote(input, p); } catch { return null; }
  const a = ev.pricing.analysis;
  const priceUnit = ev.pricing.selectedUnit;
  const netRevenue = a ? a.revenue.minus(a.fees) : null;

  const planned: ResultColumn = {
    filamentPerUnitG: plannedFilamentPerUnit(input), unitCost: ev.costs.unitTotal, totalCost: ev.costs.total,
    netRevenue, result: a ? a.result : null, marginPct: a ? a.marginPct : null,
  };

  // Reajustado: o orçamento com o filamento real (peso + purga), ao MESMO preço vendido.
  let adjusted: ResultColumn | null = null;
  let suggestedUnit: Decimal | null = null;
  const realPerUnit = measuredFilamentPerUnit(o);
  if (realPerUnit && input.materials.length) {
    const total = sum(input.materials.map((m) => D(m.qtyPerUnit)));
    const adj: QuoteInput = structuredClone(input);
    adj.materials = input.materials.map((m) => ({ ...m, qtyPerUnit: realPerUnit.times(total.isZero() ? D(1).div(input.materials.length) : D(m.qtyPerUnit).div(total)).toDecimalPlaces(4).toNumber() }));
    adj.consumptionBasis = 'total'; // a purga já está no peso informado
    adj.wastePct = null;
    adj.manualPriceUnit = priceUnit ? priceUnit.toString() : null;
    try {
      const evA = evaluateQuote(adj, p);
      // Mesmo preço vendido, inclusive o arredondamento do valor final quando o preço era o sugerido.
      const aa = priceUnit && evA.pricing.channel
        ? analyzeAtPrice(priceUnit, evA.costs, evA.pricing.channel, D(input.discountPct ?? '0'), ev.pricing.selectedSource === 'recomendado' ? input.rounding : 'nenhum')
        : evA.pricing.analysis;
      adjusted = { filamentPerUnitG: realPerUnit, unitCost: evA.costs.unitTotal, totalCost: evA.costs.total, netRevenue, result: aa ? aa.result : null, marginPct: aa ? aa.marginPct : null };
      const evS = evaluateQuote({ ...adj, manualPriceUnit: null }, p);
      suggestedUnit = evS.pricing.recommendedRoundedUnit ?? evS.pricing.recommendedUnit;
    } catch { adjusted = null; }
  }

  // Realizado: consumo e tempo reais da conclusão (custo por peça aprovada).
  let realized: ResultColumn | null = null;
  if (o.actual) {
    const c = compareOrder(db, o);
    if (c.real) {
      const approved = o.actual.qtyApproved;
      const gramsLots = new Map<ID, number>();
      const add = (lotId: ID, q: number) => { const lot = db.lots.find((l) => l.id === lotId); const mat = lot && db.materials.find((x) => x.id === lot.materialId); if (mat?.unit === 'g') gramsLots.set(lotId, (gramsLots.get(lotId) ?? 0) + q); };
      o.actual.materials.forEach((m) => add(m.lotId, m.qty));
      o.actual.failures.forEach((f) => { if (f.lotId && f.qtyLost > 0) add(f.lotId, f.qtyLost); });
      const grams = [...gramsLots.values()].reduce((s, q) => s + q, 0);
      // Receita proporcional às peças aprovadas (as rejeitadas não são vendidas).
      const net = netRevenue ? netRevenue.div(qty).times(approved) : null;
      const result = net ? cents(net.minus(c.real.total)) : null;
      realized = {
        filamentPerUnitG: approved > 0 ? D(grams).div(approved) : null, unitCost: c.real.unit, totalCost: c.real.total,
        netRevenue: net, result, marginPct: result && a && !a.revenue.isZero() ? result.div(a.revenue.div(qty).times(approved)) : null,
      };
    }
  }
  return { qty, priceUnit, planned, realized, adjusted, suggestedUnit, measured: o.measured ?? null };
}

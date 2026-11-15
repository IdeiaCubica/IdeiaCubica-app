/**
 * Purgas (v1.29).
 *
 * Purga = filamento descartado na impressão (torre, "poop", brim, suportes). É medida por COR na produção.
 * O estoque de purgas tem UMA linha por cor (nunca repete a cor) e soma:
 *   - entradas manuais (cadastro na tela de Purgas) e
 *   - entradas da produção (purga por cor informada ao medir a peça).
 * Saídas: reaproveitado (uso avulso), peça de purga (vira peça para vender) e descarte.
 *
 * Valor: cada grama vale o preço do filamento daquela cor na entrada; o saldo fica no custo médio.
 * "Parado em purgas" = saldo em gramas × custo médio da cor.
 *
 * Resultado (sem contar duas vezes):
 *   - O filamento da purga já foi baixado do estoque e entrou no custo REAL do pedido de origem: é desperdício
 *     e já reduz o resultado da empresa (pela venda daquele pedido).
 *   - Peça de purga: o material já foi custeado, então o custo da peça é só o gasto adicional (cordão, tinta,
 *     mão de obra lançada…). A venda entra no mesmo financeiro e no resultado da empresa; o "resultado das purgas"
 *     é mostrado à parte (receita − taxas − gastos adicionais) junto com o valor do material recuperado.
 */
import type { DB, FinishedGood, ID, ISODate, OrderPurge, PurgeMove, PurgeStock } from './types';
import { D, Decimal, ZERO, cents, sum } from './money';
import { BusinessError, assert, audit, byId, isISODate, newId, nextCode, nowISO, requireText, todayISO } from './core';
import { materialCostPolicy } from './quotes';
import { saleEconomics } from './sales';

/** Cor normalizada: minúsculas, sem acento e sem espaços repetidos. */
export function purgeKey(color: string): string {
  return color.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Purga da cor; cria se ainda não existe (uma por cor, sempre). */
export function ensurePurgeStock(db: DB, color: string): PurgeStock {
  const name = requireText(color, 'a cor da purga');
  const key = purgeKey(name);
  const found = db.purgeStocks.find((p) => p.key === key);
  if (found) return found;
  const p: PurgeStock = { id: newId(), color: name.trim().replace(/\s+/g, ' '), key, createdAt: nowISO() };
  db.purgeStocks.push(p);
  return p;
}

/** Cor do filamento (para a purga). */
export function filamentColor(db: DB, materialId?: ID): string | null {
  const m = materialId ? db.materials.find((x) => x.id === materialId) : undefined;
  return m?.filament?.color?.trim() || null;
}

/** Preço por grama de um filamento da cor (o informado, senão o de um filamento cadastrado da mesma cor). */
export function colorCostPerG(db: DB, color: string, materialId?: ID): Decimal {
  const direct = materialId ? materialCostPolicy(db, materialId).unitCost : null;
  if (direct) return direct;
  const key = purgeKey(color);
  for (const m of db.materials.filter((x) => x.filament && x.unit === 'g' && purgeKey(x.filament.color ?? '') === key)) {
    const c = materialCostPolicy(db, m.id).unitCost;
    if (c) return c;
  }
  return ZERO;
}

const IN_KINDS: PurgeMove['kind'][] = ['manual', 'producao'];
const isIn = (m: PurgeMove) => IN_KINDS.includes(m.kind);

/** Situação de uma cor: entradas, saídas, saldo em gramas e valor parado (custo médio). */
export function purgeBalance(db: DB, purgeId: ID) {
  const moves = db.purgeMoves.filter((m) => m.purgeId === purgeId).sort((a, b) => (a.date + a.createdAt).localeCompare(b.date + b.createdAt));
  let g = 0, value = ZERO;
  const by = { manual: 0, producao: 0, reaproveitado: 0, peca: 0, descarte: 0 } as Record<PurgeMove['kind'], number>;
  let inValue = ZERO, outValue = ZERO;
  for (const m of moves) {
    by[m.kind] += m.g;
    const v = D(m.costPerG).times(m.g);
    if (isIn(m)) { g += m.g; value = value.plus(v); inValue = inValue.plus(v); }
    else { g -= m.g; value = value.minus(v); outValue = outValue.plus(v); }
  }
  if (g <= 1e-9) { g = Math.max(0, g); value = Decimal.max(ZERO, value); }
  const avg = g > 0 ? value.div(g) : ZERO;
  return { g: Math.round(g * 100) / 100, value: cents(value), avgPerG: avg, by, inValue: cents(inValue), outValue: cents(outValue), moves };
}

/** Custo médio atual da cor (para valorizar uma saída). */
function currentAvg(db: DB, purgeId: ID) { return purgeBalance(db, purgeId).avgPerG; }

/** Cadastro manual: soma gramas a uma cor (cria a cor se não existir). */
export function addManualPurge(db: DB, input: { color: string; g: number; date: ISODate; costPerKg?: string | null; materialId?: ID; note?: string }) {
  assert(input.g > 0, 'Informe a quantidade de purga em gramas (maior que zero).');
  assert(isISODate(input.date), 'Informe a data.');
  const p = ensurePurgeStock(db, input.color);
  const cpg = input.costPerKg && D(input.costPerKg).gt(0) ? D(input.costPerKg).div(1000) : colorCostPerG(db, p.color, input.materialId);
  const m: PurgeMove = { id: newId(), purgeId: p.id, date: input.date, kind: 'manual', g: input.g, costPerG: cpg.toString(), note: input.note?.trim() || undefined, createdAt: nowISO() };
  db.purgeMoves.push(m);
  audit(db, 'Purga cadastrada', `${p.color}: +${input.g} g`);
  return m;
}

/** Saída: reaproveitado (uso avulso) ou descarte. */
export function takePurge(db: DB, input: { purgeId: ID; g: number; date: ISODate; kind: 'reaproveitado' | 'descarte'; note?: string }) {
  const p = byId(db.purgeStocks, input.purgeId, 'Purga');
  assert(input.g > 0, 'Informe a quantidade em gramas (maior que zero).');
  assert(isISODate(input.date), 'Informe a data.');
  const bal = purgeBalance(db, p.id);
  if (input.g > bal.g + 1e-9) throw new BusinessError(`Só há ${bal.g} g de purga ${p.color}.`);
  const m: PurgeMove = { id: newId(), purgeId: p.id, date: input.date, kind: input.kind, g: input.g, costPerG: currentAvg(db, p.id).toString(), note: input.note?.trim() || undefined, createdAt: nowISO() };
  db.purgeMoves.push(m);
  audit(db, input.kind === 'descarte' ? 'Purga descartada' : 'Purga reaproveitada', `${p.color}: −${input.g} g`);
  return m;
}

/** Remove um lançamento manual/saída avulsa (as entradas da produção mudam pela medição do pedido). */
export function deletePurgeMove(db: DB, moveId: ID) {
  const m = byId(db.purgeMoves, moveId, 'Lançamento de purga');
  assert(m.kind !== 'producao', 'Esta purga veio da produção: corrija a medição do pedido.');
  assert(m.kind !== 'peca', 'Esta saída virou uma peça de purga: exclua a peça para devolver a purga.');
  db.purgeMoves = db.purgeMoves.filter((x) => x.id !== m.id);
  if (isIn(m)) {
    const bal = purgeBalance(db, m.purgeId);
    if (bal.g < -1e-9) { db.purgeMoves.push(m); throw new BusinessError('Esta entrada já foi usada (reaproveitada, descartada ou em peças). Exclua as saídas antes.'); }
  }
  audit(db, 'Lançamento de purga excluído', `${m.kind}: ${m.g} g`);
}

/**
 * Purga medida no pedido: substitui as entradas de produção deste pedido (re-medir não duplica).
 * Cores sem purga cadastrada viram uma purga nova.
 */
export function syncOrderPurges(db: DB, orderId: ID, purges: OrderPurge[], date: ISODate = todayISO()) {
  const old = db.purgeMoves.filter((m) => m.kind === 'producao' && m.orderId === orderId);
  db.purgeMoves = db.purgeMoves.filter((m) => !(m.kind === 'producao' && m.orderId === orderId));
  for (const x of purges.filter((p) => p.g > 0)) {
    const st = ensurePurgeStock(db, x.color);
    db.purgeMoves.push({ id: newId(), purgeId: st.id, date, kind: 'producao', g: x.g, costPerG: colorCostPerG(db, st.color, x.materialId).toString(), orderId, createdAt: nowISO() });
  }
  // Não deixa saldo negativo (a purga já tinha sido usada).
  for (const id of new Set(old.map((m) => m.purgeId))) {
    if (purgeBalance(db, id).g < -1e-9) {
      db.purgeMoves = db.purgeMoves.filter((m) => !(m.kind === 'producao' && m.orderId === orderId)).concat(old);
      const c = db.purgeStocks.find((p) => p.id === id)?.color ?? '';
      throw new BusinessError(`A purga ${c} deste pedido já foi usada (reaproveitada, descartada ou em peças). Não dá para diminuir a medição abaixo do que já saiu.`);
    }
  }
}

/** Pedido cancelado/desfeito: a purga dele sai do estoque de purgas. */
export function dropOrderPurges(db: DB, orderId: ID) {
  syncOrderPurges(db, orderId, []);
}

/** Visão geral: por cor e totais. */
export function purgeOverview(db: DB) {
  const rows = db.purgeStocks.map((p) => ({ p, b: purgeBalance(db, p.id) })).sort((a, b) => b.b.value.cmp(a.b.value) || a.p.color.localeCompare(b.p.color));
  const total = (k: PurgeMove['kind']) => rows.reduce((s, r) => s + r.b.by[k], 0);
  return {
    rows,
    g: rows.reduce((s, r) => s + r.b.g, 0), value: sum(rows.map((r) => r.b.value)),
    generatedG: total('manual') + total('producao'), generatedValue: sum(rows.map((r) => r.b.inValue)),
    reusedG: total('reaproveitado') + total('peca'), discardedG: total('descarte'),
    reusedValue: cents(sum(db.purgeMoves.filter((m) => m.kind === 'reaproveitado' || m.kind === 'peca').map((m) => D(m.costPerG).times(m.g)))),
    discardedValue: cents(sum(db.purgeMoves.filter((m) => m.kind === 'descarte').map((m) => D(m.costPerG).times(m.g)))),
  };
}

/* ---------------- Peças de purga ---------------- */
/**
 * Peça feita com purga: vira peça pronta (estoque de pronta-entrega) para vender pelo fluxo normal.
 * O custo da peça é só o gasto adicional (o filamento já foi custeado no pedido de origem).
 */
export function createPurgePiece(db: DB, input: {
  description: string; qty: number; date: ISODate; uses: { purgeId: ID; g: number }[]; extraCost?: string | null;
  suggestedPrice?: string | null; location?: string; image?: string | null; notes?: string;
}): FinishedGood {
  const description = requireText(input.description, 'a descrição da peça');
  assert(Number.isInteger(input.qty) && input.qty > 0, 'Quantidade de peças deve ser um inteiro maior que zero.');
  assert(isISODate(input.date), 'Informe a data.');
  const uses = input.uses.filter((u) => u.purgeId && u.g > 0);
  assert(uses.length > 0, 'Informe quanto de purga (em gramas) foi usado, por cor.');
  const extra = cents(D(input.extraCost || '0'));
  assert(!extra.isNegative(), 'O gasto adicional não pode ser negativo.');
  const totals = new Map<ID, number>();
  uses.forEach((u) => totals.set(u.purgeId, (totals.get(u.purgeId) ?? 0) + u.g));
  for (const [id, g] of totals) {
    const p = byId(db.purgeStocks, id, 'Purga');
    const bal = purgeBalance(db, id);
    if (g > bal.g + 1e-9) throw new BusinessError(`Só há ${bal.g} g de purga ${p.color}.`);
  }
  const fgId = newId();
  const usesOut = [...totals.entries()].map(([purgeId, g]) => {
    const p = db.purgeStocks.find((x) => x.id === purgeId)!;
    const avg = currentAvg(db, purgeId);
    db.purgeMoves.push({ id: newId(), purgeId, date: input.date, kind: 'peca', g, costPerG: avg.toString(), finishedGoodId: fgId, note: description, createdAt: nowISO() });
    return { purgeId, color: p.color, g, value: cents(avg.times(g)).toString() };
  });
  const fg: FinishedGood = {
    id: fgId, code: nextCode(db, 'finished', 'PC'), description, qtyProduced: input.qty,
    unitCost: extra.div(input.qty).toDecimalPlaces(4).toString(), costStatus: 'realizado',
    suggestedPrice: input.suggestedPrice && D(input.suggestedPrice).gt(0) ? D(input.suggestedPrice).toString() : null,
    producedAt: input.date, location: input.location?.trim() || undefined, image: input.image ?? null, adjustments: [], allocations: [],
    notes: input.notes?.trim() || undefined, createdAt: nowISO(),
    production: { materials: usesOut.map((u) => ({ label: `Purga ${u.color}`, qty: u.g, unit: 'g' })), hours: 0, qtyMade: input.qty },
    purge: { uses: usesOut, materialValue: sum(usesOut.map((u) => D(u.value))).toString(), extraCost: extra.toString() },
  };
  db.finishedGoods.push(fg);
  audit(db, 'Peça de purga', `${fg.code}: ${input.qty} un. de ${description} (${usesOut.map((u) => `${u.color} ${u.g} g`).join(', ')})`);
  return fg;
}

/** Exclui a peça de purga (sem vendas): a purga volta para o estoque de purgas. */
export function deletePurgePiece(db: DB, fgId: ID) {
  const fg = byId(db.finishedGoods, fgId, 'Peça de purga');
  assert(fg.purge, 'Esta peça não é de purga.');
  assert(!db.sales.some((s) => s.status === 'ativa' && s.finishedGoodId === fg.id), 'Esta peça já tem venda. Cancele a venda antes de excluir.');
  db.purgeMoves = db.purgeMoves.filter((m) => m.finishedGoodId !== fg.id);
  db.finishedGoods = db.finishedGoods.filter((g) => g.id !== fg.id);
  audit(db, 'Peça de purga excluída', fg.code);
}

/** Resultado apartado das purgas: peças feitas, vendidas, receita, taxas, gastos adicionais e resultado. */
export function purgeResult(db: DB, from?: ISODate, to?: ISODate) {
  const pieces = db.finishedGoods.filter((g) => g.purge);
  const ids = new Set(pieces.map((g) => g.id));
  const sales = db.sales.filter((s) => s.status === 'ativa' && s.finishedGoodId && ids.has(s.finishedGoodId) && (!from || s.date >= from) && (!to || s.date <= to));
  const eco = sales.map(saleEconomics);
  const revenue = sum(eco.map((e) => e.revenue));
  const fees = sum(eco.map((e) => e.fees));
  const freightNet = sum(eco.map((e) => e.freightNet));
  const cogs = sum(eco.map((e) => e.cogs ?? ZERO));
  return {
    pieces, sales, soldQty: sales.reduce((s, x) => s + x.qty, 0), revenue, fees, freightNet, extraCosts: cogs,
    result: revenue.minus(fees).plus(freightNet).minus(cogs),
    materialRecovered: sum(pieces.map((g) => D(g.purge!.materialValue))),
  };
}

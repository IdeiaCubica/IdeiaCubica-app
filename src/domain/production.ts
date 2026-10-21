/**
 * Produção: projetos, ordens de produção e desempenho das impressoras.
 *
 * Política de estoque (documentada):
 *   - Ao preparar a OP, o material previsto é RESERVADO (não sai do saldo físico).
 *   - Ao concluir, as reservas são liberadas e o consumo REAL é baixado
 *     (movimentos "consumo" + "perda" para falhas), com chaves de idempotência:
 *     concluir duas vezes ou clicar repetidamente não baixa o material de novo.
 *   - Cancelar libera as reservas; OP concluída não pode ser cancelada.
 */
import type { CostParams, DB, ID, OrderStatus, ProductionOrder, Project, QuoteInput } from './types';
import { D, Decimal, ZERO, sum } from './money';
import { BusinessError, assert, audit, byId, newId, nextCode, nowISO, requireNonNegative, requireText, toLocalDate, todayISO } from './core';
import { addMovement, lotBalance, releaseAll, reserve } from './inventory';
import { emptyQuoteInput, latestVersion, resolveParams } from './quotes';
import { computeCosts, laborTotals, type CostResult } from './costing';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  planejada: 'Planejada', aguardando_material: 'Aguardando material', pronta: 'Pronta para produção', em_producao: 'Em produção',
  aguardando_acabamento: 'Aguardando acabamento', em_inspecao: 'Em inspeção', concluida: 'Concluída', cancelada: 'Cancelada',
};

/* ---------------- Projetos ---------------- */
export function saveProject(db: DB, input: Omit<Project, 'id' | 'code' | 'createdAt' | 'files'> & { code?: string }, id?: ID): Project {
  const name = requireText(input.name, 'o nome do produto/projeto');
  if (id) {
    const p = byId(db.projects, id, 'Projeto');
    Object.assign(p, { ...input, name, code: input.code?.trim() || p.code });
    audit(db, 'Projeto alterado', `${p.code} ${name}`);
    return p;
  }
  const p: Project = { ...input, name, id: newId(), code: input.code?.trim() || nextCode(db, 'project', 'PRJ'), files: [], createdAt: nowISO() };
  db.projects.push(p);
  audit(db, 'Projeto cadastrado', `${p.code} ${name}`);
  return p;
}

export function addProjectFileVersion(db: DB, projectId: ID, v: { version: string; fileName: string; date: string; notes?: string }) {
  const p = byId(db.projects, projectId, 'Projeto');
  const version = requireText(v.version, 'a versão');
  assert(!p.files.some((f) => f.version === version), `A versão ${version} já existe neste projeto.`);
  p.files.push({ ...v, version, id: newId() });
  audit(db, 'Nova versão de arquivo', `${p.code}: ${version}`);
}

/* ---------------- Ordens ---------------- */
function plannedFromInput(db: DB, input: QuoteInput) {
  const waste = input.consumptionBasis === 'peca' && input.wastePct ? D(1).plus(D(input.wastePct).div(100)) : D(1);
  return input.materials.map((m) => ({
    materialId: m.materialId ?? db.lots.find((l) => l.id === m.lotId)?.materialId ?? '',
    lotId: m.lotId,
    qty: D(m.qtyPerUnit).times(input.quantity).times(waste).toDecimalPlaces(2, Decimal.ROUND_UP).toNumber(),
  }));
}

/** Quanto desta OP está reservado (por lote). */
export function orderReservations(db: DB, orderId: ID): { lotId: ID; qty: Decimal }[] {
  const map = new Map<ID, Decimal>();
  for (const m of db.movements) {
    if (m.ref.id !== orderId || (m.type !== 'reserva' && m.type !== 'liberacao')) continue;
    map.set(m.lotId, (map.get(m.lotId) ?? ZERO).plus(D(m.qty).times(m.type === 'reserva' ? 1 : -1)));
  }
  return [...map.entries()].filter(([, q]) => q.gt(0)).map(([lotId, qty]) => ({ lotId, qty }));
}

/** Lotes candidatos de uma linha: o lote fixado ou todos os do material, do mais antigo ao mais novo. */
function candidateLots(db: DB, line: ProductionOrder['plannedMaterials'][number]) {
  if (line.lotId) return db.lots.filter((l) => l.id === line.lotId);
  return db.lots.filter((l) => l.materialId === line.materialId).sort((a, b) => (a.date + a.code).localeCompare(b.date + b.code));
}

export function createOrderFromQuote(db: DB, quoteId: ID, opts: { printerId?: ID; responsible?: string; notes?: string } = {}): ProductionOrder {
  const q = byId(db.quotes, quoteId, 'Orçamento');
  assert(q.status !== 'convertido', 'Este orçamento já foi convertido em ordem de produção.');
  assert(q.status !== 'recusado', 'Orçamento recusado não pode gerar produção.');
  const v = latestVersion(q);
  assert(v.input.materials.length > 0, 'O orçamento não possui materiais selecionados.');
  const order: ProductionOrder = {
    id: newId(), number: nextCode(db, 'order', 'OP'), projectId: q.projectId, quoteId: q.id, quoteVersion: v.version,
    description: q.name, printerId: opts.printerId ?? v.input.printerId, qtyPlanned: v.input.quantity,
    plannedMaterials: plannedFromInput(db, v.input),
    plannedHours: v.input.printHoursPerUnit !== null ? D(v.input.printHoursPerUnit).times(v.input.quantity).toNumber() : null,
    status: 'planejada', responsible: opts.responsible, notes: opts.notes, createdAt: nowISO(),
  };
  db.orders.push(order);
  q.status = 'convertido';
  audit(db, 'Ordem de produção criada', `${order.number} a partir de ${q.number} v${v.version}`);
  return order;
}

export function createManualOrder(db: DB, input: {
  description: string; projectId?: ID; printerId?: ID; qtyPlanned: number; plannedMaterials: { lotId: ID; qty: number }[];
  plannedHours: number | null; responsible?: string; notes?: string;
}): ProductionOrder {
  const description = requireText(input.description, 'a descrição da ordem');
  assert(Number.isInteger(input.qtyPlanned) && input.qtyPlanned > 0, 'Quantidade planejada inválida.');
  const planned = input.plannedMaterials.map((m) => {
    const lot = byId(db.lots, m.lotId, 'Lote');
    assert(m.qty > 0, 'Quantidade de material inválida.');
    return { materialId: lot.materialId, lotId: lot.id, qty: m.qty };
  });
  const order: ProductionOrder = { ...input, plannedMaterials: planned, description, id: newId(), number: nextCode(db, 'order', 'OP'), status: 'planejada', createdAt: nowISO() };
  db.orders.push(order);
  audit(db, 'Ordem de produção criada', `${order.number} (manual)`);
  return order;
}

/** Verifica disponibilidade por linha prevista (reservas desta própria OP contam como disponíveis para ela). */
export function checkAvailability(db: DB, order: ProductionOrder) {
  const own = new Map(orderReservations(db, order.id).map((r) => [r.lotId, r.qty]));
  return order.plannedMaterials.map((m) => {
    const available = candidateLots(db, m).reduce((acc, l) => acc.plus(lotBalance(db, l.id).available).plus(own.get(l.id) ?? ZERO), ZERO);
    return { materialId: m.materialId, lotId: m.lotId, needed: D(m.qty), available, shortage: Decimal.max(ZERO, D(m.qty).minus(available)) };
  });
}

/**
 * Reserva o material previsto. Linhas sem lote fixo são atendidas pelos lotes
 * do material por ordem de entrada (FIFO), podendo dividir entre lotes.
 * Se faltar material, a OP fica "Aguardando material" e nada é reservado (tudo ou nada).
 */
export function reserveOrderMaterials(db: DB, orderId: ID): { ok: boolean; shortages: { materialId: ID; shortage: Decimal }[] } {
  const o = byId(db.orders, orderId, 'Ordem');
  assert(['planejada', 'aguardando_material'].includes(o.status), 'Somente ordens planejadas ou aguardando material podem reservar.');
  const shortages = checkAvailability(db, o).filter((c) => c.shortage.gt(0));
  if (shortages.length) {
    o.status = 'aguardando_material';
    audit(db, 'OP aguardando material', o.number);
    return { ok: false, shortages };
  }
  // Agrupa por lote: duas linhas do mesmo lote viram uma única reserva (chave idempotente por lote).
  const toReserve = new Map<ID, Decimal>();
  for (const m of o.plannedMaterials) {
    let remaining = D(m.qty);
    for (const lot of candidateLots(db, m)) {
      if (remaining.lte(0)) break;
      const free = lotBalance(db, lot.id).available.minus(toReserve.get(lot.id) ?? ZERO);
      if (free.lte(0)) continue;
      const take = Decimal.min(free, remaining);
      toReserve.set(lot.id, (toReserve.get(lot.id) ?? ZERO).plus(take));
      remaining = remaining.minus(take);
    }
  }
  for (const [lotId, qty] of toReserve) reserve(db, lotId, qty.toNumber(), o.id);
  o.status = 'pronta';
  audit(db, 'Material reservado', o.number);
  return { ok: true, shortages: [] };
}

export function startOrder(db: DB, orderId: ID) {
  const o = byId(db.orders, orderId, 'Ordem');
  if (o.status === 'planejada' || o.status === 'aguardando_material') {
    const r = reserveOrderMaterials(db, orderId);
    if (!r.ok) throw new BusinessError('Material insuficiente para iniciar. Registre a compra ou ajuste o estoque.');
  }
  assert(o.status === 'pronta', `Não é possível iniciar uma ordem com status "${ORDER_STATUS_LABEL[o.status]}".`);
  o.status = 'em_producao';
  o.startedAt = nowISO();
  audit(db, 'Produção iniciada', o.number);
}

export function moveOrderStatus(db: DB, orderId: ID, to: 'aguardando_acabamento' | 'em_inspecao' | 'em_producao') {
  const o = byId(db.orders, orderId, 'Ordem');
  assert(['em_producao', 'aguardando_acabamento', 'em_inspecao'].includes(o.status), 'Transição de status não permitida.');
  o.status = to;
  audit(db, 'Status da OP', `${o.number}: ${ORDER_STATUS_LABEL[to]}`);
}

export interface CompleteInput {
  materials: { lotId: ID; qty: number }[];
  hours: number;
  qtyApproved: number;
  qtyRejected: number;
  laborMinutes: number | null;
  failures: { description: string; lotId?: ID; qtyLost: number; hoursLost: number }[];
  notes?: string;
}

export function completeOrder(db: DB, orderId: ID, input: CompleteInput) {
  const o = byId(db.orders, orderId, 'Ordem');
  if (o.status === 'concluida') throw new BusinessError('Esta ordem já foi concluída; o consumo não será baixado novamente.');
  assert(['em_producao', 'aguardando_acabamento', 'em_inspecao'].includes(o.status), 'Inicie a produção antes de concluir.');
  requireNonNegative(input.hours, 'Tempo real de impressão');
  assert(Number.isInteger(input.qtyApproved) && input.qtyApproved >= 0, 'Quantidade aprovada inválida.');
  assert(Number.isInteger(input.qtyRejected) && input.qtyRejected >= 0, 'Quantidade rejeitada inválida.');
  assert(input.qtyApproved + input.qtyRejected > 0, 'Informe a quantidade aprovada e/ou rejeitada.');
  assert(input.materials.length > 0 || input.failures.some((f) => f.qtyLost > 0), 'Informe o consumo real de material.');
  if (input.laborMinutes !== null) requireNonNegative(input.laborMinutes, 'Tempo de mão de obra');

  const date = todayISO();
  releaseAll(db, o.id, 'op', 'liberacao_conclusao');
  for (const m of input.materials) {
    if (m.qty <= 0) continue;
    addMovement(db, { lotId: m.lotId, type: 'consumo', qty: m.qty, date, ref: { kind: 'op', id: o.id }, key: `op:${o.id}:consumo:${m.lotId}` });
  }
  const failures = input.failures.map((f) => ({ ...f, id: newId(), description: requireText(f.description, 'a descrição da falha') }));
  for (const f of failures) {
    requireNonNegative(f.qtyLost, 'Material perdido'); requireNonNegative(f.hoursLost, 'Horas perdidas');
    if (f.lotId && f.qtyLost > 0) {
      addMovement(db, { lotId: f.lotId, type: 'perda', qty: f.qtyLost, date, ref: { kind: 'op', id: o.id }, key: `op:${o.id}:perda:${f.id}`, reason: `Falha: ${f.description}` });
    }
  }
  o.actual = { materials: input.materials.filter((m) => m.qty > 0), hours: input.hours, qtyApproved: input.qtyApproved, qtyRejected: input.qtyRejected, laborMinutes: input.laborMinutes, failures, notes: input.notes };
  o.status = 'concluida';
  o.finishedAt = nowISO();
  audit(db, 'Produção concluída', `${o.number}: ${input.qtyApproved} aprovadas, ${input.qtyRejected} rejeitadas`);
}

export function cancelOrder(db: DB, orderId: ID, reason: string) {
  const o = byId(db.orders, orderId, 'Ordem');
  assert(o.status !== 'concluida', 'Ordem concluída não pode ser cancelada (o consumo já ocorreu).');
  assert(o.status !== 'cancelada', 'Ordem já cancelada.');
  releaseAll(db, o.id, 'op', 'liberacao_cancelamento');
  o.status = 'cancelada';
  o.cancelReason = requireText(reason, 'o motivo do cancelamento');
  audit(db, 'OP cancelada', `${o.number} — ${reason}`);
}

/* ---------------- Previsto × realizado ---------------- */
export interface OrderComparison {
  estimated: { total: Decimal | null; unit: Decimal | null; materialQty: Decimal; hours: Decimal | null; complete: boolean };
  real: { total: Decimal; unit: Decimal | null; materialQty: Decimal; hours: Decimal; laborEstimated: boolean; result: CostResult } | null;
}

function orderBaseInput(db: DB, o: ProductionOrder): { input: QuoteInput; params: CostParams | null } {
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const v = q?.versions.find((x) => x.version === o.quoteVersion);
  if (v) return { input: structuredClone(v.input), params: v.params };
  const input = emptyQuoteInput(db.settings);
  input.quantity = o.qtyPlanned;
  input.printerId = o.printerId;
  input.materials = o.plannedMaterials.map((m) => ({ materialId: m.materialId, lotId: m.lotId, qtyPerUnit: m.qty / o.qtyPlanned }));
  input.printHoursPerUnit = o.plannedHours !== null ? o.plannedHours / o.qtyPlanned : null;
  input.failureRatePct = '0';
  return { input, params: null };
}

/**
 * Custo real da OP: recalcula com o MESMO motor de custos usando o consumo e o
 * tempo reais (incluindo perdas), taxa de falha 0 (as falhas reais já estão no
 * consumo) e os parâmetros do orçamento original.
 */
export function compareOrder(db: DB, o: ProductionOrder): OrderComparison {
  const { input, params: snap } = orderBaseInput(db, o);
  const baseParams = snap ?? resolveParams(db, input);
  const est = computeCosts(input, baseParams);
  const estimated = {
    total: est.total, unit: est.unitTotal, materialQty: sum(est.materialLines.map((l) => l.qtyOrder)),
    hours: est.machineHours, complete: est.complete,
  };
  if (!o.actual) return { estimated, real: null };

  const a = o.actual;
  const lostByLot = new Map<ID, number>();
  a.failures.forEach((f) => { if (f.lotId && f.qtyLost > 0) lostByLot.set(f.lotId, (lostByLot.get(f.lotId) ?? 0) + f.qtyLost); });
  const lotTotals = new Map<ID, number>();
  a.materials.forEach((m) => lotTotals.set(m.lotId, (lotTotals.get(m.lotId) ?? 0) + m.qty));
  lostByLot.forEach((q, id) => lotTotals.set(id, (lotTotals.get(id) ?? 0) + q));
  const hoursLost = a.failures.reduce((s, f) => s + f.hoursLost, 0);
  const realHours = a.hours + hoursLost;

  const real: QuoteInput = structuredClone(input);
  real.quantity = 1; // pedido inteiro como "1 lote"; o unitário é dividido pelas aprovadas
  real.consumptionBasis = 'total';
  real.wastePct = null;
  // Realizado usa o custo real dos lotes consumidos; ajustes manuais do orçamento não se aplicam.
  real.materials = [...lotTotals.entries()].map(([lotId, qty]) => ({ materialId: db.lots.find((l) => l.id === lotId)?.materialId ?? '', lotId, qtyPerUnit: qty }));
  real.overrides = {};
  real.printHoursPerUnit = realHours;
  real.failureRatePct = '0';
  real.failureSource = 'historico';
  real.printerId = o.printerId ?? input.printerId;
  const laborEstimated = a.laborMinutes === null;
  const est0 = laborTotals(input.labor);
  real.labor = laborEstimated ? { perOrder: est0.perOrder + est0.perUnit * a.qtyApproved, perUnit: 0 } : { perOrder: a.laborMinutes!, perUnit: 0 };
  real.extras = input.extras.map((e) => ({ ...e, qtyPerUnit: e.qtyPerUnit * a.qtyApproved }));
  // Amortização: (custo ÷ unidades previstas) × aprovadas. Com Q = 1, equivale a dividir por (previstas ÷ aprovadas).
  if (real.development.mode === 'diluir') {
    real.development = a.qtyApproved > 0 && real.development.expectedUnits
      ? { ...real.development, expectedUnits: real.development.expectedUnits / a.qtyApproved }
      : { ...real.development, mode: 'nenhum' };
  }

  const fresh = resolveParams(db, real);
  const realParams: CostParams = { ...baseParams, lots: { ...baseParams.lots, ...fresh.lots }, materials: { ...baseParams.materials, ...fresh.materials }, printer: fresh.printer ?? baseParams.printer };
  const r = computeCosts(real, realParams);
  return {
    estimated,
    real: {
      total: r.total, unit: a.qtyApproved > 0 ? r.total.div(a.qtyApproved) : null,
      materialQty: sum([...lotTotals.values()]), hours: D(realHours), laborEstimated, result: r,
    },
  };
}

/* ---------------- Desempenho das impressoras ---------------- */
export function printerStats(db: DB, printerId: ID, monthISO = todayISO().slice(0, 7)) {
  const p = byId(db.printers, printerId, 'Impressora');
  const done = db.orders.filter((o) => o.printerId === printerId && o.status === 'concluida' && o.actual);
  let hours = ZERO, monthHours = ZERO, approved = 0, rejected = 0, material = ZERO, lostHours = ZERO;
  for (const o of done) {
    const a = o.actual!;
    const lost = a.failures.reduce((s, f) => s + f.hoursLost, 0);
    const h = D(a.hours).plus(lost);
    hours = hours.plus(h);
    lostHours = lostHours.plus(lost);
    if (o.finishedAt && toLocalDate(o.finishedAt).slice(0, 7) === monthISO) monthHours = monthHours.plus(h);
    approved += a.qtyApproved; rejected += a.qtyRejected;
    material = material.plus(sum(a.materials.map((m) => m.qty))).plus(sum(a.failures.map((f) => f.qtyLost)));
  }
  const units = approved + rejected;
  const maintenanceCost = sum(p.maintenance.map((m) => m.cost));
  const downtime = p.maintenance.reduce((s, m) => s + (m.downtimeHours ?? 0), 0);
  return {
    orders: done.length,
    totalHours: hours.plus(p.initialHours),
    systemHours: hours,
    monthHours,
    availableMonth: p.availableHoursPerMonth,
    utilization: p.availableHoursPerMonth ? monthHours.div(p.availableHoursPerMonth) : null,
    successRate: units ? D(approved).div(units) : null,
    failureRate: units ? D(rejected).div(units) : null,
    lostHours,
    material,
    maintenanceCost,
    downtime,
    lifeUsed: p.usefulLifeHours ? hours.plus(p.initialHours).div(p.usefulLifeHours) : null,
  };
}

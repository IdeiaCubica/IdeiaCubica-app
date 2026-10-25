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
import type { CostParams, DB, FinishedGood, ID, OrderStatus, ProductionOrder, Project, Quote, QuoteInput, QuoteVersionItem } from './types';
import { D, Decimal, ZERO, sum } from './money';
import { BusinessError, assert, audit, byId, newId, nextCode, nowISO, requireNonNegative, requireText, toLocalDate, todayISO } from './core';
import { addMovement, lotBalance, releaseAll, reserve } from './inventory';
import { materialLabel } from './catalog';
import { MAX_IMAGE_CHARS, deleteQuote, emptyQuoteInput, evaluateQuote, isItemLocked, itemState, latestVersion, quoteItem, quoteItemAt, quoteItems, refreshQuoteStatus, resolveParams, saveQuote, summarize, type QuoteItemDraft } from './quotes';
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
  const filament = input.materials.map((m) => ({
    materialId: m.materialId ?? db.lots.find((l) => l.id === m.lotId)?.materialId ?? '',
    lotId: m.lotId,
    qty: D(m.qtyPerUnit).times(input.quantity).times(waste).toDecimalPlaces(2, Decimal.ROUND_UP).toNumber(),
  }));
  // Complementos do estoque (luminária, ímã…): reservados e baixados junto com o filamento.
  const complements = input.extras.filter((e) => e.materialId && e.qtyPerUnit > 0).map((e) => ({
    materialId: e.materialId!, lotId: e.lotId, qty: D(e.qtyPerUnit).times(input.quantity).toDecimalPlaces(4, Decimal.ROUND_UP).toNumber(),
  }));
  return [...filament, ...complements];
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

export const QUEUE_STATUSES: OrderStatus[] = ['planejada', 'aguardando_material', 'pronta'];

/** Próxima posição no fim da fila. */
function nextSequence(db: DB): number {
  return db.orders.reduce((max, o) => Math.max(max, o.sequence ?? 0), 0) + 1;
}

/**
 * Envia peças do orçamento para produção: um PEDIDO por peça, com data de entrega
 * obrigatória. Peças recusadas, já em produção ou vindas do estoque não entram.
 */
export function createOrdersFromQuote(db: DB, quoteId: ID, itemIds: ID[], opts: { dueDate: string; printerId?: ID; responsible?: string; notes?: string }): ProductionOrder[] {
  const q = byId(db.quotes, quoteId, 'Orçamento');
  assert(itemIds.length > 0, 'Escolha ao menos uma peça para produzir.');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(opts.dueDate ?? ''), 'Informe a data de entrega do pedido.');
  const v = latestVersion(q);
  const orders = itemIds.map((itemId) => {
    const it = quoteItem(q, itemId);
    const state = itemState(db, q, itemId);
    assert(state !== 'recusado', `A peça "${it.name}" foi recusada. Reabra-a antes de produzir.`);
    assert(state !== 'producao' && state !== 'produzido', `A peça "${it.name}" já está em produção.`);
    assert(!it.finishedGoodId, `A peça "${it.name}" vem do estoque de peças prontas: aprove-a (Pedido aprovado) em vez de produzir.`);
    assert(it.input.materials.length > 0, `A peça "${it.name}" não possui filamento selecionado.`);
    const order: ProductionOrder = {
      id: newId(), number: nextCode(db, 'pedido', 'PED'), projectId: q.projectId, quoteId: q.id, quoteVersion: v.version, quoteItemId: itemId,
      description: it.name, printerId: opts.printerId ?? it.input.printerId, qtyPlanned: it.input.quantity,
      plannedMaterials: plannedFromInput(db, it.input),
      plannedHours: it.input.printHoursPerUnit !== null ? D(it.input.printHoursPerUnit).times(it.input.quantity).toNumber() : null,
      status: 'planejada', responsible: opts.responsible, notes: opts.notes, createdAt: nowISO(),
      purpose: 'pedido', customerId: q.customerId, dueDate: opts.dueDate, sequence: nextSequence(db),
    };
    db.orders.push(order);
    q.itemStatus = { ...q.itemStatus, [itemId]: 'aprovado' };
    audit(db, 'Pedido criado', `${order.number}: ${it.name} (${q.number} v${v.version}), entrega ${opts.dueDate}`);
    return order;
  });
  refreshQuoteStatus(db, q);
  return orders;
}

/** Atalho: envia todas as peças possíveis do orçamento (compatível com o fluxo de uma peça). */
export function createOrderFromQuote(db: DB, quoteId: ID, opts: { dueDate?: string; printerId?: ID; responsible?: string; notes?: string } = {}): ProductionOrder {
  const q = byId(db.quotes, quoteId, 'Orçamento');
  const ids = quoteItems(q).filter((it) => !it.finishedGoodId && ['aberto', 'aprovado'].includes(itemState(db, q, it.itemId))).map((it) => it.itemId);
  assert(ids.length > 0, 'Não há peças disponíveis para produzir neste orçamento.');
  return createOrdersFromQuote(db, quoteId, ids, { ...opts, dueDate: opts.dueDate ?? todayISO() })[0];
}

/**
 * Retorna um pedido (ainda não concluído) para o orçamento: cancela o pedido,
 * libera o material reservado e a peça volta a ficar "Aprovada" e editável.
 */
export function returnOrderToQuote(db: DB, orderId: ID, reason: string) {
  const o = byId(db.orders, orderId, 'Pedido');
  assert(o.quoteId, 'Este pedido não veio de um orçamento.');
  assert(o.status !== 'concluida', 'Pedido já produzido não pode voltar para o orçamento.');
  assert(o.status !== 'cancelada', 'Pedido já cancelado.');
  const why = requireText(reason, 'o motivo');
  releaseAll(db, o.id, 'op', 'liberacao_cancelamento');
  o.status = 'cancelada';
  o.cancelReason = `Retornado para o orçamento: ${why}`;
  const q = db.quotes.find((x) => x.id === o.quoteId);
  if (q) {
    if (o.quoteItemId) q.itemStatus = { ...q.itemStatus, [o.quoteItemId]: 'aprovado' };
    refreshQuoteStatus(db, q);
  }
  audit(db, 'Pedido retornado para o orçamento', `${o.number} — ${why}`);
}

/** Custo e preço sugerido de uma produção para estoque (mesmo motor dos orçamentos, padrões de Parâmetros). */
export function stockEstimate(db: DB, o: Pick<ProductionOrder, 'qtyPlanned' | 'plannedMaterials' | 'plannedHours' | 'printerId'>) {
  const input = emptyQuoteInput(db.settings);
  input.quantity = o.qtyPlanned;
  input.printerId = o.printerId ?? input.printerId;
  input.materials = o.plannedMaterials.map((m) => ({ materialId: m.materialId, lotId: m.lotId, qtyPerUnit: m.qty / o.qtyPlanned }));
  input.printHoursPerUnit = o.plannedHours !== null ? o.plannedHours / o.qtyPlanned : null;
  // Produção para estoque não tem atendimento por pedido; só o tempo por peça.
  input.labor = { perOrder: 0, perUnit: input.labor.perUnit };
  input.shipping = undefined;
  const params = resolveParams(db, input);
  const ev = evaluateQuote(input, params);
  return { input, params, summary: summarize(ev), ev };
}

export function createManualOrder(db: DB, input: {
  description: string; projectId?: ID; printerId?: ID; qtyPlanned: number;
  /** Com lote: reserva daquele lote. Só com material: lotes por ordem de entrada. */
  plannedMaterials: { materialId?: ID; lotId?: ID; qty: number }[];
  plannedHours: number | null; responsible?: string; notes?: string;
  purpose?: 'pedido' | 'estoque'; customerId?: ID; dueDate?: string; image?: string | null;
}): ProductionOrder {
  const description = requireText(input.description, 'a descrição da ordem');
  if (input.image) assert(input.image.length <= MAX_IMAGE_CHARS, 'A foto é grande demais. Use uma imagem menor.');
  assert(Number.isInteger(input.qtyPlanned) && input.qtyPlanned > 0, 'Quantidade planejada inválida.');
  if (input.plannedHours !== null) requireNonNegative(input.plannedHours, 'Horas previstas');
  const planned = input.plannedMaterials.map((m) => {
    assert(m.qty > 0, 'Quantidade de material inválida.');
    if (m.lotId) {
      const lot = byId(db.lots, m.lotId, 'Lote');
      return { materialId: lot.materialId, lotId: lot.id, qty: m.qty };
    }
    const mat = byId(db.materials, m.materialId ?? '', 'Material');
    return { materialId: mat.id, qty: m.qty };
  });
  const purpose = input.purpose ?? 'estoque';
  if (input.customerId) byId(db.parties, input.customerId, 'Cliente');
  const order: ProductionOrder = {
    ...input, plannedMaterials: planned, description, id: newId(),
    number: purpose === 'estoque' ? nextCode(db, 'estoque', 'EST') : nextCode(db, 'pedido', 'PED'), status: 'planejada', createdAt: nowISO(),
    purpose, customerId: purpose === 'pedido' ? input.customerId : undefined, dueDate: input.dueDate || undefined, sequence: nextSequence(db),
  };
  if (purpose === 'estoque' && planned.length) {
    const e = stockEstimate(db, order);
    order.estimate = { input: e.input, params: e.params, summary: e.summary };
  }
  db.orders.push(order);
  audit(db, purpose === 'estoque' ? 'Produção para estoque criada' : 'Pedido criado', `${order.number} ${description}`);
  return order;
}

/**
 * Peças para estoque JÁ produzidas: cria a produção e conclui na hora, baixando o
 * material do estoque (lotes por ordem de entrada) e lançando as peças prontas
 * com o custo real. Falta de material bloqueia (nada é lançado).
 */
export function produceForStockNow(db: DB, input: Parameters<typeof createManualOrder>[1] & { location?: string }): ProductionOrder {
  assert(input.plannedMaterials.length > 0, 'Informe o material usado para baixar do estoque.');
  const o = createManualOrder(db, { ...input, purpose: 'estoque' });
  const r = reserveOrderMaterials(db, o.id);
  if (!r.ok) {
    const desc = r.shortages.map((s) => { const m = db.materials.find((x) => x.id === s.materialId); return `${m ? materialLabel(m) : 'material'}: faltam ${s.shortage.toString()} ${m?.unit ?? ''}`; }).join('; ');
    throw new BusinessError(`Estoque insuficiente para baixar o material (${desc}). Registre a compra ou o estoque inicial antes.`);
  }
  startOrder(db, o.id);
  completeOrder(db, o.id, {
    materials: orderReservations(db, o.id).map((x) => ({ lotId: x.lotId, qty: x.qty.toNumber() })),
    hours: input.plannedHours ?? 0, qtyApproved: input.qtyPlanned, qtyRejected: 0, laborMinutes: null, failures: [], notes: input.notes, location: input.location,
  });
  return o;
}

/** Ordem do quadro: data de entrega mais próxima primeiro (sem data por último); empate pela ordem de criação. */
export function byDelivery(a: ProductionOrder, b: ProductionOrder) {
  return (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31')
    || (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt);
}

/** Fila de produção (planejadas, aguardando material e prontas), pela data de entrega. */
export function productionQueue(db: DB): ProductionOrder[] {
  return db.orders.filter((o) => QUEUE_STATUSES.includes(o.status)).sort(byDelivery);
}

/**
 * Falta de material considerando a ORDEM da fila: o disponível de cada material
 * é consumido pelas OPs ainda não reservadas, da primeira para a última.
 * Retorna, por OP, quanto falta de cada material.
 */
export function queueShortages(db: DB): Map<ID, { materialId: ID; shortage: Decimal }[]> {
  const remaining = new Map<ID, Decimal>();
  const avail = (materialId: ID) => {
    if (!remaining.has(materialId)) {
      remaining.set(materialId, db.lots.filter((l) => l.materialId === materialId).reduce((a, l) => a.plus(lotBalance(db, l.id).available), ZERO));
    }
    return remaining.get(materialId)!;
  };
  const out = new Map<ID, { materialId: ID; shortage: Decimal }[]>();
  for (const o of productionQueue(db)) {
    if (o.status === 'pronta') continue; // já reservada
    const short: { materialId: ID; shortage: Decimal }[] = [];
    for (const m of o.plannedMaterials) {
      const left = avail(m.materialId).minus(m.qty);
      remaining.set(m.materialId, left);
      if (left.isNegative()) short.push({ materialId: m.materialId, shortage: Decimal.min(D(m.qty), left.abs()) });
    }
    if (short.length) out.set(o.id, short);
  }
  return out;
}

/** Move a OP para a posição `index` (0 = primeira) da fila e renumera a sequência. */
export function moveInQueue(db: DB, orderId: ID, index: number) {
  const queue = productionQueue(db);
  const from = queue.findIndex((o) => o.id === orderId);
  assert(from >= 0, 'Somente ordens na fila (ainda não iniciadas) podem ser reordenadas.');
  const [o] = queue.splice(from, 1);
  queue.splice(Math.max(0, Math.min(index, queue.length)), 0, o);
  queue.forEach((x, i) => { x.sequence = i + 1; });
}

export function updateOrderPlanning(db: DB, orderId: ID, input: { purpose: 'pedido' | 'estoque'; customerId?: ID; dueDate?: string; printerId?: ID; notes?: string }) {
  const o = byId(db.orders, orderId, 'Ordem');
  assert(o.status !== 'concluida' && o.status !== 'cancelada', 'Ordem encerrada não pode ser alterada.');
  if (input.customerId) byId(db.parties, input.customerId, 'Cliente');
  o.purpose = input.purpose;
  o.customerId = input.purpose === 'pedido' ? input.customerId : undefined;
  o.dueDate = input.dueDate || undefined;
  o.printerId = input.printerId || undefined;
  o.notes = input.notes;
  audit(db, 'Planejamento da OP alterado', o.number);
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
  /** Onde as peças prontas ficam guardadas (OP para estoque). */
  location?: string;
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
  if (o.purpose === 'estoque' && input.qtyApproved > 0) addFinishedGoodFromOrder(db, o, input.location);
  audit(db, 'Produção concluída', `${o.number}: ${input.qtyApproved} aprovadas, ${input.qtyRejected} rejeitadas`);
}

/* ---------------- Peças prontas (pronta-entrega) ---------------- */
function addFinishedGoodFromOrder(db: DB, o: ProductionOrder, location?: string) {
  const cmp = compareOrder(db, o);
  const unit = cmp.real?.unit ?? null;
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const item = q ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) : undefined;
  const price = item?.summary.unitPrice ?? o.estimate?.summary.unitPrice ?? null;
  const a = o.actual!;
  // Consumo real total (inclui perdas), agrupado por material, para consulta no estoque de peças.
  const byMat = new Map<ID, number>();
  const addQty = (lotId: ID, qty: number) => { const mid = db.lots.find((l) => l.id === lotId)?.materialId; if (mid) byMat.set(mid, (byMat.get(mid) ?? 0) + qty); };
  a.materials.forEach((m) => addQty(m.lotId, m.qty));
  a.failures.forEach((f) => { if (f.lotId && f.qtyLost > 0) addQty(f.lotId, f.qtyLost); });
  const fg: FinishedGood = {
    id: newId(), code: nextCode(db, 'finished', 'PC'), description: o.description, orderId: o.id, projectId: o.projectId, quoteId: o.quoteId,
    qtyProduced: a.qtyApproved, unitCost: unit ? unit.toDecimalPlaces(4).toString() : null,
    costStatus: unit ? (cmp.real!.laborEstimated ? 'estimado' : 'realizado') : 'pendente',
    suggestedPrice: price, producedAt: toLocalDate(o.finishedAt!), location: location?.trim() || undefined,
    image: o.image ?? item?.image ?? null, adjustments: [], allocations: [], createdAt: nowISO(),
    production: {
      materials: [...byMat.entries()].map(([mid, qty]) => { const m = db.materials.find((x) => x.id === mid); return { label: m ? (m.filament ? `${m.name} (${m.filament.materialType} ${m.filament.color})` : m.name) : 'Material removido', qty, unit: m?.unit ?? '' }; }),
      hours: a.hours + a.failures.reduce((s, f) => s + f.hoursLost, 0),
      qtyMade: a.qtyApproved + a.qtyRejected,
    },
  };
  db.finishedGoods.push(fg);
  o.finishedGoodId = fg.id;
  audit(db, 'Peças prontas em estoque', `${fg.code}: ${fg.qtyProduced} un. de ${o.number}`);
}

/** Cadastra peças prontas já existentes (produzidas antes do sistema). */
export function registerFinishedGood(db: DB, input: {
  description: string; projectId?: ID; qty: number; unitCost: string | null; suggestedPrice?: string | null; producedAt: string; location?: string; notes?: string; image?: string | null;
}): FinishedGood {
  const description = requireText(input.description, 'a descrição da peça');
  if (input.image) assert(input.image.length <= MAX_IMAGE_CHARS, 'A foto é grande demais. Use uma imagem menor.');
  assert(Number.isInteger(input.qty) && input.qty > 0, 'Quantidade deve ser um inteiro maior que zero.');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(input.producedAt), 'Informe a data de produção.');
  const cost = input.unitCost ? D(input.unitCost) : null;
  if (cost) assert(!cost.isNegative(), 'Custo não pode ser negativo.');
  const fg: FinishedGood = {
    id: newId(), code: nextCode(db, 'finished', 'PC'), description, projectId: input.projectId, qtyProduced: input.qty,
    unitCost: cost ? cost.toString() : null, costStatus: cost ? 'estimado' : 'pendente', suggestedPrice: input.suggestedPrice || null,
    producedAt: input.producedAt, location: input.location?.trim() || undefined, notes: input.notes, image: input.image ?? null, adjustments: [], createdAt: nowISO(),
  };
  db.finishedGoods.push(fg);
  audit(db, 'Peças prontas cadastradas', `${fg.code}: ${fg.qtyProduced} un.`);
  return fg;
}

/** Peças sem venda, baixa ou separação podem ter quantidade/custo corrigidos ou ser excluídas. */
export function isUntouchedFinishedGood(db: DB, fgId: ID) {
  const fg = byId(db.finishedGoods, fgId, 'Peça pronta');
  return !db.sales.some((s) => s.finishedGoodId === fgId && s.status === 'ativa') && fg.adjustments.length === 0 && !(fg.allocations ?? []).length
    && !db.quotes.some((q) => q.versions.some((v) => v.items.some((it) => it.finishedGoodId === fgId)));
}

/**
 * Corrige peças prontas. Descrição, local, preço previsto e observações sempre podem mudar;
 * quantidade, custo e data só em peças cadastradas à mão e ainda não movimentadas
 * (as produzidas vêm do consumo real da produção).
 */
export function updateFinishedGood(db: DB, fgId: ID, input: {
  description: string; location?: string; suggestedPrice?: string | null; notes?: string; qty?: number; unitCost?: string | null; producedAt?: string;
  /** Foto: sempre pode ser trocada (undefined = mantém). */
  image?: string | null;
}) {
  const fg = byId(db.finishedGoods, fgId, 'Peça pronta');
  if (input.image) assert(input.image.length <= MAX_IMAGE_CHARS, 'A foto é grande demais. Use uma imagem menor.');
  if (input.image !== undefined) fg.image = input.image;
  const description = requireText(input.description, 'a descrição da peça');
  if (input.suggestedPrice) assert(D(input.suggestedPrice).gte(0), 'O preço não pode ser negativo.');
  const changesCore = (input.qty !== undefined && input.qty !== fg.qtyProduced)
    || (input.unitCost !== undefined && (input.unitCost ?? null) !== fg.unitCost)
    || (input.producedAt !== undefined && input.producedAt !== fg.producedAt);
  if (changesCore) {
    assert(!fg.orderId, 'Quantidade, custo e data de peças produzidas vêm da produção e não podem ser alterados aqui.');
    assert(isUntouchedFinishedGood(db, fgId), 'Estas peças já foram vendidas, baixadas ou orçadas. Use “Dar baixa” para corrigir a quantidade.');
    if (input.qty !== undefined) { assert(Number.isInteger(input.qty) && input.qty > 0, 'Quantidade deve ser um inteiro maior que zero.'); fg.qtyProduced = input.qty; }
    if (input.unitCost !== undefined) {
      const c = input.unitCost ? D(input.unitCost) : null;
      if (c) assert(!c.isNegative(), 'Custo não pode ser negativo.');
      fg.unitCost = c ? c.toString() : null;
      fg.costStatus = c ? 'estimado' : 'pendente';
    }
    if (input.producedAt !== undefined) { assert(/^\d{4}-\d{2}-\d{2}$/.test(input.producedAt), 'Informe a data de produção.'); fg.producedAt = input.producedAt; }
  }
  Object.assign(fg, { description, location: input.location?.trim() || undefined, suggestedPrice: input.suggestedPrice || null, notes: input.notes });
  audit(db, 'Peças prontas alteradas', `${fg.code} ${description}`);
  return fg;
}

/** Exclui peças lançadas por engano (sem venda, baixa, separação ou orçamento). */
export function deleteFinishedGood(db: DB, fgId: ID, reason: string) {
  const fg = byId(db.finishedGoods, fgId, 'Peça pronta');
  const why = requireText(reason, 'o motivo da exclusão');
  assert(isUntouchedFinishedGood(db, fgId), 'Estas peças já foram vendidas, baixadas, separadas ou orçadas e não podem ser excluídas. Use “Dar baixa”.');
  if (fg.orderId) {
    const o = db.orders.find((x) => x.id === fg.orderId);
    if (o) o.finishedGoodId = undefined;
  }
  db.finishedGoods = db.finishedGoods.filter((x) => x.id !== fgId);
  audit(db, 'Peças prontas excluídas', `${fg.code} ${fg.description} — ${why}`);
}

export function finishedGoodBalance(db: DB, fgId: ID) {
  const fg = byId(db.finishedGoods, fgId, 'Peça pronta');
  const sold = db.sales.filter((s) => s.finishedGoodId === fgId && s.status === 'ativa').reduce((a, s) => a + s.qty, 0);
  const adjusted = fg.adjustments.reduce((a, x) => a + x.qty, 0);
  const allocated = (fg.allocations ?? []).reduce((a, x) => a + x.qty, 0);
  return { produced: fg.qtyProduced, sold, adjusted, allocated, available: fg.qtyProduced - sold - adjusted - allocated };
}

/**
 * Orçamento a partir de uma peça pronta do estoque: o cliente pediu o valor.
 * A peça continua no estoque até o usuário marcar "Pedido aprovado".
 */
/** Peça do estoque de peças prontas como item de orçamento (preço = sugerido da peça, ou o informado). */
export function finishedGoodDraft(db: DB, fgId: ID, opts: { qty: number; unitPrice?: string | null }): QuoteItemDraft {
  const fg = byId(db.finishedGoods, fgId, 'Peça pronta');
  assert(Number.isInteger(opts.qty) && opts.qty > 0, 'Quantidade deve ser um inteiro maior que zero.');
  const bal = finishedGoodBalance(db, fgId);
  assert(opts.qty <= bal.available, `Só há ${bal.available} peça(s) disponível(is) de ${fg.code}.`);
  const order = fg.orderId ? db.orders.find((o) => o.id === fg.orderId) : undefined;
  const base = order ? orderBaseInput(db, order).input : emptyQuoteInput(db.settings);
  const input: QuoteInput = { ...structuredClone(base), quantity: opts.qty, labor: { perOrder: 0, perUnit: 0 }, overrides: {} };
  delete input.deliveryKitShare;
  // Custos seguem o mesmo motor (para a margem); o preço ao cliente é o preço sugerido da peça, ou o informado.
  input.manualPriceUnit = opts.unitPrice ?? fg.suggestedPrice ?? null;
  return { name: fg.description, image: fg.image ?? null, input, finishedGoodId: fg.id };
}

export function quoteFromFinishedGood(db: DB, fgId: ID, opts: { customerId?: ID; qty: number; unitPrice?: string | null }) {
  const draft = finishedGoodDraft(db, fgId, opts);
  return saveQuote(db, { customerId: opts.customerId, name: draft.name }, [draft]);
}

/**
 * Orçamento kit: junta peças de vários orçamentos (inclusive peças do estoque) num único
 * orçamento. Peças recusadas ficam de fora; peças em produção ou separadas impedem a junção.
 * Os valores salvos de cada peça são mantidos (mesmo preço dos orçamentos de origem).
 */
export function mergeQuotes(db: DB, quoteIds: ID[], opts: { name?: string; customerId?: ID; deleteSources: boolean }): Quote {
  const ids = [...new Set(quoteIds)];
  assert(ids.length >= 2, 'Selecione ao menos dois orçamentos para juntar.');
  const sources = ids.map((id) => byId(db.quotes, id, 'Orçamento'));
  const picked: { q: Quote; it: QuoteVersionItem }[] = [];
  for (const q of sources) {
    for (const it of quoteItems(q)) {
      if (itemState(db, q, it.itemId) === 'recusado') continue;
      assert(!isItemLocked(db, q, it.itemId), `A peça "${it.name}" de ${q.number} já está em produção ou separada do estoque. Retorne-a para o orçamento antes de juntar.`);
      picked.push({ q, it });
    }
  }
  assert(picked.length > 0, 'Os orçamentos selecionados não têm peças em aberto para juntar.');
  const customers = new Set(sources.map((q) => q.customerId).filter(Boolean));
  const customerId = opts.customerId ?? (customers.size === 1 ? [...customers][0] : undefined);
  const drafts: QuoteItemDraft[] = picked.map(({ it }) => {
    const input = structuredClone(it.input);
    delete input.deliveryKitShare; // o kit de entrega é escolhido no orçamento novo
    return { name: it.name, image: it.image ?? null, input, finishedGoodId: it.finishedGoodId };
  });
  const first = latestVersion(sources[0]);
  const merged = saveQuote(db, { name: opts.name?.trim() || `Kit: ${picked.map((p) => p.it.name).slice(0, 3).join(' + ')}${picked.length > 3 ? '…' : ''}`, customerId,
    note: `Junção de ${sources.map((q) => q.number).join(', ')}` }, drafts, first.shipping);
  // Mantém o snapshot (custos e preço) de cada peça quando a entrada não mudou.
  latestVersion(merged).items.forEach((item, i) => {
    const src = picked[i].it;
    if (JSON.stringify(src.input) === JSON.stringify(item.input)) { item.params = structuredClone(src.params); item.summary = structuredClone(src.summary); }
  });
  if (opts.deleteSources) for (const q of sources) deleteQuote(db, q.id, `Juntado no orçamento ${merged.number}`);
  audit(db, 'Orçamentos juntados', `${sources.map((q) => q.number).join(' + ')} → ${merged.number}`);
  return merged;
}

/** Baixa manual (avaria, brinde, uso próprio). */
export function writeOffFinishedGood(db: DB, fgId: ID, qty: number, reason: string, date = todayISO()) {
  const fg = byId(db.finishedGoods, fgId, 'Peça pronta');
  assert(Number.isInteger(qty) && qty > 0, 'Quantidade deve ser um inteiro maior que zero.');
  const why = requireText(reason, 'o motivo da baixa');
  assert(qty <= finishedGoodBalance(db, fgId).available, 'Quantidade maior que o saldo disponível.');
  fg.adjustments.push({ id: newId(), date, qty, reason: why });
  audit(db, 'Baixa de peças prontas', `${fg.code}: ${qty} un. — ${why}`);
}

/** Dias desde a produção (para ver há quanto tempo a peça está parada). */
export function daysInStock(fg: Pick<FinishedGood, 'producedAt'>, today = todayISO()): number {
  return Math.max(0, Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(fg.producedAt + 'T00:00:00Z')) / 86_400_000));
}

/** Situação do pedido de cliente: em fila, produzindo, pronto para entregar ou entregue (venda registrada). */
export function orderDelivery(db: DB, o: ProductionOrder): 'fila' | 'producao' | 'pronto' | 'entregue' | 'cancelado' {
  if (o.status === 'cancelada') return 'cancelado';
  if (o.status !== 'concluida') return QUEUE_STATUSES.includes(o.status) ? 'fila' : 'producao';
  return db.sales.some((s) => s.orderId === o.id && s.status === 'ativa') ? 'entregue' : 'pronto';
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

/** Troca a foto da produção; se já gerou peças prontas, atualiza a foto delas também. */
export function setOrderImage(db: DB, orderId: ID, image: string | null) {
  const o = byId(db.orders, orderId, 'Pedido/produção');
  if (image) assert(image.length <= MAX_IMAGE_CHARS, 'A foto é grande demais. Use uma imagem menor.');
  o.image = image;
  const fg = o.finishedGoodId ? db.finishedGoods.find((g) => g.id === o.finishedGoodId) : undefined;
  if (fg) fg.image = image;
  audit(db, 'Foto da produção alterada', o.number);
}

/** Motivo pelo qual o pedido/produção não pode ser excluído (null = pode). */
export function orderDeleteBlock(db: DB, o: ProductionOrder): string | null {
  if (db.sales.some((s) => s.orderId === o.id && s.status === 'ativa')) return 'Há venda registrada deste pedido. Cancele a venda antes de excluir.';
  const fg = o.finishedGoodId ? db.finishedGoods.find((g) => g.id === o.finishedGoodId) : undefined;
  if (fg && !isUntouchedFinishedGood(db, fg.id)) return `As peças produzidas (${fg.code}) já foram vendidas, baixadas, separadas ou orçadas. Desfaça isso antes de excluir.`;
  return null;
}

/**
 * Exclui um pedido/produção por completo (lançado por engano): apaga reservas e baixas de
 * material (o filamento volta ao estoque), as peças prontas geradas e o próprio registro.
 * Pedido de orçamento: a peça volta a "aprovada" no orçamento.
 */
export function deleteOrder(db: DB, orderId: ID, reason: string) {
  const o = byId(db.orders, orderId, 'Pedido/produção');
  const why = requireText(reason, 'o motivo da exclusão');
  const block = orderDeleteBlock(db, o);
  if (block) throw new BusinessError(block);
  db.movements = db.movements.filter((m) => !(m.ref.kind === 'op' && m.ref.id === o.id));
  if (o.finishedGoodId) db.finishedGoods = db.finishedGoods.filter((g) => g.id !== o.finishedGoodId);
  db.orders = db.orders.filter((x) => x.id !== o.id);
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  if (q && o.status !== 'cancelada') {
    if (o.quoteItemId) q.itemStatus = { ...q.itemStatus, [o.quoteItemId]: 'aprovado' };
    refreshQuoteStatus(db, q);
  }
  audit(db, 'Pedido/produção excluído', `${o.number} ${o.description} — ${why}`);
}

/* ---------------- Previsto × realizado ---------------- */
export interface OrderComparison {
  estimated: { total: Decimal | null; unit: Decimal | null; materialQty: Decimal; hours: Decimal | null; complete: boolean };
  real: { total: Decimal; unit: Decimal | null; materialQty: Decimal; hours: Decimal; laborEstimated: boolean; result: CostResult } | null;
}

function orderBaseInput(db: DB, o: ProductionOrder): { input: QuoteInput; params: CostParams | null } {
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const it = q ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) : undefined;
  if (it) return { input: structuredClone(it.input), params: it.params };
  if (o.estimate) return { input: structuredClone(o.estimate.input), params: o.estimate.params };
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
  // Complementos do estoque já entram pelo consumo real dos lotes (acima); os demais, pelo previsto.
  real.extras = input.extras.filter((e) => !e.materialId).map((e) => ({ ...e, qtyPerUnit: e.qtyPerUnit * a.qtyApproved }));
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

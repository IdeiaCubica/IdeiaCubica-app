/**
 * Gestão de estoque.
 *
 * Fonte da verdade: as movimentações. Saldos nunca são armazenados — são
 * derivados, o que elimina divergências entre "saldo" e "histórico".
 *
 *   saldo físico   = Σ entradas − Σ saídas
 *   reservado      = Σ reservas − Σ liberações
 *   disponível     = saldo físico − reservado
 */
import type { DB, ID, ISODate, Lot, Material, MovementType, StockMovement } from './types';
import { D, Decimal, ZERO, cents } from './money';
import { BusinessError, addDays, assert, audit, byId, newId, nextCode, nowISO, requirePositive, requireText, todayISO } from './core';

const PHYSICAL_SIGN: Partial<Record<MovementType, 1 | -1>> = {
  entrada: 1, ajuste_pos: 1, consumo: -1, perda: -1, ajuste_neg: -1, devolucao: -1,
};
const RESERVED_SIGN: Partial<Record<MovementType, 1 | -1>> = { reserva: 1, liberacao: -1 };

export interface LotBalance {
  initial: Decimal;
  physical: Decimal;
  reserved: Decimal;
  available: Decimal;
  consumed: Decimal;
  lost: Decimal;
}

export function lotBalance(db: DB, lotId: ID): LotBalance {
  let physical = ZERO, reserved = ZERO, consumed = ZERO, lost = ZERO, initial = ZERO;
  for (const m of db.movements) {
    if (m.lotId !== lotId) continue;
    const q = D(m.qty);
    const ps = PHYSICAL_SIGN[m.type];
    const rs = RESERVED_SIGN[m.type];
    if (ps) physical = physical.plus(q.times(ps));
    if (rs) reserved = reserved.plus(q.times(rs));
    if (m.type === 'consumo') consumed = consumed.plus(q);
    if (m.type === 'perda') lost = lost.plus(q);
    if (m.type === 'entrada') initial = initial.plus(q);
  }
  return { initial, physical, reserved, available: physical.minus(reserved), consumed, lost };
}

export function materialBalance(db: DB, materialId: ID) {
  const lots = db.lots.filter((l) => l.materialId === materialId);
  let physical = ZERO, reserved = ZERO, value = ZERO;
  for (const l of lots) {
    const b = lotBalance(db, l.id);
    physical = physical.plus(b.physical);
    reserved = reserved.plus(b.reserved);
    value = value.plus(b.physical.times(D(l.unitCost)));
  }
  return { physical, reserved, available: physical.minus(reserved), value: cents(value), lots };
}

/** Valor contábil do estoque (custo histórico específico por lote). */
export function inventoryValue(db: DB): Decimal {
  return cents(db.lots.reduce((acc, l) => acc.plus(lotBalance(db, l.id).physical.times(D(l.unitCost))), ZERO));
}

export function lotLabel(db: DB, lot: Lot): string {
  const mat = db.materials.find((m) => m.id === lot.materialId);
  return `${mat?.code ?? '?'} · ${mat?.name ?? 'Material removido'} · ${lot.code}`;
}

export interface MovementInput {
  lotId: ID;
  type: MovementType;
  qty: number;
  date?: ISODate;
  ref: StockMovement['ref'];
  key: string;
  reason?: string;
}

/**
 * Registra uma movimentação validando:
 * - idempotência (a mesma `key` não pode ser aplicada duas vezes);
 * - saldo físico e reservado nunca negativos;
 * - reserva nunca maior que o disponível.
 */
export function addMovement(db: DB, input: MovementInput): StockMovement {
  requirePositive(input.qty, 'A quantidade');
  const lot = byId(db.lots, input.lotId, 'Lote');
  if (db.movements.some((m) => m.key === input.key)) {
    throw new BusinessError('Esta operação de estoque já foi registrada anteriormente (proteção contra lançamento duplicado).');
  }
  const bal = lotBalance(db, lot.id);
  const q = D(input.qty);
  const ps = PHYSICAL_SIGN[input.type] ?? 0;
  const rs = RESERVED_SIGN[input.type] ?? 0;
  const newPhysical = bal.physical.plus(q.times(ps));
  const newReserved = bal.reserved.plus(q.times(rs));
  const mat = db.materials.find((m) => m.id === lot.materialId);
  const u = mat?.unit ?? '';
  if (newPhysical.isNegative()) {
    throw new BusinessError(`Saldo insuficiente no lote ${lot.code}: disponível fisicamente ${bal.physical.toString()} ${u}, solicitado ${q.toString()} ${u}.`);
  }
  if (newReserved.isNegative()) throw new BusinessError(`A liberação excede a quantidade reservada no lote ${lot.code}.`);
  if (newReserved.gt(newPhysical)) {
    throw new BusinessError(`Quantidade indisponível no lote ${lot.code}: disponível ${bal.available.toString()} ${u} (saldo ${bal.physical.toString()} − reservado ${bal.reserved.toString()}).`);
  }
  const mov: StockMovement = {
    id: newId(), date: input.date ?? todayISO(), lotId: lot.id, materialId: lot.materialId, type: input.type,
    qty: input.qty, ref: input.ref, key: input.key, reason: input.reason, createdAt: nowISO(),
  };
  db.movements.push(mov);
  return mov;
}

/** Cadastro de estoque inicial (ex.: carretel já parcialmente usado antes do sistema). Não gera lançamento financeiro. */
export function registerInitialStock(db: DB, input: {
  materialId: ID; qty: number; unitCost: string; date: ISODate; supplierId?: ID; batchNumber?: string; notes?: string;
}): Lot {
  const mat = byId(db.materials, input.materialId, 'Material');
  requirePositive(input.qty, 'A quantidade');
  const unitCost = D(input.unitCost);
  assert(!unitCost.isNegative(), 'O custo unitário não pode ser negativo.');
  const lot: Lot = {
    id: newId(), code: nextCode(db, 'lot', 'L'), materialId: mat.id, origin: 'estoque_inicial', supplierId: input.supplierId,
    date: input.date, batchNumber: input.batchNumber, initialQty: input.qty, unitCost: unitCost.toString(),
    cost: { goods: cents(unitCost.times(input.qty)).toString(), freight: '0', other: '0' }, notes: input.notes,
  };
  db.lots.push(lot);
  addMovement(db, { lotId: lot.id, type: 'entrada', qty: input.qty, date: input.date, ref: { kind: 'estoque_inicial', id: lot.id }, key: `inicial:${lot.id}` });
  audit(db, 'Estoque inicial', `${mat.name}: ${input.qty} ${mat.unit} (${lot.code})`);
  return lot;
}

/**
 * Custo por unidade de estoque a partir do valor total pago (a forma segura de digitar):
 * ex.: R$ 73,58 por 1.000 g → R$ 0,07358/g (R$ 73,58/kg).
 */
export function unitCostFromTotal(totalPaid: Decimal.Value, qty: number): Decimal {
  assert(qty > 0, 'Informe a quantidade para calcular o custo unitário.');
  return D(totalPaid).div(qty);
}

/** Lote de estoque inicial sem nenhuma movimentação além da entrada (pode ser corrigido ou excluído). */
export function isUntouchedLot(db: DB, lotId: ID) {
  return db.movements.filter((m) => m.lotId === lotId).every((m) => m.type === 'entrada');
}

function requireEditableInitial(db: DB, lotId: ID) {
  const lot = byId(db.lots, lotId, 'Lote');
  assert(lot.origin === 'estoque_inicial', 'Este lote veio de uma compra. Para corrigir, cancele a compra em Compras e registre de novo.');
  assert(isUntouchedLot(db, lotId),
    'Este lote já teve consumo, reserva, perda ou ajuste. Para corrigir a quantidade, use o inventário (contagem) do lote; o custo de lotes já usados não muda para não alterar custos já apurados.');
  return lot;
}

/** Corrige um lançamento de estoque inicial ainda não usado (quantidade, custo, data, lote, observações). */
export function updateInitialStock(db: DB, lotId: ID, input: { qty: number; unitCost: string; date: ISODate; batchNumber?: string; notes?: string }) {
  const lot = requireEditableInitial(db, lotId);
  requirePositive(input.qty, 'A quantidade');
  const unitCost = D(input.unitCost);
  assert(!unitCost.isNegative(), 'O custo unitário não pode ser negativo.');
  Object.assign(lot, {
    initialQty: input.qty, unitCost: unitCost.toString(), date: input.date, batchNumber: input.batchNumber, notes: input.notes,
    cost: { goods: cents(unitCost.times(input.qty)).toString(), freight: '0', other: '0' },
  });
  const entry = db.movements.find((m) => m.lotId === lotId && m.type === 'entrada');
  if (entry) Object.assign(entry, { qty: input.qty, date: input.date });
  const mat = db.materials.find((m) => m.id === lot.materialId);
  audit(db, 'Estoque inicial corrigido', `${lot.code} ${mat?.name ?? ''}: ${input.qty} ${mat?.unit ?? ''} a ${unitCost.toString()}/${mat?.unit ?? ''}`);
  return lot;
}

/** Exclui um lançamento de estoque inicial feito por engano (só se ainda não foi usado). */
export function deleteInitialStock(db: DB, lotId: ID, reason: string) {
  const lot = requireEditableInitial(db, lotId);
  const why = requireText(reason, 'o motivo da exclusão');
  db.movements = db.movements.filter((m) => m.lotId !== lotId);
  db.lots = db.lots.filter((l) => l.id !== lotId);
  const mat = db.materials.find((m) => m.id === lot.materialId);
  audit(db, 'Estoque inicial excluído', `${lot.code} ${mat?.name ?? ''} — ${why}`);
}

/** Inventário: compara contagem física com o saldo e gera ajuste rastreável. */
export function adjustInventory(db: DB, input: { lotId: ID; countedQty: number; reason: string; date?: ISODate }) {
  const reason = requireText(input.reason, 'a justificativa do ajuste');
  assert(Number.isFinite(input.countedQty) && input.countedQty >= 0, 'A quantidade contada não pode ser negativa.');
  const lot = byId(db.lots, input.lotId, 'Lote');
  const bal = lotBalance(db, lot.id);
  const diff = D(input.countedQty).minus(bal.physical);
  if (diff.isZero()) throw new BusinessError('A contagem é igual ao saldo do sistema; nenhum ajuste necessário.');
  if (D(input.countedQty).lt(bal.reserved)) {
    throw new BusinessError(`A contagem (${input.countedQty}) é menor que a quantidade reservada (${bal.reserved}). Cancele ou ajuste as reservas antes.`);
  }
  const mov = addMovement(db, {
    lotId: lot.id, type: diff.isPositive() ? 'ajuste_pos' : 'ajuste_neg', qty: diff.abs().toNumber(), date: input.date,
    ref: { kind: 'inventario' }, key: `inventario:${newId()}`, reason: `Contado ${input.countedQty}; sistema ${bal.physical}. ${reason}`,
  });
  audit(db, 'Ajuste de inventário', `${lot.code}: diferença ${diff.toString()}`);
  return mov;
}

export function registerLoss(db: DB, input: { lotId: ID; qty: number; reason: string; date?: ISODate }) {
  const reason = requireText(input.reason, 'o motivo da perda');
  const mov = addMovement(db, { lotId: input.lotId, type: 'perda', qty: input.qty, date: input.date, ref: { kind: 'perda' }, key: `perda:${newId()}`, reason });
  audit(db, 'Perda registrada', `${input.qty} — ${reason}`);
  return mov;
}

/** Reserva vinculada a uma referência (ex.: ordem de produção). */
export function reserve(db: DB, lotId: ID, qty: number, refId: ID, refKind: StockMovement['ref']['kind'] = 'op') {
  return addMovement(db, { lotId, type: 'reserva', qty, ref: { kind: refKind, id: refId }, key: `${refKind}:${refId}:reserva:${lotId}` });
}

/** Quantidade ainda reservada para uma referência em um lote. */
export function reservedFor(db: DB, lotId: ID, refId: ID): Decimal {
  return db.movements
    .filter((m) => m.lotId === lotId && m.ref.id === refId && (m.type === 'reserva' || m.type === 'liberacao'))
    .reduce((acc, m) => acc.plus(D(m.qty).times(m.type === 'reserva' ? 1 : -1)), ZERO);
}

/** Libera tudo o que estiver reservado para a referência. Idempotente. */
export function releaseAll(db: DB, refId: ID, refKind: StockMovement['ref']['kind'] = 'op', suffix = 'liberacao') {
  const lots = new Set(db.movements.filter((m) => m.ref.id === refId && m.type === 'reserva').map((m) => m.lotId));
  for (const lotId of lots) {
    const r = reservedFor(db, lotId, refId);
    if (r.gt(0)) addMovement(db, { lotId, type: 'liberacao', qty: r.toNumber(), ref: { kind: refKind, id: refId }, key: `${refKind}:${refId}:${suffix}:${lotId}` });
  }
}

/* ------------------------------------------------------------------ */
/* Previsão de reposição                                               */
/* ------------------------------------------------------------------ */
export interface ReorderInfo {
  material: Material;
  physical: Decimal;
  reserved: Decimal;
  available: Decimal;
  /** Consumo previsto de ordens de produção abertas que AINDA NÃO reservaram material. */
  plannedDemand: Decimal;
  /** Disponível depois de atender as ordens abertas = disponível − demanda planejada. */
  projected: Decimal;
  avgDailyUse: Decimal | null;
  /** Ponto de pedido = estoque mínimo + segurança + consumo médio × prazo. */
  reorderPoint: Decimal | null;
  suggestedQty: Decimal | null;
  /** falta = não há material para as ordens abertas; repor = abaixo do ponto de pedido. */
  status: 'ok' | 'repor' | 'falta' | 'sem_parametros';
  note: string;
}

/**
 * Demanda das ordens que ainda não reservaram (planejadas / aguardando material).
 * Ordens prontas ou em produção já estão no "reservado"; somá-las aqui contaria em dobro.
 */
export function unreservedDemand(db: DB, materialId: ID): Decimal {
  let total = ZERO;
  for (const o of db.orders) {
    if (o.status !== 'planejada' && o.status !== 'aguardando_material') continue;
    for (const m of o.plannedMaterials) {
      const mid = m.materialId || db.lots.find((l) => l.id === m.lotId)?.materialId;
      if (mid === materialId) total = total.plus(D(m.qty));
    }
  }
  return total;
}

export function reorderAnalysis(db: DB, material: Material, windowDays = 90, today = todayISO()): ReorderInfo {
  const bal = materialBalance(db, material.id);
  const plannedDemand = unreservedDemand(db, material.id);
  const projected = bal.available.minus(plannedDemand);
  const since = addDays(today, -windowDays);
  const used = db.movements
    .filter((m) => m.materialId === material.id && (m.type === 'consumo' || m.type === 'perda') && m.date >= since && m.date <= today)
    .reduce((a, m) => a.plus(D(m.qty)), ZERO);
  const hasHistory = used.gt(0);
  const avgDailyUse = hasHistory ? used.div(windowDays) : null;
  const min = material.minStock ?? null;
  const safety = material.safetyStock ?? 0;
  const lead = material.leadTimeDays ?? null;
  const base = { material, physical: bal.physical, reserved: bal.reserved, available: bal.available, plannedDemand, projected, avgDailyUse };

  if (min === null && (lead === null || !hasHistory)) {
    // Sem parâmetros de reposição, ainda sinaliza quando falta material para ordens abertas.
    if (projected.isNegative()) {
      return { ...base, reorderPoint: null, suggestedQty: projected.abs().toDecimalPlaces(2, Decimal.ROUND_UP), status: 'falta',
        note: 'Material insuficiente para as ordens de produção abertas. Defina o estoque mínimo para receber também alertas preventivos.' };
    }
    return { ...base, reorderPoint: null, suggestedQty: null, status: 'sem_parametros',
      note: 'Defina estoque mínimo ou prazo de reposição (em Cadastros → Materiais) para receber sugestões.' };
  }
  const leadUse = avgDailyUse && lead !== null ? avgDailyUse.times(lead) : ZERO;
  const reorderPoint = D(min ?? 0).plus(safety).plus(leadUse);
  // Compara com o PROJETADO: disponível (já sem reservas) menos o que as ordens abertas vão consumir.
  const need = reorderPoint.minus(projected);
  const notes: string[] = [];
  if (plannedDemand.gt(0)) notes.push(`Inclui ${plannedDemand.toString()} ${material.unit} previstos em ordens ainda não reservadas.`);
  if (!hasHistory) notes.push('Sem histórico de consumo nos últimos 90 dias; sugestão baseada no mínimo.');
  if (lead === null) notes.push('Prazo de reposição não informado.');
  return {
    ...base, reorderPoint,
    suggestedQty: need.gt(0) ? need.toDecimalPlaces(2, Decimal.ROUND_UP) : ZERO,
    status: projected.isNegative() ? 'falta' : need.gt(0) ? 'repor' : 'ok',
    note: notes.join(' '),
  };
}

/** Materiais ativos que precisam de compra (falta para ordens ou abaixo do ponto de pedido). */
export function purchaseAlerts(db: DB): ReorderInfo[] {
  return db.materials.filter((m) => m.active).map((m) => reorderAnalysis(db, m)).filter((r) => r.status === 'falta' || r.status === 'repor')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'falta' ? -1 : 1));
}

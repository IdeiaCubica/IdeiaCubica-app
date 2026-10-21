/**
 * Compras de insumos.
 *
 * Uma compra gera, na MESMA transação:
 *   1. um lote por item (com custo unitário de aquisição preservado);
 *   2. a entrada no estoque (movimentação idempotente);
 *   3. o(s) título(s) financeiro(s): liquidado se à vista; em aberto se a prazo.
 *
 * Rateio de frete e outros custos de aquisição entre itens: proporcional ao
 * valor da mercadoria de cada item (documentado em docs/REGRAS_DE_CALCULO.md).
 */
import type { DB, ID, ISODate, Lot, PaymentTerms, Purchase } from './types';
import { D, Decimal, ZERO, cents, sum } from './money';
import { BusinessError, assert, audit, byId, convertQty, isISODate, newId, nextCode, nowISO, requireText } from './core';
import { addMovement, lotBalance } from './inventory';
import { categoryByName, cancelTitle, createTitlesFromTerms, titlePaid } from './finance';
import { SYS_FIN } from './schema';
import type { Unit } from './types';

export interface PurchaseItemInput {
  materialId: ID;
  qty: number;
  /** Unidade em que a quantidade foi digitada; convertida para a unidade do material. */
  unit?: Unit;
  price: string;
  batchNumber?: string;
}

export interface PurchaseInput {
  date: ISODate;
  supplierId?: ID;
  items: PurchaseItemInput[];
  freight: string;
  otherCosts: string;
  payment: PaymentTerms;
  notes?: string;
}

/** Custo por unidade = (mercadoria + frete atribuído + outros atribuídos) / quantidade. */
export function unitAcquisitionCost(goods: Decimal.Value, freight: Decimal.Value, other: Decimal.Value, qty: number): Decimal {
  if (!(qty > 0)) throw new BusinessError('Quantidade deve ser maior que zero para calcular o custo unitário.');
  return D(goods).plus(D(freight)).plus(D(other)).div(qty);
}

/** Rateio proporcional com centavos exatos (resíduo no último item). */
export function allocate(total: Decimal, weights: Decimal[]): Decimal[] {
  const totalWeight = sum(weights);
  if (total.isZero()) return weights.map(() => ZERO);
  if (totalWeight.isZero()) {
    // Sem valor de mercadoria (ex.: brindes): rateio igualitário.
    return allocate(total, weights.map(() => D(1)));
  }
  const parts = weights.map((w) => cents(total.times(w).div(totalWeight)));
  const diff = total.minus(sum(parts));
  parts[parts.length - 1] = parts[parts.length - 1].plus(diff);
  return parts;
}

export function registerPurchase(db: DB, input: PurchaseInput): Purchase {
  assert(isISODate(input.date), 'Informe a data da compra.');
  assert(input.items.length > 0, 'Adicione ao menos um item à compra.');
  if (input.supplierId) byId(db.parties, input.supplierId, 'Fornecedor');
  const freight = cents(D(input.freight || '0'));
  const other = cents(D(input.otherCosts || '0'));
  assert(!freight.isNegative() && !other.isNegative(), 'Frete e outros custos não podem ser negativos.');

  const items = input.items.map((it, i) => {
    const mat = byId(db.materials, it.materialId, `Material do item ${i + 1}`);
    assert(mat.active, `O material ${mat.name} está inativo.`);
    const qty = convertQty(it.qty, it.unit ?? mat.unit, mat.unit);
    assert(qty > 0, `Quantidade do item ${i + 1} deve ser maior que zero.`);
    const price = cents(D(it.price || '0'));
    assert(!price.isNegative(), `Valor do item ${i + 1} inválido.`);
    return { mat, qty, price, batchNumber: it.batchNumber };
  });

  const freightParts = allocate(freight, items.map((i) => i.price));
  const otherParts = allocate(other, items.map((i) => i.price));
  const total = sum(items.map((i) => i.price)).plus(freight).plus(other);
  assert(total.gt(0), 'O valor total da compra deve ser maior que zero.');

  const purchase: Purchase = {
    id: newId(), number: nextCode(db, 'purchase', 'CMP'), date: input.date, supplierId: input.supplierId,
    items: [], freight: freight.toString(), otherCosts: other.toString(), total: total.toString(),
    payment: input.payment, status: 'ativa', notes: input.notes, createdAt: nowISO(),
  };

  items.forEach((it, i) => {
    const lot: Lot = {
      id: newId(), code: nextCode(db, 'lot', 'L'), materialId: it.mat.id, origin: 'compra', purchaseId: purchase.id,
      supplierId: input.supplierId, date: input.date, batchNumber: it.batchNumber, initialQty: it.qty,
      unitCost: unitAcquisitionCost(it.price, freightParts[i], otherParts[i], it.qty).toString(),
      cost: { goods: it.price.toString(), freight: freightParts[i].toString(), other: otherParts[i].toString() },
    };
    db.lots.push(lot);
    addMovement(db, { lotId: lot.id, type: 'entrada', qty: it.qty, date: input.date, ref: { kind: 'compra', id: purchase.id }, key: `compra:${purchase.id}:${lot.id}` });
    purchase.items.push({ materialId: it.mat.id, qty: it.qty, price: it.price.toString(), batchNumber: it.batchNumber, lotId: lot.id });
  });

  const supplier = db.parties.find((p) => p.id === input.supplierId);
  createTitlesFromTerms(db, {
    direction: 'out', description: `Compra ${purchase.number}${supplier ? ' — ' + supplier.name : ''}`,
    categoryId: categoryByName(db, SYS_FIN.compraInsumos).id, amount: total, competenceDate: input.date,
    partyId: input.supplierId, origin: { kind: 'compra', id: purchase.id }, terms: input.payment,
  });

  db.purchases.push(purchase);
  audit(db, 'Compra registrada', `${purchase.number}: R$ ${total.toFixed(2)} (${input.payment.mode === 'avista' ? 'à vista' : `${input.payment.installments}x a prazo`})`);
  return purchase;
}

/**
 * Cancelamento com estorno rastreável: só é permitido se nenhum material dos
 * lotes foi movimentado e se não houver pagamentos ativos (estorne-os antes).
 */
export function cancelPurchase(db: DB, purchaseId: ID, reason: string) {
  const p = byId(db.purchases, purchaseId, 'Compra');
  assert(p.status === 'ativa', 'Compra já cancelada.');
  const why = requireText(reason, 'o motivo do cancelamento');
  for (const it of p.items) {
    const used = db.movements.some((m) => m.lotId === it.lotId && m.type !== 'entrada');
    if (used) throw new BusinessError('Há consumo, reserva ou ajuste em lotes desta compra. Não é possível cancelar; registre uma devolução/ajuste.');
  }
  const titles = db.titles.filter((t) => t.origin.kind === 'compra' && t.origin.id === p.id && t.status !== 'cancelado');
  if (titles.some((t) => titlePaid(t).gt(0))) {
    throw new BusinessError('Há pagamentos registrados para esta compra. Estorne os pagamentos no Financeiro antes de cancelar.');
  }
  for (const it of p.items) {
    const bal = lotBalance(db, it.lotId);
    addMovement(db, { lotId: it.lotId, type: 'devolucao', qty: bal.physical.toNumber(), ref: { kind: 'compra', id: p.id }, key: `compra:${p.id}:estorno:${it.lotId}`, reason: `Cancelamento: ${why}` });
  }
  titles.forEach((t) => cancelTitle(db, t.id, `Compra cancelada: ${why}`));
  p.status = 'cancelada';
  p.cancelReason = why;
  audit(db, 'Compra cancelada', `${p.number} — ${why}`);
}

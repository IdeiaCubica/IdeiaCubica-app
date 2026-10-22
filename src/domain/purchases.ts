/**
 * Compras da empresa: insumos de qualquer categoria (filamento, etiquetas,
 * embalagens…) e equipamentos (impressora, ferramentas duráveis).
 *
 * Uma compra gera, na MESMA transação:
 *   1. insumos: um lote por item (com custo unitário de aquisição preservado)
 *      e a entrada no estoque (movimentação idempotente);
 *   2. equipamentos: registro do investimento; impressora vinculada recebe o
 *      custo de aquisição (base da depreciação por hora);
 *   3. o(s) título(s) financeiro(s), separados por natureza (insumos / equipamentos):
 *      liquidados se à vista; em aberto se a prazo.
 *
 * Rateio de frete e outros custos de aquisição entre itens: proporcional ao
 * valor da mercadoria de cada item (documentado em docs/REGRAS_DE_CALCULO.md).
 */
import type { DB, ID, ISODate, Lot, PaymentTerms, Purchase, PurchaseEquipment } from './types';
import { D, Decimal, ZERO, cents, sum } from './money';
import { BusinessError, assert, audit, byId, convertQty, isISODate, newId, nextCode, nowISO, requireText } from './core';
import { addMovement, lotBalance } from './inventory';
import { savePrinter } from './catalog';
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

/** Equipamento (impressora, ferramenta durável): investimento, sem estoque. */
export interface PurchaseEquipmentInput {
  description: string;
  qty: number;
  price: string;
  /** Impressora: cadastrar nova (com o custo de aquisição) ou atualizar o valor de aquisição de uma existente. */
  printer?: { mode: 'nova'; name: string; manufacturer?: string; model?: string } | { mode: 'existente'; printerId: ID };
}

export interface PurchaseInput {
  date: ISODate;
  supplierId?: ID;
  items: PurchaseItemInput[];
  equipment?: PurchaseEquipmentInput[];
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

/** Categoria financeira de equipamentos (investimento); recriada se tiver sido removida. */
export function equipmentCategory(db: DB) {
  const found = db.finCategories.find((c) => c.name === SYS_FIN.equipamentos)
    ?? db.finCategories.find((c) => c.direction === 'out' && c.nature === 'investimento');
  if (found) return found;
  const c = { id: newId(), name: SYS_FIN.equipamentos, direction: 'out' as const, nature: 'investimento' as const, system: true };
  db.finCategories.push(c);
  return c;
}

export function registerPurchase(db: DB, input: PurchaseInput): Purchase {
  assert(isISODate(input.date), 'Informe a data da compra.');
  const eqInput = input.equipment ?? [];
  assert(input.items.length + eqInput.length > 0, 'Adicione ao menos um item à compra.');
  if (input.supplierId) byId(db.parties, input.supplierId, 'Fornecedor');
  const freight = cents(D(input.freight || '0'));
  const other = cents(D(input.otherCosts || '0'));
  assert(!freight.isNegative() && !other.isNegative(), 'Frete e outros custos não podem ser negativos.');

  const items = input.items.map((it, i) => {
    const mat = byId(db.materials, it.materialId, `Insumo do item ${i + 1}`);
    assert(mat.active, `O insumo ${mat.name} está inativo.`);
    const qty = convertQty(it.qty, it.unit ?? mat.unit, mat.unit);
    assert(qty > 0, `Quantidade do item ${i + 1} deve ser maior que zero.`);
    const price = cents(D(it.price || '0'));
    assert(!price.isNegative(), `Valor do item ${i + 1} inválido.`);
    return { mat, qty, price, batchNumber: it.batchNumber };
  });
  const equipment = eqInput.map((e, i) => {
    const description = requireText(e.description, `a descrição do equipamento ${i + 1}`);
    assert(Number.isInteger(e.qty) && e.qty > 0, `Quantidade do equipamento ${i + 1} deve ser um inteiro maior que zero.`);
    const price = cents(D(e.price || '0'));
    assert(price.gt(0), `Informe o valor do equipamento ${i + 1}.`);
    if (e.printer) {
      assert(e.qty === 1, 'Para vincular a uma impressora, lance uma impressora por linha (quantidade 1).');
      if (e.printer.mode === 'existente') byId(db.printers, e.printer.printerId, 'Impressora');
      else requireText(e.printer.name, 'o nome da nova impressora');
    }
    return { ...e, description, price };
  });

  // Frete e outros custos são rateados por valor entre TODOS os itens (insumos e equipamentos).
  const weights = [...items.map((i) => i.price), ...equipment.map((e) => e.price)];
  const freightParts = allocate(freight, weights);
  const otherParts = allocate(other, weights);
  const total = sum(weights).plus(freight).plus(other);
  assert(total.gt(0), 'O valor total da compra deve ser maior que zero.');

  const purchase: Purchase = {
    id: newId(), number: nextCode(db, 'purchase', 'CMP'), date: input.date, supplierId: input.supplierId,
    items: [], equipment: [], freight: freight.toString(), otherCosts: other.toString(), total: total.toString(),
    payment: input.payment, status: 'ativa', notes: input.notes, createdAt: nowISO(),
  };

  let materialsTotal = ZERO;
  items.forEach((it, i) => {
    materialsTotal = materialsTotal.plus(it.price).plus(freightParts[i]).plus(otherParts[i]);
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

  let equipmentTotal = ZERO;
  equipment.forEach((e, k) => {
    const i = items.length + k;
    const cost = e.price.plus(freightParts[i]).plus(otherParts[i]);
    equipmentTotal = equipmentTotal.plus(cost);
    const line: PurchaseEquipment = {
      id: newId(), description: e.description, qty: e.qty, price: e.price.toString(),
      freight: freightParts[i].toString(), other: otherParts[i].toString(), total: cost.toString(),
    };
    if (e.printer?.mode === 'nova') {
      const p = savePrinter(db, {
        name: e.printer.name, manufacturer: e.printer.manufacturer ?? '', model: e.printer.model ?? '', acquisitionValue: cost.toString(),
        residualValue: null, usefulLifeHours: null, initialHours: 0, energyMode: 'estimado', kwhPerHour: null, maintenancePerHour: null,
        availableHoursPerMonth: null, active: true, notes: `Cadastrada pela compra ${purchase.number}. Complete vida útil, valor residual e consumo em Parâmetros de Custos → Impressoras.`,
      });
      Object.assign(line, { printerId: p.id, printerCreated: true });
    } else if (e.printer?.mode === 'existente') {
      const p = byId(db.printers, e.printer.printerId, 'Impressora');
      Object.assign(line, { printerId: p.id, prevAcquisition: p.acquisitionValue });
      assert(!p.residualValue || D(p.residualValue).lte(cost), `O valor residual de ${p.name} é maior que o custo desta compra. Ajuste a impressora primeiro.`);
      p.acquisitionValue = cost.toString();
      audit(db, 'Valor de aquisição da impressora atualizado', `${p.name}: ${cost.toFixed(2)} (compra ${purchase.number})`);
    }
    purchase.equipment!.push(line);
  });

  // Um lançamento por natureza: insumos (estoque) e equipamentos (investimento), com a mesma condição de pagamento.
  const supplier = db.parties.find((p) => p.id === input.supplierId);
  const desc = `Compra ${purchase.number}${supplier ? ' — ' + supplier.name : ''}`;
  const both = materialsTotal.gt(0) && equipmentTotal.gt(0);
  if (materialsTotal.gt(0)) {
    createTitlesFromTerms(db, {
      direction: 'out', description: both ? `${desc} (insumos)` : desc,
      categoryId: categoryByName(db, SYS_FIN.compraInsumos).id, amount: materialsTotal, competenceDate: input.date,
      partyId: input.supplierId, origin: { kind: 'compra', id: purchase.id }, terms: input.payment,
    });
  }
  if (equipmentTotal.gt(0)) {
    createTitlesFromTerms(db, {
      direction: 'out', description: both ? `${desc} (equipamentos)` : desc,
      categoryId: equipmentCategory(db).id, amount: equipmentTotal, competenceDate: input.date,
      partyId: input.supplierId, origin: { kind: 'compra', id: purchase.id }, terms: input.payment,
    });
  }

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
  for (const e of p.equipment ?? []) {
    if (e.printerCreated && e.printerId) {
      const used = db.orders.some((o) => o.printerId === e.printerId) || db.quotes.some((q) => q.versions.some((v) => v.input.printerId === e.printerId));
      if (used) throw new BusinessError('A impressora cadastrada por esta compra já tem orçamentos ou produções. Não é possível cancelar a compra.');
    }
  }
  for (const it of p.items) {
    const bal = lotBalance(db, it.lotId);
    addMovement(db, { lotId: it.lotId, type: 'devolucao', qty: bal.physical.toNumber(), ref: { kind: 'compra', id: p.id }, key: `compra:${p.id}:estorno:${it.lotId}`, reason: `Cancelamento: ${why}` });
  }
  for (const e of p.equipment ?? []) {
    const printer = db.printers.find((x) => x.id === e.printerId);
    if (!printer) continue;
    if (e.printerCreated) {
      db.printers = db.printers.filter((x) => x.id !== printer.id);
      if (db.settings.defaultPrinterId === printer.id) db.settings.defaultPrinterId = undefined;
    } else if (printer.acquisitionValue === e.total) {
      printer.acquisitionValue = e.prevAcquisition ?? null;
    }
  }
  titles.forEach((t) => cancelTitle(db, t.id, `Compra cancelada: ${why}`));
  p.status = 'cancelada';
  p.cancelReason = why;
  audit(db, 'Compra cancelada', `${p.number} — ${why}`);
}

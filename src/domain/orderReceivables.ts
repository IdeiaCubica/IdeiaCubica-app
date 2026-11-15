/**
 * Conta a receber do pedido (recebimento antes da entrega).
 *
 * Quando a peça do orçamento vai para produção ("A produzir"), o valor do pedido entra em
 * Contas a receber, com vencimento na data de entrega. O cliente pode pagar antes (sinal ou
 * total) a qualquer momento. Na entrega, a venda aproveita o que já foi recebido e só gera
 * conta a receber do restante. Não é receita: o resultado continua contando a venda na entrega.
 */
import type { DB, FinTitle, FinishedGood, ID, ProductionOrder, Quote, Sale } from './types';
import { D, Decimal, ZERO } from './money';
import { BusinessError, assert, audit, newId, nowISO, toLocalDate, todayISO } from './core';
import { categoryByName, titleOpen, titlePaid } from './finance';
import { SYS_FIN } from './schema';
import { quoteItemAt, quoteItems } from './quotes';

/** Desde quando as peças concluídas aguardam destino no quadro (antes disso eram tratadas como entregues). */
export const DESTINATION_SINCE = '2026-11-01';

/** Valor do pedido para o cliente (valor da peça no orçamento, na versão enviada para produção) + o frete do orçamento, se for o pedido que leva o frete. */
export function orderValue(db: DB, o: ProductionOrder): Decimal | null {
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const it = q ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) : undefined;
  if (!it?.summary.orderPrice) return null;
  const freight = q && freightCarrierOrderId(db, q) === o.id ? quoteClientFreight(q) : ZERO;
  return D(it.summary.orderPrice).plus(freight);
}

/**
 * Frete cobrado do cliente no orçamento (v1.30). É do orçamento inteiro (uma caixa): vai para UM pedido
 * — o primeiro enviado para produção — e, na entrega, para a venda desse pedido. Antes da v1.30 o frete
 * aparecia no orçamento do cliente mas não entrava no pedido nem na venda.
 */
export function quoteClientFreight(q: Quote): Decimal {
  const v = q.versions[q.versions.length - 1];
  const companyPays = v.items.some((it) => D(it.input.freightSubsidyPerOrder ?? 0).gt(0));
  const cf = v.shipping?.clientFreight;
  return !companyPays && cf && D(cf.price).gt(0) ? D(cf.price).toDecimalPlaces(2) : ZERO;
}

/** Pedido que leva o frete do orçamento: o primeiro pedido de venda ativo (ou o já vendido) do orçamento. */
export function freightCarrierOrderId(db: DB, q: Quote): ID | null {
  const orders = db.orders.filter((o) => o.quoteId === q.id && (o.purpose ?? 'pedido') === 'pedido' && o.status !== 'cancelada')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number.localeCompare(b.number));
  return orders[0]?.id ?? null;
}

/** Frete que a venda deve cobrar (venda do pedido que leva o frete, ou a 1ª venda do orçamento sem pedidos). */
export function saleFreightDefault(db: DB, input: { quoteId?: ID; orderId?: ID }): Decimal {
  const q = input.quoteId ? db.quotes.find((x) => x.id === input.quoteId) : undefined;
  if (!q) return ZERO;
  const freight = quoteClientFreight(q);
  if (freight.isZero()) return ZERO;
  if (db.sales.some((s) => s.status === 'ativa' && s.quoteId === q.id && D(s.freightCharged).gt(0))) return ZERO;
  const carrier = freightCarrierOrderId(db, q);
  if (carrier) return input.orderId === carrier ? freight : ZERO;
  return freight;
}

/** Conta a receber provisionada do pedido (ainda não virou venda). */
export function orderReceivable(db: DB, orderId: ID): FinTitle | undefined {
  return db.titles.find((t) => t.origin.kind === 'pedido' && t.origin.id === orderId && t.status !== 'cancelado');
}

/** Venda ativa deste pedido (direta ou das peças prontas geradas por ele). */
function orderSold(db: DB, o: ProductionOrder) {
  return db.sales.some((s) => s.status === 'ativa' && (s.orderId === o.id || (!!o.finishedGoodId && s.finishedGoodId === o.finishedGoodId)));
}

/** Pedido de cliente ainda não entregue (na fila, produzindo, aguardando destino ou separado no estoque). */
export function orderOnTrack(db: DB, o: ProductionOrder): boolean {
  if ((o.purpose ?? 'pedido') !== 'pedido' || o.status === 'cancelada' || orderSold(db, o)) return false;
  if (o.status !== 'concluida') return true;
  if (o.destination === 'entregue') return false;
  if (o.destination === 'estoque') {
    const fg = db.finishedGoods.find((g) => g.id === o.finishedGoodId);
    return !!fg?.allocations?.some((a) => a.quoteId === o.quoteId);
  }
  return toLocalDate(o.finishedAt ?? '') >= DESTINATION_SINCE;
}

/** Situação do recebimento do pedido. */
export function orderPayment(db: DB, o: ProductionOrder) {
  const t = orderReceivable(db, o.id);
  if (!t) return null;
  const received = titlePaid(t);
  return { title: t, total: D(t.amount), received, open: titleOpen(t), status: titleOpen(t).isZero() ? 'pago' as const : received.gt(0) ? 'parcial' as const : 'a_receber' as const };
}

function describe(db: DB, o: ProductionOrder) {
  const c = db.parties.find((p) => p.id === o.customerId)?.name;
  return `Pedido ${o.number} — ${o.description}${c ? ` — ${c}` : ''}`;
}

/** Cria (ou atualiza vencimento/cliente) a conta a receber do pedido. Idempotente. */
export function provisionOrderReceivable(db: DB, o: ProductionOrder): FinTitle | null {
  const existing = orderReceivable(db, o.id);
  if (existing) {
    Object.assign(existing, { description: describe(db, o), partyId: o.customerId, dueDate: o.dueDate ?? existing.dueDate });
    return existing;
  }
  const value = orderValue(db, o);
  if (!value || !value.gt(0) || !orderOnTrack(db, o)) return null;
  const created = toLocalDate(o.createdAt) || todayISO();
  const t: FinTitle = {
    id: newId(), direction: 'in', description: describe(db, o), categoryId: categoryByName(db, SYS_FIN.vendaProdutos).id,
    amount: value.toString(), competenceDate: created, dueDate: o.dueDate && o.dueDate >= created ? o.dueDate : created,
    partyId: o.customerId, projectId: o.projectId, origin: { kind: 'pedido', id: o.id }, status: 'aberto', settlements: [], createdAt: nowISO(),
    notes: 'Previsto para a entrega. O cliente pode pagar antes (sinal ou total); na entrega, vira a venda.',
  };
  db.titles.push(t);
  return t;
}

/* ---------------- Peça do estoque separada para um pedido (v1.30) ---------------- */
/**
 * Peça a pronta-entrega aprovada no orçamento ("Pedido aprovado"): as peças ficam separadas no estoque e
 * o valor entra em Contas a receber (origem "separacao"), como um pedido em produção. Na entrega, a venda
 * aproveita o que já foi pago. Antes da v1.30 essas peças não geravam conta: ficavam fora de Vendas.
 */
export function allocationReceivable(db: DB, allocationId: ID): FinTitle | undefined {
  return db.titles.find((t) => t.origin.kind === 'separacao' && t.origin.id === allocationId && t.status !== 'cancelado');
}

/** Separações de peças do estoque feitas por orçamento (peça do orçamento vinda do estoque). */
function quoteAllocations(db: DB) {
  const out: { fg: FinishedGood; a: NonNullable<FinishedGood['allocations']>[number]; q: Quote; it: ReturnType<typeof quoteItems>[number] }[] = [];
  for (const fg of db.finishedGoods) for (const a of fg.allocations ?? []) {
    const q = db.quotes.find((x) => x.id === a.quoteId);
    const it = q ? quoteItems(q).find((x) => x.itemId === a.itemId) : undefined;
    // Separação feita pela produção de um pedido (peça foi para o estoque) já tem a conta do pedido.
    if (!q || !it || it.finishedGoodId !== fg.id) continue;
    out.push({ fg, a, q, it });
  }
  return out;
}

/** Cria a conta a receber da separação (idempotente). */
export function provisionAllocationReceivable(db: DB, allocationId: ID): FinTitle | null {
  const x = quoteAllocations(db).find((y) => y.a.id === allocationId);
  if (!x) return null;
  const existing = allocationReceivable(db, allocationId);
  if (existing) return existing;
  const price = x.it.summary.orderPrice ? D(x.it.summary.orderPrice) : null;
  if (!price || !price.gt(0)) return null;
  const value = x.it.input.quantity > 0 && x.a.qty !== x.it.input.quantity ? price.div(x.it.input.quantity).times(x.a.qty).toDecimalPlaces(2) : price;
  const created = toLocalDate(x.a.createdAt) || todayISO();
  const c = db.parties.find((p) => p.id === (x.a.customerId ?? x.q.customerId))?.name;
  const t: FinTitle = {
    id: newId(), direction: 'in', description: `Pedido ${x.q.number} — ${x.it.name} (pronta-entrega ${x.fg.code})${c ? ` — ${c}` : ''}`,
    categoryId: categoryByName(db, SYS_FIN.vendaProdutos).id, amount: value.toString(), competenceDate: created,
    dueDate: x.a.dueDate && x.a.dueDate >= created ? x.a.dueDate : created, partyId: x.a.customerId ?? x.q.customerId, projectId: x.q.projectId,
    origin: { kind: 'separacao', id: x.a.id }, status: 'aberto', settlements: [], createdAt: nowISO(),
    notes: 'Peças prontas separadas do estoque para este pedido. O cliente pode pagar antes (sinal ou total); na entrega, vira a venda.',
  };
  db.titles.push(t);
  return t;
}

/** Peça reaberta/recusada: a separação sai e a conta dela também (bloqueia se o cliente já pagou). */
export function dropAllocationReceivable(db: DB, allocationId: ID) {
  const t = allocationReceivable(db, allocationId);
  if (!t) return;
  const paid = titlePaid(t);
  if (paid.gt(0)) throw new BusinessError(`O cliente já pagou R$ ${paid.toFixed(2)} desta peça separada. Estorne o recebimento em Financeiro → Contas a pagar e receber antes.`);
  db.titles = db.titles.filter((x) => x.id !== t.id);
}

/** Leva para Contas a receber todos os pedidos na esteira que ainda não têm conta. Retorna quantas criou. */
export function provisionOrderReceivables(db: DB): number {
  let n = 0;
  for (const o of db.orders) {
    if (orderReceivable(db, o.id) || !orderOnTrack(db, o)) continue;
    if (provisionOrderReceivable(db, o)) n++;
  }
  // v1.30: peças do estoque separadas para pedidos aprovados também entram em Contas a receber.
  for (const x of quoteAllocations(db)) {
    if (allocationReceivable(db, x.a.id)) continue;
    if (provisionAllocationReceivable(db, x.a.id)) n++;
  }
  if (n) audit(db, 'Contas a receber dos pedidos', `${n} pedido(s) na esteira levados para Contas a receber`);
  return n;
}

/** Pedidos na esteira que ainda não estão em Contas a receber (e têm valor). */
export function pendingOrderReceivables(db: DB): ProductionOrder[] {
  return db.orders.filter((o) => !orderReceivable(db, o.id) && orderOnTrack(db, o) && !!orderValue(db, o)?.gt(0));
}

/** Separações do estoque ainda sem conta a receber (para o aviso do Financeiro). */
export function pendingAllocationReceivables(db: DB): number {
  return quoteAllocations(db).filter((x) => !allocationReceivable(db, x.a.id) && !!x.it.summary.orderPrice && D(x.it.summary.orderPrice).gt(0)).length;
}

/** Retira a conta do pedido (pedido cancelado, voltou ao orçamento, excluído ou virou produção para estoque). */
export function dropOrderReceivable(db: DB, o: ProductionOrder) {
  const t = orderReceivable(db, o.id);
  if (!t) return;
  const paid = titlePaid(t);
  if (paid.gt(0)) throw new BusinessError(`O cliente já pagou R$ ${paid.toFixed(2)} deste pedido. Estorne o recebimento em Financeiro → Contas a pagar e receber antes (ou registre a venda).`);
  db.titles = db.titles.filter((x) => x.id !== t.id);
}

/**
 * Na venda (entrega): o que o cliente já pagou no pedido passa para a venda. A conta do pedido vira
 * a parte já recebida da venda; a venda só gera conta a receber do restante. Retorna o valor já recebido.
 */
export function takeOrderAdvance(db: DB, orderId: ID | undefined, sale: Sale, receivable: Decimal): Decimal {
  const t = orderId ? orderReceivable(db, orderId) : undefined;
  if (!t) return ZERO;
  const paid = titlePaid(t);
  if (paid.isZero()) { db.titles = db.titles.filter((x) => x.id !== t.id); return ZERO; }
  assert(paid.lte(receivable), `O cliente já pagou R$ ${paid.toFixed(2)} neste pedido, mais do que o valor a receber desta venda (R$ ${receivable.toFixed(2)}). Ajuste o valor da venda ou estorne parte do recebimento.`);
  const o = db.orders.find((x) => x.id === orderId);
  t.advance = { orderId: orderId!, amount: t.amount, description: t.description, dueDate: t.dueDate, competenceDate: t.competenceDate };
  Object.assign(t, {
    origin: { kind: 'venda', id: sale.id }, amount: paid.toString(), status: 'liquidado', competenceDate: sale.date,
    description: `Venda ${sale.number} — ${sale.description} (pago antes da entrega${o ? `, pedido ${o.number}` : ''})`,
  });
  return paid;
}

/**
 * Na venda de peça separada do estoque (v1.30): a conta da separação passa para a venda. Se nada foi pago,
 * a conta sai (a venda gera a dela); se houve pagamento, vira a parte já recebida da venda.
 */
export function takeAllocationAdvance(db: DB, alloc: NonNullable<FinishedGood['allocations']>[number], finishedGoodId: ID, sale: Sale, receivable: Decimal): Decimal {
  const t = allocationReceivable(db, alloc.id);
  if (!t) return ZERO;
  const paid = titlePaid(t);
  if (paid.isZero()) { db.titles = db.titles.filter((x) => x.id !== t.id); return ZERO; }
  assert(paid.lte(receivable), `O cliente já pagou R$ ${paid.toFixed(2)} por esta peça, mais do que o valor a receber desta venda (R$ ${receivable.toFixed(2)}). Ajuste o valor da venda ou estorne parte do recebimento.`);
  t.advance = { orderId: alloc.id, amount: t.amount, description: t.description, dueDate: t.dueDate, competenceDate: t.competenceDate,
    allocation: { finishedGoodId, quoteId: alloc.quoteId, itemId: alloc.itemId, qty: alloc.qty, customerId: alloc.customerId, dueDate: alloc.dueDate, createdAt: alloc.createdAt } };
  Object.assign(t, { origin: { kind: 'venda', id: sale.id }, amount: paid.toString(), status: 'liquidado', competenceDate: sale.date,
    description: `Venda ${sale.number} — ${sale.description} (pago antes da entrega)` });
  return paid;
}

/** Venda cancelada: o que foi pago antes da entrega volta para a conta do pedido (ou da separação do estoque). */
export function restoreOrderAdvance(db: DB, sale: Sale) {
  for (const t of db.titles.filter((x) => x.origin.kind === 'venda' && x.origin.id === sale.id && x.advance)) {
    const a = t.advance!;
    const paid = titlePaid(t);
    const amount = Decimal.max(D(a.amount), paid);
    if (a.allocation) {
      // A separação volta para o estoque (as peças voltam a ficar separadas para o pedido).
      const fg = db.finishedGoods.find((g) => g.id === a.allocation!.finishedGoodId);
      if (fg && !(fg.allocations ?? []).some((x) => x.id === a.orderId)) {
        const { finishedGoodId: _f, ...rest } = a.allocation;
        void _f;
        fg.allocations = [...(fg.allocations ?? []), { id: a.orderId, ...rest }];
      }
      Object.assign(t, { origin: { kind: 'separacao', id: a.orderId }, amount: amount.toString(), description: a.description, dueDate: a.dueDate, competenceDate: a.competenceDate });
      t.status = titleOpen(t).isZero() ? 'liquidado' : 'aberto';
      delete t.advance;
      continue;
    }
    Object.assign(t, { origin: { kind: 'pedido', id: a.orderId }, amount: amount.toString(), description: a.description, dueDate: a.dueDate, competenceDate: a.competenceDate });
    t.status = titleOpen(t).isZero() ? 'liquidado' : 'aberto';
    delete t.advance;
  }
}

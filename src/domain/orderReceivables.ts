/**
 * Conta a receber do pedido (recebimento antes da entrega).
 *
 * Quando a peça do orçamento vai para produção ("A produzir"), o valor do pedido entra em
 * Contas a receber, com vencimento na data de entrega. O cliente pode pagar antes (sinal ou
 * total) a qualquer momento. Na entrega, a venda aproveita o que já foi recebido e só gera
 * conta a receber do restante. Não é receita: o resultado continua contando a venda na entrega.
 */
import type { DB, FinTitle, ID, ProductionOrder, Sale } from './types';
import { D, Decimal, ZERO } from './money';
import { BusinessError, assert, audit, newId, nowISO, toLocalDate, todayISO } from './core';
import { categoryByName, titleOpen, titlePaid } from './finance';
import { SYS_FIN } from './schema';
import { quoteItemAt } from './quotes';

/** Desde quando as peças concluídas aguardam destino no quadro (antes disso eram tratadas como entregues). */
export const DESTINATION_SINCE = '2026-11-01';

/** Valor do pedido para o cliente (valor da peça no orçamento, na versão enviada para produção). */
export function orderValue(db: DB, o: ProductionOrder): Decimal | null {
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const it = q ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) : undefined;
  return it?.summary.orderPrice ? D(it.summary.orderPrice) : null;
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

/** Leva para Contas a receber todos os pedidos na esteira que ainda não têm conta. Retorna quantas criou. */
export function provisionOrderReceivables(db: DB): number {
  let n = 0;
  for (const o of db.orders) {
    if (orderReceivable(db, o.id) || !orderOnTrack(db, o)) continue;
    if (provisionOrderReceivable(db, o)) n++;
  }
  if (n) audit(db, 'Contas a receber dos pedidos', `${n} pedido(s) na esteira levados para Contas a receber`);
  return n;
}

/** Pedidos na esteira que ainda não estão em Contas a receber (e têm valor). */
export function pendingOrderReceivables(db: DB): ProductionOrder[] {
  return db.orders.filter((o) => !orderReceivable(db, o.id) && orderOnTrack(db, o) && !!orderValue(db, o)?.gt(0));
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

/** Venda cancelada: o que foi pago antes da entrega volta para a conta do pedido. */
export function restoreOrderAdvance(db: DB, sale: Sale) {
  for (const t of db.titles.filter((x) => x.origin.kind === 'venda' && x.origin.id === sale.id && x.advance)) {
    const a = t.advance!;
    const paid = titlePaid(t);
    const amount = Decimal.max(D(a.amount), paid);
    Object.assign(t, { origin: { kind: 'pedido', id: a.orderId }, amount: amount.toString(), description: a.description, dueDate: a.dueDate, competenceDate: a.competenceDate });
    t.status = titleOpen(t).isZero() ? 'liquidado' : 'aberto';
    delete t.advance;
  }
}

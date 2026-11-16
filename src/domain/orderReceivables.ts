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
import { itemState, quoteItemAt, quoteItems } from './quotes';

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

/* ---------------- Peça aprovada pelo cliente, ainda sem produção (v1.31) ---------------- */
/**
 * Peça aprovada pelo cliente ("Cliente aprovou") entra em Contas a receber e em Vendas na hora (origem
 * "aprovacao", id = itemId), antes de ir para produção — para cobrar o sinal e o pedido fechar com o orçamento.
 *  - Enviada para produção como Venda: a conta passa para o pedido (mantém o que já foi pago).
 *  - Enviada como Estoque, reaberta, recusada ou excluída: a conta sai (bloqueia se o cliente já pagou).
 *  - Vendida direto (sem produção): a venda aproveita o que já foi pago.
 *  - Preço mudou no orçamento: o valor da conta acompanha.
 */
export function approvalReceivable(db: DB, itemId: ID): FinTitle | undefined {
  return db.titles.find((t) => t.origin.kind === 'aprovacao' && t.origin.id === itemId && t.status !== 'cancelado');
}

/** A peça deve ter conta de aprovação? (aprovada, sem pedido/separação/venda, não é do estoque, com valor). */
function approvalValue(db: DB, q: Quote, itemId: ID): Decimal | null {
  const it = quoteItems(q).find((x) => x.itemId === itemId);
  if (!it || it.finishedGoodId || !it.summary.orderPrice || !D(it.summary.orderPrice).gt(0)) return null;
  if (itemState(db, q, itemId) !== 'aprovado') return null;
  if (db.sales.some((s) => s.status === 'ativa' && s.quoteId === q.id && s.quoteItemId === itemId)) return null;
  // Frete do orçamento: fica com a 1ª peça aprovada enquanto nenhum pedido foi para produção.
  const freight = !freightCarrierOrderId(db, q) && firstApprovedItem(db, q) === itemId ? quoteClientFreight(q) : ZERO;
  return D(it.summary.orderPrice).plus(freight);
}

function firstApprovedItem(db: DB, q: Quote): ID | null {
  return quoteItems(q).find((it) => !it.finishedGoodId && itemState(db, q, it.itemId) === 'aprovado'
    && !db.sales.some((s) => s.status === 'ativa' && s.quoteId === q.id && s.quoteItemId === it.itemId))?.itemId ?? null;
}

/** Cria, atualiza ou retira a conta de aprovação da peça, conforme a situação atual. */
export function syncApprovalReceivable(db: DB, q: Quote, itemId: ID): FinTitle | null {
  const value = approvalValue(db, q, itemId);
  const t = approvalReceivable(db, itemId);
  const it = quoteItems(q).find((x) => x.itemId === itemId);
  const c = db.parties.find((p) => p.id === q.customerId)?.name;
  const description = `Pedido ${q.number} — ${it?.name ?? 'peça'} (aprovado, a produzir)${c ? ` — ${c}` : ''}`;
  if (!value) {
    if (!t) return null;
    const paid = titlePaid(t);
    if (paid.gt(0)) throw new BusinessError(`O cliente já pagou R$ ${paid.toFixed(2)} de "${it?.name ?? 'esta peça'}". Para tirar a peça da venda (reabrir, recusar, excluir ou produzir para estoque), estorne o recebimento antes em Vendas → pedido → Recebimentos.`);
    db.titles = db.titles.filter((x) => x.id !== t.id);
    return null;
  }
  if (t) {
    const paid = titlePaid(t);
    if (!D(t.amount).eq(value)) {
      if (value.lt(paid)) throw new BusinessError(`O novo valor de "${it?.name}" (R$ ${value.toFixed(2)}) é menor do que o cliente já pagou (R$ ${paid.toFixed(2)}). Estorne parte do recebimento antes.`);
      t.amount = value.toString();
      t.status = titleOpen(t).isZero() ? 'liquidado' : 'aberto';
    }
    Object.assign(t, { description, partyId: q.customerId, projectId: q.projectId });
    return t;
  }
  const today = todayISO();
  const nt: FinTitle = {
    id: newId(), direction: 'in', description, categoryId: categoryByName(db, SYS_FIN.vendaProdutos).id, amount: value.toString(),
    competenceDate: today, dueDate: today, partyId: q.customerId, projectId: q.projectId, origin: { kind: 'aprovacao', id: itemId },
    status: 'aberto', settlements: [], createdAt: nowISO(),
    notes: 'Peça aprovada pelo cliente. O cliente pode pagar antes (sinal ou total); ao enviar para produção, a conta passa para o pedido.',
  };
  db.titles.push(nt);
  return nt;
}

/** Atualiza as contas de aprovação de todas as peças do orçamento (e retira as de peças que saíram dele). */
export function syncQuoteApprovalReceivables(db: DB, q: Quote): number {
  let created = 0;
  const ids = new Set(quoteItems(q).map((it) => it.itemId));
  for (const t of db.titles.filter((x) => x.origin.kind === 'aprovacao' && x.status !== 'cancelado' && x.description.startsWith(`Pedido ${q.number} `) && !ids.has(x.origin.id!))) {
    if (titlePaid(t).gt(0)) throw new BusinessError(`O cliente já pagou R$ ${titlePaid(t).toFixed(2)} de uma peça que saiu do orçamento ${q.number}. Estorne o recebimento antes.`);
    db.titles = db.titles.filter((x) => x.id !== t.id);
  }
  for (const it of quoteItems(q)) {
    const had = !!approvalReceivable(db, it.itemId);
    const t = syncApprovalReceivable(db, q, it.itemId);
    if (t && !had) created++;
  }
  return created;
}

/** Peça enviada para produção como Venda: a conta de aprovação vira a conta do pedido (com o que já foi pago). */
export function moveApprovalToOrder(db: DB, o: ProductionOrder): FinTitle | null {
  if (!o.quoteItemId) return null;
  const t = approvalReceivable(db, o.quoteItemId);
  if (!t) return null;
  const value = orderValue(db, o);
  const paid = titlePaid(t);
  if (!value || value.lt(paid)) throw new BusinessError(`O cliente já pagou R$ ${paid.toFixed(2)} desta peça, mais que o valor do pedido. Estorne parte do recebimento antes.`);
  Object.assign(t, { origin: { kind: 'pedido', id: o.id }, amount: value.toString(), description: describe(db, o), partyId: o.customerId, dueDate: o.dueDate && o.dueDate >= t.competenceDate ? o.dueDate : t.dueDate,
    notes: 'Previsto para a entrega. O cliente pode pagar antes (sinal ou total); na entrega, vira a venda.' });
  t.status = titleOpen(t).isZero() ? 'liquidado' : 'aberto';
  return t;
}

/** Venda direta da peça aprovada (sem produção): a conta de aprovação passa para a venda. */
export function takeApprovalAdvance(db: DB, quoteId: ID | undefined, itemId: ID | undefined, sale: Sale, receivable: Decimal): Decimal {
  const t = itemId ? approvalReceivable(db, itemId) : undefined;
  if (!t || !quoteId) return ZERO;
  const paid = titlePaid(t);
  if (paid.isZero()) { db.titles = db.titles.filter((x) => x.id !== t.id); return ZERO; }
  assert(paid.lte(receivable), `O cliente já pagou R$ ${paid.toFixed(2)} por esta peça, mais do que o valor a receber desta venda (R$ ${receivable.toFixed(2)}).`);
  t.advance = { orderId: itemId!, amount: t.amount, description: t.description, dueDate: t.dueDate, competenceDate: t.competenceDate, approval: { quoteId, itemId: itemId! } };
  Object.assign(t, { origin: { kind: 'venda', id: sale.id }, amount: paid.toString(), status: 'liquidado', competenceDate: sale.date,
    description: `Venda ${sale.number} — ${sale.description} (pago antes da entrega)` });
  return paid;
}

/** Peças aprovadas ainda sem conta (para o aviso e para levar ao abrir o sistema). */
export function pendingApprovalReceivables(db: DB): number {
  let n = 0;
  for (const q of db.quotes) for (const it of quoteItems(q)) if (!approvalReceivable(db, it.itemId) && approvalValue(db, q, it.itemId)) n++;
  return n;
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
  // v1.31: peças aprovadas pelo cliente, ainda sem produção.
  for (const q of db.quotes) {
    for (const it of quoteItems(q)) {
      if (approvalReceivable(db, it.itemId) || !approvalValue(db, q, it.itemId)) continue;
      if (syncApprovalReceivable(db, q, it.itemId)) n++;
    }
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
    if (a.approval) {
      // Volta a ser a conta da peça aprovada.
      Object.assign(t, { origin: { kind: 'aprovacao', id: a.approval.itemId }, amount: amount.toString(), description: a.description, dueDate: a.dueDate, competenceDate: a.competenceDate });
      t.status = titleOpen(t).isZero() ? 'liquidado' : 'aberto';
      delete t.advance;
      continue;
    }
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

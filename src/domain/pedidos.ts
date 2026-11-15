/**
 * Vendas por PEDIDO (v1.29).
 *
 * Um pedido é o orçamento do cliente: junta todas as peças dele, estejam em produção (conta a receber do pedido)
 * ou já entregues (vendas). Vendas sem orçamento formam um pedido sozinhas.
 *
 * Recebimento do pedido como um todo:
 *   - por percentual: X% de CADA peça (cada linha recebe X% do seu valor), ou seja, rateado pela quantidade de peças;
 *   - por valor: o valor é rateado pelas linhas na proporção do que cada uma ainda tem a receber.
 * Dentro de cada linha, baixa primeiro a parcela que vence antes. Entra no extrato na data informada.
 */
import type { DB, FinTitle, ID, ISODate, ProductionOrder, Sale } from './types';
import { D, Decimal, ZERO, cents, sum } from './money';
import { BusinessError, assert, audit, byId, isISODate } from './core';
import { settleTitle, titleOpen, titlePaid } from './finance';
import { orderOnTrack, orderReceivable } from './orderReceivables';
import { ITEM_STATE_LABEL, itemState, quoteItems } from './quotes';

export interface PedidoLine {
  key: string;
  kind: 'venda' | 'pedido';
  label: string;
  number: string;
  qty: number;
  total: Decimal;
  received: Decimal;
  open: Decimal;
  delivered: boolean;
  cancelled: boolean;
  titles: FinTitle[];
  sale?: Sale;
  order?: ProductionOrder;
  nextDue: ISODate | null;
}

export interface Pedido {
  key: string;
  number: string;
  quoteId?: ID;
  customerId?: ID;
  date: ISODate;
  lines: PedidoLine[];
  qty: number;
  total: Decimal;
  received: Decimal;
  open: Decimal;
  receivedPct: Decimal;
  delivery: 'entregue' | 'parcial' | 'a_entregar' | 'cancelado';
  payment: 'pago' | 'parcial' | 'a_receber' | 'cancelado';
  nextDue: ISODate | null;
  overdue: boolean;
  /** Peças do orçamento que ainda não viraram pedido nem venda (não aprovadas ou não enviadas para produção). */
  pendingItems: { name: string; qty: number; price: Decimal | null; state: string }[];
  pendingTotal: Decimal;
}

function lineFromTitles(base: Omit<PedidoLine, 'total' | 'received' | 'open' | 'nextDue'>): PedidoLine {
  const ts = base.titles;
  const pending = ts.filter((t) => t.status === 'aberto').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { ...base, total: sum(ts.map((t) => D(t.amount))), received: sum(ts.map((t) => titlePaid(t))), open: sum(ts.map((t) => titleOpen(t))), nextDue: pending[0]?.dueDate ?? null };
}

/** Pedidos (orçamentos) com todas as peças: vendidas (entregues) e em produção (a entregar). */
export function salesPedidos(db: DB, today: ISODate): Pedido[] {
  // v1.30: peças do orçamento que ficaram de fora (não aprovadas ou não enviadas) — aparecem como aviso no pedido.
  const pending = (quoteId: ID | undefined, lines: PedidoLine[]) => {
    const q = quoteId ? db.quotes.find((x) => x.id === quoteId) : undefined;
    if (!q) return { pendingItems: [], pendingTotal: ZERO };
    const items = quoteItems(q).filter((it) => {
      const st = itemState(db, q, it.itemId);
      if (st === 'recusado') return false;
      const inLines = lines.some((l) => !l.cancelled && ((l.order?.quoteItemId === it.itemId) || l.sale?.quoteItemId === it.itemId || (l.sale?.orderId && db.orders.find((o) => o.id === l.sale!.orderId)?.quoteItemId === it.itemId)
        || (l.key.startsWith('s:') && db.finishedGoods.some((g) => g.allocations?.some((a) => `s:${a.id}` === l.key && a.itemId === it.itemId)))));
      return !inLines;
    });
    const list = items.map((it) => ({ name: it.name, qty: it.input.quantity, price: it.summary.orderPrice ? D(it.summary.orderPrice) : null, state: ITEM_STATE_LABEL[itemState(db, q, it.itemId)] }));
    return { pendingItems: list, pendingTotal: sum(list.map((x) => x.price ?? ZERO)) };
  };
  const groups = new Map<string, { quoteId?: ID; customerId?: ID; date: ISODate; lines: PedidoLine[] }>();
  const put = (key: string, info: { quoteId?: ID; customerId?: ID; date: ISODate }, line: PedidoLine) => {
    const g = groups.get(key) ?? { ...info, lines: [] };
    if (!g.customerId && info.customerId) g.customerId = info.customerId;
    if (info.date < g.date) g.date = info.date;
    g.lines.push(line);
    groups.set(key, g);
  };
  for (const s of db.sales) {
    const titles = db.titles.filter((t) => t.origin.kind === 'venda' && t.origin.id === s.id && t.direction === 'in' && t.status !== 'cancelado');
    const key = s.quoteId ? `q:${s.quoteId}` : `v:${s.id}`;
    put(key, { quoteId: s.quoteId, customerId: s.customerId, date: s.date },
      lineFromTitles({ key: `v:${s.id}`, kind: 'venda', label: s.description, number: s.number, qty: s.qty, delivered: true, cancelled: s.status !== 'ativa', titles, sale: s }));
  }
  for (const o of db.orders) {
    if (!orderOnTrack(db, o)) continue;
    const t = orderReceivable(db, o.id);
    if (!t) continue;
    const key = o.quoteId ? `q:${o.quoteId}` : `o:${o.id}`;
    const date = (o.createdAt ?? '').slice(0, 10) || today;
    put(key, { quoteId: o.quoteId, customerId: o.customerId, date },
      lineFromTitles({ key: `o:${o.id}`, kind: 'pedido', label: o.description, number: o.number, qty: Math.max(1, o.actual?.qtyApproved || o.qtyPlanned), delivered: false, cancelled: false, titles: [t], order: o }));
  }
  // v1.30: peças do estoque separadas para o pedido (conta a receber da separação).
  for (const t of db.titles) {
    if (t.origin.kind !== 'separacao' || t.status === 'cancelado') continue;
    let found: { fg: (typeof db.finishedGoods)[number]; a: NonNullable<(typeof db.finishedGoods)[number]['allocations']>[number] } | undefined;
    for (const fg of db.finishedGoods) { const a = fg.allocations?.find((x) => x.id === t.origin.id); if (a) { found = { fg, a }; break; } }
    if (!found) continue;
    const q = db.quotes.find((x) => x.id === found!.a.quoteId);
    const it = q?.versions.length ? q.versions[q.versions.length - 1].items.find((x) => x.itemId === found!.a.itemId) : undefined;
    put(`q:${found.a.quoteId}`, { quoteId: found.a.quoteId, customerId: found.a.customerId ?? q?.customerId, date: t.competenceDate },
      lineFromTitles({ key: `s:${found.a.id}`, kind: 'pedido', label: it?.name ?? found.fg.description, number: found.fg.code, qty: found.a.qty, delivered: false, cancelled: false, titles: [t] }));
  }
  const out: Pedido[] = [];
  for (const [key, g] of groups) {
    const live = g.lines.filter((l) => !l.cancelled);
    const total = sum(live.map((l) => l.total)), received = sum(live.map((l) => l.received)), open = sum(live.map((l) => l.open));
    const q = g.quoteId ? db.quotes.find((x) => x.id === g.quoteId) : undefined;
    const delivered = live.filter((l) => l.delivered).length;
    const dues = live.map((l) => l.nextDue).filter(Boolean).sort() as ISODate[];
    const nextDue = dues[0] ?? null;
    out.push({
      key, number: q?.number ?? g.lines[0].number, quoteId: g.quoteId, customerId: g.customerId ?? q?.customerId, date: g.date, lines: g.lines,
      qty: live.reduce((s, l) => s + l.qty, 0), total, received, open,
      receivedPct: total.isZero() ? ZERO : received.div(total).times(100),
      delivery: !live.length ? 'cancelado' : delivered === live.length ? 'entregue' : delivered === 0 ? 'a_entregar' : 'parcial',
      payment: !live.length ? 'cancelado' : open.isZero() ? 'pago' : received.gt(0) ? 'parcial' : 'a_receber',
      nextDue, overdue: !!nextDue && nextDue < today && open.gt(0), ...pending(g.quoteId, g.lines),
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
}

/** Reparte `total` entre os pesos, em centavos, com a soma exata (diferença na linha de maior peso). */
function splitCents(total: Decimal, weights: Decimal[]): Decimal[] {
  const wsum = sum(weights);
  if (wsum.isZero()) return weights.map(() => ZERO);
  const parts = weights.map((w) => cents(total.times(w).div(wsum)));
  const diff = total.minus(sum(parts));
  if (!diff.isZero()) {
    let k = 0;
    weights.forEach((w, i) => { if (w.gt(weights[k])) k = i; });
    parts[k] = parts[k].plus(diff);
  }
  return parts;
}

/** Quanto cada linha recebe: por % (de cada peça) ou por valor (proporcional ao que falta em cada linha). */
export function pedidoPaymentPlan(p: Pedido, input: { mode: 'pct' | 'valor'; value: string }) {
  const live = p.lines.filter((l) => !l.cancelled && l.open.gt(0));
  const v = D(input.value || '0');
  const amount = input.mode === 'pct' ? cents(p.total.times(v).div(100)) : cents(v);
  // Por %: cada linha recebe X% do seu valor; o que não couber numa linha (já paga) passa para as outras.
  let plan = input.mode === 'pct' ? splitCents(amount, live.map((l) => l.total)) : splitCents(amount, live.map((l) => l.open));
  let carry = ZERO;
  plan = plan.map((x, i) => { const cap = Decimal.min(x, live[i].open); carry = carry.plus(x.minus(cap)); return cap; });
  for (let i = 0; i < live.length && carry.gt(0); i++) {
    const room = live[i].open.minus(plan[i]);
    const add = Decimal.min(room, carry);
    plan[i] = plan[i].plus(add);
    carry = carry.minus(add);
  }
  return { amount, lines: live.map((l, i) => ({ line: l, amount: plan[i] })).filter((x) => x.amount.gt(0)), leftover: carry };
}

/** Recebimento do pedido como um todo (sinal em % ou valor), rateado pelas peças. */
export function receivePedidoPayment(db: DB, key: string, input: { mode: 'pct' | 'valor'; value: string; date: ISODate; accountId: ID; method?: string }, today: ISODate) {
  const p = salesPedidos(db, today).find((x) => x.key === key);
  if (!p) throw new BusinessError('Pedido não encontrado.');
  assert(isISODate(input.date), 'Informe a data do recebimento.');
  assert(input.accountId, 'Selecione a conta em que o dinheiro entrou.');
  byId(db.accounts, input.accountId, 'Conta financeira');
  const v = D(input.value || '0');
  if (input.mode === 'pct') assert(v.gt(0) && v.lte(100), 'O percentual deve ser maior que 0% e até 100%.');
  else assert(v.gt(0), 'Informe o valor recebido.');
  assert(p.open.gt(0), 'Este pedido já está totalmente recebido.');
  const plan = pedidoPaymentPlan(p, input);
  assert(plan.amount.gt(0), 'O recebimento ficou em R$ 0,00.');
  if (plan.amount.gt(p.open)) {
    throw new BusinessError(`O recebimento (R$ ${plan.amount.toFixed(2)}) é mais do que falta receber no pedido (R$ ${p.open.toFixed(2)}).`);
  }
  const method = input.method?.trim();
  const tag = input.mode === 'pct' ? (method ? `Sinal · ${method}` : 'Sinal') : method || undefined;
  for (const { line, amount } of plan.lines) {
    let left = amount;
    for (const t of line.titles.filter((x) => x.status === 'aberto').sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
      if (left.isZero()) break;
      const part = Decimal.min(left, titleOpen(t));
      if (part.lte(0)) continue;
      settleTitle(db, { titleId: t.id, date: input.date, amount: part.toString(), accountId: input.accountId, method: tag });
      left = left.minus(part);
    }
  }
  audit(db, 'Recebimento do pedido', `${p.number}: ${input.mode === 'pct' ? `${v.toString()}% = ` : ''}R$ ${plan.amount.toFixed(2)} (R$ ${plan.amount.div(Math.max(1, p.qty)).toFixed(3)} por peça, ${p.qty} peça(s))`);
  return plan;
}

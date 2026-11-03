/** v1.16: pedido em produção gera conta a receber; cliente paga antes (sinal/total); a venda aproveita. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty } from './catalog';
import { registerPurchase } from './purchases';
import { cancelTitle, settleTitle, titleOpen } from './finance';
import { emptyQuoteInput, latestVersion, saveQuote, setItemStatus } from './quotes';
import { completeOrder, createOrdersFromQuote, orderDeleteBlock, orderReservations, orderUndoBlockers, returnOrderToQuote, sendOrderToStock, startOrder } from './production';
import { itemState } from './quotes';
import { cancelSale, managementResult, registerSale, saleEditBlock, saleStatus } from './sales';
import { orderPayment, orderReceivable, pendingOrderReceivables, provisionOrderReceivables } from './orderReceivables';
import { cashStatement } from './reports';
import type { DB, ProductionOrder } from './types';

let db: DB;
let acc: string;
const cash = (date: string) => ({ mode: 'avista' as const, accountId: acc, installments: 1, firstDue: date, intervalDays: 30 });
const later = { mode: 'aprazo' as const, installments: 1, firstDue: '2026-12-20', intervalDays: 30 };

function newOrder(): { o: ProductionOrder; value: string; cli: string } {
  const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Azul' } });
  registerPurchase(db, { date: '2026-11-01', items: [{ materialId: fil.id, qty: 1000, price: '90' }], freight: '0', otherCosts: '0', payment: cash('2026-11-01') });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const cli = saveParty(db, { kind: 'cliente', name: 'Ana' });
  const q = saveQuote(db, { name: 'Vaso', customerId: cli.id }, [{ name: 'Vaso', input: { ...emptyQuoteInput(db.settings), quantity: 2, channelId: ch.id, markupPct: '50', failureRatePct: '0', printHoursPerUnit: 1, materials: [{ materialId: fil.id, qtyPerUnit: 50 }] } }]);
  const it = latestVersion(q).items[0];
  setItemStatus(db, q.id, it.itemId, 'aprovado');
  const o = createOrdersFromQuote(db, q.id, [it.itemId], { dueDate: '2026-11-30' })[0];
  return { o, value: it.summary.orderPrice!, cli: cli.id };
}
function finish(o: ProductionOrder) {
  startOrder(db, o.id);
  completeOrder(db, o.id, { materials: orderReservations(db, o.id).map((r) => ({ lotId: r.lotId, qty: r.qty.toNumber() })), hours: 2, qtyApproved: 2, qtyRejected: 0, laborMinutes: 0, failures: [] });
}
const sell = (o: ProductionOrder, cli: string, value: string, payment: ReturnType<typeof cash> | typeof later, date = '2026-11-28') =>
  registerSale(db, { date, orderId: o.id, customerId: cli, description: 'Vaso', qty: 2, unitPrice: String(Number(value) / 2), discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment });

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '0', openingDate: '2026-01-01', active: true });
  acc = db.accounts[0].id;
});

describe('Conta a receber do pedido', () => {
  it('enviar para produção gera a conta a receber com vencimento na entrega (não é receita)', () => {
    const { o, value } = newOrder();
    const t = orderReceivable(db, o.id)!;
    expect([t.amount, t.dueDate, t.direction, t.status]).toEqual([value, '2026-11-30', 'in', 'aberto']);
    expect(t.partyId).toBeTruthy();
    expect(managementResult(db, '2026-01-01', '2026-12-31').revenue.toString()).toBe('0');
  });

  it('sinal antes de produzir; na entrega a venda cobra só o restante e soma o sinal como recebido', () => {
    const { o, value, cli } = newOrder();
    const t = orderReceivable(db, o.id)!;
    settleTitle(db, { titleId: t.id, date: '2026-11-03', amount: '5', accountId: acc });
    expect(orderPayment(db, o)).toMatchObject({ status: 'parcial' });
    finish(o);
    const s = sell(o, cli, value, later);
    expect(orderReceivable(db, o.id)).toBeUndefined();
    const st = saleStatus(db, s, '2026-11-28');
    expect([st.total.toString(), st.received.toString(), st.open.toString(), st.status]).toEqual([value, '5', String(Number(value) - 5), 'a_pagar']);
    // O sinal continua no extrato na data em que entrou
    expect(cashStatement(db, { from: '2026-11-03', to: '2026-11-03' }).totalIn.toString()).toBe('5');
    expect(saleEditBlock(db, s)).toMatch(/antes da entrega/);
    expect(managementResult(db, '2026-11-01', '2026-11-30').revenue.toString()).toBe(value);
  });

  it('pago todo antes: a venda não gera nova conta e já nasce paga', () => {
    const { o, value, cli } = newOrder();
    settleTitle(db, { titleId: orderReceivable(db, o.id)!.id, date: '2026-11-02', amount: value, accountId: acc });
    finish(o);
    const s = sell(o, cli, value, { mode: 'avista', installments: 1, firstDue: '2026-11-28', intervalDays: 30 } as ReturnType<typeof cash>);
    const st = saleStatus(db, s, '2026-11-28');
    expect([st.status, st.received.toString(), st.titleIds]).toEqual(['pago', value, []]);
    expect(db.titles.filter((t) => t.origin.kind === 'venda' && t.origin.id === s.id)).toHaveLength(1);
  });

  it('sem pagamento antes: a conta do pedido é substituída pela da venda (sem duplicar)', () => {
    const { o, value, cli } = newOrder();
    finish(o);
    const s = sell(o, cli, value, later);
    const open = db.titles.filter((t) => t.direction === 'in' && t.status === 'aberto');
    expect(open).toHaveLength(1);
    expect(open[0].origin).toEqual({ kind: 'venda', id: s.id });
  });

  it('cancelar a venda devolve o sinal para a conta do pedido', () => {
    const { o, value, cli } = newOrder();
    settleTitle(db, { titleId: orderReceivable(db, o.id)!.id, date: '2026-11-03', amount: '5', accountId: acc });
    finish(o);
    const s = sell(o, cli, value, later);
    cancelSale(db, s.id, 'cliente desistiu da entrega hoje');
    const t = orderReceivable(db, o.id)!;
    expect([t.amount, t.status, titleOpen(t).toString()]).toEqual([value, 'aberto', String(Number(value) - 5)]);
  });

  it('pago antes mais do que a venda: avisa', () => {
    const { o, value, cli } = newOrder();
    settleTitle(db, { titleId: orderReceivable(db, o.id)!.id, date: '2026-11-03', amount: value, accountId: acc });
    finish(o);
    expect(() => registerSale(db, { date: '2026-11-28', orderId: o.id, customerId: cli, description: 'Vaso', qty: 1, unitPrice: '1', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: later })).toThrow(/já pagou/);
  });

  it('voltar ao orçamento: retira a conta; com pagamento, pede estorno antes', () => {
    const { o } = newOrder();
    const t = orderReceivable(db, o.id)!;
    expect(() => cancelTitle(db, t.id, 'x')).toThrow(/pedido/);
    settleTitle(db, { titleId: t.id, date: '2026-11-03', amount: '1', accountId: acc });
    expect(() => returnOrderToQuote(db, o.id, 'mudou a cor')).toThrow(/Estorne/);
    t.settlements[0].reversed = { at: '2026-11-03T00:00:00Z', reason: 'teste' };
    returnOrderToQuote(db, o.id, 'mudou a cor');
    expect(orderReceivable(db, o.id)).toBeUndefined();
  });

  it('pedido já produzido e enviado ao estoque (separado para o cliente) pode voltar ao orçamento ou ser excluído', () => {
    const { o } = newOrder();
    finish(o);
    const fg = sendOrderToStock(db, o.id);
    expect(orderDeleteBlock(db, db.orders.find((x) => x.id === o.id)!)).toBeNull();
    const consumed = db.movements.filter((m) => m.ref.id === o.id).length;
    expect(consumed).toBeGreaterThan(0);
    returnOrderToQuote(db, o.id, 'cliente mudou a cor');
    const back = db.orders.find((x) => x.id === o.id)!;
    expect(back.status).toBe('cancelada');
    expect(db.finishedGoods.some((g) => g.id === fg.id)).toBe(false);
    expect(db.movements.filter((m) => m.ref.id === o.id)).toHaveLength(0); // filamento volta ao estoque
    expect(orderReceivable(db, o.id)).toBeUndefined();
    const q = db.quotes.find((x) => x.id === back.quoteId)!;
    expect(itemState(db, q, back.quoteItemId!)).toBe('aprovado');
  });

  it('com venda registrada: pede para cancelar a venda antes; depois retorna', () => {
    const { o, value, cli } = newOrder();
    finish(o);
    const s = sell(o, cli, value, later);
    const cur = () => db.orders.find((x) => x.id === o.id)!;
    expect(orderUndoBlockers(db, cur()).map((b) => b.saleId)).toEqual([s.id]);
    expect(() => returnOrderToQuote(db, o.id, 'erro')).toThrow(/Cancele a venda/);
    cancelSale(db, s.id, 'entrega registrada por engano');
    returnOrderToQuote(db, o.id, 'erro');
    expect(cur().status).toBe('cancelada');
  });

  it('pedidos já na esteira (sem conta) são levados para Contas a receber uma única vez', () => {
    const { o } = newOrder();
    db.titles = db.titles.filter((t) => t.origin.kind !== 'pedido'); // como era antes da v1.16
    expect(pendingOrderReceivables(db).map((x) => x.id)).toEqual([o.id]);
    expect(provisionOrderReceivables(db)).toBe(1);
    expect(provisionOrderReceivables(db)).toBe(0);
    expect(orderReceivable(db, o.id)?.dueDate).toBe('2026-11-30');
  });

  it('peças concluídas antes do quadro de destino (antigas) não viram conta a receber', () => {
    const { o } = newOrder();
    finish(o);
    db.titles = db.titles.filter((t) => t.origin.kind !== 'pedido');
    db.orders.find((x) => x.id === o.id)!.finishedAt = '2026-10-15T12:00:00Z';
    expect(pendingOrderReceivables(db)).toEqual([]);
  });
});

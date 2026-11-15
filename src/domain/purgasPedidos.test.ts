/** v1.29: purga por cor, estoque de purgas, peças de purga, gastos extras no acabamento e vendas por pedido. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty } from './catalog';
import { registerPurchase } from './purchases';
import { accountBalance } from './finance';
import { emptyQuoteInput, latestVersion, saveQuote } from './quotes';
import { addOrderExtraCost, compareOrder, completeOrder, createOrdersFromQuote, orderReservations, removeOrderExtraCost, returnOrderToQuote, startOrder } from './production';
import { orderPurgeReport, recordMeasurement } from './medicao';
import { addManualPurge, createPurgePiece, deletePurgePiece, purgeBalance, purgeOverview, purgeResult, takePurge } from './purges';
import { receivePedidoPayment, salesPedidos } from './pedidos';
import { registerSale } from './sales';
import type { DB } from './types';

let db: DB;
let acc: string;
const T = '2026-11-16';
const cash = (date: string) => ({ mode: 'avista' as const, accountId: acc, installments: 1, firstDue: date, intervalDays: 30 });

function setup() {
  const cat = db.categories.find((c) => c.isFilament)!.id;
  const azul = saveMaterial(db, { name: 'PLA Azul', categoryId: cat, unit: 'g', active: true, referenceCost: '0.1', filament: { materialType: 'PLA', color: 'Azul' } });
  const branco = saveMaterial(db, { name: 'PLA Branco', categoryId: cat, unit: 'g', active: true, referenceCost: '0.08', filament: { materialType: 'PLA', color: 'Branco' } });
  registerPurchase(db, { date: '2026-11-01', items: [{ materialId: azul.id, qty: 2000, price: '200' }, { materialId: branco.id, qty: 2000, price: '160' }], freight: '0', otherCosts: '0', payment: cash('2026-11-01') });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const cli = saveParty(db, { kind: 'cliente', name: 'Ana' });
  const base = { ...emptyQuoteInput(db.settings), channelId: ch.id, markupPct: '100', failureRatePct: '0', printHoursPerUnit: 1 };
  const q = saveQuote(db, { name: 'Natal', customerId: cli.id }, [
    { name: 'Enfeite', input: { ...base, quantity: 10, materials: [{ materialId: azul.id, qtyPerUnit: 20 }, { materialId: branco.id, qtyPerUnit: 10 }] } },
    { name: 'Vaso', input: { ...base, quantity: 2, materials: [{ materialId: branco.id, qtyPerUnit: 50 }] } },
  ]);
  const ids = latestVersion(q).items.map((i) => i.itemId);
  return { q, ids, cli, azul, branco };
}

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '1000', openingDate: '2026-01-01', active: true });
  acc = db.accounts[0].id;
});

describe('Purga por cor e estoque de purgas', () => {
  it('medição por cor soma na purga da cor (uma por cor), com o manual; re-medir não duplica', () => {
    const { q, ids } = setup();
    addManualPurge(db, { color: 'azul ', g: 100, date: T });
    expect(db.purgeStocks).toHaveLength(1);
    const [o] = createOrdersFromQuote(db, q.id, [ids[0]], { dueDate: '2026-11-30', purpose: 'pedido' });
    startOrder(db, o.id);
    recordMeasurement(db, o.id, { pieceWeightG: 31, purgeG: null, skip: false, purges: [{ color: 'Azul', g: 40 }, { color: 'Branco', g: 15 }, { color: 'Vermelho', g: 5 }] });
    expect(db.purgeStocks.map((p) => p.color).sort()).toEqual(['Branco', 'Vermelho', 'azul']); // azul já existia: não repete
    const azul = db.purgeStocks.find((p) => p.key === 'azul')!;
    expect(purgeBalance(db, azul.id).g).toBe(140);
    expect(db.orders[0].measured!.purgeG).toBe(60);
    recordMeasurement(db, o.id, { pieceWeightG: 31, purgeG: null, skip: false, purges: [{ color: 'Azul', g: 30 }] });
    expect(purgeBalance(db, azul.id).g).toBe(130);
    expect(purgeBalance(db, db.purgeStocks.find((p) => p.key === 'branco')!.id).g).toBe(0);
    // Valor parado: 130 g × R$ 0,10 (último lote do azul)
    expect(purgeBalance(db, azul.id).value.toString()).toBe('13');
  });

  it('% de purga por cor e total sobre o filamento da cor', () => {
    const { q, ids } = setup();
    const [o] = createOrdersFromQuote(db, q.id, [ids[0]], { dueDate: '2026-11-30', purpose: 'pedido' });
    startOrder(db, o.id);
    recordMeasurement(db, o.id, { pieceWeightG: 30, purgeG: null, skip: false, purges: [{ color: 'Azul', g: 50 }, { color: 'Branco', g: 25 }] });
    const r = orderPurgeReport(db, db.orders[0])!;
    // previsto: azul 200 g + 50 de purga; branco 100 g + 25
    expect(r.rows.map((x) => [x.color, x.purgeG, x.filamentG, x.pct!.toString()])).toEqual([['Azul', 50, 250, '20'], ['Branco', 25, 125, '20']]);
    expect(r.pct!.toString()).toBe('20');
  });

  it('reaproveitar/descartar não passa do saldo; peça de purga custa só o gasto adicional e tem resultado à parte', () => {
    const { q, ids } = setup();
    addManualPurge(db, { color: 'Azul', g: 200, date: T });
    const azul = db.purgeStocks[0];
    expect(() => takePurge(db, { purgeId: azul.id, g: 300, date: T, kind: 'reaproveitado' })).toThrow(/Só há/);
    takePurge(db, { purgeId: azul.id, g: 20, date: T, kind: 'descarte' });
    const fg = createPurgePiece(db, { description: 'Chaveiro mesclado', qty: 4, date: T, uses: [{ purgeId: azul.id, g: 80 }], extraCost: '2', suggestedPrice: '10' });
    expect([fg.unitCost, fg.purge!.materialValue]).toEqual(['0.5', '8']);
    expect(purgeBalance(db, azul.id).g).toBe(100);
    const ov = purgeOverview(db);
    expect([ov.generatedG, ov.reusedG, ov.discardedG]).toEqual([200, 80, 20]);
    registerSale(db, { date: T, finishedGoodId: fg.id, description: fg.description, qty: 3, unitPrice: '10', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: cash(T) });
    const r = purgeResult(db);
    expect([r.revenue.toString(), r.extraCosts.toString(), r.result.toString()]).toEqual(['30', '1.5', '28.5']);
    expect(() => deletePurgePiece(db, fg.id)).toThrow(/venda/);
    void q; void ids;
  });

  it('pedido desfeito: a purga dele sai do estoque de purgas', () => {
    const { q, ids } = setup();
    const [o] = createOrdersFromQuote(db, q.id, [ids[0]], { dueDate: '2026-11-30', purpose: 'pedido' });
    startOrder(db, o.id);
    recordMeasurement(db, o.id, { pieceWeightG: 30, purgeG: null, skip: false, purges: [{ color: 'Azul', g: 50 }] });
    returnOrderToQuote(db, o.id, 'teste');
    expect(purgeBalance(db, db.purgeStocks[0].id).g).toBe(0);
  });
});

describe('Gastos extras no acabamento', () => {
  it('entram no custo real por peça; pagamento opcional no financeiro; excluir estorna', () => {
    const { q, ids } = setup();
    const [o] = createOrdersFromQuote(db, q.id, [ids[1]], { dueDate: '2026-11-30', purpose: 'pedido' });
    startOrder(db, o.id);
    const before = accountBalance(db, acc);
    const e = addOrderExtraCost(db, o.id, { description: 'Cordão', amount: '6', date: T, pay: { accountId: acc, method: 'PIX' } });
    expect(accountBalance(db, acc).toString()).toBe(before.minus(6).toString());
    const e2 = addOrderExtraCost(db, o.id, { description: 'Tinta', amount: '4', date: T });
    removeOrderExtraCost(db, o.id, e.id);
    expect(accountBalance(db, acc).toString()).toBe(before.toString());
    completeOrder(db, o.id, { materials: orderReservations(db, o.id).map((x) => ({ lotId: x.lotId, qty: x.qty.toNumber() })), hours: 2, qtyApproved: 2, qtyRejected: 0, laborMinutes: 0, failures: [] });
    const c = compareOrder(db, db.orders.find((x) => x.id === o.id)!);
    expect(c.real!.extras.toString()).toBe('4');
    expect(() => addOrderExtraCost(db, o.id, { description: 'x', amount: '1', date: T })).toThrow(/concluída/);
    void e2;
  });
});

describe('Vendas por pedido', () => {
  it('junta as peças do orçamento (em produção e entregues); 50% recebe metade de cada peça', () => {
    const { q, ids, cli } = setup();
    const [o1, o2] = createOrdersFromQuote(db, q.id, ids, { dueDate: '2026-11-30', purpose: 'pedido' });
    let p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect([p.lines.length, p.qty, p.delivery]).toEqual([2, 12, 'a_entregar']);
    const before = accountBalance(db, acc);
    receivePedidoPayment(db, p.key, { mode: 'pct', value: '50', date: T, accountId: acc, method: 'PIX' }, T);
    p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect(p.lines.map((l) => l.received.toString())).toEqual(p.lines.map((l) => l.total.div(2).toDecimalPlaces(2).toString()));
    expect(accountBalance(db, acc).minus(before).toString()).toBe(p.received.toString());
    // Entrega de uma das peças: vira venda, aproveita o recebido; o pedido fica "entregue em parte".
    startOrder(db, o2.id);
    completeOrder(db, o2.id, { materials: orderReservations(db, o2.id).map((x) => ({ lotId: x.lotId, qty: x.qty.toNumber() })), hours: 2, qtyApproved: 2, qtyRejected: 0, laborMinutes: 0, failures: [] });
    const line2 = p.lines.find((l) => l.order?.id === o2.id)!;
    registerSale(db, { date: T, orderId: o2.id, quoteId: q.id, customerId: cli.id, description: 'Vaso', qty: 2, unitPrice: line2.total.div(2).toString(), discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: '2026-12-10', intervalDays: 30 } });
    p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect(p.delivery).toBe('parcial');
    expect(p.lines.find((l) => l.kind === 'venda')!.received.toString()).toBe(line2.received.toString());
    // Por valor: rateado pelo que falta.
    receivePedidoPayment(db, p.key, { mode: 'valor', value: p.open.toString(), date: T, accountId: acc }, T);
    p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect([p.open.toString(), p.payment]).toEqual(['0', 'pago']);
    expect(() => receivePedidoPayment(db, p.key, { mode: 'pct', value: '10', date: T, accountId: acc }, T)).toThrow(/totalmente recebido/);
    void o1;
  });
});

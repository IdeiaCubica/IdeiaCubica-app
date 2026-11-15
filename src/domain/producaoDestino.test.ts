/** v1.28: ao enviar para produção, o usuário define VENDA (vai para Vendas/Contas a receber, aceita sinal) ou ESTOQUE. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty } from './catalog';
import { registerPurchase } from './purchases';
import { accountBalance } from './finance';
import { emptyQuoteInput, latestVersion, saveQuote } from './quotes';
import { completeOrder, createOrdersFromQuote, orderReservations, startOrder, updateOrderPlanning } from './production';
import { orderReceivable } from './orderReceivables';
import { orderPaymentSplit, receiveOrderDownPayment, registerSale, saleStatus } from './sales';
import type { DB } from './types';

let db: DB;
let acc: string;
const cash = (date: string) => ({ mode: 'avista' as const, accountId: acc, installments: 1, firstDue: date, intervalDays: 30 });

function quote() {
  const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Azul' } });
  registerPurchase(db, { date: '2026-11-01', items: [{ materialId: fil.id, qty: 2000, price: '90' }], freight: '0', otherCosts: '0', payment: cash('2026-11-01') });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const cli = saveParty(db, { kind: 'cliente', name: 'Ana' });
  const q = saveQuote(db, { name: 'Vaso', customerId: cli.id }, [{ name: 'Vaso', input: { ...emptyQuoteInput(db.settings), quantity: 10, channelId: ch.id, markupPct: '50', failureRatePct: '0', printHoursPerUnit: 1, materials: [{ materialId: fil.id, qtyPerUnit: 50 }] } }]);
  return { q, itemId: latestVersion(q).items[0].itemId, cli };
}

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '0', openingDate: '2026-01-01', active: true });
  acc = db.accounts[0].id;
});

describe('Destino da produção: venda ou estoque', () => {
  it('venda: vai para Contas a receber (Vendas) e aceita sinal rateado por peça; na entrega a venda aproveita o sinal', () => {
    const { q, itemId, cli } = quote();
    const [o] = createOrdersFromQuote(db, q.id, [itemId], { dueDate: '2026-11-30', purpose: 'pedido' });
    expect([o.purpose, o.number.startsWith('PED'), o.customerId]).toEqual(['pedido', true, cli.id]);
    const sp = orderPaymentSplit(db, o)!;
    expect(sp.qty).toBe(10);
    const before = accountBalance(db, acc);
    const r = receiveOrderDownPayment(db, { orderId: o.id, pct: '50', date: '2026-11-16', accountId: acc, method: 'PIX' });
    expect(r.amount.toString()).toBe(sp.total.div(2).toDecimalPlaces(2).toString());
    expect(orderPaymentSplit(db, o)!.receivedPct.toString()).toBe('50');
    expect(accountBalance(db, acc).minus(before).toString()).toBe(r.amount.toString()); // entrou no extrato
    expect(() => receiveOrderDownPayment(db, { orderId: o.id, pct: '60', date: '2026-11-17', accountId: acc })).toThrow(/mais do que falta receber/);
    // Entrega: a venda aproveita o sinal e só o restante fica a receber.
    startOrder(db, o.id);
    completeOrder(db, o.id, { materials: orderReservations(db, o.id).map((x) => ({ lotId: x.lotId, qty: x.qty.toNumber() })), hours: 10, qtyApproved: 10, qtyRejected: 0, laborMinutes: 0, failures: [] });
    const unit = sp.total.div(10).toString();
    const s = registerSale(db, { date: '2026-11-30', orderId: o.id, quoteId: q.id, customerId: cli.id, description: 'Vaso', qty: 10, unitPrice: unit, discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: '2026-12-10', intervalDays: 30 } });
    const st = saleStatus(db, s, '2026-11-30');
    expect([st.received.toString(), st.open.toString()]).toEqual([r.amount.toString(), sp.total.minus(r.amount).toString()]);
  });

  it('estoque: não gera conta a receber nem pedido de cliente; pode trocar para venda antes de concluir', () => {
    const { q, itemId, cli } = quote();
    const [o] = createOrdersFromQuote(db, q.id, [itemId], { dueDate: '2026-11-30', purpose: 'estoque' });
    expect([o.purpose, o.number.startsWith('EST'), o.customerId]).toEqual(['estoque', true, undefined]);
    expect(orderReceivable(db, o.id)).toBeUndefined();
    expect(() => receiveOrderDownPayment(db, { orderId: o.id, pct: '50', date: '2026-11-16', accountId: acc })).toThrow(/não tem conta a receber/);
    updateOrderPlanning(db, o.id, { purpose: 'pedido', customerId: cli.id, dueDate: '2026-11-30' });
    expect(orderReceivable(db, o.id)).toBeDefined();
    receiveOrderDownPayment(db, { orderId: o.id, pct: '30', date: '2026-11-16', accountId: acc });
    expect(() => updateOrderPlanning(db, o.id, { purpose: 'estoque', dueDate: '2026-11-30' })).toThrow(/já pagou/);
  });
});

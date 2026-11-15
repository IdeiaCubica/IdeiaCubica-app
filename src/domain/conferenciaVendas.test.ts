/** v1.30: correções da conferência orçamento × venda × extrato. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty } from './catalog';
import { registerPurchase } from './purchases';
import { accountBalance, settleTitle } from './finance';
import { emptyQuoteInput, latestVersion, saveQuote, setItemStatus } from './quotes';
import { completeOrder, createOrdersFromQuote, orderReservations, registerFinishedGood, startOrder } from './production';
import { allocationReceivable, orderReceivable, provisionOrderReceivables, saleFreightDefault } from './orderReceivables';
import { cancelSale, registerSale, saleStatus } from './sales';
import { salesPedidos } from './pedidos';
import type { DB } from './types';

let db: DB;
let acc: string;
const T = '2026-11-15';

function base() {
  const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, referenceCost: '0.1', filament: { materialType: 'PLA', color: 'Azul' } });
  registerPurchase(db, { date: '2026-11-01', items: [{ materialId: fil.id, qty: 2000, price: '200' }], freight: '0', otherCosts: '0', payment: { mode: 'avista', accountId: acc, installments: 1, firstDue: '2026-11-01', intervalDays: 30 } });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const cli = saveParty(db, { kind: 'cliente', name: 'João' });
  const input = { ...emptyQuoteInput(db.settings), channelId: ch.id, markupPct: '100', failureRatePct: '0', printHoursPerUnit: 1, materials: [{ materialId: fil.id, qtyPerUnit: 30 }] };
  return { fil, ch, cli, input };
}

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '0', openingDate: '2026-01-01', active: true });
  acc = db.accounts[0].id;
});

describe('Peça do estoque separada para o pedido', () => {
  it('aprovar gera conta a receber e aparece em Vendas; na entrega a venda aproveita o sinal; reabrir sem pagamento retira a conta', () => {
    const { cli, input } = base();
    const fg = registerFinishedGood(db, { description: 'Pote de Natal', qty: 1, unitCost: '20', producedAt: '2026-11-01' });
    const q = saveQuote(db, { name: 'Pote', customerId: cli.id }, [{ name: 'Pote de Natal', finishedGoodId: fg.id, input: { ...input, quantity: 1, manualPriceUnit: '104.90' } }]);
    const itemId = latestVersion(q).items[0].itemId;
    setItemStatus(db, q.id, itemId, 'aprovado');
    const alloc = db.finishedGoods[0].allocations![0];
    const t = allocationReceivable(db, alloc.id)!;
    expect(t.amount).toBe('104.9');
    const p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect([p.total.toString(), p.delivery, p.pendingItems.length]).toEqual(['104.9', 'a_entregar', 0]);
    settleTitle(db, { titleId: t.id, date: T, amount: '50', accountId: acc });
    const s = registerSale(db, { date: T, quoteId: q.id, quoteItemId: itemId, finishedGoodId: fg.id, customerId: cli.id, description: 'Pote de Natal', qty: 1, unitPrice: '104.90', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: T, intervalDays: 30 } });
    const st = saleStatus(db, s, T);
    expect([st.total.toString(), st.received.toString(), st.open.toString()]).toEqual(['104.9', '50', '54.9']);
    // Cancelar a venda: o pagamento volta para a separação, e a separação volta para o estoque.
    cancelSale(db, s.id, 'teste');
    expect(db.finishedGoods[0].allocations!.some((a) => a.id === alloc.id)).toBe(true);
    expect(allocationReceivable(db, alloc.id)!.amount).toBe('104.9');
  });

  it('separação antiga sem conta (antes da v1.30) é levada para Contas a receber', () => {
    const { cli, input } = base();
    const fg = registerFinishedGood(db, { description: 'Pote', qty: 1, unitCost: '20', producedAt: '2026-11-01' });
    const q = saveQuote(db, { name: 'Pote', customerId: cli.id }, [{ name: 'Pote', finishedGoodId: fg.id, input: { ...input, quantity: 1, manualPriceUnit: '104.90' } }]);
    setItemStatus(db, q.id, latestVersion(q).items[0].itemId, 'aprovado');
    db.titles = db.titles.filter((t) => t.origin.kind !== 'separacao'); // simula dado antigo
    expect(provisionOrderReceivables(db)).toBe(1);
    expect(db.titles.some((t) => t.origin.kind === 'separacao')).toBe(true);
  });
});

describe('Peças do orçamento fora do pedido', () => {
  it('peça não aprovada/enviada aparece como aviso no pedido (caso Stefany)', () => {
    const { cli, input } = base();
    const q = saveQuote(db, { name: 'HP', customerId: cli.id }, [{ name: 'Chapéu', input: { ...input, quantity: 3 } }, { name: 'Bolo', input: { ...input, quantity: 2 } }]);
    const [a] = latestVersion(q).items.map((i) => i.itemId);
    createOrdersFromQuote(db, q.id, [a], { dueDate: '2026-11-30', purpose: 'pedido' });
    const p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect(p.pendingItems.map((x) => x.name)).toEqual(['Bolo']);
    expect(p.pendingTotal.gt(0)).toBe(true);
  });
});

describe('Frete do orçamento', () => {
  it('vai para o primeiro pedido e para a venda desse pedido; o pedido fica igual ao orçamento', () => {
    const { cli, input } = base();
    const q = saveQuote(db, { name: 'Frete', customerId: cli.id }, [{ name: 'A', input: { ...input, quantity: 2 } }, { name: 'B', input: { ...input, quantity: 1 } }]);
    latestVersion(q).shipping = { originCep: null, destCep: null, lengthCm: 10, widthCm: 10, heightCm: 10, packagingWeightG: 0, clientFreight: { service: 'PAC', price: '35.80', deliveryMin: 3, deliveryMax: 5 } } as never;
    const [o1, o2] = createOrdersFromQuote(db, q.id, latestVersion(q).items.map((i) => i.itemId), { dueDate: '2026-11-30', purpose: 'pedido' });
    const v = latestVersion(q);
    const total = v.items.reduce((s, it) => s + Number(it.summary.orderPrice), 0) + 35.8;
    const p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect(p.total.toNumber()).toBeCloseTo(total, 2);
    expect(D(orderReceivable(db, o1.id)!.amount).minus(D(v.items[0].summary.orderPrice!)).toString()).toBe('35.8');
    expect(saleFreightDefault(db, { quoteId: q.id, orderId: o1.id }).toString()).toBe('35.8');
    expect(saleFreightDefault(db, { quoteId: q.id, orderId: o2.id }).toString()).toBe('0');
    startOrder(db, o1.id);
    completeOrder(db, o1.id, { materials: orderReservations(db, o1.id).map((x) => ({ lotId: x.lotId, qty: x.qty.toNumber() })), hours: 2, qtyApproved: 2, qtyRejected: 0, laborMinutes: 0, failures: [] });
    const before = accountBalance(db, acc);
    const s = registerSale(db, { date: T, orderId: o1.id, quoteId: q.id, customerId: cli.id, description: 'A', qty: 2, unitPrice: v.items[0].summary.unitPrice!, discount: '0', freightCharged: '35.80', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: T, intervalDays: 30 } });
    expect(saleStatus(db, s, T).total.toString()).toBe(D(v.items[0].summary.orderPrice!).plus('35.8').toString());
    expect(accountBalance(db, acc).toString()).toBe(before.toString()); // a prazo: nada entra no extrato
  });
});

import { D } from './money';

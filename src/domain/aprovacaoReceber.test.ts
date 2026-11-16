/** v1.31: peça aprovada pelo cliente entra em Contas a receber e em Vendas, antes da produção. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty } from './catalog';
import { registerPurchase } from './purchases';
import { accountBalance, settleTitle } from './finance';
import { emptyQuoteInput, latestVersion, saveQuote, setItemStatus } from './quotes';
import { createOrdersFromQuote, returnOrderToQuote } from './production';
import { approvalReceivable, orderReceivable, provisionOrderReceivables } from './orderReceivables';
import { cancelSale, registerSale, saleStatus } from './sales';
import { salesPedidos } from './pedidos';
import type { DB } from './types';

let db: DB;
let acc: string;
const T = '2026-11-16';

function setup() {
  const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, referenceCost: '0.1', filament: { materialType: 'PLA', color: 'Azul' } });
  registerPurchase(db, { date: '2026-11-01', items: [{ materialId: fil.id, qty: 2000, price: '200' }], freight: '0', otherCosts: '0', payment: { mode: 'avista', accountId: acc, installments: 1, firstDue: '2026-11-01', intervalDays: 30 } });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const cli = saveParty(db, { kind: 'cliente', name: 'Stefany' });
  const input = { ...emptyQuoteInput(db.settings), channelId: ch.id, markupPct: '100', failureRatePct: '0', printHoursPerUnit: 1, materials: [{ materialId: fil.id, qtyPerUnit: 30 }] };
  const q = saveQuote(db, { name: 'HP', customerId: cli.id }, [{ name: 'Chapéu', input: { ...input, quantity: 3 } }, { name: 'Bolo', input: { ...input, quantity: 2 } }]);
  const [a, b] = latestVersion(q).items.map((i) => i.itemId);
  return { q, a, b, cli, input };
}

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '0', openingDate: '2026-01-01', active: true });
  acc = db.accounts[0].id;
});

describe('Peça aprovada → a receber', () => {
  it('aprovar cria a conta e o pedido fecha com o orçamento; reabrir retira', () => {
    const { q, a, b } = setup();
    createOrdersFromQuote(db, q.id, [a], { dueDate: '2026-11-30', purpose: 'pedido' });
    setItemStatus(db, q.id, b, 'aprovado');
    const t = approvalReceivable(db, b)!;
    const v = latestVersion(q);
    expect(t.amount).toBe(D(v.items[1].summary.orderPrice!).toString());
    let p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect(p.total.toString()).toBe(D(v.items[0].summary.orderPrice!).plus(v.items[1].summary.orderPrice!).toString());
    expect(p.pendingItems).toEqual([]);
    expect(p.lines.find((l) => l.approvedOnly)!.label).toBe('Bolo');
    setItemStatus(db, q.id, b, 'aberto');
    expect(approvalReceivable(db, b)).toBeUndefined();
    p = salesPedidos(db, T).find((x) => x.quoteId === q.id)!;
    expect(p.pendingItems.map((x) => x.name)).toEqual(['Bolo']);
  });

  it('sinal na peça aprovada passa para o pedido ao enviar para produção; estoque e reabrir bloqueiam com pagamento', () => {
    const { q, b } = setup();
    setItemStatus(db, q.id, b, 'aprovado');
    const t = approvalReceivable(db, b)!;
    settleTitle(db, { titleId: t.id, date: T, amount: '5', accountId: acc });
    expect(() => setItemStatus(db, q.id, b, 'aberto')).toThrow(/já pagou/);
    expect(() => createOrdersFromQuote(db, q.id, [b], { dueDate: '2026-11-30', purpose: 'estoque' })).toThrow(/já pagou/);
    const before = accountBalance(db, acc);
    const [o] = createOrdersFromQuote(db, q.id, [b], { dueDate: '2026-11-30', purpose: 'pedido' });
    const ot = orderReceivable(db, o.id)!;
    expect(ot.id).toBe(t.id); // mesma conta, com o sinal
    expect(ot.settlements[0].amount).toBe('5');
    expect(approvalReceivable(db, b)).toBeUndefined();
    expect(accountBalance(db, acc).toString()).toBe(before.toString());
  });

  it('pedido retornado ao orçamento volta a ter a conta da aprovação', () => {
    const { q, b } = setup();
    setItemStatus(db, q.id, b, 'aprovado');
    const [o] = createOrdersFromQuote(db, q.id, [b], { dueDate: '2026-11-30', purpose: 'pedido' });
    returnOrderToQuote(db, o.id, 'mudança de cor');
    expect(approvalReceivable(db, b)).toBeDefined();
  });

  it('mudança de preço acompanha; venda direta aproveita o sinal; cancelar devolve', () => {
    const { q, a, b, cli, input } = setup();
    setItemStatus(db, q.id, b, 'aprovado');
    saveQuote(db, { quoteId: q.id, name: 'HP', customerId: cli.id }, [
      { itemId: a, name: 'Chapéu', input: { ...input, quantity: 3 } },
      { itemId: b, name: 'Bolo', input: { ...input, quantity: 4 } },
    ]);
    const v = latestVersion(q);
    const t = approvalReceivable(db, b)!;
    expect(t.amount).toBe(D(v.items[1].summary.orderPrice!).toString());
    settleTitle(db, { titleId: t.id, date: T, amount: '10', accountId: acc });
    const s = registerSale(db, { date: T, quoteId: q.id, quoteItemId: b, customerId: cli.id, description: 'Bolo', qty: 4, unitPrice: v.items[1].summary.unitPrice!, discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: T, intervalDays: 30 } });
    expect(saleStatus(db, s, T).received.toString()).toBe('10');
    expect(approvalReceivable(db, b)).toBeUndefined();
    expect(() => cancelSale(db, s.id, 'x')).not.toThrow();
    expect(approvalReceivable(db, b)!.settlements[0].amount).toBe('10');
  });

  it('peças já aprovadas antes da v1.31 entram em Contas a receber ao abrir o sistema', () => {
    const { q, b } = setup();
    setItemStatus(db, q.id, b, 'aprovado');
    db.titles = db.titles.filter((t) => t.origin.kind !== 'aprovacao');
    expect(provisionOrderReceivables(db)).toBe(1);
    expect(approvalReceivable(db, b)).toBeDefined();
  });
});

import { D } from './money';

/** v1.13: peça produzida → estoque ou entregue; vendas pago/a pagar; extrato; fechamento mensal. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty } from './catalog';
import { registerPurchase } from './purchases';
import { createManualTitle, settleTitle } from './finance';
import { emptyQuoteInput, latestVersion, saveQuote, setItemStatus } from './quotes';
import { completeOrder, createOrdersFromQuote, finishedGoodBalance, orderDestination, orderReservations, sendOrderToStock, startOrder } from './production';
import { cancelSale, registerSale, saleStatus } from './sales';
import { cashStatement, closeMonth, closingChanges, monthReport, overallStatement } from './reports';
import { quoteTotal } from './quotes';
import type { DB } from './types';

let db: DB;
let acc: string;
const cash = (date = '2026-11-05') => ({ mode: 'avista' as const, accountId: acc, installments: 1, firstDue: date, intervalDays: 30 });

function producedOrder() {
  const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Azul' } });
  registerPurchase(db, { date: '2026-11-01', items: [{ materialId: fil.id, qty: 1000, price: '90' }], freight: '0', otherCosts: '0', payment: cash('2026-11-01') });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const cli = saveParty(db, { kind: 'cliente', name: 'Ana' });
  const q = saveQuote(db, { name: 'Vaso', customerId: cli.id }, [{ name: 'Vaso', input: { ...emptyQuoteInput(db.settings), quantity: 2, channelId: ch.id, markupPct: '50', failureRatePct: '0', printHoursPerUnit: 1, materials: [{ materialId: fil.id, qtyPerUnit: 50 }] } }]);
  const itemId = latestVersion(q).items[0].itemId;
  setItemStatus(db, q.id, itemId, 'aprovado');
  const o = createOrdersFromQuote(db, q.id, [itemId], { dueDate: '2026-11-10' })[0];
  startOrder(db, o.id);
  completeOrder(db, o.id, { materials: orderReservations(db, o.id).map((r) => ({ lotId: r.lotId, qty: r.qty.toNumber() })), hours: 2, qtyApproved: 2, qtyRejected: 0, laborMinutes: 0, failures: [] });
  return { o: db.orders.find((x) => x.id === o.id)!, q, cli };
}

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '500', openingDate: '2026-01-01', active: true });
  acc = db.accounts[0].id;
});

describe('Peça produzida: estoque ou entregue', () => {
  it('concluída aguarda decisão; "estoque" cria as peças prontas separadas para o cliente', () => {
    const { o, q } = producedOrder();
    expect(orderDestination(db, o)).toBeNull();
    const fg = sendOrderToStock(db, o.id, 'prateleira 1');
    expect(orderDestination(db, o)).toBe('estoque');
    expect([fg.qtyProduced, fg.location]).toEqual([2, 'prateleira 1']);
    expect(fg.allocations?.[0]).toMatchObject({ quoteId: q.id, qty: 2 });
    expect(finishedGoodBalance(db, fg.id).available).toBe(0); // separadas para o pedido
    expect(() => sendOrderToStock(db, o.id)).toThrow(/já foi/);
    // Venda depois: baixa as peças do estoque (consome a separação)
    registerSale(db, { date: '2026-11-08', orderId: o.id, quoteId: q.id, description: 'Vaso', qty: 2, unitPrice: '20', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: cash('2026-11-08') });
    expect(finishedGoodBalance(db, fg.id)).toMatchObject({ sold: 2, allocated: 0, available: 0 });
    expect(db.finishedGoods[0].allocations).toEqual([]);
  });

  it('"entregue" registra a venda; a pagar até receber; cancelar volta para Produzidas', () => {
    const { o, cli } = producedOrder();
    const s = registerSale(db, { date: '2026-11-08', orderId: o.id, customerId: cli.id, description: 'Vaso', qty: 2, unitPrice: '20', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: '2026-11-20', intervalDays: 30 } });
    expect(orderDestination(db, o)).toBe('entregue');
    let st = saleStatus(db, s, '2026-11-25');
    expect([st.status, st.open.toString(), st.overdue]).toEqual(['a_pagar', '40', true]);
    settleTitle(db, { titleId: st.titleIds[0], date: '2026-11-25', amount: '40', accountId: acc });
    st = saleStatus(db, s, '2026-11-25');
    expect([st.status, st.received.toString()]).toEqual(['pago', '40']);
    // Cancelar (depois de estornar não é preciso aqui: venda nova a prazo sem pagamento)
    const s2 = registerSale(db, { date: '2026-11-09', description: 'Avulsa', qty: 1, unitPrice: '10', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: '2026-11-20', intervalDays: 30 } });
    cancelSale(db, s2.id, 'teste');
    expect(saleStatus(db, s2, '2026-11-25').status).toBe('cancelada');
  });
});

describe('Lista por orçamento', () => {
  it('valor, custo, resultado (= valor − taxas − custo), horas e peças do orçamento', () => {
    const { q } = producedOrder();
    const t = quoteTotal(db, db.quotes.find((x) => x.id === q.id)!);
    expect(t.pieces).toBe(2);
    expect(t.hours.toString()).toBe('2');
    expect(t.price.gt(t.cost)).toBe(true);
    // canal sem taxas: resultado = valor − custo
    expect(t.result.toString()).toBe(t.price.minus(t.cost).toDecimalPlaces(2).toString());
  });
});

describe('Extrato e fechamento mensal', () => {
  it('extrato com saldo inicial, entradas, saídas, detalhe e saldo acumulado', () => {
    const { o, cli } = producedOrder(); // compra à vista de R$ 90 em 01/11
    registerSale(db, { date: '2026-11-08', orderId: o.id, customerId: cli.id, description: 'Vaso', qty: 2, unitPrice: '20', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: cash('2026-11-08') });
    const cat = db.finCategories.find((c) => c.nature === 'despesa_fixa')!;
    createManualTitle(db, { categoryId: cat.id, description: 'Internet', amount: '100', competenceDate: '2026-11-10', terms: cash('2026-11-10'), notes: 'Fibra 300MB' });
    createManualTitle(db, { categoryId: cat.id, description: 'Aluguel outubro', amount: '50', competenceDate: '2026-10-30', terms: cash('2026-10-30') });
    const st = cashStatement(db, { from: '2026-11-01', to: '2026-11-30' });
    expect(st.opening.toString()).toBe('450'); // 500 − 50 (outubro)
    expect(st.rows.map((r) => [r.date, r.amountIn.toString(), r.amountOut.toString(), r.balance.toString()])).toEqual([
      ['2026-11-01', '0', '90', '360'], ['2026-11-08', '40', '0', '400'], ['2026-11-10', '0', '100', '300']]);
    expect(st.rows[0].detail).toMatch(/PLA/);
    expect(st.rows[1].detail).toBe('2 × Vaso — Ana');
    expect(st.rows[2].detail).toBe('Fibra 300MB');
    expect(st.closing.toString()).toBe('300');
  });

  it('extrato total: geral e mês a mês, por natureza, onde está o dinheiro e resultado por venda', () => {
    const { o, cli } = producedOrder(); // compra de insumos R$ 90 em 01/11
    registerSale(db, { date: '2026-11-08', orderId: o.id, customerId: cli.id, description: 'Vaso', qty: 2, unitPrice: '20', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: cash('2026-11-08') });
    const cat = db.finCategories.find((c) => c.nature === 'despesa_fixa')!;
    createManualTitle(db, { categoryId: cat.id, description: 'Aluguel outubro', amount: '50', competenceDate: '2026-10-30', terms: cash('2026-10-30') });
    const all = overallStatement(db);
    expect([all.opening.toString(), all.totalIn.toString(), all.totalOut.toString(), all.closing.toString()]).toEqual(['500', '40', '140', '400']);
    expect(all.byMonth.map((m) => [m.ym, m.totalIn.toString(), m.totalOut.toString(), m.net.toString(), m.balance.toString()])).toEqual([
      ['2026-10', '0', '50', '-50', '450'], ['2026-11', '40', '90', '-50', '400']]);
    expect(all.outByNature.map((g) => [g.nature, g.amount.toString()])).toEqual([['estoque', '90'], ['despesa_fixa', '50']]);
    expect(all.inByNature.map((g) => [g.nature, g.amount.toString()])).toEqual([['receita_venda', '40']]);
    // Insumo: comprou 1000 g por R$ 90, consumiu 100 g → R$ 81 continuam em estoque
    expect(all.assets.materials.toString()).toBe('81');
    expect(all.result.revenue.toString()).toBe('40');
    expect(all.result.operating.toString()).toBe(all.result.contribution.minus(50).toString());
    expect(all.sales).toHaveLength(1);
    const s = all.sales[0];
    expect([s.revenue.toString(), s.received.toString(), s.open.toString()]).toEqual(['40', '40', '0']);
    expect(s.profit!.toString()).toBe(s.revenue.minus(s.fees).plus(s.freightNet).minus(s.cogs!).toString());
  });

  it('fechamento: resultado, peças vendidas, produção; registra e avisa mudanças posteriores', () => {
    const { o, cli } = producedOrder();
    registerSale(db, { date: '2026-11-08', orderId: o.id, customerId: cli.id, description: 'Vaso', qty: 2, unitPrice: '20', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: cash('2026-11-08') });
    const cat = db.finCategories.find((c) => c.nature === 'despesa_fixa')!;
    createManualTitle(db, { categoryId: cat.id, description: 'Internet', amount: '10', competenceDate: '2026-11-10', terms: cash('2026-11-10') });
    const r = monthReport(db, '2026-11');
    expect(r.result.revenue.toString()).toBe('40');
    expect(r.result.fixed.toString()).toBe('10');
    expect(r.piecesSold).toHaveLength(1);
    expect(r.piecesSold[0]).toMatchObject({ name: 'Vaso', qty: 2 });
    expect(r.production.approved).toBe(2);
    expect(r.production.consumption[0].qty.toString()).toBe('100');
    closeMonth(db, '2026-11', 'primeiro fechamento');
    expect(db.monthClosings).toHaveLength(1);
    expect(closingChanges(db, '2026-11')).toEqual([]);
    createManualTitle(db, { categoryId: cat.id, description: 'Luz', amount: '5', competenceDate: '2026-11-15', terms: cash('2026-11-15') });
    expect(closingChanges(db, '2026-11').map((c) => c.key)).toEqual(expect.arrayContaining(['despesasFixas', 'resultado']));
    closeMonth(db, '2026-11');
    expect(db.monthClosings).toHaveLength(1); // refazer substitui
  });
});

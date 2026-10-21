/** Testes integrados: compras, financeiro, estoque, produção e vendas operando sobre o mesmo banco. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, savePrinter } from './catalog';
import { cancelPurchase, registerPurchase } from './purchases';
import { accountBalance, openTotals, reverseSettlement, settleTitle, titleOpen } from './finance';
import { adjustInventory, lotBalance, reorderAnalysis, reserve, releaseAll, addMovement } from './inventory';
import { emptyQuoteInput, materialCostPolicy, saveQuote } from './quotes';
import { cancelOrder, compareOrder, completeOrder, createOrderFromQuote, reserveOrderMaterials, startOrder } from './production';
import { managementResult, registerSale } from './sales';
import type { DB } from './types';

let db: DB;
let accountId: string;
let filamentId: string;

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '1000', openingDate: '2026-01-01', active: true });
  accountId = db.accounts[0].id;
  const cat = db.categories.find((c) => c.isFilament)!;
  filamentId = saveMaterial(db, {
    name: 'PLA Preto A', categoryId: cat.id, unit: 'g', active: true,
    filament: { materialType: 'PLA', color: 'Preto', netWeightG: 1000 },
  }).id;
});

const buyCash = () => registerPurchase(db, {
  date: '2026-02-01', items: [{ materialId: filamentId, qty: 1000, price: '100' }], freight: '10', otherCosts: '0',
  payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-01', intervalDays: 30 },
});

describe('Compras', () => {
  it('compra à vista: lote com custo/g, entrada no estoque e saída de caixa única', () => {
    const p = buyCash();
    const lot = db.lots.find((l) => l.id === p.items[0].lotId)!;
    expect(lot.unitCost).toBe('0.11');
    expect(lotBalance(db, lot.id).physical.toString()).toBe('1000');
    const titles = db.titles.filter((t) => t.origin.id === p.id);
    expect(titles).toHaveLength(1);
    expect(titles[0].status).toBe('liquidado');
    expect(accountBalance(db, accountId).toString()).toBe('890');
  });

  it('compra a prazo: obrigação em aberto; pagamento liquida sem duplicar despesa', () => {
    const p = registerPurchase(db, {
      date: '2026-02-01', items: [{ materialId: filamentId, qty: 2, unit: 'kg', price: '180' }], freight: '20', otherCosts: '0',
      payment: { mode: 'aprazo', installments: 2, firstDue: '2026-03-01', intervalDays: 30 },
    });
    expect(db.lots.find((l) => l.id === p.items[0].lotId)!.initialQty).toBe(2000); // conversão kg → g
    const titles = db.titles.filter((t) => t.origin.id === p.id);
    expect(titles.map((t) => t.amount)).toEqual(['100', '100']);
    expect(titles.map((t) => t.dueDate)).toEqual(['2026-03-01', '2026-03-31']);
    expect(accountBalance(db, accountId).toString()).toBe('1000');
    expect(openTotals(db, '2026-02-02').payable.toString()).toBe('200');

    settleTitle(db, { titleId: titles[0].id, date: '2026-03-01', amount: '100', accountId });
    expect(titles[0].status).toBe('liquidado');
    expect(db.titles.filter((t) => t.origin.id === p.id)).toHaveLength(2); // nenhum título novo
    expect(accountBalance(db, accountId).toString()).toBe('900');
    expect(() => settleTitle(db, { titleId: titles[0].id, date: '2026-03-02', amount: '1', accountId })).toThrow(/liquidado/);
  });

  it('pagamento parcial, excesso bloqueado e estorno reabre o saldo', () => {
    const p = registerPurchase(db, {
      date: '2026-02-01', items: [{ materialId: filamentId, qty: 1000, price: '100' }], freight: '0', otherCosts: '0',
      payment: { mode: 'aprazo', installments: 1, firstDue: '2026-03-01', intervalDays: 30 },
    });
    const t = db.titles.find((x) => x.origin.id === p.id)!;
    expect(() => settleTitle(db, { titleId: t.id, date: '2026-03-01', amount: '150', accountId })).toThrow(/excede/);
    settleTitle(db, { titleId: t.id, date: '2026-03-01', amount: '40', accountId });
    expect(titleOpen(t).toString()).toBe('60');
    reverseSettlement(db, t.id, t.settlements[0].id, 'lançado errado');
    expect(titleOpen(t).toString()).toBe('100');
    expect(accountBalance(db, accountId).toString()).toBe('1000');
  });

  it('cancelamento de compra exige estorno do pagamento e gera devolução rastreável', () => {
    const p = buyCash();
    expect(() => cancelPurchase(db, p.id, 'erro')).toThrow(/Estorne/);
    const t = db.titles.find((x) => x.origin.id === p.id)!;
    reverseSettlement(db, t.id, t.settlements[0].id, 'devolvido');
    cancelPurchase(db, p.id, 'erro de cadastro');
    expect(lotBalance(db, p.items[0].lotId).physical.toString()).toBe('0');
    expect(db.movements.filter((m) => m.lotId === p.items[0].lotId)).toHaveLength(2); // histórico preservado
    expect(t.status).toBe('cancelado');
  });
});

describe('Estoque', () => {
  it('reserva reduz disponível sem alterar físico; cancelamento devolve', () => {
    const lotId = buyCash().items[0].lotId;
    reserve(db, lotId, 300, 'op-x');
    let b = lotBalance(db, lotId);
    expect([b.physical, b.reserved, b.available].map(String)).toEqual(['1000', '300', '700']);
    releaseAll(db, 'op-x');
    b = lotBalance(db, lotId);
    expect(b.available.toString()).toBe('1000');
  });
  it('impede reserva acima do disponível e saldo negativo', () => {
    const lotId = buyCash().items[0].lotId;
    reserve(db, lotId, 900, 'op-1');
    expect(() => reserve(db, lotId, 200, 'op-2')).toThrow(/indisponível/);
    expect(() => addMovement(db, { lotId, type: 'consumo', qty: 1001, ref: { kind: 'manual' }, key: 'k1' })).toThrow(/insuficiente/);
  });
  it('mesma operação não baixa duas vezes (idempotência)', () => {
    const lotId = buyCash().items[0].lotId;
    addMovement(db, { lotId, type: 'consumo', qty: 10, ref: { kind: 'op', id: 'a' }, key: 'op:a:consumo' });
    expect(() => addMovement(db, { lotId, type: 'consumo', qty: 10, ref: { kind: 'op', id: 'a' }, key: 'op:a:consumo' })).toThrow(/duplicado/);
    expect(lotBalance(db, lotId).physical.toString()).toBe('990');
  });
  it('inventário gera ajuste com justificativa obrigatória', () => {
    const lotId = buyCash().items[0].lotId;
    expect(() => adjustInventory(db, { lotId, countedQty: 950, reason: '' })).toThrow(/justificativa/);
    adjustInventory(db, { lotId, countedQty: 950, reason: 'pesagem' });
    expect(lotBalance(db, lotId).physical.toString()).toBe('950');
  });
  it('reposição considera reservas (disponível), não só saldo', () => {
    const lotId = buyCash().items[0].lotId;
    db.materials[0].minStock = 500;
    expect(reorderAnalysis(db, db.materials[0], 90, '2026-02-02').status).toBe('ok');
    reserve(db, lotId, 600, 'op-z');
    const r = reorderAnalysis(db, db.materials[0], 90, '2026-02-02');
    expect(r.status).toBe('repor');
    expect(r.suggestedQty!.toString()).toBe('100');
  });
});

describe('Produção e vendas', () => {
  function setupQuote(failure = '0') {
    const lotId = buyCash().items[0].lotId;
    db.settings.energyTariff = '1';
    db.settings.laborHourCost = '30';
    db.settings.productiveHoursPerMonth = 200;
    const printer = savePrinter(db, {
      name: 'A1', manufacturer: 'Bambu Lab', model: 'A1', acquisitionValue: '4000', residualValue: '0', usefulLifeHours: 8000,
      initialHours: 0, energyMode: 'medido', kwhPerHour: '0.1', maintenancePerHour: '0.1', availableHoursPerMonth: 300, active: true,
    });
    const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
    const input = { ...emptyQuoteInput(db.settings), quantity: 4, materials: [{ materialId: filamentId, lotId, qtyPerUnit: 50 }], printHoursPerUnit: 1,
      printerId: printer.id, channelId: ch.id, failureRatePct: failure, markupPct: '40' };
    const q = saveQuote(db, { name: 'Chaveiro' }, input);
    return { lotId, q, printer, ch };
  }

  it('orçamento preserva snapshot: mudar custo depois não altera versão antiga', () => {
    const { q, lotId } = setupQuote();
    const before = q.versions[0].summary.totalCost;
    db.lots.find((l) => l.id === lotId)!.unitCost = '0.50';
    expect(q.versions[0].params.lots[lotId].unitCost).toBe('0.11');
    expect(q.versions[0].summary.totalCost).toBe(before);
  });

  it('ciclo completo: reserva → início → conclusão com falha → comparação', () => {
    const { q, lotId } = setupQuote();
    const op = createOrderFromQuote(db, q.id);
    expect(q.status).toBe('convertido');
    expect(op.plannedMaterials[0].qty).toBe(200);
    expect(reserveOrderMaterials(db, op.id).ok).toBe(true);
    expect(lotBalance(db, lotId).reserved.toString()).toBe('200');
    startOrder(db, op.id);
    completeOrder(db, op.id, {
      materials: [{ lotId, qty: 210 }], hours: 4.5, qtyApproved: 4, qtyRejected: 1, laborMinutes: null,
      failures: [{ description: 'Descolou da mesa', lotId, qtyLost: 30, hoursLost: 0.5 }],
    });
    const b = lotBalance(db, lotId);
    expect(b.reserved.toString()).toBe('0');
    expect(b.physical.toString()).toBe(String(1000 - 210 - 30));
    // Concluir novamente não baixa de novo
    expect(() => completeOrder(db, op.id, { materials: [{ lotId, qty: 210 }], hours: 1, qtyApproved: 1, qtyRejected: 0, laborMinutes: null, failures: [] })).toThrow(/já foi concluída/);
    expect(lotBalance(db, lotId).physical.toString()).toBe('760');

    const cmp = compareOrder(db, op);
    expect(cmp.real).not.toBeNull();
    expect(cmp.real!.materialQty.toString()).toBe('240');
    expect(cmp.real!.hours.toString()).toBe('5');
    // material real: 240 g × 0,11 = 26,40
    expect(cmp.real!.result.components.find((c) => c.key === 'material')!.value!.toString()).toBe('26.4');
    expect(cmp.real!.unit!.gt(0)).toBe(true);
  });

  it('política de preço: referência do cadastro até existir compra; depois, a última compra', () => {
    db.materials[0].referenceCost = '0.10';
    expect(materialCostPolicy(db, filamentId).unitCost!.toString()).toBe('0.1');
    buyCash();
    const pol = materialCostPolicy(db, filamentId);
    expect(pol.unitCost!.toString()).toBe('0.11');
    expect(pol.source).toMatch(/última compra/);
  });

  it('orçamento por material (sem lote) gera OP que reserva por ordem de entrada, dividindo entre lotes', () => {
    const { printer, ch } = setupQuote();       // 1º lote: 1.000 g
    buyCash();                                   // 2º lote: 1.000 g
    const lots = db.lots.filter((l) => l.materialId === filamentId);
    const q = saveQuote(db, { name: 'Peça grande' }, { ...emptyQuoteInput(db.settings), quantity: 3, materials: [{ materialId: filamentId, qtyPerUnit: 500 }],
      printHoursPerUnit: 1, printerId: printer.id, channelId: ch.id, failureRatePct: '0', markupPct: '40' });
    const op = createOrderFromQuote(db, q.id);
    expect(op.plannedMaterials[0]).toMatchObject({ materialId: filamentId, qty: 1500 });
    expect(reserveOrderMaterials(db, op.id).ok).toBe(true);
    expect(lotBalance(db, lots[0].id).reserved.toString()).toBe('1000'); // o mais antigo primeiro
    expect(lotBalance(db, lots[1].id).reserved.toString()).toBe('500');
  });

  it('material insuficiente: OP aguarda material sem reservar parcialmente', () => {
    const { q, lotId } = setupQuote();
    const op = createOrderFromQuote(db, q.id);
    reserve(db, lotId, 900, 'outra-op');
    const r = reserveOrderMaterials(db, op.id);
    expect(r.ok).toBe(false);
    expect(op.status).toBe('aguardando_material');
    expect(lotBalance(db, lotId).reserved.toString()).toBe('900');
    cancelOrder(db, op.id, 'cliente desistiu');
    expect(op.status).toBe('cancelada');
  });

  it('venda a prazo gera conta a receber; recebimento liquida', () => {
    const { q, ch } = setupQuote();
    const sale = registerSale(db, {
      date: '2026-02-10', description: 'Chaveiro', quoteId: q.id, qty: 4, unitPrice: '25', discount: '0', freightCharged: '0', freightCost: '0',
      channelId: ch.id, feesWithheld: true, payment: { mode: 'aprazo', installments: 2, firstDue: '2026-03-10', intervalDays: 30 },
    });
    expect(sale.costStatus).toBe('estimado');
    const rec = db.titles.filter((t) => t.origin.id === sale.id);
    expect(rec.map((t) => t.amount)).toEqual(['50', '50']);
    settleTitle(db, { titleId: rec[0].id, date: '2026-03-10', amount: '50', accountId });
    expect(openTotals(db, '2026-03-11').receivable.toString()).toBe('50');
    const res = managementResult(db, '2026-02-01', '2026-02-28');
    expect(res.revenue.toString()).toBe('100');
    // A compra de filamento (estoque) NÃO é despesa do resultado
    expect(res.fixed.toString()).toBe('0');
    expect(res.status).toBe('estimado');
  });

  it('taxas não retidas geram conta a pagar; retidas reduzem o valor a receber', () => {
    const { ch } = setupQuote();
    ch.commissionPct = '10';
    const s1 = registerSale(db, { date: '2026-02-10', description: 'X', qty: 1, unitPrice: '100', discount: '0', freightCharged: '0', freightCost: '0',
      channelId: ch.id, feesWithheld: true, manualUnitCost: '40', payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-10', intervalDays: 30 } });
    expect(db.titles.filter((t) => t.origin.id === s1.id).map((t) => t.amount)).toEqual(['90']);
    const s2 = registerSale(db, { date: '2026-02-10', description: 'Y', qty: 1, unitPrice: '100', discount: '0', freightCharged: '0', freightCost: '0',
      channelId: ch.id, feesWithheld: false, manualUnitCost: '40', payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-10', intervalDays: 30 } });
    const t2 = db.titles.filter((t) => t.origin.id === s2.id);
    expect(t2.map((t) => [t.direction, t.amount])).toEqual([['in', '100'], ['out', '10']]);
  });
});

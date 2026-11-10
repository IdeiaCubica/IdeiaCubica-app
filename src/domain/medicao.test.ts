/** v1.23: peso real e purga ao sair da impressão; resultado Previsto × Realizado × Reajustado. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty } from './catalog';
import { registerPurchase } from './purchases';
import { emptyQuoteInput, latestVersion, saveQuote, setItemStatus } from './quotes';
import { completeOrder, createOrdersFromQuote, orderReservations, startOrder } from './production';
import { measuredFilamentTotal, orderResult, recordMeasurement } from './medicao';
import type { DB, ProductionOrder } from './types';

let db: DB;
let o: ProductionOrder;
const cur = () => db.orders.find((x) => x.id === o.id)!;

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '0', openingDate: '2026-01-01', active: true });
  const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Azul' } });
  registerPurchase(db, { date: '2026-11-01', items: [{ materialId: fil.id, qty: 1000, price: '100' }], freight: '0', otherCosts: '0', payment: { mode: 'avista', accountId: db.accounts[0].id, installments: 1, firstDue: '2026-11-01', intervalDays: 30 } });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const cli = saveParty(db, { kind: 'cliente', name: 'Ana' });
  const q = saveQuote(db, { name: 'Vaso', customerId: cli.id }, [{ name: 'Vaso', input: { ...emptyQuoteInput(db.settings), quantity: 4, channelId: ch.id, markupPct: '100', failureRatePct: '0', printHoursPerUnit: 1, consumptionBasis: 'total', materials: [{ materialId: fil.id, qtyPerUnit: 50 }] } }]);
  const it = latestVersion(q).items[0];
  setItemStatus(db, q.id, it.itemId, 'aprovado');
  o = createOrdersFromQuote(db, q.id, [it.itemId], { dueDate: '2026-11-30' })[0];
  startOrder(db, o.id);
});

describe('Medição real da peça', () => {
  it('ao ir para o acabamento: peso obrigatório, a não ser que marque "não informar"', () => {
    expect(() => recordMeasurement(db, o.id, { pieceWeightG: null, purgeG: 10, skip: false })).toThrow(/peso real/);
    expect(cur().status).toBe('em_producao');
    recordMeasurement(db, o.id, { pieceWeightG: null, purgeG: null, skip: true });
    expect(cur().status).toBe('aguardando_acabamento');
    expect(cur().measured?.skipped).toBe(true);
    expect(orderResult(db, cur())!.adjusted).toBeNull();
  });

  it('reajustado = orçamento com o peso real e a purga, ao mesmo preço; sugere o novo preço', () => {
    recordMeasurement(db, o.id, { pieceWeightG: 60, purgeG: 20, skip: false }, 'em_inspecao');
    expect(cur().status).toBe('em_inspecao');
    // 60 g × 4 + 20 g de purga = 260 g no total; 65 g por peça (previsto 50 g)
    expect(measuredFilamentTotal(cur())!.toString()).toBe('260');
    const r = orderResult(db, cur())!;
    expect(r.planned.filamentPerUnitG!.toString()).toBe('50');
    expect(r.adjusted!.filamentPerUnitG!.toString()).toBe('65');
    expect(r.adjusted!.unitCost!.gt(r.planned.unitCost!)).toBe(true);
    expect(r.adjusted!.netRevenue!.toString()).toBe(r.planned.netRevenue!.toString()); // mesmo preço vendido
    expect(r.adjusted!.result!.lt(r.planned.result!)).toBe(true); // peça mais pesada → resultado menor
    expect(r.suggestedUnit!.gt(r.priceUnit!)).toBe(true); // preço sugerido sobe
    expect(r.realized).toBeNull(); // ainda não concluído
  });

  it('realizado vem da conclusão (consumo e tempo reais)', () => {
    recordMeasurement(db, o.id, { pieceWeightG: 55, purgeG: 0, skip: false });
    completeOrder(db, o.id, { materials: orderReservations(db, o.id).map((r) => ({ lotId: r.lotId, qty: 220 })), hours: 4, qtyApproved: 4, qtyRejected: 0, laborMinutes: 0, failures: [] });
    const r = orderResult(db, cur())!;
    expect(r.realized!.filamentPerUnitG!.toString()).toBe('55');
    expect(r.realized!.result).not.toBeNull();
    expect(r.adjusted).not.toBeNull();
  });
});

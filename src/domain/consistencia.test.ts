/** Consistência do preço: mesmo filamento e parâmetros → mesmo valor por grama, qualquer que seja a divisão em peças. */
import { describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial } from './catalog';
import { emptyQuoteInput, evaluateQuote, latestVersion, resolveParams, saveQuote } from './quotes';
import { registerPurchase } from './purchases';
import { materialStatement } from './inventory';
import { compareOrder, completeOrder, createOrdersFromQuote, orderReservations, registerFinishedGood, startOrder, updateFinishedGood } from './production';
import { D } from './money';

function setup() {
  const db = createEmptyDB();
  const cat = db.categories.find((c) => c.isFilament)!;
  const pla = saveMaterial(db, { name: 'PLA', categoryId: cat.id, unit: 'g', active: true, referenceCost: '0.15', filament: { materialType: 'PLA', color: 'Branco' } });
  const silk = saveMaterial(db, { name: 'PLA Silk', categoryId: cat.id, unit: 'g', active: true, referenceCost: '0.20', filament: { materialType: 'PLA Silk', color: 'Dourado' } });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const base = { ...emptyQuoteInput(db.settings), channelId: ch.id, markupPct: '40', failureRatePct: '0', rounding: 'final90' as const, labor: { perOrder: 0, perUnit: 0 }, printHoursPerUnit: null };
  const price = (materialId: string, quantity: number, grams: number) => {
    const input = { ...base, quantity, materials: [{ materialId, qtyPerUnit: grams }] };
    return evaluateQuote(input, resolveParams(db, input)).pricing.analysis!.revenue;
  };
  return { pla: pla.id, silk: silk.id, price };
}

describe('Complementos do estoque e fotos', () => {
  it('luminária do estoque: custo da última compra no orçamento, reservada e baixada na produção', () => {
    const db = createEmptyDB();
    saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '1000', openingDate: '2026-01-01', active: true });
    const cat = db.categories.find((c) => c.isFilament)!;
    const other = db.categories.find((c) => !c.isFilament)!;
    const pla = saveMaterial(db, { name: 'PLA', categoryId: cat.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Branco' } });
    const lamp = saveMaterial(db, { name: 'Luminária LED', categoryId: other.id, unit: 'un', active: true });
    const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
    const pay = { mode: 'avista' as const, accountId: db.accounts[0].id, installments: 1, firstDue: '2026-02-01', intervalDays: 30 };
    registerPurchase(db, { date: '2026-02-01', items: [{ materialId: pla.id, qty: 1000, price: '100' }, { materialId: lamp.id, qty: 10, price: '80' }], freight: '0', otherCosts: '0', payment: pay });
    const input = { ...emptyQuoteInput(db.settings), channelId: ch.id, markupPct: '0', failureRatePct: '0', rounding: 'nenhum' as const, labor: { perOrder: 0, perUnit: 0 }, printHoursPerUnit: null,
      quantity: 3, materials: [{ materialId: pla.id, qtyPerUnit: 50 }], extras: [{ id: 'x', kind: 'outro' as const, description: 'Luminária', qtyPerUnit: 1, manualUnitCost: null, materialId: lamp.id }] };
    const ev = evaluateQuote(input, resolveParams(db, input));
    expect(ev.costs.components.find((c) => c.key === 'extras')!.value!.toString()).toBe('24'); // 3 × R$ 8,00
    expect(ev.costs.total.toString()).toBe('39'); // + 150 g × R$ 0,10
    const q = saveQuote(db, { name: 'Abajur' }, [{ name: 'Abajur', input }]);
    const op = createOrdersFromQuote(db, q.id, [latestVersion(q).items[0].itemId], { dueDate: '2026-03-01' })[0];
    expect(op.plannedMaterials.find((m) => m.materialId === lamp.id)?.qty).toBe(3);
    startOrder(db, op.id);
    completeOrder(db, op.id, { materials: orderReservations(db, op.id).map((r) => ({ lotId: r.lotId, qty: r.qty.toNumber() })), hours: 1, qtyApproved: 3, qtyRejected: 0, laborMinutes: null, failures: [] });
    expect(materialStatement(db, lamp.id).physical.toString()).toBe('7');
    // custo real não conta a luminária duas vezes (consumo do lote + previsto)
    expect(compareOrder(db, op).real!.total.toString()).toBe('39');
  });

  it('foto da produção para estoque vai para as peças prontas e pode ser trocada no estoque', () => {
    const db = createEmptyDB();
    const fg = registerFinishedGood(db, { description: 'Vaso', qty: 2, unitCost: '5', producedAt: '2026-02-01', image: 'data:image/jpeg;base64,AAA' });
    expect(fg.image).toBe('data:image/jpeg;base64,AAA');
    updateFinishedGood(db, fg.id, { description: 'Vaso', image: 'data:image/jpeg;base64,BBB' });
    expect(fg.image).toBe('data:image/jpeg;base64,BBB');
    updateFinishedGood(db, fg.id, { description: 'Vaso' }); // sem image: mantém
    expect(fg.image).toBe('data:image/jpeg;base64,BBB');
  });
});

describe('Mesmo material e parâmetros', () => {
  it('4 peças de 10,10 g custam o mesmo que 1 peça de 40,40 g (antes: R$ 11,60 × R$ 8,90)', () => {
    const { pla, price } = setup();
    const four = price(pla, 4, 10.10);
    const one = price(pla, 1, 40.40);
    // 40,4 g × R$ 0,15 × 1,4 = R$ 8,484 → modelo arredondado uma vez para R$ 8,90 (+4,9%, dentro do limite)
    expect(one.toString()).toBe('8.9');
    expect(four.toString()).toBe('8.92'); // 4 × R$ 2,23 (antes 4 × R$ 2,90 = R$ 11,60)
    expect(four.minus(one).abs().lte('0.04')).toBe(true); // só centavos de diferença (preço por peça em centavos)
  });

  it('filamentos com preços diferentes dão valores diferentes, mesmo em peça pequena', () => {
    const { pla, silk, price } = setup();
    const a = price(pla, 4, 10);
    const b = price(silk, 4, 10);
    expect(b.gt(a)).toBe(true);
    expect(b.div(a).toDecimalPlaces(2).toString()).toBe(D('1.33').toString()); // 0,20 ÷ 0,15
  });
});

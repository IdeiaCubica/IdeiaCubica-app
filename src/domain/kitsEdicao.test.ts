/** v1.6: kits de entrega, orçamento kit, peças já produzidas, extrato do estoque e edições. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { deleteMaterial, materialUsage, saveAccount, saveChannel, saveMaterial, saveParty, savePrinter, materialLabel } from './catalog';
import { correctLot, deletePurchase, purchaseDeleteBlock, registerPurchase } from './purchases';
import { accountBalance, createManualTitle, settleTitle, updateTitle } from './finance';
import { lotBalance, materialStatement } from './inventory';
import { emptyQuoteInput, latestVersion, materialCostPolicy, quoteSanity, quoteTotal, resolveParams, evaluateQuote, saveQuote, withKitShares } from './quotes';
import { finishedGoodBalance, mergeQuotes, produceForStockNow, quoteFromFinishedGood } from './production';
import { consumeKit, deleteDeliveryKit, kitUnitCost, quoteKit, saveDeliveryKit } from './deliveryKits';
import { cancelSale, registerSale, saleEconomics, saleEditBlock, updateSale } from './sales';
import type { DB } from './types';
import { D } from './money';

let db: DB;
let accountId: string;
let filamentId: string;
let bagId: string;
let cardId: string;
const cash = () => ({ mode: 'avista' as const, accountId, installments: 1, firstDue: '2026-02-01', intervalDays: 30 });

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '1000', openingDate: '2026-01-01', active: true });
  accountId = db.accounts[0].id;
  const fil = db.categories.find((c) => c.isFilament)!;
  const pack = db.categories.find((c) => c.name === 'Caixas e embalagens')!;
  filamentId = saveMaterial(db, { name: 'PLA Basic', categoryId: fil.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Azul', netWeightG: 1000 } }).id;
  bagId = saveMaterial(db, { name: 'Saquinho organza', categoryId: pack.id, unit: 'un', active: true }).id;
  cardId = saveMaterial(db, { name: 'Cartão de agradecimento', categoryId: pack.id, unit: 'un', active: true }).id;
  registerPurchase(db, { date: '2026-02-01', items: [{ materialId: filamentId, qty: 2, unit: 'kg', price: '180' }, { materialId: bagId, qty: 100, price: '50' }, { materialId: cardId, qty: 50, price: '25' }],
    freight: '0', otherCosts: '0', payment: cash() });
});

function quoteBase() {
  const printer = savePrinter(db, { name: 'A1', manufacturer: 'Bambu Lab', model: 'A1', acquisitionValue: '4000', residualValue: '0', usefulLifeHours: 8000,
    initialHours: 0, energyMode: 'medido', kwhPerHour: '0.1', maintenancePerHour: '0.1', availableHoursPerMonth: 300, active: true });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  db.settings.energyTariff = '1';
  db.settings.laborHourCost = '30';
  return { ...emptyQuoteInput(db.settings), quantity: 1, materials: [{ materialId: filamentId, qtyPerUnit: 50 }], printHoursPerUnit: 1, printerId: printer.id, channelId: ch.id, failureRatePct: '0', markupPct: '40' };
}

describe('Cor do filamento nas listas', () => {
  it('materialLabel acrescenta tipo e cor quando o nome não tem', () => {
    expect(materialLabel(db.materials.find((m) => m.id === filamentId)!)).toBe('PLA Basic · Azul');
    expect(materialLabel({ name: 'PETG Preto', filament: { materialType: 'PETG', color: 'Preto' } })).toBe('PETG Preto');
    expect(materialLabel({ name: 'Saquinho' })).toBe('Saquinho');
  });
});

describe('Estoque: compras − produção', () => {
  it('extrato do insumo e peças já produzidas baixam o filamento (lotes mais antigos primeiro)', () => {
    registerPurchase(db, { date: '2026-03-01', items: [{ materialId: filamentId, qty: 1, unit: 'kg', price: '100' }], freight: '0', otherCosts: '0', payment: cash() });
    const o = produceForStockNow(db, { description: 'Vaso', qtyPlanned: 10, plannedMaterials: [{ materialId: filamentId, qty: 2100 }], plannedHours: 20, location: 'prateleira 1' });
    expect(o.status).toBe('concluida');
    const s = materialStatement(db, filamentId);
    expect([s.purchased.toString(), s.consumed.toString(), s.physical.toString()]).toEqual(['3000', '2100', '900']);
    // FIFO: lote de fevereiro (2000 g) esgota antes do de março
    const [l1, l2] = db.lots.filter((l) => l.materialId === filamentId);
    expect([lotBalance(db, l1.id).physical.toString(), lotBalance(db, l2.id).physical.toString()]).toEqual(['0', '900']);
    const fg = db.finishedGoods.find((g) => g.orderId === o.id)!;
    expect(fg.qtyProduced).toBe(10);
    expect(fg.location).toBe('prateleira 1');
    expect(() => produceForStockNow(db, { description: 'X', qtyPlanned: 1, plannedMaterials: [{ materialId: filamentId, qty: 5000 }], plannedHours: 1 })).toThrow(/insuficiente/);
  });
});

describe('Kits de entrega', () => {
  it('custo do kit, rateio exato entre as peças, oculto ao cliente e baixado na venda', () => {
    const kit = saveDeliveryKit(db, { name: 'Kit presente', active: true, items: [{ materialId: bagId, qty: 1 }, { materialId: cardId, qty: 1 }], extras: [{ description: 'Adesivo', cost: '0.30' }] });
    expect(kitUnitCost(db, kit).total.toString()).toBe('1.3'); // 0,50 + 0,50 + 0,30
    const base = quoteBase();
    const qk = quoteKit(db, kit.id, 1);
    const shares = withKitShares([{ input: { ...base, quantity: 2 } }, { input: { ...base, quantity: 1 } }], { ...qk, total: '1' }, () => false);
    expect(shares.map((s) => s.input.deliveryKitShare)).toEqual(['0.67', '0.33']); // soma exata = 1,00
    const q = saveQuote(db, { name: 'Pedido' }, [{ name: 'Chaveiro', input: base }], undefined);
    const before = latestVersion(q).items[0].summary.totalCost!;
    const q2 = saveQuote(db, { quoteId: q.id, deliveryKit: qk }, [{ itemId: latestVersion(q).items[0].itemId, name: 'Chaveiro', input: base }]);
    const it = latestVersion(q2).items[0];
    expect(it.input.deliveryKitShare).toBe('1.3');
    expect(D(it.summary.totalCost!).minus(before).toString()).toBe('1.3');
    expect(latestVersion(q2).deliveryKit?.name).toBe('Kit presente');
    // Venda com kit: baixa saquinho e cartão; custo do kit entra no resultado sem contar duas vezes
    const sale = registerSale(db, { date: '2026-02-10', quoteId: q2.id, quoteItemId: it.itemId, description: 'Chaveiro', qty: 1, unitPrice: '50', discount: '0', freightCharged: '0', freightCost: '0',
      feesWithheld: true, deliveryKit: { kitId: kit.id, qty: 1 }, payment: { mode: 'aprazo', installments: 1, firstDue: '2026-03-10', intervalDays: 30 } });
    expect(sale.deliveryKit?.cost).toBe('1.3');
    expect(materialStatement(db, bagId).physical.toString()).toBe('99');
    expect(D(sale.unitCost!).plus(1.3).toFixed(4)).toBe(D(it.summary.unitCost!).toFixed(4));
    expect(saleEconomics(sale).cogs!.toFixed(2)).toBe(D(it.summary.unitCost!).toFixed(2));
    // Cancelar a venda devolve o kit ao estoque; kit usado não é apagado (fica inativo)
    cancelSale(db, sale.id, 'teste');
    expect(materialStatement(db, bagId).physical.toString()).toBe('100');
    expect(deleteDeliveryKit(db, kit.id)).toBe('inativado');
    expect(() => consumeKit(db, kit.id, 500, { kind: 'venda', id: 'x' })).toThrow(/insuficiente/);
  });
});

describe('Orçamento kit', () => {
  it('junta orçamentos de peças do estoque mantendo os valores salvos', () => {
    const base = quoteBase();
    const o = produceForStockNow(db, { description: 'Dragão', qtyPlanned: 3, plannedMaterials: [{ materialId: filamentId, qty: 150 }], plannedHours: 3 });
    const fg = db.finishedGoods.find((g) => g.orderId === o.id)!;
    fg.suggestedPrice = '35';
    const cli = saveParty(db, { kind: 'cliente', name: 'Ana' });
    const a = quoteFromFinishedGood(db, fg.id, { customerId: cli.id, qty: 2 });
    const b = saveQuote(db, { customerId: cli.id, name: 'Chaveiro' }, [{ name: 'Chaveiro', input: base }]);
    const sum = quoteTotal(db, a).price.plus(quoteTotal(db, b).price);
    const merged = mergeQuotes(db, [a.id, b.id], { name: 'Kit da Ana', deleteSources: true });
    expect(merged.customerId).toBe(cli.id);
    expect(latestVersion(merged).items.map((i) => i.name)).toEqual(['Dragão', 'Chaveiro']);
    expect(quoteTotal(db, merged).price.toString()).toBe(sum.toString());
    expect(db.quotes.map((q) => q.id)).toEqual([merged.id]);
    expect(latestVersion(merged).items[0].finishedGoodId).toBe(fg.id);
    expect(finishedGoodBalance(db, fg.id).available).toBe(3);
  });
});

describe('Conferência do orçamento', () => {
  it('aponta custo de filamento improvável e preço abaixo do custo', () => {
    registerPurchase(db, { date: '2026-03-01', items: [{ materialId: filamentId, qty: 1, unit: 'g', price: '89.37' }], freight: '0', otherCosts: '0', payment: cash() });
    const input = quoteBase();
    const params = resolveParams(db, input);
    const ev = evaluateQuote(input, params);
    expect(quoteSanity(db, input, params, ev).join(' ')).toMatch(/alto demais/);
    const cheap = { ...input, manualPriceUnit: '0.01' };
    expect(quoteSanity(db, cheap, params, evaluateQuote(cheap, params)).join(' ')).toMatch(/prejuízo/);
  });
});

describe('Exclusão e relançamento', () => {
  it('compra lançada errado é excluída por inteiro (lotes, estoque, caixa) e pode ser relançada', () => {
    const wrong = registerPurchase(db, { date: '2026-03-01', items: [{ materialId: filamentId, qty: 1, unit: 'g', price: '89.37' }], freight: '2.40', otherCosts: '0', payment: cash() });
    const balance = accountBalance(db, accountId).toString();
    deletePurchase(db, wrong.id, 'quantidade em gramas');
    expect(db.purchases.some((p) => p.id === wrong.id)).toBe(false);
    expect(db.lots.some((l) => l.purchaseId === wrong.id)).toBe(false);
    expect(db.titles.some((t) => t.origin.id === wrong.id)).toBe(false);
    expect(D(accountBalance(db, accountId)).minus(balance).toString()).toBe('91.77'); // saída do caixa desfeita
    expect(materialStatement(db, filamentId).physical.toString()).toBe('2000');
    const ok = registerPurchase(db, { date: '2026-03-01', items: [{ materialId: filamentId, qty: 1, unit: 'kg', price: '89.37' }], freight: '2.40', otherCosts: '0', payment: cash() });
    expect(D(db.lots.find((l) => l.id === ok.items[0].lotId)!.unitCost).times(1000).toString()).toBe('91.77');
    // Lote já usado: não exclui (usar Editar compra)
    produceForStockNow(db, { description: 'Peça', qtyPlanned: 1, plannedMaterials: [{ materialId: filamentId, qty: 2500 }], plannedHours: 1 });
    expect(purchaseDeleteBlock(db, ok)).toMatch(/já foi usado/);
  });

  it('insumo sem histórico é excluído; com histórico é bloqueado', () => {
    const cat = db.categories.find((c) => c.name === 'Etiquetas')!;
    const tmp = saveMaterial(db, { name: 'Etiqueta errada', categoryId: cat.id, unit: 'un', active: true });
    deleteMaterial(db, tmp.id);
    expect(db.materials.some((m) => m.id === tmp.id)).toBe(false);
    expect(() => deleteMaterial(db, filamentId)).toThrow(/histórico/);
    expect(materialUsage(db, filamentId)).toMatchObject({ lots: 1, purchases: 1 });
  });
});

describe('Correção do custo pelo cadastro do insumo', () => {
  it('corrige o lote da compra (mesmo usado) e o preço nos orçamentos muda junto', () => {
    const p = registerPurchase(db, { date: '2026-03-01', items: [{ materialId: filamentId, qty: 1, unit: 'g', price: '89.37' }], freight: '2.40', otherCosts: '0', payment: cash() });
    const lotId = p.items[0].lotId;
    expect(materialCostPolicy(db, filamentId).unitCost!.times(1000).toString()).toBe('91770');
    correctLot(db, lotId, { qty: 1000, price: '89.37' });
    expect(materialCostPolicy(db, filamentId).unitCost!.times(1000).toString()).toBe('91.77'); // frete continua rateado
    expect(db.titles.filter((t) => t.origin.id === p.id).map((t) => t.amount)).toEqual(['91.77']);
    expect(lotBalance(db, lotId).physical.toString()).toBe('1000');
  });

  it('opção "usar o preço do cadastro" vale mesmo com compras registradas', () => {
    const m = db.materials.find((x) => x.id === filamentId)!;
    saveMaterial(db, { ...m, referenceCost: '0.09', costSource: 'cadastro' }, m.id);
    expect(materialCostPolicy(db, filamentId)).toMatchObject({ source: expect.stringMatching(/cadastro/) });
    expect(materialCostPolicy(db, filamentId).unitCost!.toString()).toBe('0.09');
    expect(() => saveMaterial(db, { ...m, referenceCost: null, costSource: 'cadastro' }, m.id)).toThrow(/informe o preço/);
  });
});

describe('Edições', () => {
  it('venda editada refaz títulos e encargos, mantendo número; bloqueada após recebimento a prazo', () => {
    const s = registerSale(db, { date: '2026-02-10', description: 'Vaso', qty: 2, unitPrice: '30', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, manualUnitCost: '10', payment: cash() });
    expect(accountBalance(db, accountId).toString()).toBe('805'); // 1000 − 255 (compra) + 60
    updateSale(db, s.id, { date: '2026-02-10', description: 'Vaso grande', qty: 2, unitPrice: '35', discount: '5', freightCharged: '0', freightCost: '0', feesWithheld: true, manualUnitCost: '10', payment: cash() });
    expect([s.number, s.description, s.unitPrice]).toEqual(['VND-0001', 'Vaso grande', '35']);
    expect(db.titles.filter((t) => t.origin.id === s.id).map((t) => t.amount)).toEqual(['65']);
    expect(accountBalance(db, accountId).toString()).toBe('810');
    const p = registerSale(db, { date: '2026-02-10', description: 'X', qty: 1, unitPrice: '10', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'aprazo', installments: 1, firstDue: '2026-03-10', intervalDays: 30 } });
    settleTitle(db, { titleId: db.titles.find((t) => t.origin.id === p.id)!.id, date: '2026-03-10', amount: '10', accountId });
    expect(saleEditBlock(db, p)).toMatch(/Estorne/);
  });

  it('título manual: corrige valor sem pagamento; título de compra só muda descrição/vencimento', () => {
    const cat = db.finCategories.find((c) => c.nature === 'despesa_fixa')!;
    const [t] = createManualTitle(db, { categoryId: cat.id, description: 'Aluguel', amount: '1500', competenceDate: '2026-02-01', terms: { mode: 'aprazo', installments: 1, firstDue: '2026-02-10', intervalDays: 30 } });
    updateTitle(db, t.id, { description: 'Aluguel fevereiro', dueDate: '2026-02-15', amount: '1450' });
    expect([t.description, t.amount, t.dueDate]).toEqual(['Aluguel fevereiro', '1450', '2026-02-15']);
    const buy = db.titles.find((x) => x.origin.kind === 'compra')!;
    expect(() => updateTitle(db, buy.id, { description: buy.description, dueDate: buy.dueDate, amount: '1' })).toThrow(/edite a compra/);
  });
});

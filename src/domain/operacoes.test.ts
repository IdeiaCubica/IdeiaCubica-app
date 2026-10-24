/** Testes integrados: compras, financeiro, estoque, produção e vendas operando sobre o mesmo banco. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveChannel, saveMaterial, saveParty, savePrinter } from './catalog';
import { cancelPurchase, registerPurchase } from './purchases';
import { accountBalance, openTotals, reverseSettlement, settleTitle, titleOpen } from './finance';
import { adjustInventory, deleteInitialStock, lotBalance, purchaseAlerts, registerInitialStock, reorderAnalysis, reserve, releaseAll, addMovement, unitCostFromTotal, updateInitialStock } from './inventory';
import { deleteQuote, emptyQuoteInput, evaluateQuote, itemState, latestVersion, materialCostPolicy, paramsForItem, quoteTotal, saveQuote, setItemStatus, staleItems } from './quotes';
import {
  cancelOrder, compareOrder, completeOrder, createManualOrder, createOrderFromQuote, createOrdersFromQuote, daysInStock, finishedGoodBalance, moveInQueue,
  orderDelivery, productionQueue, queueShortages, quoteFromFinishedGood, reserveOrderMaterials, returnOrderToQuote, startOrder, writeOffFinishedGood,
  deleteFinishedGood, registerFinishedGood, updateFinishedGood,
} from './production';
import { migrate } from './schema';
import { managementResult, registerSale } from './sales';
import type { DB } from './types';
import { buildClientQuote } from './clientQuote';
import { D } from './money';

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

  it('compra de insumos gerais (etiquetas, embalagens) entra no estoque com custo por unidade', () => {
    const cat = db.categories.find((c) => c.name === 'Etiquetas')!;
    const etq = saveMaterial(db, { name: 'Etiqueta 5×3 cm', categoryId: cat.id, unit: 'un', active: true }).id;
    const cx = saveMaterial(db, { name: 'Caixa 20×15×10', categoryId: db.categories.find((c) => c.name === 'Caixas e embalagens')!.id, unit: 'un', active: true }).id;
    const p = registerPurchase(db, {
      date: '2026-02-01', items: [{ materialId: etq, qty: 500, price: '40' }, { materialId: cx, qty: 50, price: '60' }], freight: '10', otherCosts: '0',
      payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-01', intervalDays: 30 },
    });
    // Frete rateado pelo valor: 4,00 nas etiquetas e 6,00 nas caixas
    expect(db.lots.find((l) => l.id === p.items[0].lotId)!.unitCost).toBe('0.088'); // (40 + 4) / 500
    expect(db.lots.find((l) => l.id === p.items[1].lotId)!.unitCost).toBe('1.32'); // (60 + 6) / 50
    expect(lotBalance(db, p.items[1].lotId).physical.toString()).toBe('50');
  });

  it('compra de impressora: investimento separado, cadastra a impressora com o custo de aquisição e não entra no estoque', () => {
    const p = registerPurchase(db, {
      date: '2026-02-01', items: [{ materialId: filamentId, qty: 1000, price: '100' }],
      equipment: [{ description: 'Bambu Lab A1', qty: 1, price: '4700', printer: { mode: 'nova', name: 'A1 nº 2', manufacturer: 'Bambu Lab', model: 'A1' } }],
      freight: '96', otherCosts: '0', payment: { mode: 'aprazo', installments: 2, firstDue: '2026-03-01', intervalDays: 30 },
    });
    // Frete 96 rateado por valor: 100/4800 → 2,00 no filamento; 94,00 na impressora
    const eq = p.equipment![0];
    expect([eq.freight, eq.total]).toEqual(['94', '4794']);
    expect(db.lots.find((l) => l.id === p.items[0].lotId)!.unitCost).toBe('0.102');
    const printer = db.printers.find((x) => x.id === eq.printerId)!;
    expect(printer.acquisitionValue).toBe('4794');
    expect(db.lots).toHaveLength(1); // impressora não vira lote de estoque
    const titles = db.titles.filter((t) => t.origin.id === p.id);
    const byCat = (name: string) => titles.filter((t) => db.finCategories.find((c) => c.id === t.categoryId)!.name === name).map((t) => t.amount);
    expect(byCat('Compra de insumos')).toEqual(['51', '51']);
    expect(byCat('Impressoras e equipamentos')).toEqual(['2397', '2397']);
    expect(p.total).toBe('4896');
    // Investimento não é despesa do resultado
    expect(managementResult(db, '2026-02-01', '2026-02-28').fixed.toString()).toBe('0');
    // Cancelar remove a impressora cadastrada pela compra
    cancelPurchase(db, p.id, 'teste');
    expect(db.printers.find((x) => x.id === eq.printerId)).toBeUndefined();
  });

  it('compra vinculada a impressora existente atualiza o valor de aquisição (e o cancelamento restaura)', () => {
    const pr = savePrinter(db, { name: 'A1', manufacturer: 'Bambu Lab', model: 'A1', acquisitionValue: null, residualValue: null, usefulLifeHours: 6000,
      initialHours: 0, energyMode: 'medido', kwhPerHour: '0.095', maintenancePerHour: '0.2', availableHoursPerMonth: 300, active: true });
    const p = registerPurchase(db, { date: '2026-02-01', items: [], equipment: [{ description: 'A1', qty: 1, price: '4769.10', printer: { mode: 'existente', printerId: pr.id } }],
      freight: '0', otherCosts: '0', payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-01', intervalDays: 30 } });
    expect(pr.acquisitionValue).toBe('4769.1');
    expect(accountBalance(db, accountId).toString()).toBe('-3769.1');
    expect(() => registerPurchase(db, { date: '2026-02-01', items: [], equipment: [{ description: 'x', qty: 2, price: '10', printer: { mode: 'existente', printerId: pr.id } }],
      freight: '0', otherCosts: '0', payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-01', intervalDays: 30 } })).toThrow(/quantidade 1/);
    const t = db.titles.find((x) => x.origin.id === p.id)!;
    reverseSettlement(db, t.id, t.settlements[0].id, 'teste');
    cancelPurchase(db, p.id, 'teste');
    expect(pr.acquisitionValue).toBeNull();
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
  it('estoque inicial: custo pelo total pago (R$ 73,58 por 1.000 g = R$ 73,58/kg), correção e exclusão', () => {
    const unit = unitCostFromTotal('73.58', 1000);
    expect(unit.toString()).toBe('0.07358');
    expect(unit.times(1000).toString()).toBe('73.58');      // exibido como R$ 73,58/kg (não R$ 73.580/kg)
    const lot = registerInitialStock(db, { materialId: filamentId, qty: 1000, unitCost: unit.toString(), date: '2026-10-22' });
    expect(lot.cost.goods).toBe('73.58');
    // Lançou errado (R$/g digitado como preço do carretel): corrige
    updateInitialStock(db, lot.id, { qty: 800, unitCost: unitCostFromTotal('60', 800).toString(), date: '2026-10-21' });
    expect(lotBalance(db, lot.id).physical.toString()).toBe('800');
    expect(lot.unitCost).toBe('0.075');
    expect(db.movements.find((m) => m.lotId === lot.id)!.date).toBe('2026-10-21');
    // Depois de usado não pode mais mudar nem excluir
    reserve(db, lot.id, 10, 'op-x');
    expect(() => updateInitialStock(db, lot.id, { qty: 900, unitCost: '0.07', date: '2026-10-21' })).toThrow(/já teve consumo/);
    expect(() => deleteInitialStock(db, lot.id, 'erro')).toThrow(/já teve consumo/);
    releaseAll(db, 'op-x');
    db.movements = db.movements.filter((m) => m.lotId !== lot.id || m.type === 'entrada');
    deleteInitialStock(db, lot.id, 'lançado errado');
    expect(db.lots.find((l) => l.id === lot.id)).toBeUndefined();
    expect(db.movements.some((m) => m.lotId === lot.id)).toBe(false);
    // Lote de compra não é editado aqui
    const p = buyCash();
    expect(() => deleteInitialStock(db, p.items[0].lotId, 'x')).toThrow(/compra/);
  });

  it('inventário gera ajuste com justificativa obrigatória', () => {
    const lotId = buyCash().items[0].lotId;
    expect(() => adjustInventory(db, { lotId, countedQty: 950, reason: '' })).toThrow(/justificativa/);
    adjustInventory(db, { lotId, countedQty: 950, reason: 'pesagem' });
    expect(lotBalance(db, lotId).physical.toString()).toBe('950');
  });
  it('sinaliza compra pela demanda de ordens abertas ainda não reservadas, sem contar em dobro', () => {
    const lotId = buyCash().items[0].lotId;
    const mat = db.materials[0];
    // OP planejada que precisa de 1.200 g (mais que os 1.000 g em estoque)
    db.orders.push({ id: 'op-a', status: 'planejada', plannedMaterials: [{ materialId: mat.id, qty: 1200 }] } as unknown as DB['orders'][number]);
    let r = reorderAnalysis(db, mat, 90, '2026-02-02');
    expect(r.plannedDemand.toString()).toBe('1200');
    expect(r.status).toBe('falta');
    expect(r.suggestedQty!.toString()).toBe('200');
    expect(purchaseAlerts(db)).toHaveLength(1);
    // Ordem com 300 g já reservada: entra no "reservado" e NÃO na demanda planejada
    db.orders[0].plannedMaterials[0].qty = 300;
    reserve(db, lotId, 300, 'op-a');
    db.orders[0].status = 'pronta';
    r = reorderAnalysis(db, mat, 90, '2026-02-02');
    expect(r.plannedDemand.toString()).toBe('0');
    expect(r.available.toString()).toBe('700');
    expect(r.projected.toString()).toBe('700');
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
    const q = saveQuote(db, { name: 'Chaveiro' }, [{ name: 'Chaveiro', input }]);
    return { lotId, q, printer, ch };
  }

  it('orçamento preserva snapshot: mudar custo depois não altera versão antiga', () => {
    const { q, lotId } = setupQuote();
    const before = q.versions[0].items[0].summary.totalCost;
    db.lots.find((l) => l.id === lotId)!.unitCost = '0.50';
    expect(q.versions[0].items[0].params.lots[lotId].unitCost).toBe('0.11');
    expect(q.versions[0].items[0].summary.totalCost).toBe(before);
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
    const q = saveQuote(db, { name: 'Peça grande' }, [{ name: 'Peça grande', input: { ...emptyQuoteInput(db.settings), quantity: 3, materials: [{ materialId: filamentId, qtyPerUnit: 500 }],
      printHoursPerUnit: 1, printerId: printer.id, channelId: ch.id, failureRatePct: '0', markupPct: '40' } }]);
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

  it('fila de produção: ordenada pela entrega (sem data por último), empate pela criação', () => {
    const { q, printer } = setupQuote();
    const a = createOrderFromQuote(db, q.id, { dueDate: '2026-12-20' });
    const b = createManualOrder(db, { description: 'Vaso', qtyPlanned: 2, plannedMaterials: [{ materialId: filamentId, qty: 100 }], plannedHours: 3, printerId: printer.id });
    const c = createManualOrder(db, { description: 'Suporte', qtyPlanned: 1, plannedMaterials: [{ materialId: filamentId, qty: 50 }], plannedHours: 1, dueDate: '2026-12-01' });
    expect(productionQueue(db).map((o) => o.id)).toEqual([c.id, a.id, b.id]);
    // Sem data de entrega, vale a ordem manual
    const d = createManualOrder(db, { description: 'Placa', qtyPlanned: 1, plannedMaterials: [{ materialId: filamentId, qty: 1 }], plannedHours: 1 });
    moveInQueue(db, d.id, 0);
    expect(productionQueue(db).map((o) => o.id)).toEqual([c.id, a.id, d.id, b.id]);
    db.orders = db.orders.filter((o) => o.id !== d.id);
    startOrder(db, a.id);
    expect(productionQueue(db).map((o) => o.id)).toEqual([c.id, b.id]);
    expect(() => moveInQueue(db, a.id, 0)).toThrow(/fila/);
    // OP manual sem lote fixo reserva por material
    expect(b.plannedMaterials[0].lotId).toBeUndefined();
    // Falta acumulada na ordem da fila: 1.000 g − 200 (a, reservada) = 800; b usa 100, c usa 50 → sem falta
    expect(queueShortages(db).size).toBe(0);
    createManualOrder(db, { description: 'Grande', qtyPlanned: 1, plannedMaterials: [{ materialId: filamentId, qty: 700 }], plannedHours: 9 });
    const s = [...queueShortages(db).values()];
    expect(s).toHaveLength(1);
    expect(s[0][0].shortage.toString()).toBe('50');
    expect(b.purpose).toBe('estoque');
  });

  it('OP para estoque gera peças prontas com custo real; venda baixa o saldo e respeita o disponível', () => {
    const { lotId, printer, ch } = setupQuote();
    const op = createManualOrder(db, { description: 'Dragão articulado', qtyPlanned: 5, plannedMaterials: [{ lotId, qty: 100 }], plannedHours: 5, printerId: printer.id, purpose: 'estoque' });
    startOrder(db, op.id);
    completeOrder(db, op.id, { materials: [{ lotId, qty: 100 }], hours: 5, qtyApproved: 4, qtyRejected: 1, laborMinutes: 40, failures: [], location: 'Prateleira A' });
    expect(db.finishedGoods).toHaveLength(1);
    const fg = db.finishedGoods[0];
    expect(fg.qtyProduced).toBe(4);
    expect(fg.location).toBe('Prateleira A');
    expect(fg.costStatus).toBe('realizado');
    expect(fg.unitCost).toBe(compareOrder(db, op).real!.unit!.toDecimalPlaces(4).toString());
    expect(op.finishedGoodId).toBe(fg.id);

    const sale = registerSale(db, { date: '2026-02-10', description: fg.description, finishedGoodId: fg.id, qty: 3, unitPrice: '60', discount: '0', freightCharged: '0',
      freightCost: '0', channelId: ch.id, feesWithheld: true, payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-10', intervalDays: 30 } });
    expect(sale.unitCost).toBe(fg.unitCost);
    expect(finishedGoodBalance(db, fg.id).available).toBe(1);
    expect(() => registerSale(db, { date: '2026-02-11', description: 'x', finishedGoodId: fg.id, qty: 2, unitPrice: '60', discount: '0', freightCharged: '0',
      freightCost: '0', feesWithheld: true, payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-10', intervalDays: 30 } })).toThrow(/Só há 1/);
    writeOffFinishedGood(db, fg.id, 1, 'avaria');
    expect(finishedGoodBalance(db, fg.id).available).toBe(0);
    // Peças produzidas: só descrição/local/preço mudam; vendidas não podem ser excluídas
    expect(() => updateFinishedGood(db, fg.id, { description: 'Dragão', qty: 9 })).toThrow(/vêm da produção/);
    updateFinishedGood(db, fg.id, { description: 'Dragão articulado G', location: 'B', suggestedPrice: '70' });
    expect(fg.suggestedPrice).toBe('70');
    expect(() => deleteFinishedGood(db, fg.id, 'x')).toThrow(/não podem ser excluídas/);
    // Cadastro manual errado: corrige e exclui
    const man = registerFinishedGood(db, { description: 'Chaveiro', qty: 5, unitCost: '75.58', producedAt: '2026-10-01' });
    updateFinishedGood(db, man.id, { description: 'Chaveiro', qty: 6, unitCost: '3.58', producedAt: '2026-10-02' });
    expect([man.qtyProduced, man.unitCost, man.producedAt]).toEqual([6, '3.58', '2026-10-02']);
    deleteFinishedGood(db, man.id, 'lançado errado');
    expect(db.finishedGoods.find((g) => g.id === man.id)).toBeUndefined();
    expect(daysInStock({ producedAt: '2026-01-01' }, '2026-01-31')).toBe(30);
  });

  it('OP de pedido não vai para o estoque de peças; entrega é marcada pela venda', () => {
    const { q, ch } = setupQuote();
    const op = createOrderFromQuote(db, q.id, { dueDate: '2026-03-01' });
    expect(orderDelivery(db, op)).toBe('fila');
    startOrder(db, op.id);
    expect(orderDelivery(db, op)).toBe('producao');
    completeOrder(db, op.id, { materials: [{ lotId: db.lots[0].id, qty: 200 }], hours: 4, qtyApproved: 4, qtyRejected: 0, laborMinutes: null, failures: [] });
    expect(db.finishedGoods).toHaveLength(0);
    expect(orderDelivery(db, op)).toBe('pronto');
    registerSale(db, { date: '2026-02-10', description: 'Chaveiro', orderId: op.id, qty: 4, unitPrice: '25', discount: '0', freightCharged: '0', freightCost: '0',
      channelId: ch.id, feesWithheld: true, payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-10', intervalDays: 30 } });
    expect(orderDelivery(db, op)).toBe('entregue');
  });

  it('orçamento para o cliente: valores da versão salva, frete do cliente e nenhum dado de custo', () => {
    const { q, lotId, printer, ch } = setupQuote();
    const cli = saveParty(db, { kind: 'cliente', name: 'Maria', phone: '11987654321' });
    const base = latestVersion(q).items[0].input;
    const ship = { originCep: '01001000', destCep: null, lengthCm: 20, widthCm: 15, heightCm: 10, packagingWeightG: 80,
      clientFreight: { service: 'PAC', price: '22.5', deliveryMin: 3, deliveryMax: 5 } };
    const q2 = saveQuote(db, { customerId: cli.id }, [
      { name: 'Vaso', image: 'data:image/jpeg;base64,AAA', input: { ...base, quantity: 3, manualPriceUnit: '25', discountPct: '10' } },
      { name: 'Porta-lápis', input: { ...base, quantity: 2, manualPriceUnit: '10' } },
    ], ship);
    void lotId; void printer; void ch;
    const doc = buildClientQuote(db, q2, { validityDays: 7 }, '2026-10-21');
    expect(doc.items.map((i) => i.unitPrice.toString())).toEqual(['25', '10']);
    expect(doc.subtotal.toString()).toBe('95');      // 75 + 20
    expect(doc.discount.toString()).toBe('7.5');     // 25 × 10% × 3
    expect(doc.freight).toEqual({ label: 'Frete (PAC)', price: D('22.5'), delivery: '3 a 5 dias úteis', free: false });
    expect(doc.total.toString()).toBe('110');        // 67,50 + 20 + 22,50
    expect(doc.validUntil).toBe('2026-10-28');
    expect(doc.items[0].image).toBe('data:image/jpeg;base64,AAA');
    expect(doc.items[1].image).toBeNull();
    expect(doc.items[0].materials).toEqual(['PLA Preto']);
    expect(doc.customer?.name).toBe('Maria');
    // Só algumas peças: o cliente aprova uma parte
    const only = buildClientQuote(db, q2, {}, '2026-10-21', [q2.versions[0].items[1].itemId]);
    expect(only.items).toHaveLength(1);
    expect(only.total.toString()).toBe('42.5');      // 20 + 22,50
    // Nenhum campo interno vai para o documento
    const json = JSON.stringify(doc);
    for (const k of ['cost', 'Cost', 'margin', 'markup', 'hours', 'weight', 'qtyPerUnit', 'source']) expect(json).not.toContain(k);
    // Frete pago pela empresa: "grátis".
    const q3 = saveQuote(db, { name: 'Sem foto' }, [{ name: 'Sem foto', input: { ...base, freightSubsidyPerOrder: '15' } }]);
    const d3 = buildClientQuote(db, q3, {}, '2026-10-21');
    expect(d3.items[0].image).toBeNull();
    expect(d3.freight?.free).toBe(true);
    expect(d3.total.toString()).toBe(D(latestVersion(q3).items[0].summary.orderPrice!).toString());
  });

  it('valor do orçamento é o mesmo em todas as telas; custos novos só entram quando o usuário atualiza', () => {
    const { q, lotId } = setupQuote();
    const it = latestVersion(q).items[0];
    const savedPrice = it.summary.orderPrice;
    // Custo do filamento muda depois de salvar (ex.: nova compra mais cara)
    db.lots.find((l) => l.id === lotId)!.unitCost = '0.50';
    // Tela do orçamento (peça não alterada) usa o snapshot salvo → mesmo valor da lista e do documento
    const shown = evaluateQuote(it.input, paramsForItem(db, q, it.itemId, it.input)).pricing.analysis!.revenue.toString();
    expect(shown).toBe(savedPrice);
    expect(buildClientQuote(db, q, {}, '2026-10-24').total.toString()).toBe(savedPrice);
    // O sistema avisa que os custos de hoje dariam outro valor
    const stale = staleItems(db, q);
    expect(stale).toHaveLength(1);
    expect(stale[0].current).not.toBe(savedPrice);
    // Salvar sem alterar a peça não muda o preço sozinho
    saveQuote(db, { quoteId: q.id }, [{ itemId: it.itemId, name: it.name, input: it.input }]);
    expect(latestVersion(q).items[0].summary.orderPrice).toBe(savedPrice);
    // Atualizar custos (ação do usuário) gera nova versão com o valor novo, em todas as telas
    saveQuote(db, { quoteId: q.id, refreshCosts: true }, [{ itemId: it.itemId, name: it.name, input: it.input }]);
    const v3 = latestVersion(q).items[0];
    expect(v3.summary.orderPrice).toBe(stale[0].current);
    expect(evaluateQuote(v3.input, paramsForItem(db, q, v3.itemId, v3.input)).pricing.analysis!.revenue.toString()).toBe(v3.summary.orderPrice);
    expect(buildClientQuote(db, q, {}, '2026-10-24').total.toString()).toBe(v3.summary.orderPrice);
    expect(staleItems(db, q)).toHaveLength(0);
    expect(q.versions[0].items[0].summary.orderPrice).toBe(savedPrice);   // histórico preservado
  });

  it('orçamento com várias peças: aprova algumas, produz por peça com data de entrega e retorna pedido', () => {
    const { q } = setupQuote();
    const base = latestVersion(q).items[0].input;
    const cli = saveParty(db, { kind: 'cliente', name: 'João' });
    const qq = saveQuote(db, { customerId: cli.id }, [
      { name: 'Chaveiro A', input: { ...base, quantity: 2 } },
      { name: 'Chaveiro B', input: { ...base, quantity: 1 } },
      { name: 'Chaveiro C', input: { ...base, quantity: 1 } },
    ]);
    const [a, b, c] = latestVersion(qq).items.map((i) => i.itemId);
    expect(quoteTotal(db, qq).count).toBe(3);
    setItemStatus(db, qq.id, c, 'recusado');
    expect(quoteTotal(db, qq).count).toBe(2);
    expect(() => createOrdersFromQuote(db, qq.id, [a], { dueDate: '' })).toThrow(/data de entrega/);
    const [pa] = createOrdersFromQuote(db, qq.id, [a], { dueDate: '2026-11-10' });
    expect(pa.number).toMatch(/^PED-/);
    expect(pa.quoteItemId).toBe(a);
    expect(pa.customerId).toBe(cli.id);
    expect(itemState(db, qq, a)).toBe('producao');
    expect(qq.status).toBe('aprovado');             // B ainda aberta
    // Peça em produção não pode ser alterada nem removida
    const items = latestVersion(qq).items;
    expect(() => saveQuote(db, { quoteId: qq.id, customerId: cli.id }, items.map((i) => ({ itemId: i.itemId, name: i.name, input: { ...i.input, quantity: 9 } })))).toThrow(/em produção/);
    expect(() => saveQuote(db, { quoteId: qq.id, customerId: cli.id }, items.filter((i) => i.itemId !== a).map((i) => ({ itemId: i.itemId, name: i.name, input: i.input })))).toThrow(/não pode ser removida/);
    // Quadro: entrega mais próxima primeiro
    const [pb] = createOrdersFromQuote(db, qq.id, [b], { dueDate: '2026-11-01' });
    expect(productionQueue(db).filter((o) => o.quoteId === qq.id).map((o) => o.id)).toEqual([pb.id, pa.id]);
    expect(qq.status).toBe('convertido');           // todas as não recusadas em produção
    // Retornar o pedido para o orçamento: libera e volta a ficar aprovada e editável
    returnOrderToQuote(db, pa.id, 'cliente mudou a cor');
    expect(pa.status).toBe('cancelada');
    expect(itemState(db, qq, a)).toBe('aprovado');
    expect(qq.status).toBe('aprovado');
    // Exclusão bloqueada com pedido ativo; liberada depois
    expect(() => deleteQuote(db, qq.id, 'teste')).toThrow(/pedidos ativos/);
    returnOrderToQuote(db, pb.id, 'teste');
    deleteQuote(db, qq.id, 'teste');
    expect(db.quotes.find((x) => x.id === qq.id)).toBeUndefined();
  });

  it('produção para estoque calcula custo e preço; orçamento a partir da peça pronta separa ao aprovar', () => {
    const { lotId, printer, ch } = setupQuote();
    db.settings.defaultMarkupPct = '100';
    db.settings.defaultChannelId = ch.id;
    const op = createManualOrder(db, { description: 'Dragão', qtyPlanned: 4, plannedMaterials: [{ lotId, qty: 200 }], plannedHours: 8, printerId: printer.id, purpose: 'estoque' });
    expect(op.number).toMatch(/^EST-/);
    expect(op.estimate?.summary.unitCost).toBeTruthy();
    expect(op.estimate?.summary.unitPrice).toBeTruthy();
    startOrder(db, op.id);
    completeOrder(db, op.id, { materials: [{ lotId, qty: 200 }], hours: 8, qtyApproved: 4, qtyRejected: 0, laborMinutes: null, failures: [] });
    const fg = db.finishedGoods.find((g) => g.orderId === op.id)!;
    expect(fg.suggestedPrice).toBe(op.estimate!.summary.unitPrice);
    expect(fg.production).toEqual({ materials: [{ label: 'PLA Preto A (PLA Preto)', qty: 200, unit: 'g' }], hours: 8, qtyMade: 4 });
    const cli = saveParty(db, { kind: 'cliente', name: 'Ana' });
    const qs = quoteFromFinishedGood(db, fg.id, { customerId: cli.id, qty: 3 });
    const it = latestVersion(qs).items[0];
    expect(it.finishedGoodId).toBe(fg.id);
    expect(it.summary.unitPrice).toBe(fg.suggestedPrice);
    expect(finishedGoodBalance(db, fg.id).available).toBe(4);   // continua no estoque
    expect(() => createOrdersFromQuote(db, qs.id, [it.itemId], { dueDate: '2026-11-01' })).toThrow(/estoque/);
    setItemStatus(db, qs.id, it.itemId, 'aprovado');             // "Pedido aprovado": separa 3
    expect(itemState(db, qs, it.itemId)).toBe('separado');
    expect(finishedGoodBalance(db, fg.id).available).toBe(1);
    // Venda consome a separação
    registerSale(db, { date: '2026-02-10', description: fg.description, finishedGoodId: fg.id, quoteId: qs.id, quoteItemId: it.itemId, qty: 3, unitPrice: '50', discount: '0',
      freightCharged: '0', freightCost: '0', channelId: ch.id, feesWithheld: true, payment: { mode: 'avista', accountId, installments: 1, firstDue: '2026-02-10', intervalDays: 30 } });
    expect(finishedGoodBalance(db, fg.id)).toMatchObject({ sold: 3, allocated: 0, available: 1 });
    expect(itemState(db, qs, it.itemId)).toBe('separado');
  });

  it('migração: orçamento antigo de uma peça vira items[] e pedidos apontam para a peça', () => {
    const { q } = setupQuote();
    const op = createOrderFromQuote(db, q.id, { dueDate: '2026-11-01' });
    const v = q.versions[0];
    const legacy = structuredClone(db) as unknown as { quotes: Record<string, unknown>[]; orders: Record<string, unknown>[] };
    const lq = legacy.quotes[0] as { versions: Record<string, unknown>[]; image?: string; status: string };
    lq.versions = [{ version: 1, createdAt: v.createdAt, input: v.items[0].input, params: v.items[0].params, summary: v.items[0].summary }];
    lq.image = 'data:x'; lq.status = 'convertido';
    delete (legacy.orders[0] as { quoteItemId?: string }).quoteItemId;
    const m = migrate(legacy);
    const mq = m.quotes[0];
    expect(mq.versions[0].items[0]).toMatchObject({ itemId: `${q.id}:1`, name: 'Chaveiro', image: 'data:x' });
    expect(m.orders[0].quoteItemId).toBe(`${q.id}:1`);
    expect(itemState(m, mq, `${q.id}:1`)).toBe('producao');
    void op;
  });

  it('numeração: orçamentos começam em ORC-00000203; códigos de insumo seguem a sigla da categoria', () => {
    const fresh = createEmptyDB();
    const qx = saveQuote(fresh, {}, [{ name: 'X', input: emptyQuoteInput(fresh.settings) }]);
    expect(qx.number).toBe('ORC-00000203');
    const old = structuredClone(fresh) as typeof fresh;
    old.counters = { quote: 1 }; old.settings.appliedMigrations = []; old.settings.codeDigits = {};
    const mig = migrate(old);
    expect(saveQuote(mig, {}, [{ name: 'Y', input: emptyQuoteInput(mig.settings) }]).number).toBe('ORC-00000203');
    expect(saveQuote(migrate(mig), {}, [{ name: 'Z', input: emptyQuoteInput(mig.settings) }]).number).toBe('ORC-00000204');
    // Insumos: sigla da categoria + sequência
    const fil = fresh.categories.find((c) => c.isFilament)!;
    expect(fil.code).toBe('FL');
    saveMaterial(fresh, { name: 'PLA manual', categoryId: fil.id, unit: 'g', active: true, code: 'FL00002', filament: { materialType: 'PLA', color: 'Azul', netWeightG: 1000 } });
    const next = saveMaterial(fresh, { name: 'PLA novo', categoryId: fil.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Rosa', netWeightG: 1000 } });
    expect(next.code).toBe('FL00003');
    const et = fresh.categories.find((c) => c.name === 'Etiquetas')!;
    expect(saveMaterial(fresh, { name: 'Etiqueta', categoryId: et.id, unit: 'un', active: true }).code).toBe('ET00001');
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

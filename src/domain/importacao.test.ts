/** v1.7: importação de filamentos, dimensões da peça e exclusão de pedido/produção. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount, saveMaterial } from './catalog';
import { filamentTemplateCsv, importFilaments, parseNumBR, parseTable, previewFilamentImport } from './filamentImport';
import { registerPurchase } from './purchases';
import { materialStatement } from './inventory';
import { createManualOrder, deleteOrder, orderDeleteBlock, produceForStockNow } from './production';
import { registerSale } from './sales';
import { emptyQuoteInput, latestVersion, saveQuote } from './quotes';
import { formatDimensions } from './clientQuote';
import type { DB } from './types';

let db: DB;
let accountId: string;
beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '1000', openingDate: '2026-01-01', active: true });
  accountId = db.accounts[0].id;
});
const cash = () => ({ mode: 'avista' as const, accountId, installments: 1, firstDue: '2026-02-01', intervalDays: 30 });

describe('Importação de filamentos', () => {
  it('lê o modelo, cria marcas e grava preço em R$/g a partir de R$/kg', () => {
    const p = previewFilamentImport(db, filamentTemplateCsv());
    expect(p.missingColumns).toEqual([]);
    expect(p.rows.map((r) => r.status)).toEqual(['novo', 'novo', 'novo']);
    const res = importFilaments(db, p.rows, { updateExisting: false });
    expect(res).toEqual({ created: 3, updated: 0, skipped: 0 });
    const m = db.materials.find((x) => x.name === 'PLA Basic Preto')!;
    expect([m.unit, m.referenceCost, m.filament?.netWeightG, m.filament?.colorHex, m.minStock]).toEqual(['g', '0.0899', 1000, '#111111', 500]);
    expect(db.brands.map((b) => b.name).sort()).toEqual(['Bambu Lab', 'Voolt3D']);
    expect(m.code).toMatch(/^FL\d{5}$/);
  });

  it('aceita células coladas do Excel (tabulação), "1.000" e cabeçalho com acentos; aponta erros e duplicados', () => {
    saveMaterial(db, { name: 'PLA Branco', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Branco' } });
    const text = 'Nome\tTipo\tCor\tPeso líquido\tPreço por kg\nPLA Branco\tPLA\tBranco\t1.000\t85,00\nTPU Vermelho\tTPU\tVermelho\t500\t1,20\nSem cor\tPLA\t\t1000\t90\nASA Cinza\tASA\tCinza\t1\t99';
    expect(parseTable(text)[1]).toEqual(['PLA Branco', 'PLA', 'Branco', '1.000', '85,00']);
    expect(parseNumBR('1.000')!.toString()).toBe('1000');
    const { rows } = previewFilamentImport(db, text);
    expect(rows.map((r) => r.status)).toEqual(['existe', 'erro', 'erro', 'erro']);
    expect(rows[1].message).toMatch(/fora do normal/);
    expect(rows[2].message).toMatch(/falta a cor/);
    expect(rows[3].message).toMatch(/em gramas/);
    expect(importFilaments(db, rows, { updateExisting: true })).toEqual({ created: 0, updated: 1, skipped: 3 });
    expect(db.materials.find((m) => m.name === 'PLA Branco')!.referenceCost).toBe('0.085');
  });

  it('sem as colunas obrigatórias não importa nada', () => {
    expect(previewFilamentImport(db, 'marca;peso\nX;1000').missingColumns).toEqual(['nome', 'tipo', 'cor']);
  });
});

describe('Dimensões da peça', () => {
  it('opcionais, formatadas para o cliente e sem mudar o preço salvo', () => {
    expect(formatDimensions(null)).toBeNull();
    expect(formatDimensions({ height: null, width: null, depth: null })).toBeNull();
    expect(formatDimensions({ height: 10, width: 5.5, depth: 3 })).toBe('10 × 5,5 × 3 cm (A × L × P)');
    expect(formatDimensions({ height: 12, width: null, depth: 4 })).toBe('12 × 4 cm (A × P)');
    const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, referenceCost: '0.09', filament: { materialType: 'PLA', color: 'Azul' } });
    const input = { ...emptyQuoteInput(db.settings), quantity: 2, materials: [{ materialId: fil.id, qtyPerUnit: 20 }], printHoursPerUnit: 1, markupPct: '40' };
    const q = saveQuote(db, { name: 'X' }, [{ name: 'X', input }]);
    const it = latestVersion(q).items[0];
    fil.referenceCost = '0.20'; // custo mudou depois de salvar
    saveQuote(db, { quoteId: q.id }, [{ itemId: it.itemId, name: 'X', input: { ...input, dimensionsCm: { height: 8, width: 4, depth: 2 } } }]);
    const it2 = latestVersion(q).items[0];
    expect(it2.input.dimensionsCm).toEqual({ height: 8, width: 4, depth: 2 });
    expect(it2.summary.orderPrice).toBe(it.summary.orderPrice); // só dimensões: mantém o valor salvo
  });
});

describe('Excluir pedido/produção', () => {
  it('apaga a produção, devolve o filamento ao estoque e remove as peças geradas', () => {
    const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Azul' } });
    registerPurchase(db, { date: '2026-02-01', items: [{ materialId: fil.id, qty: 1000, price: '90' }], freight: '0', otherCosts: '0', payment: cash() });
    const o = produceForStockNow(db, { description: 'Suporte para Console de Carro', qtyPlanned: 2, plannedMaterials: [{ materialId: fil.id, qty: 300 }], plannedHours: 4 });
    expect(materialStatement(db, fil.id).physical.toString()).toBe('700');
    deleteOrder(db, o.id, 'lançado por engano');
    expect(db.orders.some((x) => x.id === o.id)).toBe(false);
    expect(db.finishedGoods).toHaveLength(0);
    expect(materialStatement(db, fil.id).physical.toString()).toBe('1000');
    // Planejada (sem consumo) também é excluída; com venda, bloqueia
    const p = createManualOrder(db, { description: 'Y', qtyPlanned: 1, plannedMaterials: [{ materialId: fil.id, qty: 10 }], plannedHours: 1 });
    deleteOrder(db, p.id, 'teste');
    const o2 = produceForStockNow(db, { description: 'Z', qtyPlanned: 1, plannedMaterials: [{ materialId: fil.id, qty: 10 }], plannedHours: 1 });
    registerSale(db, { date: '2026-02-10', orderId: o2.id, finishedGoodId: o2.finishedGoodId, description: 'Z', qty: 1, unitPrice: '10', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: cash() });
    expect(orderDeleteBlock(db, o2)).toMatch(/venda/);
  });
});

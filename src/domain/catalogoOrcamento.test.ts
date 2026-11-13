/** Peça do catálogo no orçamento: preço do catálogo, custos da origem (v1.25). */
import { describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveChannel, saveMaterial } from './catalog';
import { emptyQuoteInput, evaluateQuote, latestVersion, resolveParams, saveQuote } from './quotes';
import { registerFinishedGood } from './production';
import type { CatalogProduct, CatalogRecord } from './catalogo';
import { catalogProductDraft, catalogProductPrice, catalogsForQuote, currentCatalogPrice } from './catalogoOrcamento';

function setup() {
  const db = createEmptyDB();
  const cat = db.categories.find((c) => c.isFilament)!;
  const pla = saveMaterial(db, { name: 'PLA', categoryId: cat.id, unit: 'g', active: true, referenceCost: '0.10', filament: { materialType: 'PLA', color: 'Branco' } });
  const ch = saveChannel(db, { name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0', active: true });
  const input = { ...emptyQuoteInput(db.settings), channelId: ch.id, markupPct: '100', failureRatePct: '0', rounding: 'final90' as const, labor: { perOrder: 0, perUnit: 0 }, printHoursPerUnit: null,
    quantity: 3, materials: [{ materialId: pla.id, qtyPerUnit: 30 }] };
  const q = saveQuote(db, { name: 'Chaveiro' }, [{ name: 'Chaveiro', input }]);
  const itemId = latestVersion(q).items[0].itemId;
  const fg = registerFinishedGood(db, { description: 'Vaso pronto', qty: 2, unitCost: '5', producedAt: '2026-11-01' });
  const product = (over: Partial<CatalogProduct>): CatalogProduct => ({ id: over.id ?? 'p', name: 'Produto', description: '', image: null, originalPrice: null, promoPrice: null, showPrice: true, badge: null, ...over });
  const catalog = {
    id: 'cat1', name: 'Natal 2026', theme: 'natal', status: 'publicado', createdAt: '', updatedAt: '', links: [],
    data: { version: 1, settings: {}, sections: [], kits: [], products: [
      product({ id: 'p1', name: 'Chaveiro de Natal', originalPrice: '12', promoPrice: '9.5', source: { kind: 'orcamento', quoteId: q.id, itemId, label: 'x' } }),
      product({ id: 'p2', name: 'Vaso', originalPrice: '40', source: { kind: 'estoque', finishedGoodId: fg.id, label: 'y' } }),
      product({ id: 'p3', name: 'Sem origem', originalPrice: '15' }),
      product({ id: 'p4', name: 'Sem preço' }),
    ] },
  } as unknown as CatalogRecord;
  return { db, catalog, pla: pla.id, fg };
}

describe('Peça do catálogo no orçamento', () => {
  it('usa o preço do catálogo (promocional) e os custos da peça de origem; sem arredondamento', () => {
    const { db, catalog, pla } = setup();
    const d = catalogProductDraft(db, catalog, 'p1', 10);
    expect(d.name).toBe('Chaveiro de Natal');
    expect(d.input.quantity).toBe(10);
    expect(d.input.manualPriceUnit).toBe('9.5');
    expect(d.input.catalogRef).toMatchObject({ catalogId: 'cat1', catalogName: 'Natal 2026', productId: 'p1', price: '9.5' });
    expect(d.input.materials[0].materialId).toBe(pla);
    const ev = evaluateQuote(d.input, resolveParams(db, d.input));
    expect(ev.pricing.analysis!.revenue.toString()).toBe('95'); // 10 × 9,50, sem ,90
    expect(ev.costs.total.gt(0)).toBe(true);
  });

  it('peça pronta: pronta-entrega com saldo; sem saldo vira sob encomenda', () => {
    const { db, catalog, fg } = setup();
    const ok = catalogProductDraft(db, catalog, 'p2', 2);
    expect(ok.finishedGoodId).toBe(fg.id);
    expect(ok.input.manualPriceUnit).toBe('40');
    const big = catalogProductDraft(db, catalog, 'p2', 5);
    expect(big.finishedGoodId).toBeUndefined();
    expect(big.input.manualPriceUnit).toBe('40');
  });

  it('sem origem: nome e preço do catálogo; sem preço: não deixa orçar', () => {
    const { db, catalog } = setup();
    const d = catalogProductDraft(db, catalog, 'p3', 1);
    expect(d.name).toBe('Sem origem');
    expect(d.input.manualPriceUnit).toBe('15');
    expect(d.input.materials).toEqual([]);
    expect(() => catalogProductDraft(db, catalog, 'p4', 1)).toThrow(/não tem preço/);
    expect(() => catalogProductDraft(db, catalog, 'p1', 0)).toThrow(/Quantidade/);
  });

  it('preço atual do catálogo, preço promocional e Catálogo Geral', () => {
    const { db, catalog } = setup();
    const d = catalogProductDraft(db, catalog, 'p1', 1);
    catalog.data.products[0].promoPrice = '8.9';
    expect(currentCatalogPrice(catalog, d.input.catalogRef!)).toBe('8.9');
    expect(currentCatalogPrice(null, d.input.catalogRef!)).toBeNull();
    expect(catalogProductPrice({ promoPrice: null, originalPrice: '12' })).toBe('12');
    expect(catalogProductPrice({ promoPrice: '0', originalPrice: '12' })).toBe('12');
    const geral = { ...catalog, id: 'g', data: { ...catalog.data, kind: 'geral' } } as CatalogRecord;
    expect(catalogsForQuote([catalog, geral]).map((c) => c.id)).toEqual(['cat1']);
  });
});

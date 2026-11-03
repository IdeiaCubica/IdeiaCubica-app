/** v1.19: catálogo digital — cópia independente, kits, seções, publicação sem dados internos, validade. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveMaterial } from './catalog';
import { emptyQuoteInput, latestVersion, saveQuote } from './quotes';
import {
  addProducts, catalogStatus, duplicateCatalog, kitReferencePrice, moveEntry, newCatalog, publicSnapshot, publishProblems, randomSlug,
  removeProduct, removeSection, saveKit, updateProduct, whatsappNumber, cartTotals, cartMessage, withDefaults, type CatalogRecord,
} from './catalogo';
import { productCandidates, productFromCandidate } from './catalogoFontes';
import { CATALOG_THEMES, customFromTheme, resolveTheme, themeOf } from './catalogThemes';
import type { DB } from './types';

let db: DB;
let rec: CatalogRecord;

beforeEach(() => {
  db = createEmptyDB();
  const fil = saveMaterial(db, { name: 'PLA', categoryId: db.categories.find((c) => c.isFilament)!.id, unit: 'g', active: true, filament: { materialType: 'PLA', color: 'Azul' } });
  const base = { ...emptyQuoteInput(db.settings), quantity: 1, markupPct: '50', failureRatePct: '0', printHoursPerUnit: 1, materials: [{ materialId: fil.id, qtyPerUnit: 50 }] };
  saveQuote(db, { name: 'Vaso' }, [{ name: 'Vaso', input: base }]);
  saveQuote(db, { name: 'Luminária' }, [{ name: 'Luminária', input: base }]);
  rec = newCatalog({ name: 'Natal', theme: 'natal', storeName: 'Ideia Cúbica' });
  addProducts(rec.data, productCandidates(db).map(productFromCandidate));
});

describe('Catálogo digital', () => {
  it('tem as 15 temáticas prontas (com Corporativo, Eventos e Itens Religiosos) e o layout próprio', () => {
    expect(CATALOG_THEMES.map((t) => t.id)).toHaveLength(15);
    expect(CATALOG_THEMES.map((t) => t.id)).toEqual(expect.arrayContaining(['corporativo', 'eventos', 'religioso']));
    const custom = customFromTheme(themeOf('natal'));
    custom.colors.primary = '#123456'; custom.headingFont = 'Lobster'; custom.ornaments = ['🦄'];
    const r = resolveTheme('personalizado', custom);
    expect([r.colors.primary, r.fonts.heading, r.ornaments[0]]).toEqual(['#123456', 'Lobster', '🦄']);
    expect(r.googleFonts).toMatch(/Lobster/);
    expect(resolveTheme('natal', custom).colors.primary).toBe(themeOf('natal').colors.primary); // só vale no "Personalizado"
  });

  it('carrinho: total previsto, 5% acima de R$ 200, itens a combinar e mensagem do WhatsApp', () => {
    const cart = { enabled: true, discountAbove: '200', discountPct: '5' };
    const lines = [
      { id: 'a', name: 'Vaso', type: 'produto' as const, qty: 2, unitPrice: '60' },
      { id: 'b', name: 'KIT NATAL', type: 'kit' as const, qty: 1, unitPrice: '80' },
      { id: 'c', name: 'Peça sob consulta', type: 'produto' as const, qty: 1, unitPrice: null },
    ];
    let t = cartTotals(lines, cart);
    expect([t.subtotal.toString(), t.eligible, t.discount.toString(), t.total.toString(), t.toQuote, t.pieces]).toEqual(['200', false, '0', '200', 1, 4]);
    expect(t.missing?.toString()).toBe('0'); // exatamente 200 ainda não é "acima"
    lines[1].qty = 2;
    t = cartTotals(lines, cart);
    expect([t.subtotal.toString(), t.eligible, t.discount.toString(), t.total.toString()]).toEqual(['280', true, '14', '266']);
    const msg = cartMessage('Natal', lines, cart, 'nome Ana');
    expect(msg).toMatch(/2x Vaso — R\$ 60,00 cada = R\$ 120,00/);
    expect(msg).toMatch(/2x KIT NATAL \(kit\)/);
    expect(msg).toMatch(/Peça sob consulta — valor a combinar/);
    expect(msg).toMatch(/Desconto de 5% .*−R\$ 14,00/);
    expect(msg).toMatch(/\*Total previsto: R\$ 266,00\* \+ 1 item\(ns\) a combinar/);
    expect(msg).toMatch(/Observação: nome Ana/);
    expect(cartTotals(lines, { enabled: true, discountAbove: null, discountPct: null }).discount.toString()).toBe('0');
  });

  it('catálogos antigos ganham carrinho e PERSONALIZADO por padrão', () => {
    const old = { settings: { storeName: 'x' } } as unknown as Parameters<typeof withDefaults>[0];
    withDefaults(old);
    expect(old.settings).toMatchObject({ cart: { enabled: true, discountAbove: '200', discountPct: '5' }, customRequest: { enabled: true }, custom: null });
  });

  it('produto é cópia: editar no catálogo não altera o orçamento', () => {
    const before = JSON.stringify(db.quotes);
    const p = rec.data.products.find((x) => x.name === 'Vaso')!;
    updateProduct(rec.data, p.id, { name: 'Vaso Natalino', description: 'Lindo', originalPrice: '39.9', promoPrice: '29.9', badge: 'MAIS VENDIDO' });
    expect(JSON.stringify(db.quotes)).toBe(before);
    expect(latestVersion(db.quotes[0]).items[0].name).toBe('Vaso');
    expect(p).toMatchObject({ name: 'Vaso Natalino', originalPrice: '39.9', promoPrice: '29.9' });
    expect(() => updateProduct(rec.data, p.id, { originalPrice: '-1' })).toThrow(/negativo/);
  });

  it('kit: ao menos 2 produtos, preço de referência = soma, não muda o preço dos produtos', () => {
    const [a, b] = rec.data.products;
    updateProduct(rec.data, a.id, { originalPrice: '50' });
    updateProduct(rec.data, b.id, { originalPrice: '100' });
    expect(() => saveKit(rec.data, { name: 'Kit', description: '', productIds: [a.id], image: null, referencePrice: null, promoPrice: null, showPrice: true, badge: null })).toThrow(/dois produtos/);
    const kit = saveKit(rec.data, { name: 'KIT NATAL', description: '', productIds: [a.id, b.id], image: null, referencePrice: null, promoPrice: '119.9', showPrice: true, badge: null });
    expect(kit.referencePrice).toBe('150');
    expect(kitReferencePrice(rec.data, [a.id, b.id])).toBe('150');
    expect([a.originalPrice, b.originalPrice]).toEqual(['50', '100']);
    removeProduct(rec.data, a.id);
    expect(rec.data.kits[0].productIds).toEqual([b.id]);
  });

  it('publicação: só dados comerciais; preço oculto não vai; seção vazia some', () => {
    const p = rec.data.products[0];
    updateProduct(rec.data, p.id, { showPrice: false });
    const snap = publicSnapshot(rec);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/"(source|quoteId|itemId|unitCost|totalCost|marginPct|finishedGoodId)"/);
    const item = snap.sections.flatMap((s) => s.items).find((i) => i.id === p.id)!;
    expect([item.price, item.promoPrice]).toEqual([null, null]);
    expect(snap.sections.every((s) => s.items.length > 0 || s.banner)).toBe(true);
  });

  it('precisa de contato para publicar', () => {
    expect(publishProblems(rec).join(' ')).toMatch(/contato/);
    rec.data.settings.contact.whatsapp = '(11) 91234-5678';
    expect(publishProblems(rec)).toEqual([]);
    expect(whatsappNumber('(11) 91234-5678')).toBe('5511912345678');
  });

  it('duplicar: copia tudo, nasce rascunho e sem link', () => {
    rec.links = [{ slug: 'abcdefghij12', expiresAt: null, active: true, publishedAt: '2026-11-01T00:00:00Z', revokedAt: null }];
    rec.status = 'publicado';
    const copy = duplicateCatalog(rec);
    expect(copy.id).not.toBe(rec.id);
    expect([copy.status, copy.links]).toEqual(['rascunho', []]);
    expect(copy.data.products.map((p) => p.name)).toEqual(rec.data.products.map((p) => p.name));
    updateProduct(copy.data, copy.data.products[0].id, { name: 'Outro nome' });
    expect(rec.data.products[0].name).not.toBe('Outro nome'); // catálogos independentes
  });

  it('situação: publicado, expirado pela data ou manualmente, rascunho', () => {
    expect(catalogStatus(rec)).toBe('rascunho');
    rec.links = [{ slug: 'abcdefghij12', expiresAt: '2026-12-01T00:00:00Z', active: true, publishedAt: '2026-11-01T00:00:00Z', revokedAt: null }];
    expect(catalogStatus(rec, new Date('2026-11-15'))).toBe('publicado');
    expect(catalogStatus(rec, new Date('2026-12-02'))).toBe('expirado');
    rec.links[0].active = false;
    expect(catalogStatus(rec, new Date('2026-11-15'))).toBe('expirado');
  });

  it('trocar a temática não perde produtos; ordem e seções', () => {
    const names = rec.data.products.map((p) => p.name);
    rec.theme = 'black_friday';
    expect(rec.data.products.map((p) => p.name)).toEqual(names);
    const s = rec.data.sections[1];
    const first = s.entries[0].id;
    moveEntry(rec.data, s.id, 0, 1);
    expect(s.entries[1].id).toBe(first);
    removeSection(rec.data, s.id);
    expect(rec.data.sections[0].entries.map((e) => e.id)).toContain(first);
  });

  it('link aleatório, não sequencial', () => {
    const a = randomSlug(), b = randomSlug();
    expect(a).toMatch(/^[a-z0-9]{12}$/);
    expect(a).not.toBe(b);
  });
});

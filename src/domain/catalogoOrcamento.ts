/**
 * Peça do catálogo no orçamento (v1.25; kits na v1.26).
 *
 * O usuário escolhe um produto (ou um kit) de um catálogo e a peça entra no orçamento com o PREÇO DO
 * CATÁLOGO (promocional, se houver; senão o original). O preço só é alterado no catálogo: no orçamento
 * ele fica travado, com a opção de buscar o preço atual do catálogo.
 *
 * Kit: cada produto do kit vira uma peça do orçamento, na quantidade de kits. O preço do kit é repartido
 * entre as peças na proporção do preço de cada produto (sem preço em algum, em partes iguais), de modo
 * que a soma das peças dá exatamente o preço do kit × quantidade.
 *
 * Os custos (para a margem e o lucro) vêm da origem do produto no catálogo:
 *   - peça de orçamento → copia a peça (filamento, peso, tempo, foto, ajustes);
 *   - peça pronta do estoque → peça pronta-entrega, se houver saldo; sem saldo, vira sob encomenda
 *     com os dados da produção dela;
 *   - sem origem (ou origem excluída) → só nome, foto e preço: o custo fica para preencher.
 */
import type { CatalogPriceRef, DB, ID, QuoteInput } from './types';
import type { CatalogKit, CatalogProduct, CatalogRecord } from './catalogo';
import { BusinessError, assert } from './core';
import { D, cents } from './money';
import { copyQuoteItem, emptyQuoteInput, type QuoteItemDraft } from './quotes';
import { finishedGoodBalance, finishedGoodDraft, orderBaseInput } from './production';

const positive = (...xs: (string | null | undefined)[]): string | null =>
  xs.find((x): x is string => x !== null && x !== undefined && x !== '' && D(x).gt(0)) ?? null;

/** Preço de 1 peça do produto no catálogo: promocional, se houver; senão o original. */
export function catalogProductPrice(p: Pick<CatalogProduct, 'promoPrice' | 'originalPrice'>): string | null {
  return positive(p.promoPrice, p.originalPrice);
}

/** Preço de 1 kit no catálogo: promocional, se houver; senão o de referência. */
export function catalogKitPrice(k: Pick<CatalogKit, 'promoPrice' | 'referencePrice'>): string | null {
  return positive(k.promoPrice, k.referencePrice);
}

/** Catálogos que têm produtos para orçar (o Catálogo Geral só junta outros catálogos e fica de fora). */
export function catalogsForQuote(list: CatalogRecord[]): CatalogRecord[] {
  return list.filter((c) => c.data.kind !== 'geral');
}

/** Produtos do kit que ainda existem no catálogo. */
export function kitProducts(catalog: CatalogRecord, kit: CatalogKit): CatalogProduct[] {
  return kit.productIds.map((id) => catalog.data.products.find((p) => p.id === id)).filter((p): p is CatalogProduct => !!p);
}

/**
 * Reparte o preço de 1 kit entre os produtos (em centavos), na proporção do preço de cada um;
 * se algum produto não tem preço, em partes iguais. O último fica com a diferença de centavos.
 */
export function kitPriceShares(kitPrice: string, products: Pick<CatalogProduct, 'promoPrice' | 'originalPrice'>[]): string[] {
  const total = D(kitPrice);
  const prices = products.map(catalogProductPrice);
  const weights = prices.every(Boolean) ? prices.map((p) => D(p!)) : products.map(() => D(1));
  const sum = weights.reduce((a, w) => a.plus(w), D(0));
  const shares = weights.map((w) => cents(total.times(w).div(sum)));
  shares[shares.length - 1] = total.minus(shares.slice(0, -1).reduce((a, s) => a.plus(s), D(0)));
  return shares.map((s) => s.toString());
}

/** Rascunho da peça com os custos da origem do produto (o preço entra depois). */
function originDraft(db: DB, p: CatalogProduct, qty: number, price: string): QuoteItemDraft {
  let draft: QuoteItemDraft | null = null;
  const src = p.source;
  if (src?.kind === 'orcamento') {
    const q = db.quotes.find((x) => x.id === src.quoteId);
    if (q) { try { draft = { ...copyQuoteItem(q, src.itemId, { qty }) }; } catch { draft = null; } }
  } else if (src?.kind === 'estoque') {
    const fg = db.finishedGoods.find((g) => g.id === src.finishedGoodId);
    if (fg) {
      if (finishedGoodBalance(db, fg.id).available >= qty) draft = finishedGoodDraft(db, fg.id, { qty, unitPrice: price });
      else {
        // Sem saldo suficiente: sob encomenda, com os dados da produção da peça.
        const order = fg.orderId ? db.orders.find((o) => o.id === fg.orderId) : undefined;
        const base: QuoteInput = order ? structuredClone(orderBaseInput(db, order).input) : emptyQuoteInput(db.settings);
        base.quantity = qty; base.deliveryKitShare = null; base.overrides = {};
        if (fg.dimensionsCm) base.dimensionsCm = structuredClone(fg.dimensionsCm);
        draft = { name: fg.description, image: fg.image ?? null, input: base };
      }
    }
  }
  return draft ?? { name: p.name, image: null, input: { ...emptyQuoteInput(db.settings), quantity: qty } };
}

function withPrice(draft: QuoteItemDraft, p: CatalogProduct, name: string, qty: number, ref: CatalogPriceRef): QuoteItemDraft {
  const input: QuoteInput = { ...draft.input, quantity: qty, manualPriceUnit: ref.price, catalogRef: ref };
  return { ...draft, name, image: p.image ?? draft.image ?? null, input };
}

export function catalogProductDraft(db: DB, catalog: CatalogRecord, productId: ID, qty: number): QuoteItemDraft {
  assert(Number.isInteger(qty) && qty > 0, 'Quantidade deve ser um inteiro maior que zero.');
  const p = catalog.data.products.find((x) => x.id === productId);
  if (!p) throw new BusinessError('Produto não encontrado no catálogo.');
  const price = catalogProductPrice(p);
  if (!price) throw new BusinessError(`"${p.name}" não tem preço no catálogo "${catalog.name}". Informe o preço no catálogo antes de orçar.`);
  const ref: CatalogPriceRef = { catalogId: catalog.id, catalogName: catalog.name, productId: p.id, productName: p.name, price };
  return withPrice(originDraft(db, p, qty, price), p, p.name, qty, ref);
}

/** Kit do catálogo: uma peça por produto, com o preço do kit repartido entre elas (v1.26). */
export function catalogKitDrafts(db: DB, catalog: CatalogRecord, kitId: ID, qty: number): QuoteItemDraft[] {
  assert(Number.isInteger(qty) && qty > 0, 'Quantidade deve ser um inteiro maior que zero.');
  const kit = catalog.data.kits.find((k) => k.id === kitId);
  if (!kit) throw new BusinessError('Kit não encontrado no catálogo.');
  const price = catalogKitPrice(kit);
  if (!price) throw new BusinessError(`O kit "${kit.name}" não tem preço no catálogo "${catalog.name}". Informe o preço no catálogo antes de orçar.`);
  const products = kitProducts(catalog, kit);
  if (!products.length) throw new BusinessError(`O kit "${kit.name}" não tem produtos no catálogo.`);
  const shares = kitPriceShares(price, products);
  return products.map((p, i) => {
    const ref: CatalogPriceRef = { catalogId: catalog.id, catalogName: catalog.name, productId: p.id, productName: p.name, price: shares[i], kitId: kit.id, kitName: kit.name };
    return withPrice(originDraft(db, p, qty, shares[i]), p, `${p.name} (${kit.name})`, qty, ref);
  });
}

/** Preço atual do produto (ou da parte dele no kit) no catálogo (null = removido ou sem preço). */
export function currentCatalogPrice(catalog: CatalogRecord | null, ref: CatalogPriceRef): string | null {
  if (!catalog) return null;
  if (ref.kitId) {
    const kit = catalog.data.kits.find((k) => k.id === ref.kitId);
    const price = kit ? catalogKitPrice(kit) : null;
    if (!kit || !price) return null;
    const products = kitProducts(catalog, kit);
    const i = products.findIndex((p) => p.id === ref.productId);
    return i < 0 ? null : kitPriceShares(price, products)[i];
  }
  const p = catalog.data.products.find((x) => x.id === ref.productId);
  return p ? catalogProductPrice(p) : null;
}

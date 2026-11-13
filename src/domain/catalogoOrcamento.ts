/**
 * Peça do catálogo no orçamento (v1.25).
 *
 * O usuário escolhe um produto de um catálogo e a peça entra no orçamento com o PREÇO DO CATÁLOGO
 * (promocional, se houver; senão o original). O preço só é alterado no catálogo: no orçamento ele fica
 * travado, com a opção de buscar o preço atual do catálogo.
 *
 * Os custos (para a margem e o lucro) vêm da origem do produto no catálogo:
 *   - peça de orçamento → copia a peça (filamento, peso, tempo, foto, ajustes);
 *   - peça pronta do estoque → peça pronta-entrega, se houver saldo; sem saldo, vira sob encomenda
 *     com os dados da produção dela;
 *   - sem origem (ou origem excluída) → só nome, foto e preço: o custo fica para preencher.
 */
import type { CatalogPriceRef, DB, ID, QuoteInput } from './types';
import type { CatalogProduct, CatalogRecord } from './catalogo';
import { BusinessError, assert } from './core';
import { D } from './money';
import { copyQuoteItem, emptyQuoteInput, type QuoteItemDraft } from './quotes';
import { finishedGoodBalance, finishedGoodDraft, orderBaseInput } from './production';

/** Preço de 1 peça do produto no catálogo: promocional, se houver; senão o original. */
export function catalogProductPrice(p: Pick<CatalogProduct, 'promoPrice' | 'originalPrice'>): string | null {
  const v = [p.promoPrice, p.originalPrice].find((x) => x !== null && x !== undefined && x !== '' && D(x).gt(0));
  return v ?? null;
}

/** Catálogos que têm produtos para orçar (o Catálogo Geral só junta outros catálogos e fica de fora). */
export function catalogsForQuote(list: CatalogRecord[]): CatalogRecord[] {
  return list.filter((c) => c.data.kind !== 'geral');
}

export function catalogProductDraft(db: DB, catalog: CatalogRecord, productId: ID, qty: number): QuoteItemDraft {
  assert(Number.isInteger(qty) && qty > 0, 'Quantidade deve ser um inteiro maior que zero.');
  const p = catalog.data.products.find((x) => x.id === productId);
  if (!p) throw new BusinessError('Produto não encontrado no catálogo.');
  const price = catalogProductPrice(p);
  if (!price) throw new BusinessError(`"${p.name}" não tem preço no catálogo "${catalog.name}". Informe o preço no catálogo antes de orçar.`);

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
  if (!draft) draft = { name: p.name, image: null, input: { ...emptyQuoteInput(db.settings), quantity: qty } };

  const ref: CatalogPriceRef = { catalogId: catalog.id, catalogName: catalog.name, productId: p.id, productName: p.name, price };
  const input: QuoteInput = { ...draft.input, quantity: qty, manualPriceUnit: price, catalogRef: ref };
  return { ...draft, name: p.name, image: p.image ?? draft.image ?? null, input };
}

/** Preço atual do produto no catálogo (null = produto removido ou sem preço). */
export function currentCatalogPrice(catalog: CatalogRecord | null, ref: CatalogPriceRef): string | null {
  const p = catalog?.data.products.find((x) => x.id === ref.productId);
  return p ? catalogProductPrice(p) : null;
}

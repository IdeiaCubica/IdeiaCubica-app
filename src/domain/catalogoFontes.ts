/**
 * Peças que podem entrar no catálogo (modelos dos orçamentos e peças prontas) e a cópia comercial
 * que vai para o catálogo. Fica fora de catalogo.ts para a página pública não carregar o orçamento.
 */
import type { DB, ID } from './types';
import type { DecStr } from './money';
import { newId } from './core';
import type { CatalogProduct, CatalogSource } from './catalogo';
import { itemState, quoteItemImage, quoteItems } from './quotes';
import { finishedGoodBalance } from './production';
export interface ProductCandidate { key: string; source: CatalogSource; name: string; image: string | null; price: DecStr | null; detail: string }

/** Peças que podem entrar no catálogo: modelos dos orçamentos (não recusados) e peças prontas do estoque. */
export function productCandidates(db: DB): ProductCandidate[] {
  const out: ProductCandidate[] = [];
  const customer = (id?: ID) => db.parties.find((p) => p.id === id)?.name;
  for (const q of [...db.quotes].reverse()) {
    for (const it of quoteItems(q)) {
      if (itemState(db, q, it.itemId) === 'recusado') continue;
      out.push({
        key: `q:${q.id}:${it.itemId}`, source: { kind: 'orcamento', quoteId: q.id, itemId: it.itemId, label: `${q.number} · ${it.name}` },
        name: it.name, image: it.image ?? quoteItemImage(q, it.itemId), price: it.summary.unitPrice ?? null,
        detail: `Orçamento ${q.number}${customer(q.customerId) ? ` · ${customer(q.customerId)}` : ''}`,
      });
    }
  }
  for (const g of db.finishedGoods) {
    const b = finishedGoodBalance(db, g.id);
    out.push({
      key: `e:${g.id}`, source: { kind: 'estoque', finishedGoodId: g.id, label: `${g.code} · ${g.description}` },
      name: g.description, image: g.image ?? null, price: g.suggestedPrice ?? null,
      detail: `Peça pronta ${g.code} · ${b.available} disponível(is)`,
    });
  }
  return out;
}

/** Cópia comercial da peça para o catálogo (independente da origem). */
export function productFromCandidate(c: ProductCandidate): CatalogProduct {
  return { id: newId(), source: structuredClone(c.source), name: c.name, description: '', image: c.image, originalPrice: c.price, promoPrice: null, showPrice: true, badge: null };
}


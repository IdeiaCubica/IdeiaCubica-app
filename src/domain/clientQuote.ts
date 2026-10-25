/**
 * Orçamento para o cliente: monta APENAS o que o cliente deve ver.
 * Nunca inclui custos, margem, markup, peso, horas de máquina, fonte do modelo
 * nem dados internos. Valores vêm da versão SALVA do orçamento, recalculada
 * com o snapshot de parâmetros dela (mesmos números da tela).
 */
import type { ClientQuoteSettings, DB, ID, Quote, QuoteInput } from './types';
import { D, Decimal, ZERO, cents } from './money';
import { addDays, todayISO } from './core';
import { evaluateQuote, itemState, latestVersion } from './quotes';
import { quoteShipping } from './shipping';
import { formatAddress } from './address';

export const CLIENT_QUOTE_DEFAULTS: ClientQuoteSettings = {
  validityDays: 7,
  productionDays: 5,
  paymentTerms: 'PIX ou cartão. 50% na aprovação e 50% na entrega.',
  notes: 'As cores podem variar levemente conforme o filamento. Peças feitas sob medida, camada por camada.',
  whatsapp: '', instagram: '', email: '', site: '',
};

export function clientQuoteSettings(db: DB): ClientQuoteSettings {
  return { ...CLIENT_QUOTE_DEFAULTS, ...db.settings.clientQuote };
}

export interface ClientQuoteDocItem {
  description: string;
  image: string | null;
  materials: string[];
  /** Dimensões aproximadas de 1 peça, ex.: "10 × 5 × 3 cm (A × L × P)"; null = não informadas. */
  dimensions: string | null;
  quantity: number;
  unitPrice: Decimal;
  /** Valor da peça já com desconto. */
  total: Decimal;
  discountPct: Decimal;
  discount: Decimal;
  /** Peça a pronta-entrega (do estoque). */
  ready: boolean;
}

export interface ClientQuoteDoc {
  number: string;
  version: number;
  issueDate: string;
  validUntil: string | null;
  customer: { name: string; phone?: string; address?: string } | null;
  items: ClientQuoteDocItem[];
  /** Soma das peças sem desconto. */
  subtotal: Decimal;
  discount: Decimal;
  freight: { label: string; price: Decimal | null; delivery: string | null; free: boolean } | null;
  total: Decimal;
  productionDays: number | null;
  paymentTerms: string;
  notes: string;
  contacts: { whatsapp: string; instagram: string; email: string; site: string };
  companyName: string;
}

const deliveryText = (min: number | null, max: number | null) =>
  min === null ? null : min === max || max === null ? `${min} dia${min === 1 ? '' : 's'} útei${min === 1 ? 'l' : 's'}` : `${min} a ${max} dias úteis`;

/**
 * Monta o documento com as peças escolhidas (padrão: todas as não recusadas).
 * Permite enviar ao cliente o orçamento de todas as peças ou só de algumas.
 */
/** "10 × 5 × 3 cm (A × L × P)" com as medidas informadas; null quando nenhuma foi preenchida. */
export function formatDimensions(d: QuoteInput['dimensionsCm']): string | null {
  if (!d) return null;
  const parts = [['A', d.height], ['L', d.width], ['P', d.depth]].filter(([, v]) => v !== null && v !== undefined && Number(v) > 0) as [string, number][];
  if (!parts.length) return null;
  const n = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return `${parts.map(([, v]) => n(v)).join(' × ')} cm (${parts.map(([k]) => k).join(' × ')})`;
}

export function buildClientQuote(db: DB, quote: Quote, opts: Partial<ClientQuoteSettings> = {}, today = todayISO(), itemIds?: ID[]): ClientQuoteDoc {
  const v = latestVersion(quote);
  const chosen = v.items.filter((it) => (itemIds ? itemIds.includes(it.itemId) : itemState(db, quote, it.itemId) !== 'recusado'));
  if (!chosen.length) throw new Error('Escolha ao menos uma peça para o documento.');
  const cfg = { ...clientQuoteSettings(db), ...opts };

  const items: ClientQuoteDocItem[] = chosen.map((it) => {
    const a = evaluateQuote(it.input, it.params).pricing.analysis;
    if (!a) throw new Error(`A peça "${it.name}" ainda não tem valor para o cliente. Complete as informações e salve antes de gerar o documento.`);
    const qty = it.input.quantity;
    const gross = cents(a.unitPrice.times(qty));
    const materials = [...new Set(it.input.materials.map((m) => {
      const mat = db.materials.find((x) => x.id === (m.materialId || db.lots.find((l) => l.id === m.lotId)?.materialId));
      if (!mat) return null;
      return mat.filament ? `${mat.filament.materialType} ${mat.filament.color}`.trim() : mat.name;
    }).filter((x): x is string => !!x))];
    const discount = gross.minus(a.revenue);
    return {
      description: it.name, image: it.image ?? null, materials, dimensions: formatDimensions(it.input.dimensionsCm), quantity: qty, unitPrice: a.unitPrice, total: a.revenue,
      discountPct: a.discountPct, discount: discount.gt(0) ? discount : ZERO, ready: !!it.finishedGoodId,
    };
  });
  const subtotal = items.reduce((s, x) => s.plus(cents(x.unitPrice.times(x.quantity))), ZERO);
  const discount = items.reduce((s, x) => s.plus(x.discount), ZERO);
  const total = items.reduce((s, x) => s.plus(x.total), ZERO);

  const ship = v.shipping ?? quoteShipping(db, chosen[0].input);
  const companyPaysFreight = chosen.some((it) => D(it.input.freightSubsidyPerOrder ?? 0).gt(0));
  const cf = ship.clientFreight;
  const freight = companyPaysFreight
    ? { label: 'Frete', price: null, delivery: null, free: true }
    : cf ? { label: `Frete (${cf.service})`, price: cents(D(cf.price)), delivery: deliveryText(cf.deliveryMin, cf.deliveryMax), free: false }
    : null;

  const c = db.parties.find((p) => p.id === quote.customerId);
  const address = c?.addressParts ? formatAddress(c.addressParts) : c?.address;
  return {
    number: quote.number,
    version: v.version,
    issueDate: today,
    validUntil: cfg.validityDays ? addDays(today, cfg.validityDays) : null,
    customer: c ? { name: c.name, phone: c.phone, address: address || undefined } : null,
    items,
    subtotal,
    discount,
    freight,
    total: freight?.price ? total.plus(freight.price) : total,
    productionDays: cfg.productionDays,
    paymentTerms: cfg.paymentTerms.trim(),
    notes: cfg.notes.trim(),
    contacts: { whatsapp: cfg.whatsapp.trim(), instagram: cfg.instagram.trim(), email: cfg.email.trim(), site: cfg.site.trim() },
    companyName: db.settings.companyName || 'Ideia Cúbica',
  };
}

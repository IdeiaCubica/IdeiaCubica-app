/**
 * Orçamento para o cliente: monta APENAS o que o cliente deve ver.
 * Nunca inclui custos, margem, markup, peso, horas de máquina, fonte do modelo
 * nem dados internos. Valores vêm da versão SALVA do orçamento, recalculada
 * com o snapshot de parâmetros dela (mesmos números da tela).
 */
import type { ClientQuoteSettings, DB, Quote } from './types';
import { D, Decimal, ZERO, cents } from './money';
import { addDays, todayISO } from './core';
import { evaluateQuote, latestVersion } from './quotes';
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

export interface ClientQuoteDoc {
  number: string;
  version: number;
  issueDate: string;
  validUntil: string | null;
  customer: { name: string; phone?: string; address?: string } | null;
  item: { description: string; image: string | null; materials: string[]; quantity: number };
  unitPrice: Decimal;
  subtotal: Decimal;
  discountPct: Decimal;
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

export function buildClientQuote(db: DB, quote: Quote, opts: Partial<ClientQuoteSettings> = {}, today = todayISO()): ClientQuoteDoc {
  const v = latestVersion(quote);
  const ev = evaluateQuote(v.input, v.params);
  const a = ev.pricing.analysis;
  if (!a) throw new Error('Este orçamento ainda não tem valor para o cliente. Complete as informações e salve antes de gerar o documento.');
  const cfg = { ...clientQuoteSettings(db), ...opts };
  const qty = v.input.quantity;
  const subtotal = cents(a.unitPrice.times(qty));
  const total = a.revenue;
  const discount = subtotal.minus(total);

  const ship = quoteShipping(db, v.input);
  const companyPaysFreight = D(v.input.freightSubsidyPerOrder ?? 0).gt(0);
  const cf = ship.clientFreight;
  const freight = companyPaysFreight
    ? { label: 'Frete', price: null, delivery: null, free: true }
    : cf ? { label: `Frete (${cf.service})`, price: cents(D(cf.price)), delivery: deliveryText(cf.deliveryMin, cf.deliveryMax), free: false }
    : null;

  const materials = [...new Set(v.input.materials.map((m) => {
    const mat = db.materials.find((x) => x.id === (m.materialId || db.lots.find((l) => l.id === m.lotId)?.materialId));
    if (!mat) return null;
    return mat.filament ? `${mat.filament.materialType} ${mat.filament.color}`.trim() : mat.name;
  }).filter((x): x is string => !!x))];

  const c = db.parties.find((p) => p.id === quote.customerId);
  const address = c?.addressParts ? formatAddress(c.addressParts) : c?.address;
  return {
    number: quote.number,
    version: v.version,
    issueDate: today,
    validUntil: cfg.validityDays ? addDays(today, cfg.validityDays) : null,
    customer: c ? { name: c.name, phone: c.phone, address: address || undefined } : null,
    item: { description: quote.name, image: quote.image ?? null, materials, quantity: qty },
    unitPrice: a.unitPrice,
    subtotal,
    discountPct: a.discountPct,
    discount: discount.gt(0) ? discount : ZERO,
    freight,
    total: freight?.price ? total.plus(freight.price) : total,
    productionDays: cfg.productionDays,
    paymentTerms: cfg.paymentTerms.trim(),
    notes: cfg.notes.trim(),
    contacts: { whatsapp: cfg.whatsapp.trim(), instagram: cfg.instagram.trim(), email: cfg.email.trim(), site: cfg.site.trim() },
    companyName: db.settings.companyName || 'Ideia Cúbica',
  };
}

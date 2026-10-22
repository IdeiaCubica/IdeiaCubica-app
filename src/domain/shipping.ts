/**
 * Pacote para cotação de frete: peso das peças (filamento por peça × quantidade)
 * + peso da embalagem, nas medidas da caixa DESTE orçamento (cada peça pode ter
 * a sua). Orçamento novo parte do padrão de Parâmetros → Envios; orçamentos
 * antigos, sem caixa própria, usam o padrão atual.
 * O peso do filamento é uma estimativa do peso real da peça (suportes removidos
 * pesam um pouco menos), suficiente para a cotação.
 */
import type { DB, QuoteInput, QuoteShipping, Settings } from './types';
import { D, Decimal } from './money';

export interface ShippingPackage { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** Padrão de envio de um novo orçamento: origem e caixa de Parâmetros → Envios. */
export function shippingDefaults(settings: Settings): QuoteShipping {
  const box = settings.shippingBox;
  return {
    originCep: digits(settings.companyAddress?.cep) || null,
    destCep: null,
    lengthCm: box?.lengthCm ?? null,
    widthCm: box?.widthCm ?? null,
    heightCm: box?.heightCm ?? null,
    packagingWeightG: box?.packagingWeightG ?? null,
  };
}

/** Envio efetivo do orçamento: o dele, ou o padrão para orçamentos antigos. */
export function quoteShipping(db: DB, input: Pick<QuoteInput, 'shipping'>): QuoteShipping {
  return input.shipping ?? shippingDefaults(db.settings);
}

/** Peso (g) das peças de uma linha: filamento por peça × quantidade. */
export function piecesWeightG(db: DB, input: Pick<QuoteInput, 'materials' | 'quantity'>): Decimal {
  let gramsPerUnit = D(0);
  for (const m of input.materials) {
    const mat = db.materials.find((x) => x.id === (m.materialId || db.lots.find((l) => l.id === m.lotId)?.materialId));
    const factor = mat?.unit === 'kg' ? 1000 : mat?.unit === 'g' || !mat ? 1 : 0;
    gramsPerUnit = gramsPerUnit.plus(D(m.qtyPerUnit || 0).times(factor));
  }
  return gramsPerUnit.times(input.quantity || 0);
}

/** Pacote de um orçamento com várias peças: todas na mesma caixa do orçamento. */
export function packageFor(db: DB, inputs: Pick<QuoteInput, 'materials' | 'quantity'>[], ship: QuoteShipping) {
  const merged = { materials: [] as QuoteInput['materials'], quantity: 1, shipping: ship };
  const grams = inputs.reduce((s, i) => s.plus(piecesWeightG(db, i)), D(0));
  merged.materials = grams.gt(0) ? [{ materialId: '', qtyPerUnit: grams.toNumber() }] : [];
  return quotePackage(db, merged);
}

export function quotePackage(db: DB, input: Pick<QuoteInput, 'materials' | 'quantity' | 'shipping'>): { pkg: ShippingPackage | null; missing: string[]; piecesG: number } {
  const box = quoteShipping(db, input);
  const missing: string[] = [];
  const piecesG = piecesWeightG(db, input);
  if (piecesG.lte(0)) missing.push('peso da peça');
  if (!(box.lengthCm! > 0) || !(box.widthCm! > 0) || !(box.heightCm! > 0)) missing.push('medidas da caixa');
  if ((box.packagingWeightG ?? 0) < 0) missing.push('peso da embalagem válido');
  if (missing.length) return { pkg: null, missing, piecesG: piecesG.toNumber() };
  const totalKg = piecesG.plus(box.packagingWeightG ?? 0).div(1000).toDecimalPlaces(3, Decimal.ROUND_UP);
  return {
    pkg: { weightKg: Math.max(0.001, totalKg.toNumber()), lengthCm: box.lengthCm!, widthCm: box.widthCm!, heightCm: box.heightCm! },
    missing: [],
    piecesG: piecesG.toNumber(),
  };
}

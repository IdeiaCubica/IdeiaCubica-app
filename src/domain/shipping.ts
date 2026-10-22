/**
 * Pacote para cotação de frete: peso das peças (filamento por peça × quantidade)
 * + peso da embalagem, nas medidas da caixa padrão (Parâmetros → Envios).
 * O peso do filamento é uma estimativa do peso real da peça (suportes removidos
 * pesam um pouco menos), suficiente para a cotação.
 */
import type { DB, QuoteInput } from './types';
import { D, Decimal } from './money';

export interface ShippingPackage { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }

export function quotePackage(db: DB, input: Pick<QuoteInput, 'materials' | 'quantity'>): { pkg: ShippingPackage | null; missing: string[]; piecesG: number } {
  const box = db.settings.shippingBox;
  const missing: string[] = [];
  let gramsPerUnit = D(0);
  for (const m of input.materials) {
    const mat = db.materials.find((x) => x.id === (m.materialId || db.lots.find((l) => l.id === m.lotId)?.materialId));
    const factor = mat?.unit === 'kg' ? 1000 : mat?.unit === 'g' || !mat ? 1 : 0;
    gramsPerUnit = gramsPerUnit.plus(D(m.qtyPerUnit || 0).times(factor));
  }
  const piecesG = gramsPerUnit.times(input.quantity || 0);
  if (piecesG.lte(0)) missing.push('peso da peça');
  if (!box?.lengthCm || !box.widthCm || !box.heightCm) missing.push('medidas da caixa (Parâmetros de Custos → Gerais → Envios)');
  if (missing.length) return { pkg: null, missing, piecesG: piecesG.toNumber() };
  const totalKg = piecesG.plus(box!.packagingWeightG ?? 0).div(1000).toDecimalPlaces(3, Decimal.ROUND_UP);
  return {
    pkg: { weightKg: Math.max(0.001, totalKg.toNumber()), lengthCm: box!.lengthCm!, widthCm: box!.widthCm!, heightCm: box!.heightCm! },
    missing: [],
    piecesG: piecesG.toNumber(),
  };
}

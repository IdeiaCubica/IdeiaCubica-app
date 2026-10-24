/**
 * Conferência de custos improváveis (proteção contra erro de digitação/unidade).
 * Sem dependências de outros módulos de domínio, para poder ser usada em qualquer lugar.
 */
import type { Material } from './types';
import { D, Decimal } from './money';

/**
 * Faixa plausível de preço de filamento (R$/kg). Fora dela, quase sempre é erro de
 * unidade (ex.: "1" digitado em gramas quando era 1 kg → custo 1.000× maior).
 */
export const FILAMENT_PER_KG_RANGE = { min: 20, max: 800 } as const;

/** Aviso de custo improvável para o insumo (null = custo plausível ou sem referência). */
export function unusualUnitCost(mat: Pick<Material, 'unit' | 'filament'> | undefined, unitCost: Decimal.Value | null | undefined): string | null {
  if (!mat || unitCost === null || unitCost === undefined) return null;
  if (mat.unit !== 'g' && mat.unit !== 'kg') return null;
  const perKg = mat.unit === 'g' ? D(unitCost).times(1000) : D(unitCost);
  if (!mat.filament && mat.unit === 'g' && perKg.lt(FILAMENT_PER_KG_RANGE.max)) return null;
  const brl = (v: Decimal) => v.toDecimalPlaces(2).toFixed(2).replace('.', ',');
  if (perKg.gt(FILAMENT_PER_KG_RANGE.max)) {
    return `Custo de R$ ${brl(perKg)}/kg parece alto demais. Confira a quantidade e a unidade: 1 kg = 1.000 g (um carretel de 1 kg digitado como "1 g" deixa o custo 1.000× maior).`;
  }
  if (mat.filament && perKg.lt(FILAMENT_PER_KG_RANGE.min)) {
    return `Custo de R$ ${brl(perKg)}/kg parece baixo demais para filamento. Confira se a quantidade não foi digitada em gramas a mais (ex.: 1.000 kg em vez de 1.000 g).`;
  }
  return null;
}

/**
 * Tendências de produção: guarda os relatórios diários e estima o retorno de
 * cada ideia com o MESMO motor de custos dos orçamentos (parâmetros reais da
 * empresa). Peso, tempo e preço de mercado vêm da pesquisa e são estimativas.
 */
import type { DB, TrendIdea, TrendReport } from './types';
import { D, Decimal, ZERO } from './money';
import { newId, nowISO } from './core';
import { emptyQuoteInput, evaluateQuote, resolveParams } from './quotes';
import { analyzeAtPrice, type PriceAnalysis } from './pricing';

const KEEP_REPORTS = 30;

export function saveTrendReport(db: DB, r: Omit<TrendReport, 'id' | 'generatedAt'>): TrendReport {
  const report: TrendReport = { ...r, id: newId(), generatedAt: nowISO() };
  db.trends = [report, ...db.trends.filter((x) => x.date !== r.date)].slice(0, KEEP_REPORTS);
  return report;
}

export interface IdeaEstimate {
  complete: boolean;
  pending: string[];
  unitCost: Decimal | null;
  /** Preço sugerido pelo markup padrão. */
  recommendedUnit: Decimal | null;
  /** Preço médio do mercado (meio da faixa pesquisada). */
  marketUnit: Decimal | null;
  /** Resultado vendendo ao preço de mercado. */
  market: PriceAnalysis | null;
  /** Lucro por hora de máquina ao preço de mercado. */
  profitPerHour: Decimal | null;
}

export function estimateIdea(db: DB, idea: Pick<TrendIdea, 'estWeightG' | 'estPrintHours' | 'priceMin' | 'priceMax'>, materialId?: string): IdeaEstimate {
  const pending: string[] = [];
  const input = emptyQuoteInput(db.settings);
  input.channelId = db.channels.find((c) => c.active)?.id;
  input.markupPct = db.settings.defaultMarkupPct ?? null;
  input.rounding = db.settings.defaultRounding;
  if (materialId && idea.estWeightG) input.materials = [{ materialId, qtyPerUnit: idea.estWeightG }];
  else pending.push(materialId ? 'peso estimado' : 'filamento cadastrado');
  if (idea.estPrintHours) input.printHoursPerUnit = idea.estPrintHours;
  else pending.push('tempo estimado');

  const marketUnit = idea.priceMin && idea.priceMax ? D(idea.priceMin).plus(idea.priceMax).div(2)
    : idea.priceMin ? D(idea.priceMin) : idea.priceMax ? D(idea.priceMax) : null;
  if (pending.length) return { complete: false, pending, unitCost: null, recommendedUnit: null, marketUnit, market: null, profitPerHour: null };

  const ev = evaluateQuote(input, resolveParams(db, input));
  const unitCost = ev.costs.unitTotal ?? null;
  const ch = ev.pricing.channel ?? { name: 'sem canal', rates: ZERO, fixedFee: ZERO };
  const market = marketUnit ? analyzeAtPrice(marketUnit, ev.costs, ch) : null;
  const h = ev.costs.machineHours;
  return {
    complete: ev.costs.complete,
    pending: ev.costs.complete ? [] : ev.costs.pending,
    unitCost,
    recommendedUnit: ev.pricing.recommendedRoundedUnit ?? ev.pricing.recommendedUnit,
    marketUnit,
    market,
    profitPerHour: market && h && h.gt(0) ? market.result.div(h) : null,
  };
}

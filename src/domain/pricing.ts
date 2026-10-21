/**
 * Formação de preço de venda — função pura.
 *
 *   alíquotas (r)  = tributos + comissão + taxa de pagamento + outros (fração da receita)
 *   taxa fixa (F)  = taxa fixa do canal por pedido
 *
 *   k              = markup desejado (fração) — lucro sobre o CUSTO TOTAL
 *
 *   Preço mínimo (pedido)      = (custos diretos + F) ÷ (1 − r)
 *        → cobre custos incrementais e encargos; NÃO cobre a estrutura.
 *   Preço sugerido (pedido)    = (custo total × (1 + k) + F) ÷ (1 − r)
 *        → o markup incide sobre o custo e os encargos do canal são somados
 *          por fora, de modo que, depois de pagar as taxas, sobra exatamente
 *          custo × k de lucro.
 *   Preço premium (unidade)    = sugerido arredondado + valor agregado justificado.
 *
 *   Margem de contribuição = receita − custos variáveis (diretos + encargos)
 *   Lucro (resultado)      = margem de contribuição − estrutura
 *   Markup (%)             = lucro ÷ custo total          (o que foi pedido nos parâmetros)
 *   Margem sobre a venda   = lucro ÷ receita              (sempre menor que o markup)
 */
import type { CostParams, QuoteInput, RoundingRule } from './types';
import type { CostResult } from './costing';
import { D, Decimal, Dn, ONE, ZERO, cents } from './money';

export const ROUNDING_LABEL: Record<RoundingRule, string> = {
  nenhum: 'Sem arredondamento (centavos)', final90: 'Final ,90', final99: 'Final ,99', inteiro: 'Real inteiro', meio: 'Múltiplo de R$ 0,50',
};

/** Arredondamento comercial sempre PARA CIMA, para não corroer a margem. */
export function roundPrice(price: Decimal, rule: RoundingRule): Decimal {
  if (price.lte(0)) return cents(price);
  const up = (d: Decimal, step: Decimal) => d.div(step).toDecimalPlaces(0, Decimal.ROUND_CEIL).times(step);
  switch (rule) {
    case 'nenhum': return price.toDecimalPlaces(2, Decimal.ROUND_CEIL);
    case 'inteiro': return price.toDecimalPlaces(0, Decimal.ROUND_CEIL);
    case 'meio': return up(price, D('0.5'));
    case 'final90':
    case 'final99': {
      const tail = D(rule === 'final90' ? '0.90' : '0.99');
      let candidate = price.floor().plus(tail);
      if (candidate.lt(price)) candidate = candidate.plus(1);
      return candidate;
    }
  }
}

export interface ChannelRates { name: string; rates: Decimal; fixedFee: Decimal }

export function channelRates(channel: CostParams['channel']): ChannelRates | null {
  if (!channel) return null;
  const rates = [channel.taxPct, channel.commissionPct, channel.paymentFeePct, channel.otherPct].reduce((a, v) => a.plus(D(v)), ZERO).div(100);
  return { name: channel.name, rates, fixedFee: D(channel.fixedFeePerOrder) };
}

export interface PriceAnalysis {
  unitPrice: Decimal;
  discountPct: Decimal;
  effectiveUnitPrice: Decimal;
  revenue: Decimal;
  fees: Decimal;
  variableCosts: Decimal;
  contributionMargin: Decimal;
  contributionPct: Decimal | null;
  structure: Decimal;
  result: Decimal;
  marginPct: Decimal | null;
  markupPct: Decimal | null;
  coversStructure: boolean;
}

/** Analisa o resultado de vender o pedido a um preço unitário (antes do desconto). */
export function analyzeAtPrice(unitPrice: Decimal, costs: Pick<CostResult, 'direct' | 'structure' | 'quantity'>, ch: ChannelRates, discountPct: Decimal = ZERO): PriceAnalysis {
  if (discountPct.isNegative() || discountPct.gte(100)) throw new Error('Desconto deve estar entre 0 e 100%.');
  const q = D(costs.quantity);
  const effectiveUnitPrice = cents(unitPrice.times(ONE.minus(discountPct.div(100))));
  const revenue = effectiveUnitPrice.times(q);
  const fees = revenue.times(ch.rates).plus(ch.fixedFee);
  const variableCosts = costs.direct.plus(fees);
  const contributionMargin = revenue.minus(variableCosts);
  const result = contributionMargin.minus(costs.structure);
  const totalCost = costs.direct.plus(costs.structure);
  return {
    unitPrice, discountPct, effectiveUnitPrice, revenue, fees, variableCosts, contributionMargin,
    contributionPct: revenue.isZero() ? null : contributionMargin.div(revenue),
    structure: costs.structure, result,
    marginPct: revenue.isZero() ? null : result.div(revenue),
    markupPct: totalCost.isZero() ? null : result.div(totalCost),
    coversStructure: result.gte(0),
  };
}

export interface PricingResult {
  channel: ChannelRates | null;
  errors: string[];
  minimumUnit: Decimal | null;
  recommendedUnit: Decimal | null;
  recommendedRoundedUnit: Decimal | null;
  premiumUnit: Decimal | null;
  premiumJustification: string | null;
  selectedUnit: Decimal | null;
  selectedSource: 'recomendado' | 'manual' | null;
  analysis: PriceAnalysis | null;
  minimumAnalysis: PriceAnalysis | null;
  marketAnalysis: PriceAnalysis | null;
}

export function computePricing(input: QuoteInput, params: CostParams, costs: CostResult): PricingResult {
  const errors: string[] = [];
  const ch = channelRates(params.channel);
  const q = D(costs.quantity);
  const discount = D(input.discountPct ?? '0');
  const empty: PricingResult = {
    channel: ch, errors, minimumUnit: null, recommendedUnit: null, recommendedRoundedUnit: null, premiumUnit: null,
    premiumJustification: null, selectedUnit: null, selectedSource: null, analysis: null, minimumAnalysis: null, marketAnalysis: null,
  };
  if (!ch) { errors.push('Selecione o canal de venda para calcular tributos e taxas.'); return empty; }
  if (ch.rates.gte(1)) { errors.push('A soma dos encargos do canal é igual ou superior a 100% da receita.'); return empty; }

  const minimumOrder = costs.direct.plus(ch.fixedFee).div(ONE.minus(ch.rates));
  const minimumUnit = minimumOrder.div(q).toDecimalPlaces(2, Decimal.ROUND_CEIL);

  let recommendedUnit: Decimal | null = null;
  let recommendedRoundedUnit: Decimal | null = null;
  const k = Dn(input.markupPct);
  if (k === null) errors.push('Defina o markup (em Parâmetros de Custos ou neste orçamento) para obter o preço sugerido.');
  else if (k.isNegative()) errors.push('O markup não pode ser negativo.');
  else {
    recommendedUnit = costs.total.times(ONE.plus(k.div(100))).plus(ch.fixedFee).div(ONE.minus(ch.rates)).div(q);
    recommendedRoundedUnit = roundPrice(recommendedUnit, input.rounding);
  }

  let premiumUnit: Decimal | null = null;
  const premAmount = Dn(input.premium.amountPerUnit);
  const just = input.premium.justification.trim();
  if (premAmount && premAmount.gt(0) && recommendedRoundedUnit) {
    if (!just) errors.push('O preço premium exige uma justificativa comercial (personalização, acabamento, exclusividade...).');
    else premiumUnit = roundPrice(recommendedRoundedUnit.plus(premAmount), input.rounding);
  }

  const manual = Dn(input.manualPriceUnit);
  const selectedUnit = manual && manual.gt(0) ? manual : recommendedRoundedUnit;
  const selectedSource = manual && manual.gt(0) ? 'manual' : recommendedRoundedUnit ? 'recomendado' : null;
  const market = Dn(input.marketPriceUnit);

  return {
    channel: ch, errors, minimumUnit, recommendedUnit, recommendedRoundedUnit, premiumUnit,
    premiumJustification: premiumUnit ? just : null, selectedUnit, selectedSource,
    analysis: selectedUnit ? analyzeAtPrice(selectedUnit, costs, ch, discount) : null,
    minimumAnalysis: analyzeAtPrice(minimumUnit, costs, ch),
    marketAnalysis: market && market.gt(0) ? analyzeAtPrice(market, costs, ch, discount) : null,
  };
}

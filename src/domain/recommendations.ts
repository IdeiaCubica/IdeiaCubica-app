/**
 * Sugestões iniciais de parâmetros para a operação com uma Bambu Lab A1.
 *
 * Cada valor traz a origem: "informado" (dado da empresa), "fabricante"
 * (publicação da Bambu Lab) ou "estimativa" (ponto de partida a calibrar com
 * os dados reais). Nada aqui é aplicado sem ação explícita do usuário.
 */
import { D, Decimal } from './money';

export type RecSource = 'informado' | 'fabricante' | 'estimativa';
export interface Recommendation {
  key: string;
  label: string;
  value: string;            // valor sugerido (decimal canônico)
  unit: string;
  source: RecSource;
  why: string;
}

export const A1_ACQUISITION = '4769.10';
export const A1_RESIDUAL_PCT = '20';
export const A1_LIFE_HOURS = 6000;

/** Depreciação por hora = (aquisição − residual) ÷ vida útil. */
export function a1Depreciation(acq: Decimal.Value = A1_ACQUISITION, residualPct: Decimal.Value = A1_RESIDUAL_PCT, lifeHours = A1_LIFE_HOURS) {
  const residual = D(acq).times(residualPct).div(100);
  return { residual, perHour: D(acq).minus(residual).div(lifeHours) };
}

export function printerRecommendations(): Recommendation[] {
  const dep = a1Depreciation();
  return [
    { key: 'acquisitionValue', label: 'Valor de aquisição', value: A1_ACQUISITION, unit: 'R$', source: 'informado', why: 'Valor pago pela Bambu Lab A1.' },
    { key: 'residualValue', label: 'Valor residual', value: dep.residual.toDecimalPlaces(2).toString(), unit: 'R$', source: 'estimativa', why: `${A1_RESIDUAL_PCT}% do valor pago: quanto se espera obter vendendo a impressora usada ao fim da vida útil.` },
    { key: 'usefulLifeHours', label: 'Vida útil', value: String(A1_LIFE_HOURS), unit: 'h de impressão', source: 'estimativa', why: 'Ponto de partida conservador para uma impressora de bancada com manutenção em dia. Revise conforme o desgaste real.' },
    { key: 'depreciation', label: '→ Depreciação resultante', value: dep.perHour.toDecimalPlaces(4).toString(), unit: 'R$/h', source: 'estimativa', why: `(R$ 4.769,10 − R$ ${dep.residual.toFixed(2).replace('.', ',')}) ÷ ${A1_LIFE_HOURS} h.` },
    { key: 'kwhPerHour', label: 'Consumo de energia', value: '0.095', unit: 'kWh/h', source: 'fabricante', why: 'Média publicada pela Bambu Lab para a A1 imprimindo PLA (~95 W). Meça com uma tomada medidora para trocar "estimado" por "medido".' },
    { key: 'maintenancePerHour', label: 'Manutenção e desgaste', value: '0.20', unit: 'R$/h', source: 'estimativa', why: 'Cobre bico/hotend, mesa PEI, correias e lubrificação. Calibre somando o que gastar em peças em 6 meses ÷ horas impressas no período.' },
    { key: 'availableHoursPerMonth', label: 'Horas disponíveis por mês', value: '300', unit: 'h', source: 'estimativa', why: '~10 h/dia × 30 dias. Usado só para medir a taxa de utilização.' },
  ];
}

export function generalRecommendations(): Recommendation[] {
  return [
    { key: 'energyTariff', label: 'Tarifa de energia', value: '0.95', unit: 'R$/kWh', source: 'estimativa', why: 'Use o valor da SUA conta: total pago ÷ kWh consumidos (já inclui impostos e bandeira). Tarifas residenciais costumam ficar perto de R$ 0,80–1,10/kWh.' },
    { key: 'laborHourCost', label: 'Custo da hora de trabalho', value: '30', unit: 'R$/h', source: 'estimativa', why: 'Defina pela renda que você quer tirar ÷ horas trabalhadas no mês. Ex.: R$ 4.800 ÷ 160 h = R$ 30/h.' },
    { key: 'productiveHoursPerMonth', label: 'Horas produtivas de máquina por mês', value: '150', unit: 'h', source: 'estimativa', why: 'Horas que a impressora realmente imprime (≈ 5 h/dia). Quanto menor, maior o rateio das despesas fixas por peça — comece conservador.' },
    { key: 'defaultMarkupPct', label: 'Markup', value: '100', unit: '%', source: 'estimativa', why: 'Lucro igual ao custo (preço ≈ 2× custo + taxas do canal), equivalente a ~50% de margem sobre a venda. Ajuste comparando com o preço de mercado de cada peça.' },
    { key: 'defaultFailureRatePct', label: 'Taxa de falha esperada', value: '5', unit: '%', source: 'estimativa', why: 'Provisória até haver histórico: depois de algumas ordens concluídas o sistema calcula a taxa real.' },
    { key: 'defaultLaborOrderMin', label: 'Mão de obra por orçamento', value: '15', unit: 'min', source: 'estimativa', why: 'Atender, preparar o arquivo e fatiar.' },
    { key: 'defaultLaborUnitMin', label: 'Mão de obra por peça', value: '5', unit: 'min', source: 'estimativa', why: 'Retirar da mesa, limpar suportes e embalar. Aumente para peças com acabamento ou montagem.' },
    { key: 'defaultRounding', label: 'Arredondamento', value: 'final90', unit: '', source: 'estimativa', why: 'Preços terminados em ,90 (sempre para cima, sem perder margem).' },
  ];
}

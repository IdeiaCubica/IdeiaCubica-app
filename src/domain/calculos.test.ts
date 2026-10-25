/** Testes dos cálculos puros: custo, energia, depreciação, rateio, perdas, preço e margem. */
import { describe, expect, it } from 'vitest';
import { D, splitInstallments, parseBR } from './money';
import { unitAcquisitionCost, allocate } from './purchases';
import { depreciationPerHour } from './catalog';
import { computeCosts, componentValue } from './costing';
import { analyzeAtPrice, commercialRound, computePricing, roundPrice } from './pricing';
import { emptyQuoteInput } from './quotes';
import { createEmptyDB } from './schema';
import type { CostParams, QuoteInput } from './types';

const settings = createEmptyDB().settings;

function params(over: Partial<CostParams> = {}): CostParams {
  return {
    capturedAt: '2026-01-01T00:00:00Z',
    lots: {
      pretoA: { label: 'Preto A', unitCost: '0.10', unit: 'g', materialId: 'mA' },
      pretoB: { label: 'Preto B', unitCost: '0.09', unit: 'g', materialId: 'mB' },
      caixa: { label: 'Caixa', unitCost: '1.50', unit: 'un', materialId: 'mC' },
    },
    printer: { id: 'p1', name: 'A1', depreciationPerHour: '0.5', kwhPerHour: '0.1', energyMode: 'medido', maintenancePerHour: '0.2' },
    energyTariff: '1.00',
    laborHourCost: '30',
    overheadPerMachineHour: '1',
    overheadBasis: 'teste',
    channel: { id: 'c1', name: 'Direto', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0' },
    ...over,
  };
}

function input(over: Partial<QuoteInput> = {}): QuoteInput {
  return {
    ...emptyQuoteInput(settings),
    materials: [{ materialId: 'mA', lotId: 'pretoA', qtyPerUnit: 30 }],
    printHoursPerUnit: 2,
    printerId: 'p1',
    failureRatePct: '0',
    markupPct: '30',
    ...over,
  };
}

describe('Precisão e utilidades', () => {
  it('parseBR aceita formatos brasileiro e internacional', () => {
    expect(parseBR('1.234,56')!.toString()).toBe('1234.56');
    expect(parseBR('12,5')!.toString()).toBe('12.5');
    expect(parseBR('0.1')!.toString()).toBe('0.1');
    expect(parseBR('R$ 10,00')!.toString()).toBe('10');
    expect(parseBR('abc')).toBeNull();
    expect(parseBR('')).toBeNull();
  });
  it('não sofre erro de ponto flutuante', () => {
    expect(D(0.1).plus(0.2).toString()).toBe('0.3');
  });
  it('parcelas somam exatamente o total', () => {
    const p = splitInstallments(D('100'), 3);
    expect(p.map(String)).toEqual(['33.33', '33.33', '33.34']);
  });
});

describe('Custo por grama', () => {
  it('R$ 100 + R$ 10 de frete / 1000 g = R$ 0,11/g', () => {
    expect(unitAcquisitionCost('100', '10', '0', 1000).toString()).toBe('0.11');
  });
  it('rejeita quantidade zero', () => {
    expect(() => unitAcquisitionCost('100', '0', '0', 0)).toThrow();
  });
  it('rateio de frete proporcional com centavos exatos', () => {
    const parts = allocate(D('10'), [D('100'), D('50'), D('50')]);
    expect(parts.map(String)).toEqual(['5', '2.5', '2.5']);
    const odd = allocate(D('10'), [D('1'), D('1'), D('1')]);
    expect(odd.reduce((a, b) => a.plus(b)).toString()).toBe('10');
  });
});

describe('Materiais', () => {
  it('usa o custo do lote selecionado (Preto A vs Preto B)', () => {
    expect(componentValue(computeCosts(input(), params()), 'material')!.toString()).toBe('3');
    const b = computeCosts(input({ materials: [{ materialId: 'mB', lotId: 'pretoB', qtyPerUnit: 30 }] }), params());
    expect(componentValue(b, 'material')!.toString()).toBe('2.7');
  });
  it('soma múltiplos filamentos', () => {
    const r = computeCosts(input({ materials: [{ materialId: 'mA', lotId: 'pretoA', qtyPerUnit: 30 }, { materialId: 'mB', lotId: 'pretoB', qtyPerUnit: 10 }], quantity: 2 }), params());
    // (30×0,10 + 10×0,09) × 2 = 7,80
    expect(componentValue(r, 'material')!.toString()).toBe('7.8');
  });
  it('não aplica perda quando o consumo informado já é o total do fatiador', () => {
    const r = computeCosts(input({ consumptionBasis: 'total', wastePct: '10' }), params());
    expect(componentValue(r, 'material')!.toString()).toBe('3');
  });
  it('aplica perda apenas quando o consumo é somente da peça', () => {
    const r = computeCosts(input({ consumptionBasis: 'peca', wastePct: '10' }), params());
    expect(componentValue(r, 'material')!.toString()).toBe('3.3');
  });
  it('perda não informada em base "peça" deixa o orçamento pendente', () => {
    const r = computeCosts(input({ consumptionBasis: 'peca', wastePct: null }), params());
    expect(r.complete).toBe(false);
  });
});

describe('Preço do filamento e ajustes manuais', () => {
  it('sem lote, usa o custo do material pela política (params.materials)', () => {
    const p = params({ materials: { mA: { label: 'Preto A', unitCost: '0.12', unit: 'g', source: 'última compra' } } });
    const r = computeCosts(input({ materials: [{ materialId: 'mA', qtyPerUnit: 10 }] }), p);
    expect(componentValue(r, 'material')!.toString()).toBe('1.2');
    expect(r.materialLines[0].source).toBe('última compra');
  });
  it('o preço do filamento não pode ser alterado no orçamento (ajuste da rubrica é ignorado)', () => {
    const r = computeCosts(input({ overrides: { material: '99' } }), params());
    const c = r.components.find((x) => x.key === 'material')!;
    expect(c.value!.toString()).toBe('3');
    expect(c.status).toBe('ok');
  });
  it('material sem preço fica pendente', () => {
    const p = params({ materials: { mX: { label: 'Novo', unitCost: null, unit: 'g', source: 'sem preço' } } });
    const r = computeCosts(input({ materials: [{ materialId: 'mX', qtyPerUnit: 10 }] }), p);
    expect(r.complete).toBe(false);
    expect(r.pending.join(' ')).toMatch(/Sem preço/);
  });
  it('rubrica ajustada substitui o calculado, mantém o calculado visível e entra no total', () => {
    const r = computeCosts(input({ overrides: { energia: '5' } }), params());
    const c = r.components.find((x) => x.key === 'energia')!;
    expect(c.status).toBe('ajustado');
    expect(c.value!.toString()).toBe('5');
    expect(c.calculated!.toString()).toBe('0.2');
    expect(r.total.toString()).toBe(r.components.reduce((a, x) => a.plus(x.value ?? 0), D(0)).toString());
  });
  it('ajuste manual resolve a pendência daquela rubrica', () => {
    const r = computeCosts(input({ overrides: { energia: '1' } }), params({ energyTariff: null }));
    expect(r.pending.join(' ')).not.toMatch(/Tarifa/);
  });
  it('ajuste negativo é bloqueado', () => {
    expect(() => computeCosts(input({ overrides: { mao_obra: '-1' } }), params())).toThrow();
  });
});

describe('Energia, depreciação e manutenção', () => {
  it('energia = horas × kWh/h × tarifa', () => {
    // 2 h × 0,1 kWh/h × R$ 1,00
    const r = computeCosts(input(), params());
    expect(componentValue(r, 'energia')!.toString()).toBe('0.2');
    expect(r.components.find((c) => c.key === 'energia')!.status).toBe('ok');
  });
  it('energia por potência estimada é marcada como estimada', () => {
    const p = params();
    p.printer!.energyMode = 'estimado';
    const r = computeCosts(input(), p);
    expect(r.components.find((c) => c.key === 'energia')!.status).toBe('estimado');
  });
  it('tarifa ausente → pendente, sem assumir zero', () => {
    const r = computeCosts(input(), params({ energyTariff: null }));
    expect(componentValue(r, 'energia')).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.pending.join(' ')).toMatch(/Tarifa de energia/);
  });
  it('depreciação por hora = (aquisição − residual) / vida útil', () => {
    expect(depreciationPerHour({ acquisitionValue: '5000', residualValue: '1000', usefulLifeHours: 8000 })!.toString()).toBe('0.5');
    expect(depreciationPerHour({ acquisitionValue: '5000', residualValue: null, usefulLifeHours: null })).toBeNull();
  });
  it('depreciação e manutenção por hora de máquina', () => {
    const r = computeCosts(input({ quantity: 3 }), params());
    expect(componentValue(r, 'depreciacao')!.toString()).toBe('3'); // 6 h × 0,5
    expect(componentValue(r, 'manutencao')!.toString()).toBe('1.2'); // 6 h × 0,2
  });
});

describe('Rateio de custos indiretos', () => {
  it('horas de máquina × taxa por hora, no grupo estrutura', () => {
    const r = computeCosts(input(), params({ overheadPerMachineHour: '2.5' }));
    const c = r.components.find((x) => x.key === 'indiretos')!;
    expect(c.value!.toString()).toBe('5');
    expect(c.group).toBe('estrutura');
    expect(r.structure.toString()).toBe('5');
  });
  it('sem rateio configurado → pendente', () => {
    const r = computeCosts(input(), params({ overheadPerMachineHour: null }));
    expect(r.complete).toBe(false);
  });
});

describe('Falhas e mão de obra', () => {
  it('falha incide só sobre custos de impressão: base × f/(1−f)', () => {
    // base = material 3 + energia 0,2 + depreciação 1 + manutenção 0,4 = 4,6; f = 20% → 4,6 × 0,25 = 1,15
    const r = computeCosts(input({ failureRatePct: '20', labor: { perOrder: 0, perUnit: 60 } }), params());
    expect(componentValue(r, 'falhas')!.toString()).toBe('1.15');
    expect(componentValue(r, 'mao_obra')!.toString()).toBe('30'); // não é afetada pela falha
  });
  it('falha não informada → pendente', () => {
    expect(computeCosts(input({ failureRatePct: null }), params()).complete).toBe(false);
  });
  it('mão de obra separa minutos por pedido e por unidade', () => {
    const labor = { perOrder: 30, perUnit: 6 };
    const r = computeCosts(input({ quantity: 10, labor }), params());
    // (30 + 6×10) / 60 = 1,5 h × 30 = 45
    expect(componentValue(r, 'mao_obra')!.toString()).toBe('45');
  });
  it('tempo de impressão não vira mão de obra', () => {
    const r = computeCosts(input({ printHoursPerUnit: 10 }), params());
    expect(componentValue(r, 'mao_obra')!.toString()).toBe('0');
    expect(r.warnings.join(' ')).toMatch(/mão de obra/);
  });
});

describe('Formação de preço e margem', () => {
  const costs = { direct: D(50), structure: D(0), quantity: 1 };
  const direct = { name: 'Direto', rates: D(0), fixedFee: D(0) };

  it('markup ≠ margem: custo 50, preço 100 → margem 50%, markup 100%', () => {
    const a = analyzeAtPrice(D(100), costs, direct);
    expect(a.marginPct!.toString()).toBe('0.5');
    expect(a.markupPct!.toString()).toBe('1');
  });
  it('margem de contribuição = receita − custos variáveis (inclui taxas)', () => {
    const a = analyzeAtPrice(D(100), costs, { name: 'MP', rates: D('0.2'), fixedFee: D(5) });
    // 100 − (50 + 20 + 5) = 25
    expect(a.contributionMargin.toString()).toBe('25');
    expect(a.contributionPct!.toString()).toBe('0.25');
  });
  it('preço por markup: (custo × (1 + markup) + taxa fixa) ÷ (1 − encargos)', () => {
    const p = params({ overheadPerMachineHour: '0', channel: { id: 'c', name: 'MP', taxPct: '6', commissionPct: '14', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '5' } });
    const i = input({ markupPct: '30' });
    const c = computeCosts(i, p);
    const pr = computePricing(i, p, c);
    const expected = c.total.times('1.3').plus(5).div(D(1).minus('0.2'));
    expect(pr.recommendedUnit!.toString()).toBe(expected.toString());
    // No preço sugerido (cobrado em centavos), depois de pagar as taxas, o lucro ≈ custo × markup
    const a = analyzeAtPrice(pr.recommendedUnit!, c, pr.channel!);
    expect(a.result.minus(c.total.times('0.3')).abs().lt('0.01')).toBe(true);
    expect(a.markupPct!.minus('0.3').abs().lt('0.005')).toBe(true);
    // e a margem sobre a venda é menor que o markup
    expect(a.marginPct!.lt(a.markupPct!)).toBe(true);
  });
  it('exemplo clássico: custo 50, markup 100%, sem taxas → preço 100, margem 50%', () => {
    const p = params({ channel: { id: 'c', name: 'D', taxPct: '0', commissionPct: '0', paymentFeePct: '0', otherPct: '0', fixedFeePerOrder: '0' } });
    const pr = computePricing(input({ markupPct: '100' }), p, { ...computeCosts(input(), p), direct: D(50), structure: D(0), total: D(50), quantity: 1 } as never);
    expect(pr.recommendedUnit!.toString()).toBe('100');
    expect(pr.analysis!.marginPct!.toString()).toBe('0.5');
    expect(pr.analysis!.markupPct!.toString()).toBe('1');
  });
  it('markup ausente ou negativo não gera preço sugerido', () => {
    const p = params();
    expect(computePricing(input({ markupPct: null }), p, computeCosts(input(), p)).errors.join(' ')).toMatch(/markup/);
    expect(computePricing(input({ markupPct: '-5' }), p, computeCosts(input(), p)).recommendedUnit).toBeNull();
  });
  it('preço mínimo cobre custos diretos e encargos, mas não a estrutura', () => {
    const p = params({ overheadPerMachineHour: '10' });
    const i = input();
    const c = computeCosts(i, p);
    const pr = computePricing(i, p, c);
    expect(pr.minimumAnalysis!.contributionMargin.gte(0)).toBe(true);
    expect(pr.minimumAnalysis!.coversStructure).toBe(false);
  });
  it('sem canal → não calcula preço', () => {
    const p = params({ channel: null });
    const i = input();
    expect(computePricing(i, p, computeCosts(i, p)).errors[0]).toMatch(/canal/);
  });
  it('premium exige justificativa', () => {
    const p = params();
    const i = input({ premium: { amountPerUnit: '10', justification: '' } });
    const pr = computePricing(i, p, computeCosts(i, p));
    expect(pr.premiumUnit).toBeNull();
    const i2 = input({ premium: { amountPerUnit: '10', justification: 'Pintura à mão' } });
    expect(computePricing(i2, p, computeCosts(i2, p)).premiumUnit).not.toBeNull();
  });
  it('desconto reduz receita e margem', () => {
    const a = analyzeAtPrice(D(100), costs, direct, D(10));
    expect(a.effectiveUnitPrice.toString()).toBe('90');
    expect(a.result.toString()).toBe('40');
  });
});

describe('Arredondamento comercial', () => {
  it('sempre para cima', () => {
    expect(roundPrice(D('47.23'), 'final90').toString()).toBe('47.9');
    expect(roundPrice(D('47.95'), 'final90').toString()).toBe('48.9');
    expect(roundPrice(D('47.23'), 'final99').toString()).toBe('47.99');
    expect(roundPrice(D('47.01'), 'inteiro').toString()).toBe('48');
    expect(roundPrice(D('47.01'), 'meio').toString()).toBe('47.5');
    expect(roundPrice(D('47.001'), 'nenhum').toString()).toBe('47.01');
    expect(roundPrice(D('47.90'), 'final90').toString()).toBe('47.9');
  });
  it('limite de +5%: peça barata não é distorcida; preço maior mantém o final ,90', () => {
    expect(commercialRound(D('2.05'), 'final90')).toEqual({ value: D('2.05'), limited: true });
    expect(commercialRound(D('2.051'), 'final90').value.toString()).toBe('2.06');
    expect(commercialRound(D('47.23'), 'final90')).toEqual({ value: D('47.9'), limited: false });
    expect(commercialRound(D('8.6'), 'final90').value.toString()).toBe('8.9'); // +3,5%: dentro do limite
  });
  it('markup e margem são recalculados no preço arredondado', () => {
    const p = params({ overheadPerMachineHour: '0' });
    const i = input({ rounding: 'final90', markupPct: '30' });
    const c = computeCosts(i, p);
    const pr = computePricing(i, p, c);
    expect(pr.recommendedRoundedUnit!.gte(pr.recommendedUnit!)).toBe(true);
    expect(pr.analysis!.markupPct!.gte('0.3')).toBe(true);
  });
});

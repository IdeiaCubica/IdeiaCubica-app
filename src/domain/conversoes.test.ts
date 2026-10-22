/** Auditoria das conversões de interface: tempo, preço por kg/g e energia. */
import { describe, expect, it } from 'vitest';
import { fmtDuration, hmToHours, hoursToHM, parseDuration, perGramToPerKg, perKgToPerGram, wattsToKwhPerHour } from './conversions';
import { computeCosts, componentValue } from './costing';
import { emptyQuoteInput } from './quotes';
import { createEmptyDB } from './schema';
import { D, parseBR, toInputBR } from './money';
import { a1Depreciation } from './recommendations';
import { quotePackage } from './shipping';

describe('Tempo de produção', () => {
  it('1 h 20 min = 1,3333 h (e não 1,2 h nem 24 min)', () => {
    expect(hmToHours(1, 20)).toBeCloseTo(1.333333, 5);
    expect(hoursToHM(hmToHours(1, 20))).toEqual({ h: 1, m: 20 });
    expect(fmtDuration(hmToHours(1, 20))).toBe('1 h 20 min');
  });
  it('ida e volta é exata para todos os minutos de 0 a 59 em várias horas', () => {
    for (let h = 0; h <= 30; h++) for (let m = 0; m < 60; m++) expect(hoursToHM(hmToHours(h, m))).toEqual({ h, m });
  });
  it('arredonda ao minuto com "vai um"', () => {
    expect(hoursToHM(1.9999)).toEqual({ h: 2, m: 0 });
    expect(hoursToHM(0.5)).toEqual({ h: 0, m: 30 });
    expect(hoursToHM(-1)).toBeNull();
  });
  it('lê durações sem ambiguidade e rejeita número solto', () => {
    expect(parseDuration('1:20')).toBeCloseTo(4 / 3, 6);
    expect(parseDuration('1h20')).toBeCloseTo(4 / 3, 6);
    expect(parseDuration('1h 20min')).toBeCloseTo(4 / 3, 6);
    expect(parseDuration('80min')).toBeCloseTo(4 / 3, 6);
    expect(parseDuration('2h')).toBe(2);
    expect(parseDuration('45m')).toBe(0.75);
    expect(parseDuration('1,20')).toBeNull();
    expect(parseDuration('1:75')).toBeNull();
  });
  it('custo de máquina usa o tempo corretamente: 1 h 20 min × R$ 0,40/h = R$ 0,5333', () => {
    const settings = createEmptyDB().settings;
    const input = { ...emptyQuoteInput(settings), materials: [], printHoursPerUnit: hmToHours(1, 20), failureRatePct: '0' };
    const r = computeCosts(input, {
      capturedAt: '', lots: {}, energyTariff: '1', laborHourCost: '30', overheadPerMachineHour: '0', overheadBasis: '', channel: null,
      printer: { id: 'p', name: 'A1', depreciationPerHour: '0.4', kwhPerHour: '0.1', energyMode: 'medido', maintenancePerHour: '0' },
    });
    expect(componentValue(r, 'depreciacao')!.toDecimalPlaces(4).toString()).toBe('0.5333');
    expect(r.machineHours!.toDecimalPlaces(4).toString()).toBe('1.3333');
  });
});

describe('Recomendações da A1', () => {
  it('depreciação: (4.769,10 − 20%) ÷ 6.000 h = R$ 0,63588/h', () => {
    const d = a1Depreciation();
    expect(d.residual.toString()).toBe('953.82');
    expect(d.perHour.toDecimalPlaces(5).toString()).toBe('0.63588');
  });
});

describe('Pacote para frete', () => {
  it('peso = filamento por peça × quantidade + embalagem, em kg arredondado para cima', () => {
    const db = createEmptyDB();
    db.settings.shippingBox = { lengthCm: 20, widthCm: 15, heightCm: 10, packagingWeightG: 80 };
    db.materials.push({ id: 'f', unit: 'g' } as never);
    const r = quotePackage(db, { quantity: 3, materials: [{ materialId: 'f', qtyPerUnit: 45.5 }] });
    expect(r.piecesG).toBe(136.5);
    expect(r.pkg).toEqual({ weightKg: 0.217, lengthCm: 20, widthCm: 15, heightCm: 10 });
  });
  it('cada orçamento tem a sua caixa e CEP de saída; novo orçamento parte do padrão', () => {
    const db = createEmptyDB();
    db.settings.shippingBox = { lengthCm: 20, widthCm: 15, heightCm: 10, packagingWeightG: 80 };
    db.settings.companyAddress = { cep: '01001-000' };
    db.materials.push({ id: 'f', unit: 'g' } as never);
    const input = emptyQuoteInput(db.settings);
    expect(input.shipping).toEqual({ originCep: '01001000', destCep: null, lengthCm: 20, widthCm: 15, heightCm: 10, packagingWeightG: 80 });
    input.materials = [{ materialId: 'f', qtyPerUnit: 300 }];
    input.shipping = { ...input.shipping!, lengthCm: 30, widthCm: 30, heightCm: 25, packagingWeightG: 150 };
    expect(quotePackage(db, input).pkg).toEqual({ weightKg: 0.45, lengthCm: 30, widthCm: 30, heightCm: 25 });
    // Mudar o padrão depois não altera a caixa já escolhida no orçamento
    db.settings.shippingBox = { lengthCm: 10, widthCm: 10, heightCm: 10, packagingWeightG: 20 };
    expect(quotePackage(db, input).pkg!.lengthCm).toBe(30);
    // Orçamento antigo, sem caixa própria, usa o padrão atual
    expect(quotePackage(db, { ...input, shipping: undefined }).pkg!.lengthCm).toBe(10);
  });
  it('aponta o que falta', () => {
    const r = quotePackage(createEmptyDB(), { quantity: 1, materials: [] });
    expect(r.pkg).toBeNull();
    expect(r.missing.join(' ')).toMatch(/peso da peça.*medidas da caixa/);
  });
});

describe('Preço de material e energia', () => {
  it('R$ 120/kg ↔ R$ 0,12/g', () => {
    expect(perKgToPerGram('120').toString()).toBe('0.12');
    expect(perGramToPerKg('0.12').toString()).toBe('120');
    expect(perGramToPerKg(perKgToPerGram('99.9')).toString()).toBe('99.9');
  });
  it('95 W → 0,095 kWh/h', () => {
    expect(wattsToKwhPerHour(95).toString()).toBe('0.095');
  });
  it('valores digitados no padrão brasileiro voltam ao campo sem perda', () => {
    for (const v of ['4769,1', '0,95', '1.234,56', '0,0005']) {
      expect(toInputBR(parseBR(v)!.toString())).toBe(parseBR(v)!.toString().replace('.', ','));
    }
    expect(D(parseBR('4.769,10')!).toString()).toBe('4769.1');
  });
});

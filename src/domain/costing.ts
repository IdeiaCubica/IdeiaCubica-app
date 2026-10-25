/**
 * Motor de custos do orçamento — função pura: (entrada, parâmetros) → custos.
 *
 * Princípios:
 * - Cada componente (rubrica) é rastreável: valor, status e fórmula aplicada.
 * - O usuário pode AJUSTAR qualquer rubrica; o valor calculado continua
 *   visível e o componente fica marcado como "ajustado".
 * - Parâmetro ausente ⇒ componente "pendente" (fora do total) e orçamento
 *   marcado como INCOMPLETO. Nada é assumido como zero silenciosamente.
 * - Sem duplicidade:
 *     · se o consumo informado já é o total do fatiador (inclui suportes,
 *       purga, brim), NÃO se aplica perda %;
 *     · a taxa de falha incide apenas sobre os custos consumidos durante a
 *       impressão (material, energia, depreciação, manutenção);
 *     · tempo de impressão ≠ mão de obra: são recursos distintos.
 * - Todos os valores são POR PEDIDO (quantidade Q); o unitário é total ÷ Q.
 */
import type { CostParams, LaborMinutes, QuoteInput } from './types';
import { D, Decimal, Dn, ONE, ZERO, fmtBRL, fmtNum, sum } from './money';

export type CompStatus = 'ok' | 'estimado' | 'pendente' | 'ajustado' | 'nao_aplicavel';
export type CompGroup = 'direto' | 'estrutura';

export interface CostComponent {
  key: string;
  label: string;
  group: CompGroup;
  value: Decimal | null;
  /** Valor calculado pelo sistema antes de eventual ajuste manual. */
  calculated: Decimal | null;
  status: CompStatus;
  formula: string;
}

export interface MaterialLineResult {
  materialId: string;
  lotId?: string;
  label: string;
  unit: string;
  qtyOrder: Decimal;
  unitCost: Decimal | null;
  cost: Decimal | null;
  source: string;
}

export interface CostResult {
  quantity: number;
  machineHours: Decimal | null;
  laborHours: Decimal;
  materialLines: MaterialLineResult[];
  components: CostComponent[];
  /** Custos diretos/incrementais do pedido (sem estrutura). */
  direct: Decimal;
  /** Rateio de estrutura e amortização de desenvolvimento. */
  structure: Decimal;
  total: Decimal;
  unitTotal: Decimal;
  pending: string[];
  warnings: string[];
  complete: boolean;
  hasEstimates: boolean;
}

/** Aceita o formato atual e o detalhado da v0.1 (orçamentos antigos). */
export function laborTotals(l: LaborMinutes | Record<string, number> | undefined): { perOrder: number; perUnit: number } {
  if (!l) return { perOrder: 0, perUnit: 0 };
  if ('perOrder' in l || 'perUnit' in l) return { perOrder: Number(l.perOrder) || 0, perUnit: Number(l.perUnit) || 0 };
  const o = l as Record<string, number>;
  const s = (keys: string[]) => keys.reduce((acc, k) => acc + (Number(o[k]) || 0), 0);
  return { perOrder: s(['arquivo', 'fatiamento', 'atendimento']), perUnit: s(['preparacao', 'retirada', 'suportes', 'acabamento', 'montagem', 'inspecao', 'embalagem']) };
}

export function computeCosts(input: QuoteInput, params: CostParams): CostResult {
  const pending: string[] = [];
  const warnings: string[] = [];
  const components: CostComponent[] = [];
  const Q = input.quantity;
  if (!Number.isInteger(Q) || Q < 1) throw new Error('A quantidade do pedido deve ser um número inteiro maior que zero.');
  const q = D(Q);
  const overrides = input.overrides ?? {};

  /**
   * Registra o componente aplicando ajuste manual, se houver. Retorna o valor final.
   * As pendências da rubrica só contam se ela NÃO foi ajustada manualmente.
   */
  const push = ({ pendingMsgs, ...c }: Omit<CostComponent, 'calculated'> & { pendingMsgs?: string[] }): Decimal | null => {
    const ov = isLockedComponent(c.key) ? null : Dn(overrides[c.key]);
    if (ov !== null) {
      if (ov.isNegative()) throw new Error(`O valor ajustado de "${c.label}" não pode ser negativo.`);
      components.push({ ...c, calculated: c.value, value: ov, status: 'ajustado',
        formula: `${c.formula} — ajustado manualmente (calculado: ${c.value ? fmtBRL(c.value) : 'pendente'}).` });
      return ov;
    }
    components.push({ ...c, calculated: c.value });
    if (c.value === null) pendingMsgs?.forEach((m) => pending.push(m));
    return c.value;
  };

  /* ---------- 1. Materiais ---------- */
  let wasteFactor = ONE;
  const matPending: string[] = [];
  if (input.consumptionBasis === 'peca') {
    const w = Dn(input.wastePct);
    if (w === null) matPending.push('Perda/estruturas auxiliares (%) não informada para consumo "somente peça".');
    else {
      if (w.isNegative() || w.gte(100)) throw new Error('Percentual de perda deve estar entre 0 e 100.');
      wasteFactor = ONE.plus(w.div(100));
    }
  }
  const materialLines: MaterialLineResult[] = input.materials.map((m) => {
    const qtyOrder = D(m.qtyPerUnit).times(q).times(wasteFactor);
    const lot = m.lotId ? params.lots[m.lotId] : undefined;
    const mat = params.materials?.[m.materialId];
    const label = lot?.label ?? mat?.label ?? 'Material não encontrado';
    const unit = lot?.unit ?? mat?.unit ?? 'g';
    // O preço do filamento vem sempre do sistema (lote/compra ou cadastro); não é digitado no orçamento.
    let unitCost: Decimal | null = null;
    let source = '';
    if (lot) { unitCost = D(lot.unitCost); source = 'lote selecionado'; }
    else if (mat?.unitCost) { unitCost = D(mat.unitCost); source = mat.source; }
    if (!unitCost) matPending.push(`Sem preço para "${label}": cadastre o preço do filamento em Cadastros → Materiais ou registre uma compra.`);
    if (m.qtyPerUnit <= 0) matPending.push(`Informe o peso por peça de "${label}".`);
    return { materialId: m.materialId, lotId: m.lotId, label, unit, qtyOrder, unitCost, cost: unitCost ? qtyOrder.times(unitCost) : null, source };
  });
  if (input.materials.length === 0) matPending.push('Nenhum filamento/insumo informado.');
  const materialCalc = matPending.length ? null : sum(materialLines.map((l) => l.cost));
  const materialCost = push({
    key: 'material', label: 'Filamento / material', group: 'direto', value: materialCalc, status: materialCalc === null ? 'pendente' : 'ok',
    formula: input.consumptionBasis === 'total'
      ? 'Σ (peso por peça × quantidade × preço do filamento). Peso do fatiador já inclui suportes/purga.'
      : `Σ (peso por peça × quantidade × (1 + perda ${fmtNum(input.wastePct)}%) × preço do filamento).`,
    pendingMsgs: matPending,
  });

  /* ---------- 2. Máquina ---------- */
  const H = input.printHoursPerUnit !== null && input.printHoursPerUnit !== undefined ? D(input.printHoursPerUnit).times(q) : null;
  const hOk = H !== null && H.gt(0);
  const hourMsg = H === null ? 'Tempo de produção não informado.' : 'Tempo de produção deve ser maior que zero.';
  const printer = params.printer;
  const tariff = Dn(params.energyTariff);

  // Energia
  const ePend: string[] = [];
  if (!hOk) ePend.push(hourMsg);
  if (!printer) ePend.push('Impressora não selecionada.');
  if (!tariff) ePend.push('Tarifa de energia (R$/kWh) não configurada em Parâmetros de Custos.');
  if (printer && printer.kwhPerHour === null) ePend.push(`Consumo de energia (kWh/h) da impressora ${printer.name} não informado.`);
  const energyCalc = ePend.length ? null : H!.times(D(printer!.kwhPerHour!)).times(tariff!);
  const energy = push({ key: 'energia', label: 'Energia elétrica', group: 'direto', value: energyCalc,
    status: energyCalc === null ? 'pendente' : printer!.energyMode === 'medido' ? 'ok' : 'estimado',
    formula: `horas × ${printer?.kwhPerHour ? fmtNum(printer.kwhPerHour, 3) : '—'} kWh/h × ${tariff ? fmtBRL(tariff, 4) : '—'}/kWh`, pendingMsgs: ePend });

  // Depreciação
  const dPend: string[] = [];
  if (!hOk) dPend.push(hourMsg);
  if (!printer) dPend.push('Impressora não selecionada.');
  else if (printer.depreciationPerHour === null) dPend.push(`Dados de depreciação da impressora ${printer.name} incompletos (valor e vida útil).`);
  const depCalc = dPend.length ? null : H!.times(D(printer!.depreciationPerHour!));
  const dep = push({ key: 'depreciacao', label: 'Depreciação da impressora', group: 'direto', value: depCalc, status: depCalc ? 'ok' : 'pendente',
    formula: `horas × ${printer?.depreciationPerHour ? fmtBRL(printer.depreciationPerHour, 4) : '—'}/h ((aquisição − residual) ÷ vida útil)`, pendingMsgs: dPend });

  // Manutenção
  const mPend: string[] = [];
  if (!hOk) mPend.push(hourMsg);
  if (!printer) mPend.push('Impressora não selecionada.');
  else if (printer.maintenancePerHour === null) mPend.push(`Custo de manutenção por hora da impressora ${printer.name} não informado.`);
  const maintCalc = mPend.length ? null : H!.times(D(printer!.maintenancePerHour!));
  const maint = push({ key: 'manutencao', label: 'Manutenção e desgaste', group: 'direto', value: maintCalc, status: maintCalc ? 'ok' : 'pendente',
    formula: `horas × ${printer?.maintenancePerHour ? fmtBRL(printer.maintenancePerHour, 4) : '—'}/h`, pendingMsgs: mPend });

  /* ---------- 3. Falhas ---------- */
  const f = Dn(input.failureRatePct);
  let failureCalc: Decimal | null = null;
  const fPend: string[] = [];
  if (f === null) fPend.push('Taxa de falha não informada (informe 0 se não espera falhas).');
  else {
    if (f.isNegative() || f.gte(90)) throw new Error('Taxa de falha deve estar entre 0 e 90%.');
    const fr = f.div(100);
    failureCalc = sum([materialCost, energy, dep, maint]).times(fr).div(ONE.minus(fr));
  }
  push({ key: 'falhas', label: 'Falhas e reimpressões', group: 'direto', value: failureCalc,
    status: failureCalc === null ? 'pendente' : input.failureSource === 'manual' ? 'estimado' : 'ok',
    formula: `(material + energia + depreciação + manutenção) × f ÷ (1 − f), f = ${f ? fmtNum(f) + '%' : '—'}`, pendingMsgs: fPend });

  /* ---------- 4. Mão de obra ---------- */
  const lab = laborTotals(input.labor);
  const laborHours = D(lab.perOrder).plus(D(lab.perUnit).times(q)).div(60);
  const laborRate = Dn(params.laborHourCost);
  const lPend: string[] = [];
  let laborCalc: Decimal | null = null;
  if (laborHours.isZero()) {
    laborCalc = ZERO;
    if (!overrides.mao_obra) warnings.push('Nenhum tempo de mão de obra informado. Confirme se não há preparação, acabamento ou embalagem.');
  } else if (!laborRate) lPend.push('Custo da hora de trabalho não configurado em Parâmetros de Custos.');
  else laborCalc = laborHours.times(laborRate);
  push({ key: 'mao_obra', label: 'Mão de obra', group: 'direto', value: laborCalc, status: laborCalc === null ? 'pendente' : 'ok',
    formula: `(${fmtNum(lab.perOrder)} min por orçamento + ${fmtNum(lab.perUnit)} min por peça × quantidade) ÷ 60 × ${laborRate ? fmtBRL(laborRate) + '/h' : '—'}`, pendingMsgs: lPend });

  /* ---------- 5. Outros custos do produto ---------- */
  if (input.extras.length) {
    const xPend: string[] = [];
    const total = sum(input.extras.map((e) => {
      const fromStock = e.materialId ? params.materials?.[e.materialId] : undefined;
      const uc = e.lotId ? (params.lots[e.lotId] ? D(params.lots[e.lotId].unitCost) : null)
        : e.materialId ? Dn(fromStock?.unitCost ?? null) : Dn(e.manualUnitCost);
      if (uc === null) {
        xPend.push(e.materialId ? `Sem preço para o complemento "${fromStock?.label ?? e.description}": registre a compra ou o preço no cadastro.` : `Custo não definido para "${e.description || e.kind}".`);
        return ZERO;
      }
      return uc.times(e.qtyPerUnit).times(q);
    }));
    push({ key: 'extras', label: 'Complementos e outros (luminária, ímã, embalagem…)', group: 'direto', value: xPend.length ? null : total, status: xPend.length ? 'pendente' : 'ok',
      formula: 'Σ (quantidade por peça × quantidade × custo unitário; complementos do estoque pelo custo da última compra)', pendingMsgs: xPend });
  }

  /* ---------- 6. Frete subsidiado ---------- */
  const freight = Dn(input.freightSubsidyPerOrder);
  if (freight && freight.gt(0)) push({ key: 'frete', label: 'Frete pago pela empresa', group: 'direto', value: freight, status: 'ok', formula: 'valor por pedido' });

  /* ---------- 6b. Kit de entrega (acessórios complementares: saquinho, cartão, adesivo…) ---------- */
  const kit = Dn(input.deliveryKitShare);
  if (kit && kit.gt(0)) push({ key: 'kit_entrega', label: 'Kit de entrega (acessórios)', group: 'direto', value: kit, status: 'ok', formula: 'parte do kit de entrega do pedido atribuída a esta peça (não aparece para o cliente)' });

  /* ---------- 7. Desenvolvimento / modelagem ---------- */
  const dev = input.development;
  if (dev.mode !== 'nenhum') {
    const devHours = D(dev.hours || 0);
    const vPend: string[] = [];
    let devCost: Decimal | null = null;
    if (devHours.gt(0) && !laborRate) vPend.push('Custo da hora de trabalho necessário para o custo de desenvolvimento.');
    else devCost = devHours.times(laborRate ?? ZERO).plus(D(dev.licenseCost ?? '0'));
    if (dev.mode === 'cobrar') {
      push({ key: 'desenvolvimento', label: 'Modelagem (cobrada neste pedido)', group: 'direto', value: devCost, status: devCost ? 'ok' : 'pendente',
        formula: 'horas de modelagem × custo da hora + direitos de uso', pendingMsgs: vPend });
    } else {
      if (!dev.expectedUnits || dev.expectedUnits <= 0) vPend.push('Informe a quantidade prevista de vendas para diluir o desenvolvimento.');
      const amort = vPend.length || !devCost ? null : devCost.div(dev.expectedUnits!).times(q);
      push({ key: 'desenvolvimento', label: 'Amortização da modelagem', group: 'estrutura', value: amort, status: amort ? 'estimado' : 'pendente',
        formula: `(horas × custo da hora + direitos) ÷ ${dev.expectedUnits ?? '—'} vendas previstas × quantidade`, pendingMsgs: vPend });
    }
  }

  /* ---------- 8. Custos indiretos (rateio) ---------- */
  const ohRate = Dn(params.overheadPerMachineHour);
  const oPend: string[] = [];
  if (!ohRate) oPend.push('Rateio de despesas indiretas não configurado (horas produtivas/mês em Parâmetros de Custos).');
  else if (!hOk) oPend.push(hourMsg);
  const ohCalc = oPend.length ? null : H!.times(ohRate!);
  push({ key: 'indiretos', label: 'Despesas indiretas rateadas', group: 'estrutura', value: ohCalc, status: ohCalc ? 'estimado' : 'pendente',
    formula: `horas × ${ohRate ? fmtBRL(ohRate, 4) + '/h' : '—'} (${params.overheadBasis})`, pendingMsgs: oPend });

  /* ---------- Totais ---------- */
  const direct = sum(components.filter((c) => c.group === 'direto').map((c) => c.value));
  const structure = sum(components.filter((c) => c.group === 'estrutura').map((c) => c.value));
  const total = direct.plus(structure);
  const uniquePending = [...new Set(pending)];
  return {
    quantity: Q, machineHours: H, laborHours, materialLines, components, direct, structure, total,
    unitTotal: total.div(q), pending: uniquePending, warnings, complete: uniquePending.length === 0,
    hasEstimates: components.some((c) => c.status === 'estimado' || c.status === 'ajustado'),
  };
}

/** Utilitário para testes e UI: valor de um componente pela chave. */
/** Rubricas cujo valor vem obrigatoriamente do cadastro e não aceitam ajuste manual (preço do filamento). */
export const isLockedComponent = (key: string) => key === 'material';

export const componentValue =(r: CostResult, key: string): Decimal | null => r.components.find((c) => c.key === key)?.value ?? null;

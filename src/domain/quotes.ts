/**
 * Orçamentos: resolução de parâmetros, versionamento e histórico.
 *
 * Cada salvamento cria uma NOVA versão imutável contendo a entrada e o
 * snapshot de todos os parâmetros usados (custos de lote, tarifa, hora de
 * trabalho, impressora, canal, rateio). Mudanças futuras de preço de filamento
 * ou de configuração nunca alteram orçamentos antigos.
 */
import type { CostParams, DB, ID, Quote, QuoteInput, QuoteStatus, Settings } from './types';
import { Decimal, ZERO } from './money';
import { assert, audit, byId, newId, nextCode, nowISO, requireText } from './core';
import { computeCosts, type CostResult } from './costing';
import { computePricing, type PricingResult } from './pricing';
import { depreciationPerHour, overheadRate } from './catalog';
import { lotLabel } from './inventory';
import { shippingDefaults } from './shipping';

/** Novo orçamento já preenchido com os padrões de Parâmetros de Custos (todos alteráveis no orçamento). */
export function emptyQuoteInput(settings: Settings): QuoteInput {
  return {
    quantity: 1,
    source: { kind: 'manual', facts: [] },
    materials: [],
    consumptionBasis: 'total',
    wastePct: null,
    printHoursPerUnit: null,
    plates: null,
    printerId: settings.defaultPrinterId ?? undefined,
    labor: { perOrder: settings.defaultLaborOrderMin ?? 0, perUnit: settings.defaultLaborUnitMin ?? 0 },
    failureRatePct: settings.defaultFailureRatePct ?? null,
    failureSource: 'manual',
    extras: [],
    freightSubsidyPerOrder: null,
    shipping: shippingDefaults(settings),
    development: { mode: 'nenhum', hours: 0, licenseCost: null, expectedUnits: null },
    channelId: settings.defaultChannelId ?? undefined,
    markupPct: settings.defaultMarkupPct ?? null,
    discountPct: null,
    marketPriceUnit: null,
    premium: { amountPerUnit: null, justification: '' },
    manualPriceUnit: null,
    rounding: settings.defaultRounding,
    overrides: {},
  };
}

/**
 * Política de custeio do material no orçamento (documentada em docs/REGRAS_DE_CALCULO.md):
 *   1. custo do lote da compra MAIS RECENTE do material (custo de aquisição real);
 *   2. se ainda não houver compra, o custo de referência informado no cadastro;
 *   3. se nenhum existir, fica pendente (o usuário pode digitar o preço no orçamento).
 */
export function materialCostPolicy(db: DB, materialId: ID): { unitCost: Decimal | null; source: string } {
  const lots = db.lots.filter((l) => l.materialId === materialId).sort((a, b) => (a.date + a.code).localeCompare(b.date + b.code));
  const last = lots[lots.length - 1];
  if (last) return { unitCost: new Decimal(last.unitCost), source: `última compra (${last.code})` };
  const mat = db.materials.find((m) => m.id === materialId);
  if (mat?.referenceCost) return { unitCost: new Decimal(mat.referenceCost), source: 'preço de referência do cadastro' };
  return { unitCost: null, source: 'sem preço' };
}

/** Normaliza linhas de orçamentos antigos (v0.1 guardava só o lote). */
function lineMaterialId(db: DB, line: { materialId?: ID; lotId?: ID }): ID | undefined {
  return line.materialId ?? db.lots.find((l) => l.id === line.lotId)?.materialId;
}

/** Monta o snapshot de parâmetros a partir do estado atual do banco. */
export function resolveParams(db: DB, input: QuoteInput): CostParams {
  const lots: CostParams['lots'] = {};
  const lotIds = [...input.materials.map((m) => m.lotId), ...input.extras.map((e) => e.lotId)].filter(Boolean) as ID[];
  for (const id of lotIds) {
    const lot = db.lots.find((l) => l.id === id);
    if (!lot) continue;
    const mat = db.materials.find((m) => m.id === lot.materialId);
    lots[id] = { label: lotLabel(db, lot), unitCost: lot.unitCost, unit: mat?.unit ?? 'un', materialId: lot.materialId };
  }
  const materials: NonNullable<CostParams['materials']> = {};
  for (const line of input.materials) {
    const id = lineMaterialId(db, line);
    const mat = db.materials.find((m) => m.id === id);
    if (!mat || materials[mat.id]) continue;
    const pol = materialCostPolicy(db, mat.id);
    materials[mat.id] = { label: `${mat.code} · ${mat.name}`, unitCost: pol.unitCost ? pol.unitCost.toString() : null, unit: mat.unit, source: pol.source };
  }
  const p = db.printers.find((x) => x.id === input.printerId);
  const dep = p ? depreciationPerHour(p) : null;
  const oh = overheadRate(db);
  const ch = db.channels.find((c) => c.id === input.channelId);
  return {
    capturedAt: nowISO(),
    lots,
    materials,
    printer: p ? { id: p.id, name: p.name, depreciationPerHour: dep ? dep.toString() : null, kwhPerHour: p.kwhPerHour, energyMode: p.energyMode, maintenancePerHour: p.maintenancePerHour } : null,
    energyTariff: db.settings.energyTariff,
    laborHourCost: db.settings.laborHourCost,
    overheadPerMachineHour: oh.rate ? oh.rate.toString() : null,
    overheadBasis: oh.basis,
    channel: ch ? { id: ch.id, name: ch.name, taxPct: ch.taxPct, commissionPct: ch.commissionPct, paymentFeePct: ch.paymentFeePct, otherPct: ch.otherPct, fixedFeePerOrder: ch.fixedFeePerOrder } : null,
  };
}

export interface QuoteEvaluation { costs: CostResult; pricing: PricingResult }

export function evaluateQuote(input: QuoteInput, params: CostParams): QuoteEvaluation {
  const costs = computeCosts(input, params);
  const pricing = computePricing(input, params, costs);
  return { costs, pricing };
}

/** Indicadores por hora de máquina: custo ÷ horas e preço ÷ horas (pedido inteiro). */
export function perHour(ev: QuoteEvaluation): { costPerHour: Decimal | null; pricePerHour: Decimal | null } {
  const h = ev.costs.machineHours;
  if (!h || h.lte(0)) return { costPerHour: null, pricePerHour: null };
  return { costPerHour: ev.costs.total.div(h), pricePerHour: ev.pricing.analysis ? ev.pricing.analysis.revenue.div(h) : null };
}

const MAX_IMAGE_CHARS = 600_000; // ~450 KB: protege o limite do armazenamento local

export function saveQuote(db: DB, meta: { quoteId?: ID; name: string; projectId?: ID; customerId?: ID; note?: string; image?: string | null }, input: QuoteInput): Quote {
  const name = requireText(meta.name, 'a descrição da peça');
  assert(Number.isInteger(input.quantity) && input.quantity >= 1, 'A quantidade deve ser um inteiro maior que zero.');
  if (meta.customerId) byId(db.parties, meta.customerId, 'Cliente');
  for (const m of input.materials) {
    byId(db.materials, m.materialId, 'Filamento/insumo');
    if (m.lotId) byId(db.lots, m.lotId, 'Lote de material');
    assert(m.qtyPerUnit > 0, 'Informe o peso por peça de cada filamento (maior que zero).');
  }
  if (meta.image) assert(meta.image.length <= MAX_IMAGE_CHARS, 'A imagem é grande demais para o armazenamento local. Use uma imagem menor.');
  const params = resolveParams(db, input);
  const ev = evaluateQuote(input, params);
  const { costs, pricing } = ev;
  const version = {
    version: 1, createdAt: nowISO(), input: structuredClone(input), params, note: meta.note,
    summary: {
      totalCost: costs.total.toString(), unitCost: costs.unitTotal.toString(),
      unitPrice: pricing.selectedUnit ? pricing.selectedUnit.toString() : null,
      orderPrice: pricing.analysis ? pricing.analysis.revenue.toString() : null,
      marginPct: pricing.analysis?.marginPct ? pricing.analysis.marginPct.toString() : null,
      markupPct: pricing.analysis?.markupPct ? pricing.analysis.markupPct.toString() : null,
      hours: costs.machineHours ? costs.machineHours.toString() : null,
      complete: costs.complete && pricing.errors.length === 0,
    },
  };
  if (meta.quoteId) {
    const q = byId(db.quotes, meta.quoteId, 'Orçamento');
    assert(q.status !== 'convertido', 'Orçamento já convertido em ordem de produção; crie um novo orçamento para alterar.');
    version.version = q.versions.length + 1;
    q.versions.push(version);
    Object.assign(q, { name, projectId: meta.projectId, customerId: meta.customerId, image: meta.image ?? null });
    audit(db, 'Orçamento revisado', `${q.number} v${version.version}`);
    return q;
  }
  const q: Quote = {
    id: newId(), number: nextCode(db, 'quote', 'ORC'), name, projectId: meta.projectId, customerId: meta.customerId,
    status: 'rascunho', createdAt: nowISO(), versions: [version], image: meta.image ?? null,
  };
  db.quotes.push(q);
  audit(db, 'Orçamento criado', `${q.number} ${name}`);
  return q;
}

export function setQuoteStatus(db: DB, quoteId: ID, status: QuoteStatus) {
  const q = byId(db.quotes, quoteId, 'Orçamento');
  assert(q.status !== 'convertido', 'Orçamento já convertido em ordem de produção.');
  assert(status !== 'convertido', 'Use "Gerar ordem de produção" para converter.');
  q.status = status;
  audit(db, 'Status do orçamento', `${q.number}: ${status}`);
}

export const latestVersion = (q: Quote) => q.versions[q.versions.length - 1];

/**
 * Taxa de falha histórica (por impressora, opcional): unidades rejeitadas ÷
 * (aprovadas + rejeitadas) nas OPs concluídas. null se não houver histórico.
 */
export function historicalFailureRate(db: DB, printerId?: ID): { ratePct: Decimal; orders: number; units: number } | null {
  let approved = ZERO, rejected = ZERO, orders = 0;
  for (const o of db.orders) {
    if (o.status !== 'concluida' || !o.actual) continue;
    if (printerId && o.printerId !== printerId) continue;
    approved = approved.plus(o.actual.qtyApproved);
    rejected = rejected.plus(o.actual.qtyRejected);
    orders++;
  }
  const units = approved.plus(rejected);
  if (units.isZero()) return null;
  return { ratePct: rejected.div(units).times(100), orders, units: units.toNumber() };
}

export const marginOf = (cost: Decimal, price: Decimal) => (price.isZero() ? null : price.minus(cost).div(price));
export const markupOf = (cost: Decimal, price: Decimal) => (cost.isZero() ? null : price.div(cost).minus(1));

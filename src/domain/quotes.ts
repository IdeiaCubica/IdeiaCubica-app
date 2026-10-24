/**
 * Orçamentos: resolução de parâmetros, versionamento e histórico.
 *
 * Cada salvamento cria uma NOVA versão imutável contendo a entrada e o
 * snapshot de todos os parâmetros usados (custos de lote, tarifa, hora de
 * trabalho, impressora, canal, rateio). Mudanças futuras de preço de filamento
 * ou de configuração nunca alteram orçamentos antigos.
 */
import type { CostParams, DB, ID, Quote, QuoteDeliveryKit, QuoteInput, QuoteItemStatus, QuoteShipping, QuoteStatus, QuoteSummary, QuoteVersion, QuoteVersionItem, Settings } from './types';
import { D, Decimal, ZERO } from './money';
import { BusinessError, assert, audit, byId, newId, nextCode, nowISO, requireText } from './core';
import { computeCosts, type CostResult } from './costing';
import { computePricing, type PricingResult } from './pricing';
import { depreciationPerHour, overheadRate } from './catalog';
import { lotLabel } from './inventory';
import { shippingDefaults } from './shipping';
import { unusualUnitCost } from './costSanity';

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

/**
 * Conferência de segurança do orçamento: aponta valores improváveis que costumam ser
 * erro de digitação (custo do filamento fora da faixa, peso ou tempo absurdos, preço
 * abaixo do custo). Não bloqueia: o usuário confere antes de enviar ao cliente.
 */
export function quoteSanity(db: DB, input: QuoteInput, params: CostParams, ev?: QuoteEvaluation): string[] {
  const out: string[] = [];
  for (const line of input.materials) {
    const id = lineMaterialId(db, line);
    const mat = db.materials.find((m) => m.id === id);
    const snap = line.lotId ? params.lots[line.lotId] : id ? params.materials?.[id] : undefined;
    const w = unusualUnitCost(mat ?? (snap ? { unit: snap.unit, filament: { materialType: '', color: '' } } : undefined), snap?.unitCost);
    if (w) out.push(`${mat ? mat.name : 'Filamento'}: ${w}${snap && 'source' in snap ? ` (origem: ${snap.source})` : ''}`);
    if (mat?.unit === 'g' && line.qtyPerUnit > 5000) out.push(`Peso de ${line.qtyPerUnit} g por peça em ${mat.name} parece alto demais. O peso é de UMA peça, em gramas.`);
  }
  if (input.printHoursPerUnit !== null && input.printHoursPerUnit > 200) out.push(`Tempo de impressão de ${input.printHoursPerUnit.toFixed(1)} h por peça parece alto demais. Confira o tempo de UMA peça.`);
  const revenue = ev?.pricing.analysis?.revenue;
  if (ev && revenue && revenue.lt(ev.costs.total)) out.push('O valor para o cliente está abaixo do custo total: este orçamento dá prejuízo.');
  return out;
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

const MAX_IMAGE_CHARS = 600_000; // ~450 KB por imagem: protege o limite do armazenamento

export function summarize(ev: QuoteEvaluation): QuoteSummary {
  const { costs, pricing } = ev;
  return {
    totalCost: costs.total.toString(), unitCost: costs.unitTotal.toString(),
    unitPrice: pricing.selectedUnit ? pricing.selectedUnit.toString() : null,
    orderPrice: pricing.analysis ? pricing.analysis.revenue.toString() : null,
    marginPct: pricing.analysis?.marginPct ? pricing.analysis.marginPct.toString() : null,
    markupPct: pricing.analysis?.markupPct ? pricing.analysis.markupPct.toString() : null,
    hours: costs.machineHours ? costs.machineHours.toString() : null,
    complete: costs.complete && pricing.errors.length === 0,
  };
}

export interface QuoteItemDraft { itemId?: ID; name: string; image?: string | null; input: QuoteInput; finishedGoodId?: ID }

const sameInput = (a: QuoteInput, b: QuoteInput) => JSON.stringify({ overrides: {}, ...a }) === JSON.stringify({ overrides: {}, ...b });

/**
 * Parâmetros para exibir/recalcular uma peça. Regra única para todas as telas:
 * peça salva e não alterada usa o SNAPSHOT da versão salva (o mesmo valor da lista
 * e do documento do cliente). Só usa os custos atuais se a peça foi alterada ou se
 * o usuário pediu para atualizar os custos.
 */
export function paramsForItem(db: DB, quote: Quote | undefined, itemId: ID | undefined, input: QuoteInput, useCurrentCosts = false): CostParams {
  const saved = quote && itemId ? quoteItems(quote).find((x) => x.itemId === itemId) : undefined;
  if (saved && (!useCurrentCosts || isItemLocked(db, quote!, itemId!)) && sameInput(saved.input, input)) return saved.params;
  return resolveParams(db, input);
}

/** Peças cujo valor mudaria com os custos de hoje (filamento, parâmetros, impressora…). */
export function staleItems(db: DB, q: Quote) {
  return quoteItems(q).filter((it) => !isItemLocked(db, q, it.itemId)).map((it) => {
    let current: string | null = null;
    try { current = evaluateQuote(it.input, resolveParams(db, it.input)).pricing.analysis?.revenue.toString() ?? null; } catch { current = null; }
    return { it, saved: it.summary.orderPrice ?? null, current };
  }).filter((r) => r.saved !== r.current);
}

/**
 * Distribui o custo do kit de entrega entre as peças (pela quantidade de peças), em centavos exatos.
 * Peças travadas (em produção) mantêm a parte que já tinham; o restante vai para as demais.
 */
export function withKitShares<T extends { input: QuoteInput }>(drafts: T[], kit: QuoteDeliveryKit | null, locked: (d: T) => boolean): T[] {
  const lockedSum = drafts.filter(locked).reduce((a, d) => a.plus(D(d.input.deliveryKitShare || '0')), D(0));
  const targets = drafts.filter((d) => !locked(d));
  const remaining = kit ? Decimal.max(D(0), D(kit.total).minus(lockedSum)) : D(0);
  const weights = targets.map((d) => D(Math.max(d.input.quantity, 0)));
  const totalW = weights.reduce((a, w) => a.plus(w), D(0));
  const parts = targets.map((_, i) => (remaining.isZero() || totalW.isZero() ? D(0) : remaining.times(weights[i]).div(totalW).toDecimalPlaces(2)));
  if (parts.length && !remaining.isZero()) parts[parts.length - 1] = parts[parts.length - 1].plus(remaining.minus(parts.reduce((a, p) => a.plus(p), D(0))));
  return drafts.map((d) => {
    const k = targets.indexOf(d);
    if (k < 0) return d;
    const share = parts[k].gt(0) ? parts[k].toString() : null;
    if ((d.input.deliveryKitShare ?? null) === share) return d;
    const input = { ...d.input };
    if (share) input.deliveryKitShare = share; else delete input.deliveryKitShare;
    return { ...d, input };
  });
}

/**
 * Salva uma nova versão do orçamento com todas as peças. Peças que já têm pedido
 * em produção (ou separadas do estoque) ficam travadas: precisam continuar iguais.
 */
export function saveQuote(db: DB, meta: { quoteId?: ID; name?: string; projectId?: ID; customerId?: ID; note?: string; refreshCosts?: boolean; deliveryKit?: QuoteDeliveryKit | null },
  draftsIn: QuoteItemDraft[], shipping?: QuoteShipping): Quote {
  assert(draftsIn.length > 0, 'Adicione ao menos uma peça ao orçamento.');
  if (meta.customerId) byId(db.parties, meta.customerId, 'Cliente');
  const prev = meta.quoteId ? byId(db.quotes, meta.quoteId, 'Orçamento') : undefined;
  const prevItems = prev ? latestVersion(prev).items : [];
  // Kit de entrega: distribui o custo entre as peças que ainda podem mudar (mesma regra da tela).
  const kit = meta.deliveryKit === undefined ? (prev ? latestVersion(prev).deliveryKit : undefined) : meta.deliveryKit ?? undefined;
  const drafts = meta.deliveryKit === undefined ? draftsIn
    : withKitShares(draftsIn, kit ?? null, (d) => !!(prev && d.itemId && isItemLocked(db, prev, d.itemId)));
  const items: QuoteVersionItem[] = drafts.map((d, i) => {
    const label = drafts.length > 1 ? `peça ${i + 1}` : 'peça';
    const name = requireText(d.name, `a descrição da ${label}`);
    const input = d.input;
    assert(Number.isInteger(input.quantity) && input.quantity >= 1, `A quantidade da ${label} deve ser um inteiro maior que zero.`);
    for (const m of input.materials) {
      byId(db.materials, m.materialId, 'Filamento/insumo');
      if (m.lotId) byId(db.lots, m.lotId, 'Lote de material');
      assert(m.qtyPerUnit > 0, `Informe o peso de cada filamento da ${label} (maior que zero).`);
    }
    if (d.image) assert(d.image.length <= MAX_IMAGE_CHARS, `A imagem da ${label} é grande demais. Use uma imagem menor.`);
    if (d.finishedGoodId) byId(db.finishedGoods, d.finishedGoodId, 'Peça pronta');
    const itemId = d.itemId ?? newId();
    const old = prevItems.find((x) => x.itemId === itemId);
    if (prev && old && isItemLocked(db, prev, itemId)) {
      // Peça em produção: mantém exatamente a versão que foi produzida.
      assert(JSON.stringify(old.input) === JSON.stringify(input) && old.name === name,
        `A peça "${old.name}" já está em produção e não pode ser alterada. Retorne o pedido para o orçamento antes de mudar.`);
      return structuredClone(old);
    }
    // Peça não alterada mantém os custos e o valor salvos (não muda de preço sozinha);
    // só recalcula com os custos atuais se foi alterada ou se o usuário pediu.
    if (old && !meta.refreshCosts && sameInput(old.input, input)) {
      return { ...structuredClone(old), name, image: d.image ?? null, finishedGoodId: d.finishedGoodId };
    }
    const params = resolveParams(db, input);
    return { itemId, name, image: d.image ?? null, input: structuredClone(input), params, summary: summarize(evaluateQuote(input, params)), finishedGoodId: d.finishedGoodId };
  });
  if (prev) {
    for (const old of prevItems) {
      if (!items.some((x) => x.itemId === old.itemId)) {
        assert(!isItemLocked(db, prev, old.itemId), `A peça "${old.name}" está em produção e não pode ser removida do orçamento.`);
      }
    }
  }
  const name = meta.name?.trim() || items[0].name;
  const version: QuoteVersion = { version: 1, createdAt: nowISO(), items, shipping: shipping ? structuredClone(shipping) : undefined, deliveryKit: kit ? structuredClone(kit) : undefined, note: meta.note };
  if (prev) {
    version.version = prev.versions.length + 1;
    prev.versions.push(version);
    Object.assign(prev, { name, projectId: meta.projectId ?? prev.projectId, customerId: meta.customerId });
    const keep = new Set(items.map((x) => x.itemId));
    prev.itemStatus = Object.fromEntries(Object.entries(prev.itemStatus ?? {}).filter(([k]) => keep.has(k)));
    refreshQuoteStatus(db, prev);
    audit(db, 'Orçamento revisado', `${prev.number} v${version.version} (${items.length} peça(s))`);
    return prev;
  }
  const q: Quote = {
    id: newId(), number: nextCode(db, 'quote', 'ORC'), name, projectId: meta.projectId, customerId: meta.customerId,
    status: 'rascunho', createdAt: nowISO(), versions: [version], itemStatus: {},
  };
  db.quotes.push(q);
  audit(db, 'Orçamento criado', `${q.number} ${name} (${items.length} peça(s))`);
  return q;
}

export const latestVersion = (q: Quote) => q.versions[q.versions.length - 1];
export const quoteItems = (q: Quote) => latestVersion(q).items;

export function quoteItem(q: Quote, itemId?: ID): QuoteVersionItem {
  const items = quoteItems(q);
  const it = itemId ? items.find((x) => x.itemId === itemId) : items[0];
  if (!it) throw new BusinessError('Peça não encontrada neste orçamento.');
  return it;
}

/** Peça de uma versão específica (pedidos guardam a versão que foi produzida). */
export function quoteItemAt(q: Quote, version: number | undefined, itemId?: ID): QuoteVersionItem | undefined {
  const v = q.versions.find((x) => x.version === version) ?? latestVersion(q);
  return itemId ? v.items.find((x) => x.itemId === itemId) ?? quoteItems(q).find((x) => x.itemId === itemId) : v.items[0];
}

export type ItemState = QuoteItemStatus | 'producao' | 'produzido' | 'separado';
export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  aberto: 'Aguardando cliente', aprovado: 'Aprovada', recusado: 'Recusada', producao: 'Em produção', produzido: 'Produzida', separado: 'Pedido aprovado (estoque)',
};

export function itemOrder(db: DB, q: Quote, itemId: ID) {
  return db.orders.find((o) => o.quoteId === q.id && (o.quoteItemId ?? quoteItems(q)[0]?.itemId) === itemId && o.status !== 'cancelada');
}

export function itemAllocation(db: DB, q: Quote, itemId: ID) {
  for (const fg of db.finishedGoods) {
    const a = fg.allocations?.find((x) => x.quoteId === q.id && x.itemId === itemId);
    if (a) return { fg, allocation: a };
  }
  return undefined;
}

export function itemState(db: DB, q: Quote, itemId: ID): ItemState {
  const o = itemOrder(db, q, itemId);
  if (o) return o.status === 'concluida' ? 'produzido' : 'producao';
  if (itemAllocation(db, q, itemId)) return 'separado';
  if (db.sales.some((s) => s.status === 'ativa' && s.quoteId === q.id && s.quoteItemId === itemId && s.finishedGoodId)) return 'separado';
  return q.itemStatus?.[itemId] ?? 'aberto';
}

/** Peça travada para edição: tem pedido ativo ou peças do estoque separadas para ela. */
export function isItemLocked(db: DB, q: Quote, itemId: ID) {
  const s = itemState(db, q, itemId);
  return s === 'producao' || s === 'produzido' || s === 'separado';
}

/** Situação geral do orçamento, a partir das peças. */
export function refreshQuoteStatus(db: DB, q: Quote) {
  const states = quoteItems(q).map((it) => itemState(db, q, it.itemId));
  const done = (s: ItemState) => s === 'producao' || s === 'produzido' || s === 'separado';
  const active = states.filter((s) => s !== 'recusado');
  if (states.length && active.length === 0) q.status = 'recusado';
  else if (active.length && active.every(done)) q.status = 'convertido';
  else if (states.some((s) => s === 'aprovado' || done(s))) q.status = 'aprovado';
  else q.status = q.sentAt ? 'enviado' : 'rascunho';
}

/** Aprovar, recusar ou reabrir uma peça. Peça vinda do estoque aprovada = "Pedido aprovado": separa as peças prontas. */
export function setItemStatus(db: DB, quoteId: ID, itemId: ID, status: QuoteItemStatus, opts: { dueDate?: string } = {}) {
  const q = byId(db.quotes, quoteId, 'Orçamento');
  const it = quoteItem(q, itemId);
  const state = itemState(db, q, itemId);
  assert(state !== 'producao' && state !== 'produzido', `A peça "${it.name}" já está em produção. Retorne o pedido para o orçamento antes de mudar a situação.`);
  if (it.finishedGoodId) {
    const fg = byId(db.finishedGoods, it.finishedGoodId, 'Peça pronta');
    const alloc = fg.allocations?.find((a) => a.quoteId === q.id && a.itemId === itemId);
    if (status === 'aprovado' && !alloc) {
      const available = fg.qtyProduced - db.sales.filter((s) => s.finishedGoodId === fg.id && s.status === 'ativa').reduce((a, s) => a + s.qty, 0)
        - fg.adjustments.reduce((a, x) => a + x.qty, 0) - (fg.allocations ?? []).reduce((a, x) => a + x.qty, 0);
      assert(it.input.quantity <= available, `Só há ${available} peça(s) de ${fg.code} disponível(is) no estoque.`);
      fg.allocations = [...(fg.allocations ?? []), { id: newId(), quoteId: q.id, itemId, qty: it.input.quantity, customerId: q.customerId, dueDate: opts.dueDate || undefined, createdAt: nowISO() }];
      audit(db, 'Pedido aprovado (estoque)', `${q.number}: ${it.input.quantity} un. de ${fg.code} separadas`);
    } else if (status !== 'aprovado' && alloc) {
      fg.allocations = (fg.allocations ?? []).filter((a) => a.id !== alloc.id);
    }
  }
  q.itemStatus = { ...q.itemStatus, [itemId]: status };
  refreshQuoteStatus(db, q);
  audit(db, 'Situação da peça', `${q.number} · ${it.name}: ${status}`);
}

/** Situação geral definida pelo usuário: "enviado" marca o envio; aprovar/recusar aplica a todas as peças abertas. */
export function setQuoteStatus(db: DB, quoteId: ID, status: QuoteStatus) {
  const q = byId(db.quotes, quoteId, 'Orçamento');
  assert(status !== 'convertido', 'Use "Enviar para produção" nas peças aprovadas.');
  if (status === 'enviado') q.sentAt = q.sentAt ?? nowISO();
  if (status === 'rascunho') q.sentAt = undefined;
  if (status === 'aprovado' || status === 'recusado') {
    for (const it of quoteItems(q)) if (itemState(db, q, it.itemId) === 'aberto') setItemStatus(db, q.id, it.itemId, status === 'aprovado' ? 'aprovado' : 'recusado');
  }
  refreshQuoteStatus(db, q);
  if (status === 'rascunho' || status === 'enviado') {
    if (q.status === 'rascunho' || q.status === 'enviado') q.status = status;
  }
  audit(db, 'Status do orçamento', `${q.number}: ${q.status}`);
}

/** Totais do orçamento (peças escolhidas ou todas as não recusadas). */
export function quoteTotal(db: DB, q: Quote, itemIds?: ID[]) {
  const items = quoteItems(q).filter((it) => (itemIds ? itemIds.includes(it.itemId) : itemState(db, q, it.itemId) !== 'recusado'));
  let price = ZERO, cost = ZERO, hours = ZERO, pending = false;
  for (const it of items) {
    if (it.summary.orderPrice) price = price.plus(it.summary.orderPrice); else pending = true;
    if (it.summary.totalCost) cost = cost.plus(it.summary.totalCost);
    if (it.summary.hours) hours = hours.plus(it.summary.hours);
  }
  return { items, price, cost, hours, pending, count: items.length };
}

/** Exclui um orçamento sem pedidos ativos, vendas ou peças separadas. O histórico (backups) preserva os dados. */
export function deleteQuote(db: DB, quoteId: ID, reason: string) {
  const q = byId(db.quotes, quoteId, 'Orçamento');
  const why = requireText(reason, 'o motivo da exclusão');
  assert(!db.orders.some((o) => o.quoteId === q.id && o.status !== 'cancelada'), 'Há pedidos ativos deste orçamento. Retorne-os para o orçamento (ou cancele) antes de excluir.');
  assert(!db.sales.some((s) => s.quoteId === q.id && s.status === 'ativa'), 'Há vendas registradas a partir deste orçamento. Cancele-as antes de excluir.');
  assert(!db.finishedGoods.some((fg) => fg.allocations?.some((a) => a.quoteId === q.id)), 'Há peças do estoque separadas para este orçamento. Reabra as peças antes de excluir.');
  db.quotes = db.quotes.filter((x) => x.id !== q.id);
  audit(db, 'Orçamento excluído', `${q.number} ${q.name} — ${why}`);
}

/**
 * Orçamentos anteriores à v1.5 tinham uma única peça por versão
 * (version.input/params/summary e quote.image). Converte para items[].
 */
export function migrateQuoteItems(db: DB) {
  for (const q of db.quotes) {
    const legacy = q as Quote & { image?: string | null };
    const legacyId = `${q.id}:1`;
    let converted = false;
    for (const v of q.versions as (QuoteVersion & { input?: QuoteInput; params?: CostParams; summary?: QuoteSummary })[]) {
      if (v.items) continue;
      v.items = [{ itemId: legacyId, name: q.name, image: legacy.image ?? null, input: v.input!, params: v.params!, summary: v.summary! }];
      v.shipping = v.input?.shipping;
      delete v.input; delete v.params; delete v.summary;
      converted = true;
    }
    if (!converted) continue;
    delete legacy.image;
    const wasConverted = q.status === 'convertido';
    q.itemStatus = q.itemStatus ?? {};
    if (q.status === 'aprovado' || wasConverted) q.itemStatus[legacyId] = 'aprovado';
    if (q.status === 'recusado') q.itemStatus[legacyId] = 'recusado';
    if (q.status === 'enviado') q.sentAt = q.createdAt;
    for (const o of db.orders) if (o.quoteId === q.id && !o.quoteItemId) o.quoteItemId = legacyId;
    for (const s of db.sales) if (s.quoteId === q.id && !s.quoteItemId) s.quoteItemId = legacyId;
  }
}

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

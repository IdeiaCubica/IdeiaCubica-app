/**
 * Vendas e resultado gerencial.
 *
 * Uma venda gera, na mesma transação:
 *   - conta(s) a receber (liquidada se à vista);
 *   - encargos do canal: se retidos pelo canal (marketplace/gateway), o valor a
 *     receber já vem líquido; senão, gera conta a pagar das taxas;
 *   - frete pago pela empresa: conta a pagar.
 * O custo de fabricação da venda é um snapshot: realizado (OP concluída) ou
 * estimado (orçamento), sempre identificado.
 */
import type { DB, ID, ISODate, PaymentTerms, Sale } from './types';
import { D, Decimal, Dn, ZERO, cents, sum } from './money';
import { assert, audit, byId, isISODate, newId, nextCode, nowISO, requireText } from './core';
import { categoryByName, cancelTitle, createTitlesFromTerms, titlePaid } from './finance';
import { SYS_FIN } from './schema';
import { channelRates } from './pricing';
import { compareOrder, finishedGoodBalance } from './production';
import { latestVersion } from './quotes';

export interface SaleInput {
  date: ISODate;
  customerId?: ID;
  projectId?: ID;
  quoteId?: ID;
  orderId?: ID;
  finishedGoodId?: ID;
  description: string;
  qty: number;
  unitPrice: string;
  discount: string;
  freightCharged: string;
  freightCost: string;
  channelId?: ID;
  feesWithheld: boolean;
  manualUnitCost?: string | null;
  payment: PaymentTerms;
  notes?: string;
}

/** Determina o custo unitário da venda e sua natureza. */
export function resolveSaleCost(db: DB, input: Pick<SaleInput, 'orderId' | 'quoteId' | 'manualUnitCost' | 'finishedGoodId'>): { unitCost: Decimal | null; status: Sale['costStatus'] } {
  if (input.finishedGoodId) {
    const fg = byId(db.finishedGoods, input.finishedGoodId, 'Peça pronta');
    if (fg.unitCost !== null) return { unitCost: D(fg.unitCost), status: fg.costStatus };
  }
  if (input.orderId) {
    const o = byId(db.orders, input.orderId, 'Ordem de produção');
    const cmp = compareOrder(db, o);
    if (cmp.real?.unit) return { unitCost: cmp.real.unit, status: cmp.real.laborEstimated ? 'estimado' : 'realizado' };
    if (cmp.estimated.unit) return { unitCost: cmp.estimated.unit, status: 'estimado' };
  }
  if (input.quoteId) {
    const q = byId(db.quotes, input.quoteId, 'Orçamento');
    const u = latestVersion(q).summary.unitCost;
    if (u) return { unitCost: D(u), status: 'estimado' };
  }
  const manual = Dn(input.manualUnitCost);
  if (manual) return { unitCost: manual, status: 'estimado' };
  return { unitCost: null, status: 'pendente' };
}

export function saleGross(s: Pick<Sale, 'qty' | 'unitPrice' | 'discount'>): Decimal {
  return cents(D(s.unitPrice).times(s.qty).minus(D(s.discount)));
}

export function registerSale(db: DB, input: SaleInput): Sale {
  assert(isISODate(input.date), 'Informe a data da venda.');
  const description = requireText(input.description, 'a descrição do produto vendido');
  assert(Number.isInteger(input.qty) && input.qty > 0, 'Quantidade deve ser um inteiro maior que zero.');
  const unitPrice = cents(D(input.unitPrice));
  assert(unitPrice.gt(0), 'Preço unitário deve ser maior que zero.');
  const discount = cents(D(input.discount || '0'));
  const freightCharged = cents(D(input.freightCharged || '0'));
  const freightCost = cents(D(input.freightCost || '0'));
  assert(!discount.isNegative() && !freightCharged.isNegative() && !freightCost.isNegative(), 'Valores não podem ser negativos.');
  const gross = cents(unitPrice.times(input.qty).minus(discount));
  assert(gross.gt(0), 'O desconto não pode ser maior ou igual ao valor da venda.');
  const channel = input.channelId ? byId(db.channels, input.channelId, 'Canal de venda') : undefined;
  const ch = channelRates(channel ?? null);
  const fees = ch ? cents(gross.times(ch.rates).plus(ch.fixedFee)) : ZERO;
  if (input.customerId) byId(db.parties, input.customerId, 'Cliente');
  if (input.finishedGoodId) {
    const bal = finishedGoodBalance(db, input.finishedGoodId);
    assert(input.qty <= bal.available, `Só há ${bal.available} peça(s) pronta(s) deste item em estoque.`);
  }
  const cost = resolveSaleCost(db, input);

  const sale: Sale = {
    id: newId(), number: nextCode(db, 'sale', 'VND'), date: input.date, customerId: input.customerId, projectId: input.projectId,
    quoteId: input.quoteId, orderId: input.orderId, finishedGoodId: input.finishedGoodId, description, qty: input.qty, unitPrice: unitPrice.toString(),
    discount: discount.toString(), freightCharged: freightCharged.toString(), freightCost: freightCost.toString(), channelId: input.channelId,
    fees: { ratesPct: ch ? ch.rates.times(100).toString() : '0', fixed: ch ? ch.fixedFee.toString() : '0', total: fees.toString() },
    feesWithheld: input.feesWithheld, unitCost: cost.unitCost ? cost.unitCost.toString() : null, costStatus: cost.status,
    payment: input.payment, status: 'ativa', notes: input.notes, createdAt: nowISO(),
  };

  const customer = db.parties.find((p) => p.id === input.customerId);
  const receivable = gross.plus(freightCharged).minus(input.feesWithheld ? fees : ZERO);
  assert(receivable.gt(0), 'O valor líquido a receber deve ser maior que zero.');
  createTitlesFromTerms(db, {
    direction: 'in', description: `Venda ${sale.number} — ${description}${customer ? ' — ' + customer.name : ''}`,
    categoryId: categoryByName(db, SYS_FIN.vendaProdutos).id, amount: receivable, competenceDate: input.date,
    partyId: input.customerId, projectId: input.projectId, origin: { kind: 'venda', id: sale.id }, terms: input.payment,
  });
  if (!input.feesWithheld && fees.gt(0)) {
    createTitlesFromTerms(db, {
      direction: 'out', description: `Taxas da venda ${sale.number}`, categoryId: categoryByName(db, SYS_FIN.taxasVenda).id, amount: fees,
      competenceDate: input.date, projectId: input.projectId, origin: { kind: 'venda', id: sale.id },
      terms: { mode: 'aprazo', installments: 1, firstDue: input.date, intervalDays: 30 },
    });
  }
  if (freightCost.gt(0)) {
    createTitlesFromTerms(db, {
      direction: 'out', description: `Frete da venda ${sale.number}`, categoryId: categoryByName(db, SYS_FIN.freteVenda).id, amount: freightCost,
      competenceDate: input.date, projectId: input.projectId, origin: { kind: 'venda', id: sale.id },
      terms: { mode: 'aprazo', installments: 1, firstDue: input.date, intervalDays: 30 },
    });
  }
  db.sales.push(sale);
  audit(db, 'Venda registrada', `${sale.number}: R$ ${gross.toFixed(2)}`);
  return sale;
}

export function cancelSale(db: DB, saleId: ID, reason: string) {
  const s = byId(db.sales, saleId, 'Venda');
  assert(s.status === 'ativa', 'Venda já cancelada.');
  const why = requireText(reason, 'o motivo do cancelamento');
  const titles = db.titles.filter((t) => t.origin.kind === 'venda' && t.origin.id === s.id && t.status !== 'cancelado');
  assert(!titles.some((t) => titlePaid(t).gt(0)), 'Há recebimentos/pagamentos registrados para esta venda. Estorne-os antes de cancelar.');
  titles.forEach((t) => cancelTitle(db, t.id, `Venda cancelada: ${why}`));
  s.status = 'cancelada';
  s.cancelReason = why;
  audit(db, 'Venda cancelada', `${s.number} — ${why}`);
}

/* ------------------------------------------------------------------ */
/* Resultado                                                           */
/* ------------------------------------------------------------------ */
export interface SaleEconomics {
  revenue: Decimal;      // receita de produtos (após desconto)
  fees: Decimal;
  freightNet: Decimal;   // frete cobrado − frete pago (negativo = subsídio)
  cogs: Decimal | null;  // custo dos produtos vendidos
  contribution: Decimal | null;
}

export function saleEconomics(s: Sale): SaleEconomics {
  const revenue = saleGross(s);
  const fees = D(s.fees.total);
  const freightNet = D(s.freightCharged).minus(D(s.freightCost));
  const cogs = s.unitCost !== null ? cents(D(s.unitCost).times(s.qty)) : null;
  return { revenue, fees, freightNet, cogs, contribution: cogs === null ? null : revenue.minus(fees).plus(freightNet).minus(cogs) };
}

/**
 * Resultado gerencial do período (competência):
 *   receita − encargos ± frete − CPV = margem de contribuição
 *   − despesas fixas = resultado operacional
 * Compras de estoque e investimentos NÃO entram como despesa.
 */
export function managementResult(db: DB, from: ISODate, to: ISODate) {
  const sales = db.sales.filter((s) => s.status === 'ativa' && s.date >= from && s.date <= to);
  const eco = sales.map(saleEconomics);
  const revenue = sum(eco.map((e) => e.revenue));
  const fees = sum(eco.map((e) => e.fees));
  const freightNet = sum(eco.map((e) => e.freightNet));
  const cogs = sum(eco.map((e) => e.cogs));
  const pendingCost = sales.filter((s) => s.costStatus === 'pendente').length;
  const estimatedCost = sales.filter((s) => s.costStatus === 'estimado').length;
  const contribution = revenue.minus(fees).plus(freightNet).minus(cogs);
  let fixed = ZERO, otherIn = ZERO, otherOut = ZERO;
  for (const t of db.titles) {
    if (t.status === 'cancelado' || t.competenceDate < from || t.competenceDate > to || t.origin.kind === 'venda') continue;
    const c = db.finCategories.find((x) => x.id === t.categoryId);
    if (c?.nature === 'despesa_fixa') fixed = fixed.plus(D(t.amount));
    if (c?.nature === 'receita_outra') otherIn = otherIn.plus(D(t.amount));
    if (c?.nature === 'outros' && t.direction === 'out') otherOut = otherOut.plus(D(t.amount));
  }
  const operating = contribution.minus(fixed).plus(otherIn).minus(otherOut);
  return {
    salesCount: sales.length, revenue, fees, freightNet, cogs, contribution,
    contributionPct: revenue.isZero() ? null : contribution.div(revenue),
    fixed, otherIn, otherOut, operating,
    status: pendingCost ? 'parcial' as const : estimatedCost ? 'estimado' as const : 'realizado' as const,
    pendingCost, estimatedCost,
  };
}

/** Resultado por produto/projeto. */
export function resultByProject(db: DB) {
  const rows = new Map<string, { key: string; name: string; qty: number; revenue: Decimal; fees: Decimal; cogs: Decimal; contribution: Decimal; statuses: Set<string> }>();
  for (const s of db.sales) {
    if (s.status !== 'ativa') continue;
    const proj = db.projects.find((p) => p.id === s.projectId);
    const key = proj?.id ?? `desc:${s.description.toLowerCase()}`;
    const row = rows.get(key) ?? { key, name: proj ? `${proj.code} · ${proj.name}` : s.description, qty: 0, revenue: ZERO, fees: ZERO, cogs: ZERO, contribution: ZERO, statuses: new Set<string>() };
    const e = saleEconomics(s);
    row.qty += s.qty;
    row.revenue = row.revenue.plus(e.revenue);
    row.fees = row.fees.plus(e.fees);
    row.cogs = row.cogs.plus(e.cogs ?? ZERO);
    row.contribution = row.contribution.plus(e.revenue.minus(e.fees).plus(e.freightNet).minus(e.cogs ?? ZERO));
    row.statuses.add(s.costStatus);
    rows.set(key, row);
  }
  return [...rows.values()].map((r) => ({
    ...r,
    contributionPct: r.revenue.isZero() ? null : r.contribution.div(r.revenue),
    unitContribution: r.qty ? r.contribution.div(r.qty) : null,
    status: r.statuses.has('pendente') ? 'parcial' : r.statuses.has('estimado') ? 'estimado' : 'realizado',
  })).sort((a, b) => b.contribution.cmp(a.contribution));
}

/** Ponto de equilíbrio: receita necessária para cobrir despesas fixas mensais com a margem de contribuição média. */
export function breakEven(fixedMonthly: Decimal, contributionPct: Decimal | null): Decimal | null {
  if (!contributionPct || contributionPct.lte(0)) return null;
  return cents(fixedMonthly.div(contributionPct));
}

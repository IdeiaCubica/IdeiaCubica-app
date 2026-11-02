/**
 * Relatórios do financeiro: extrato (entradas e saídas de dinheiro, com o detalhe de cada uma)
 * e fechamento mensal (resultado, caixa, despesas, peças vendidas e produzidas do mês).
 *
 * Extrato = visão de CAIXA: só o que entrou/saiu de fato (pagamentos e recebimentos registrados).
 * Resultado = visão de COMPETÊNCIA: vendas e despesas do mês, mesmo que pagas em outro mês.
 */
import type { DB, FinNature, FinTitle, ID, ISODate, MonthClosing } from './types';
import { D, Decimal, ZERO, cents, sum } from './money';
import { assert, audit, fmtDate, newId, nowISO } from './core';
import { managementResult, saleEconomics, saleGross } from './sales';
import { inventoryValue } from './inventory';
import { materialLabel } from './catalog';
import { finishedGoodBalance } from './production';

export function monthRange(ym: string): { from: ISODate; to: ISODate } {
  assert(/^\d{4}-\d{2}$/.test(ym), 'Mês inválido.');
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export interface StatementRow {
  date: ISODate; titleId: ID; settlementId: ID;
  description: string; detail: string; category: string; party: string; account: string; method: string;
  origin: FinTitle['origin']['kind']; originLabel: string;
  amountIn: Decimal; amountOut: Decimal; balance: Decimal;
}

/** O que foi comprado/vendido naquele lançamento (para saber do que se trata cada saída e entrada). */
function titleDetail(db: DB, t: FinTitle): { label: string; detail: string } {
  if (t.origin.kind === 'compra') {
    const p = db.purchases.find((x) => x.id === t.origin.id);
    if (!p) return { label: 'Compra', detail: '' };
    const items = p.items.map((it) => {
      const m = db.materials.find((x) => x.id === it.materialId);
      return `${m ? materialLabel(m) : 'insumo'} (${it.qty.toLocaleString('pt-BR')} ${m?.unit ?? ''})`;
    });
    const eq = (p.equipment ?? []).map((e) => e.description);
    return { label: `Compra ${p.number}`, detail: [...items, ...eq].join(', ') };
  }
  if (t.origin.kind === 'venda') {
    const s = db.sales.find((x) => x.id === t.origin.id);
    if (!s) return { label: 'Venda', detail: '' };
    const c = db.parties.find((x) => x.id === s.customerId)?.name;
    return { label: `Venda ${s.number}`, detail: `${s.qty} × ${s.description}${c ? ` — ${c}` : ''}` };
  }
  if (t.origin.kind === 'pedido') {
    const o = db.orders.find((x) => x.id === t.origin.id);
    const c = db.parties.find((x) => x.id === t.partyId)?.name;
    return { label: `Pedido ${o?.number ?? ''}`.trim(), detail: o ? `${o.qtyPlanned} × ${o.description}${c ? ` — ${c}` : ''} (recebido antes da entrega)` : '' };
  }
  return { label: 'Lançamento manual', detail: t.notes ?? '' };
}

/**
 * Extrato de caixa do período: cada pagamento/recebimento registrado (estornos não contam),
 * em ordem de data, com saldo acumulado a partir do saldo de abertura.
 */
export function cashStatement(db: DB, opts: { from: ISODate; to: ISODate; accountId?: ID }) {
  const accounts = db.accounts.filter((a) => !opts.accountId || a.id === opts.accountId);
  const accIds = new Set(accounts.map((a) => a.id));
  let opening = sum(accounts.map((a) => D(a.openingBalance)));
  const moves: Omit<StatementRow, 'balance'>[] = [];
  for (const t of db.titles) {
    for (const s of t.settlements) {
      if (s.reversed || !accIds.has(s.accountId)) continue;
      const amount = D(s.amount);
      const signed = t.direction === 'in' ? amount : amount.negated();
      if (s.date < opts.from) { opening = opening.plus(signed); continue; }
      if (s.date > opts.to) continue;
      const cat = db.finCategories.find((c) => c.id === t.categoryId)?.name ?? '';
      const info = titleDetail(db, t);
      moves.push({
        date: s.date, titleId: t.id, settlementId: s.id, description: t.description, detail: info.detail, category: cat,
        party: db.parties.find((p) => p.id === t.partyId)?.name ?? '', account: db.accounts.find((a) => a.id === s.accountId)?.name ?? '',
        method: s.method ?? t.method ?? '', origin: t.origin.kind, originLabel: info.label,
        amountIn: t.direction === 'in' ? amount : ZERO, amountOut: t.direction === 'out' ? amount : ZERO,
      });
    }
  }
  moves.sort((a, b) => a.date.localeCompare(b.date) || (b.amountIn.gt(0) ? 1 : 0) - (a.amountIn.gt(0) ? 1 : 0));
  let bal = cents(opening);
  const rows: StatementRow[] = moves.map((m) => { bal = bal.plus(m.amountIn).minus(m.amountOut); return { ...m, balance: bal }; });
  const totalIn = sum(rows.map((r) => r.amountIn)), totalOut = sum(rows.map((r) => r.amountOut));
  return { opening: cents(opening), rows, totalIn, totalOut, closing: cents(opening.plus(totalIn).minus(totalOut)) };
}

/** Extrato em CSV (separador ";", abre direto no Excel em português). */
export function statementCsv(st: ReturnType<typeof cashStatement>): string {
  const n = (d: Decimal) => (d.isZero() ? '' : d.toFixed(2).replace('.', ','));
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ['Data;Descrição;Detalhe;Categoria;Cliente/fornecedor;Conta;Forma;Entrada;Saída;Saldo',
    `;Saldo inicial;;;;;;;;${st.opening.toFixed(2).replace('.', ',')}`,
    ...st.rows.map((r) => [fmtDate(r.date), q(r.description), q(r.detail), q(r.category), q(r.party), q(r.account), q(r.method), n(r.amountIn), n(r.amountOut), r.balance.toFixed(2).replace('.', ',')].join(';')),
    `;Totais;;;;;;${st.totalIn.toFixed(2).replace('.', ',')};${st.totalOut.toFixed(2).replace('.', ',')};${st.closing.toFixed(2).replace('.', ',')}`];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Para onde foi (ou de onde veio) o dinheiro, pela natureza da categoria. */
export const NATURE_GROUP: Record<FinNature, string> = {
  receita_venda: 'Vendas recebidas', receita_outra: 'Outras receitas', aporte: 'Aportes dos sócios',
  estoque: 'Compra de insumos (vira estoque)', investimento: 'Impressoras e equipamentos (investimento)',
  despesa_fixa: 'Despesas fixas', custo_variavel: 'Taxas e fretes de venda', retirada: 'Retiradas dos sócios', outros: 'Outros',
};

/** Entradas e saídas do extrato somadas por natureza (do maior para o menor). */
export function natureTotals(db: DB, rows: StatementRow[]) {
  const ins = new Map<FinNature, Decimal>(), outs = new Map<FinNature, Decimal>();
  for (const r of rows) {
    const t = db.titles.find((x) => x.id === r.titleId);
    const n = db.finCategories.find((c) => c.id === t?.categoryId)?.nature ?? 'outros';
    if (r.amountIn.gt(0)) ins.set(n, (ins.get(n) ?? ZERO).plus(r.amountIn));
    if (r.amountOut.gt(0)) outs.set(n, (outs.get(n) ?? ZERO).plus(r.amountOut));
  }
  const list = (map: Map<FinNature, Decimal>) => [...map.entries()].map(([nature, amount]) => ({ nature, label: NATURE_GROUP[nature], amount })).sort((a, b) => b.amount.cmp(a.amount));
  return { inByNature: list(ins), outByNature: list(outs) };
}

/** Resultado de cada venda: quanto entrou, o que custou e quanto sobrou. */
export function salesResults(db: DB, opts: { from?: ISODate; to?: ISODate } = {}) {
  return db.sales.filter((s) => s.status === 'ativa' && (!opts.from || s.date >= opts.from) && (!opts.to || s.date <= opts.to))
    .map((s) => {
      const e = saleEconomics(s);
      const titles = db.titles.filter((t) => t.origin.kind === 'venda' && t.origin.id === s.id && t.direction === 'in' && t.status !== 'cancelado');
      const received = sum(titles.flatMap((t) => t.settlements.filter((x) => !x.reversed).map((x) => D(x.amount))));
      return {
        sale: s, customer: db.parties.find((p) => p.id === s.customerId)?.name ?? '',
        revenue: e.revenue, fees: e.fees, freightNet: e.freightNet, cogs: e.cogs, profit: e.contribution,
        marginPct: e.contribution && !e.revenue.isZero() ? e.contribution.div(e.revenue) : null,
        received, open: sum(titles.map((t) => D(t.amount))).minus(received),
      };
    }).sort((a, b) => b.sale.date.localeCompare(a.sale.date) || b.sale.number.localeCompare(a.sale.number));
}

/**
 * Extrato total (desde o início): tudo o que entrou e saiu, mês a mês e no geral, agrupado pela
 * natureza (vendas, insumos, equipamentos, despesas…), o resultado acumulado da empresa e
 * onde está o dinheiro que saiu (estoque, peças prontas, equipamentos, a receber).
 */
export function overallStatement(db: DB, opts: { accountId?: ID } = {}) {
  const st = cashStatement(db, { from: '0000-01-01', to: '9999-12-31', accountId: opts.accountId });

  type Month = { ym: string; totalIn: Decimal; totalOut: Decimal; net: Decimal; balance: Decimal; count: number };
  const months = new Map<string, Month>();
  for (const r of st.rows) {
    const ym = r.date.slice(0, 7);
    const m = months.get(ym) ?? { ym, totalIn: ZERO, totalOut: ZERO, net: ZERO, balance: ZERO, count: 0 };
    m.totalIn = m.totalIn.plus(r.amountIn); m.totalOut = m.totalOut.plus(r.amountOut); m.count++;
    m.balance = r.balance; // linhas em ordem de data: a última do mês é o saldo de fim do mês
    months.set(ym, m);
  }
  const byMonth = [...months.values()].map((m) => ({ ...m, net: m.totalIn.minus(m.totalOut) })).sort((a, b) => a.ym.localeCompare(b.ym));
  const { inByNature, outByNature } = natureTotals(db, st.rows);
  const equipment = outByNature.find((g) => g.nature === 'investimento')?.amount ?? ZERO;

  // Onde está o dinheiro que saiu: bens que continuam na empresa (valor de custo, hoje).
  const finishedGoods = cents(db.finishedGoods.reduce((acc, fg) => {
    const b = finishedGoodBalance(db, fg.id);
    return fg.unitCost ? acc.plus(D(fg.unitCost).times(b.produced - b.sold - b.adjusted)) : acc;
  }, ZERO));
  let receivable = ZERO, payable = ZERO;
  for (const t of db.titles) {
    if (t.status !== 'aberto') continue;
    const open = D(t.amount).minus(sum(t.settlements.filter((s) => !s.reversed).map((s) => D(s.amount))));
    if (t.direction === 'in') receivable = receivable.plus(open); else payable = payable.plus(open);
  }

  return {
    ...st, byMonth, inByNature, outByNature,
    /** Resultado gerencial acumulado (competência): vendas − custos das peças vendidas − despesas. */
    result: managementResult(db, '0000-01-01', '9999-12-31'),
    assets: {
      materials: inventoryValue(db), finishedGoods,
      equipment,
      receivable: cents(receivable), payable: cents(payable),
    },
    sales: salesResults(db),
  };
}

/** Tudo o que compõe o fechamento de um mês. */
export function monthReport(db: DB, ym: string) {
  const { from, to } = monthRange(ym);
  const result = managementResult(db, from, to);
  const cash = cashStatement(db, { from, to });

  // Caixa por categoria (o que entrou e saiu de fato, agrupado).
  const byCat = (dir: 'in' | 'out') => {
    const map = new Map<string, Decimal>();
    for (const r of cash.rows) {
      const v = dir === 'in' ? r.amountIn : r.amountOut;
      if (v.gt(0)) map.set(r.category || 'Sem categoria', (map.get(r.category || 'Sem categoria') ?? ZERO).plus(v));
    }
    return [...map.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount.cmp(a.amount));
  };

  // Despesas do mês por competência, com o detalhe de cada lançamento.
  const expenses = db.titles.filter((t) => t.direction === 'out' && t.status !== 'cancelado' && t.competenceDate >= from && t.competenceDate <= to)
    .map((t) => {
      const c = db.finCategories.find((x) => x.id === t.categoryId);
      return { title: t, category: c?.name ?? '', nature: c?.nature ?? 'outros', amount: D(t.amount), detail: titleDetail(db, t).detail };
    }).sort((a, b) => b.amount.cmp(a.amount));

  // Peças vendidas no mês, agrupadas pelo nome da peça.
  const sales = db.sales.filter((s) => s.status === 'ativa' && s.date >= from && s.date <= to);
  const pieces = new Map<string, { name: string; qty: number; revenue: Decimal; cogs: Decimal; contribution: Decimal; pendingCost: boolean }>();
  for (const s of sales) {
    const key = s.description.trim().toLowerCase();
    const e = saleEconomics(s);
    const row = pieces.get(key) ?? { name: s.description.trim(), qty: 0, revenue: ZERO, cogs: ZERO, contribution: ZERO, pendingCost: false };
    row.qty += s.qty;
    row.revenue = row.revenue.plus(e.revenue);
    row.cogs = row.cogs.plus(e.cogs ?? ZERO);
    row.contribution = row.contribution.plus(e.revenue.minus(e.fees).plus(e.freightNet).minus(e.cogs ?? ZERO));
    row.pendingCost ||= e.cogs === null;
    pieces.set(key, row);
  }
  const piecesSold = [...pieces.values()].map((p) => ({ ...p, marginPct: p.revenue.isZero() ? null : p.contribution.div(p.revenue) }))
    .sort((a, b) => b.contribution.cmp(a.contribution));

  // Produção do mês: ordens concluídas e material consumido.
  const done = db.orders.filter((o) => o.status === 'concluida' && (o.finishedAt ?? '').slice(0, 10) >= from && (o.finishedAt ?? '').slice(0, 10) <= to);
  const consumption = new Map<ID, { label: string; unit: string; qty: Decimal; cost: Decimal }>();
  for (const m of db.movements) {
    if ((m.type !== 'consumo' && m.type !== 'perda') || m.date < from || m.date > to) continue;
    const lot = db.lots.find((l) => l.id === m.lotId);
    const mat = db.materials.find((x) => x.id === m.materialId);
    const row = consumption.get(m.materialId) ?? { label: mat ? materialLabel(mat) : 'Insumo removido', unit: mat?.unit ?? '', qty: ZERO, cost: ZERO };
    row.qty = row.qty.plus(m.qty);
    row.cost = row.cost.plus(lot ? D(m.qty).times(lot.unitCost) : ZERO);
    consumption.set(m.materialId, row);
  }

  // Em aberto de lançamentos com competência até o fim do mês (valores de hoje).
  let receivable = ZERO, payable = ZERO;
  for (const t of db.titles) {
    if (t.status !== 'aberto' || t.competenceDate > to) continue;
    const open = D(t.amount).minus(sum(t.settlements.filter((s) => !s.reversed).map((s) => D(s.amount))));
    if (t.direction === 'in') receivable = receivable.plus(open); else payable = payable.plus(open);
  }

  return {
    ym, from, to, result, cash,
    cashInByCategory: byCat('in'), cashOutByCategory: byCat('out'), expenses,
    piecesSold, salesCount: sales.length, piecesSoldQty: sales.reduce((s, x) => s + x.qty, 0), grossSales: sum(sales.map((s) => saleGross(s))),
    production: {
      orders: done.length, approved: done.reduce((s, o) => s + (o.actual?.qtyApproved ?? 0), 0), rejected: done.reduce((s, o) => s + (o.actual?.qtyRejected ?? 0), 0),
      consumption: [...consumption.values()].sort((a, b) => b.cost.cmp(a.cost)),
    },
    receivable: cents(receivable), payable: cents(payable), inventoryNow: inventoryValue(db),
    closing: db.monthClosings.find((c) => c.month === ym) ?? null,
  };
}

const FIGURES = (r: ReturnType<typeof monthReport>): Record<string, string> => ({
  receita: r.result.revenue.toString(), encargos: r.result.fees.toString(), frete: r.result.freightNet.toString(), cpv: r.result.cogs.toString(),
  margem: r.result.contribution.toString(), despesasFixas: r.result.fixed.toString(), resultado: r.result.operating.toString(),
  entradas: r.cash.totalIn.toString(), saidas: r.cash.totalOut.toString(), saldoFinal: r.cash.closing.toString(),
  pecasVendidas: String(r.piecesSoldQty), pecasProduzidas: String(r.production.approved),
});

export const CLOSING_LABEL: Record<string, string> = {
  receita: 'Receita de vendas', encargos: 'Tributos e taxas', frete: 'Frete (cobrado − pago)', cpv: 'Custo das peças vendidas', margem: 'Margem de contribuição',
  despesasFixas: 'Despesas fixas', resultado: 'Resultado do mês', entradas: 'Entradas de caixa', saidas: 'Saídas de caixa', saldoFinal: 'Saldo de caixa no fim do mês',
  pecasVendidas: 'Peças vendidas', pecasProduzidas: 'Peças produzidas',
};

/** Registra o fechamento do mês (fotografia dos números). Refazer substitui o anterior. */
export function closeMonth(db: DB, ym: string, notes?: string): MonthClosing {
  const r = monthReport(db, ym);
  const closing: MonthClosing = { id: newId(), month: ym, closedAt: nowISO(), figures: FIGURES(r), notes: notes?.trim() || undefined };
  db.monthClosings = [...db.monthClosings.filter((c) => c.month !== ym), closing];
  audit(db, 'Fechamento mensal', `${ym}: resultado R$ ${r.result.operating.toFixed(2)}`);
  return closing;
}

/** Números que mudaram depois do fechamento (lançamentos feitos ou alterados depois). */
export function closingChanges(db: DB, ym: string): { key: string; closed: string; now: string }[] {
  const c = db.monthClosings.find((x) => x.month === ym);
  if (!c) return [];
  const now = FIGURES(monthReport(db, ym));
  return Object.keys(c.figures).filter((k) => now[k] !== undefined && !D(now[k]).eq(D(c.figures[k]))).map((k) => ({ key: k, closed: c.figures[k], now: now[k] }));
}

/**
 * Financeiro.
 *
 * Modelo: cada obrigação/direito é um TÍTULO (conta a pagar ou a receber),
 * reconhecido uma única vez na data de competência. Pagamentos e recebimentos
 * são LIQUIDAÇÕES do título — nunca uma nova despesa. Assim:
 *   - compra à vista  → título já liquidado na data (saída de caixa);
 *   - compra a prazo  → título(s) em aberto; o pagamento liquida, sem duplicar;
 *   - venda a prazo   → conta a receber; o recebimento liquida o saldo.
 *
 * Três visões distintas, nunca misturadas:
 *   - Fluxo de caixa:      liquidações efetivas por conta.
 *   - Resultado gerencial: receita − custos variáveis − CPV − despesas fixas (competência).
 *   - Investimento:        ativos (natureza "investimento") e estoque — não são custo de uma peça.
 */
import type { DB, FinCategory, FinTitle, ID, ISODate, PaymentTerms } from './types';
import { D, Decimal, ZERO, cents, splitInstallments } from './money';
import { BusinessError, addDays, assert, audit, byId, isISODate, newId, nowISO, requireText } from './core';

export const titlePaid = (t: FinTitle): Decimal =>
  t.settlements.filter((s) => !s.reversed).reduce((a, s) => a.plus(D(s.amount)), ZERO);

export const titleOpen = (t: FinTitle): Decimal => (t.status === 'cancelado' ? ZERO : D(t.amount).minus(titlePaid(t)));

export function categoryByName(db: DB, name: string): FinCategory {
  const c = db.finCategories.find((x) => x.name === name);
  if (!c) throw new BusinessError(`Categoria financeira "${name}" não encontrada. Restaure as categorias padrão em Configurações.`);
  return c;
}

export function validateTerms(db: DB, terms: PaymentTerms, baseDate: ISODate) {
  assert(isISODate(baseDate), 'Data inválida.');
  if (terms.mode === 'avista') {
    assert(terms.accountId, 'Selecione a conta financeira de onde sai/entra o dinheiro.');
    byId(db.accounts, terms.accountId, 'Conta financeira');
  } else {
    assert(Number.isInteger(terms.installments) && terms.installments >= 1 && terms.installments <= 48, 'Número de parcelas deve estar entre 1 e 48.');
    assert(isISODate(terms.firstDue), 'Informe o primeiro vencimento.');
    assert(terms.firstDue >= baseDate, 'O primeiro vencimento não pode ser anterior à data da operação.');
    assert(Number.isInteger(terms.intervalDays) && terms.intervalDays >= 1, 'Intervalo entre parcelas inválido.');
  }
}

/** Cria os títulos de uma operação conforme condições de pagamento. */
export function createTitlesFromTerms(db: DB, base: {
  direction: 'in' | 'out'; description: string; categoryId: ID; amount: Decimal; competenceDate: ISODate;
  partyId?: ID; projectId?: ID; origin: FinTitle['origin']; terms: PaymentTerms;
}): FinTitle[] {
  validateTerms(db, base.terms, base.competenceDate);
  const total = cents(base.amount);
  assert(total.gt(0), 'O valor deve ser maior que zero.');
  const t = base.terms;
  const n = t.mode === 'avista' ? 1 : t.installments;
  const parts = splitInstallments(total, n);
  const titles = parts.map((amount, i): FinTitle => {
    const due = t.mode === 'avista' ? base.competenceDate : addDays(t.firstDue, i * t.intervalDays);
    const title: FinTitle = {
      id: newId(), direction: base.direction, description: n > 1 ? `${base.description} (${i + 1}/${n})` : base.description,
      categoryId: base.categoryId, amount: amount.toString(), competenceDate: base.competenceDate, dueDate: due,
      partyId: base.partyId, projectId: base.projectId, origin: base.origin, installment: n > 1 ? { n: i + 1, of: n } : undefined,
      method: t.method, status: 'aberto', settlements: [], createdAt: nowISO(),
    };
    if (t.mode === 'avista') {
      title.settlements.push({ id: newId(), date: base.competenceDate, amount: amount.toString(), accountId: t.accountId!, method: t.method });
      title.status = 'liquidado';
    }
    return title;
  });
  db.titles.push(...titles);
  return titles;
}

/** Lançamento manual (despesa, receita avulsa, investimento, aporte...). */
export function createManualTitle(db: DB, input: {
  categoryId: ID; description: string; amount: string; competenceDate: ISODate; partyId?: ID; projectId?: ID;
  terms: PaymentTerms; notes?: string;
}): FinTitle[] {
  const category = byId(db.finCategories, input.categoryId, 'Categoria financeira');
  const description = requireText(input.description, 'a descrição');
  const titles = createTitlesFromTerms(db, {
    direction: category.direction, description, categoryId: category.id, amount: D(input.amount),
    competenceDate: input.competenceDate, partyId: input.partyId, projectId: input.projectId, origin: { kind: 'manual' }, terms: input.terms,
  });
  if (input.notes) titles.forEach((t) => (t.notes = input.notes));
  audit(db, 'Lançamento financeiro', `${description}: R$ ${input.amount}`);
  return titles;
}

/** Liquida (total ou parcialmente) um título. */
export function settleTitle(db: DB, input: { titleId: ID; date: ISODate; amount: string; accountId: ID; method?: string }) {
  const t = byId(db.titles, input.titleId, 'Título');
  assert(t.status !== 'cancelado', 'Título cancelado não pode ser liquidado.');
  assert(t.status !== 'liquidado', 'Este título já está totalmente liquidado.');
  assert(isISODate(input.date), 'Informe a data do pagamento/recebimento.');
  byId(db.accounts, input.accountId, 'Conta financeira');
  const amount = cents(D(input.amount));
  assert(amount.gt(0), 'O valor deve ser maior que zero.');
  const open = titleOpen(t);
  if (amount.gt(open)) throw new BusinessError(`O valor (R$ ${amount.toFixed(2)}) excede o saldo em aberto (R$ ${open.toFixed(2)}).`);
  t.settlements.push({ id: newId(), date: input.date, amount: amount.toString(), accountId: input.accountId, method: input.method });
  if (titleOpen(t).isZero()) t.status = 'liquidado';
  audit(db, t.direction === 'in' ? 'Recebimento' : 'Pagamento', `${t.description}: R$ ${amount.toFixed(2)}`);
}

/** Estorno de liquidação: mantém o histórico e reabre o saldo. */
export function reverseSettlement(db: DB, titleId: ID, settlementId: ID, reason: string) {
  const t = byId(db.titles, titleId, 'Título');
  const s = byId(t.settlements, settlementId, 'Liquidação');
  assert(!s.reversed, 'Esta liquidação já foi estornada.');
  s.reversed = { at: nowISO(), reason: requireText(reason, 'o motivo do estorno') };
  if (t.status === 'liquidado') t.status = 'aberto';
  audit(db, 'Estorno de liquidação', `${t.description}: R$ ${s.amount} — ${reason}`);
}

/**
 * Corrige um título. Descrição, vencimento, fornecedor/cliente e observações sempre podem mudar.
 * Valor, competência e categoria só em lançamentos manuais ainda sem pagamento
 * (títulos de compra/venda são corrigidos editando a compra/venda de origem).
 */
export function updateTitle(db: DB, titleId: ID, input: { description: string; dueDate: ISODate; partyId?: ID; notes?: string; amount?: string; competenceDate?: ISODate; categoryId?: ID }) {
  const t = byId(db.titles, titleId, 'Título');
  assert(t.status !== 'cancelado', 'Título cancelado não pode ser editado.');
  const description = requireText(input.description, 'a descrição');
  assert(isISODate(input.dueDate), 'Informe o vencimento.');
  if (input.partyId) byId(db.parties, input.partyId, 'Fornecedor/cliente');
  const amount = input.amount !== undefined ? cents(D(input.amount || '0')) : D(t.amount);
  const core = !amount.eq(D(t.amount)) || (input.competenceDate && input.competenceDate !== t.competenceDate) || (input.categoryId && input.categoryId !== t.categoryId);
  if (core) {
    assert(t.origin.kind === 'manual', `Este título foi gerado por uma ${t.origin.kind}. Para mudar valor, data ou categoria, edite a ${t.origin.kind} de origem.`);
    assert(titlePaid(t).isZero(), 'Há pagamento/recebimento registrado neste título. Estorne-o antes de mudar o valor.');
    assert(amount.gt(0), 'O valor deve ser maior que zero.');
    if (input.competenceDate) { assert(isISODate(input.competenceDate), 'Data de competência inválida.'); t.competenceDate = input.competenceDate; }
    if (input.categoryId) {
      const c = byId(db.finCategories, input.categoryId, 'Categoria financeira');
      assert(c.direction === t.direction, 'A categoria precisa ser do mesmo tipo (pagar/receber).');
      t.categoryId = c.id;
    }
    t.amount = amount.toString();
  }
  Object.assign(t, { description, dueDate: input.dueDate, partyId: input.partyId || undefined, notes: input.notes });
  audit(db, 'Título editado', description);
  return t;
}

export function cancelTitle(db: DB, titleId: ID, reason: string) {
  const t = byId(db.titles, titleId, 'Título');
  assert(t.status !== 'cancelado', 'Título já cancelado.');
  if (titlePaid(t).gt(0)) throw new BusinessError('Há pagamentos/recebimentos registrados neste título. Estorne-os antes de cancelar.');
  t.status = 'cancelado';
  t.cancelReason = requireText(reason, 'o motivo do cancelamento');
  audit(db, 'Título cancelado', `${t.description} — ${reason}`);
}

/* ------------------------------------------------------------------ */
/* Consultas                                                           */
/* ------------------------------------------------------------------ */
export function accountBalance(db: DB, accountId: ID, until?: ISODate): Decimal {
  const acc = byId(db.accounts, accountId, 'Conta');
  let bal = D(acc.openingBalance);
  for (const t of db.titles) {
    for (const s of t.settlements) {
      if (s.reversed || s.accountId !== accountId) continue;
      if (until && s.date > until) continue;
      bal = t.direction === 'in' ? bal.plus(D(s.amount)) : bal.minus(D(s.amount));
    }
  }
  return cents(bal);
}

export const cashBalance = (db: DB): Decimal => db.accounts.reduce((a, acc) => a.plus(accountBalance(db, acc.id)), ZERO);

export function openTotals(db: DB, today: ISODate) {
  let receivable = ZERO, payable = ZERO, overdueIn = ZERO, overdueOut = ZERO;
  for (const t of db.titles) {
    if (t.status !== 'aberto') continue;
    const open = titleOpen(t);
    if (t.direction === 'in') { receivable = receivable.plus(open); if (t.dueDate < today) overdueIn = overdueIn.plus(open); }
    else { payable = payable.plus(open); if (t.dueDate < today) overdueOut = overdueOut.plus(open); }
  }
  return { receivable, payable, overdueIn, overdueOut };
}

/** Fluxo de caixa realizado por mês (AAAA-MM). */
export function cashFlowByMonth(db: DB, from: ISODate, to: ISODate) {
  const map = new Map<string, { in: Decimal; out: Decimal }>();
  for (const t of db.titles) for (const s of t.settlements) {
    if (s.reversed || s.date < from || s.date > to) continue;
    const k = s.date.slice(0, 7);
    const row = map.get(k) ?? { in: ZERO, out: ZERO };
    if (t.direction === 'in') row.in = row.in.plus(D(s.amount)); else row.out = row.out.plus(D(s.amount));
    map.set(k, row);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v, net: v.in.minus(v.out) }));
}

/** Despesas por categoria (competência) — exclui estoque, investimento e retiradas. */
export function expensesByCategory(db: DB, from: ISODate, to: ISODate) {
  const map = new Map<ID, Decimal>();
  for (const t of db.titles) {
    if (t.direction !== 'out' || t.status === 'cancelado' || t.competenceDate < from || t.competenceDate > to) continue;
    const c = db.finCategories.find((x) => x.id === t.categoryId);
    if (!c || !['despesa_fixa', 'custo_variavel', 'outros'].includes(c.nature)) continue;
    map.set(c.id, (map.get(c.id) ?? ZERO).plus(D(t.amount)));
  }
  return [...map.entries()].map(([id, v]) => ({ category: db.finCategories.find((c) => c.id === id)!, amount: v })).sort((a, b) => b.amount.cmp(a.amount));
}

/** Capital investido: aportes e investimentos em ativos (competência), para leitura do investimento acumulado. */
export function investedCapital(db: DB) {
  let assets = ZERO, contributions = ZERO;
  for (const t of db.titles) {
    if (t.status === 'cancelado') continue;
    const c = db.finCategories.find((x) => x.id === t.categoryId);
    if (c?.nature === 'investimento') assets = assets.plus(D(t.amount));
    if (c?.nature === 'aporte') contributions = contributions.plus(D(t.amount));
  }
  return { assets, contributions };
}

/** Saídas previstas em aberto nos próximos N dias versus saldo de caixa. */
export function cashNeed(db: DB, today: ISODate, days = 30) {
  const limit = addDays(today, days);
  let inflow = ZERO, outflow = ZERO;
  for (const t of db.titles) {
    if (t.status !== 'aberto' || t.dueDate > limit) continue;
    if (t.direction === 'in') inflow = inflow.plus(titleOpen(t)); else outflow = outflow.plus(titleOpen(t));
  }
  const cash = cashBalance(db);
  return { cash, inflow, outflow, projected: cash.plus(inflow).minus(outflow) };
}

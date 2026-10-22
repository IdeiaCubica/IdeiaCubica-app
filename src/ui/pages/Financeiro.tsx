import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { FinTitle, PaymentTerms, Sale } from '../../domain/types';
import { accountBalance, cancelTitle, cashBalance, cashFlowByMonth, cashNeed, createManualTitle, expensesByCategory, investedCapital, openTotals, reverseSettlement, settleTitle, titleOpen, titlePaid } from '../../domain/finance';
import { finishedGoodBalance } from '../../domain/production';
import { breakEven, cancelSale, managementResult, registerSale, resolveSaleCost, resultByProject, saleEconomics, saleGross } from '../../domain/sales';
import { channelRates } from '../../domain/pricing';
import { itemState, quoteItem, quoteItemAt, quoteItems } from '../../domain/quotes';
import { addDays, fmtDate, todayISO } from '../../domain/core';
import { D, ZERO, cents, fmtBRL, fmtPct, parseBR } from '../../domain/money';
import { Alert, Badge, Check, Combobox, DataTable, DateField, Empty, Kpi, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, dec, num, useConfirm, useForm, type Tone } from '../components/ui';
import { NATURE_LABEL } from './Configuracoes';

type Tab = 'painel' | 'titulos' | 'vendas' | 'resultado';

const monthRange = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
};
const monthLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${m}/${y}`; };

export function Financeiro({ param }: { param?: string }) {
  const { db } = useStore();
  const tab = (param as Tab) || 'painel';
  const [manual, setManual] = useState(false);
  const [selling, setSelling] = useState(false);
  const today = todayISO();
  const overdue = db.titles.filter((t) => t.status === 'aberto' && t.dueDate < today).length;
  return (
    <>
      <PageHead eyebrow="Módulo 3" title="Financeiro" text="Fluxo de caixa, resultado gerencial e investimentos — visões separadas, sem tratar todo recebimento como lucro."
        actions={<><button className="btn secondary" onClick={() => setManual(true)}>Novo lançamento</button><button className="btn primary" onClick={() => setSelling(true)}>Registrar venda</button></>} />
      {db.accounts.length === 0 && <div style={{ marginBottom: 16 }}><Alert tone="warning" title="Nenhuma conta financeira">Cadastre ao menos uma conta em <a href="#/config/contas">Configurações → Contas financeiras</a> para registrar pagamentos e recebimentos.</Alert></div>}
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`financeiro/${t}`)} tabs={[
        { id: 'painel', label: 'Painel' }, { id: 'titulos', label: 'Contas a pagar e receber', count: overdue || undefined },
        { id: 'vendas', label: 'Vendas', count: db.sales.length }, { id: 'resultado', label: 'Resultado por produto' },
      ]} />
      {tab === 'painel' && <Painel />}
      {tab === 'titulos' && <Titulos />}
      {tab === 'vendas' && <Vendas onNew={() => setSelling(true)} />}
      {tab === 'resultado' && <Resultado />}
      {manual && <ManualForm onClose={() => setManual(false)} />}
      {selling && <SaleForm onClose={() => setSelling(false)} />}
    </>
  );
}

/* ---------------- Painel ---------------- */
function Painel() {
  const { db } = useStore();
  const today = todayISO();
  const [ym, setYm] = useState(today.slice(0, 7));
  const { from, to } = monthRange(ym);
  const res = managementResult(db, from, to);
  const open = openTotals(db, today);
  const need = cashNeed(db, today, 30);
  const inv = investedCapital(db);
  const fixedMonthly = db.overheads.reduce((a, o) => a.plus(D(o.monthlyAmount)), ZERO);
  const be = fixedMonthly.gt(0) ? breakEven(fixedMonthly, res.contributionPct) : null;
  const flowFrom = monthRange(addDays(`${ym}-01`, -150).slice(0, 7)).from;
  const flow = cashFlowByMonth(db, flowFrom, to);
  const expenses = expensesByCategory(db, from, to);
  const resTone: Tone = res.status === 'realizado' ? 'success' : res.status === 'estimado' ? 'warning' : 'error';
  return (
    <div className="stack">
      <div className="row"><label className="muted">Período de competência:</label><input type="month" value={ym} onChange={(e) => e.target.value && setYm(e.target.value)} style={{ height: 'var(--control-h)', border: '1px solid var(--n-300)', borderRadius: 'var(--r-control)', padding: '0 14px', font: 'inherit', background: '#fff' }} /></div>
      <div className="kpis">
        <Kpi accent label="Saldo de caixa (hoje)" value={fmtBRL(cashBalance(db))} hint={`${db.accounts.length} conta(s)`} />
        <Kpi label="A receber" value={fmtBRL(open.receivable)} hint={open.overdueIn.gt(0) ? <span style={{ color: 'var(--error)' }}>{fmtBRL(open.overdueIn)} vencido</span> : 'nada vencido'} />
        <Kpi label="A pagar" value={fmtBRL(open.payable)} hint={open.overdueOut.gt(0) ? <span style={{ color: 'var(--error)' }}>{fmtBRL(open.overdueOut)} vencido</span> : 'nada vencido'} />
        <Kpi label="Caixa projetado em 30 dias" value={<span style={{ color: need.projected.isNegative() ? 'var(--error)' : undefined }}>{fmtBRL(need.projected)}</span>} hint={`+${fmtBRL(need.inflow)} / −${fmtBRL(need.outflow)}`} />
      </div>
      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h2>Resultado gerencial · {monthLabel(ym)}</h2><Badge tone={resTone}>{res.status === 'parcial' ? 'parcialmente apurado' : res.status}</Badge></div>
          <div className="card-body">
            {res.salesCount === 0 && res.fixed.isZero() ? <p className="muted">Sem vendas ou despesas fixas lançadas neste período.</p> : (
              <dl className="dl">
                <dt>Receita de vendas ({res.salesCount})</dt><dd className="right">{fmtBRL(res.revenue)}</dd>
                <dt>Tributos e taxas de venda</dt><dd className="right">− {fmtBRL(res.fees)}</dd>
                <dt>Frete (cobrado − pago)</dt><dd className="right">{fmtBRL(res.freightNet)}</dd>
                <dt>Custo dos produtos vendidos</dt><dd className="right">− {fmtBRL(res.cogs)}</dd>
                <dt><b>Margem de contribuição</b></dt><dd className="right"><b>{fmtBRL(res.contribution)}</b> ({fmtPct(res.contributionPct)})</dd>
                <dt>Despesas fixas (competência)</dt><dd className="right">− {fmtBRL(res.fixed)}</dd>
                {(res.otherIn.gt(0) || res.otherOut.gt(0)) && <><dt>Outras receitas/despesas</dt><dd className="right">{fmtBRL(res.otherIn.minus(res.otherOut))}</dd></>}
                <dt><b>Resultado operacional</b></dt><dd className="right" style={{ color: res.operating.isNegative() ? 'var(--error)' : undefined }}><b>{fmtBRL(res.operating)}</b></dd>
              </dl>
            )}
            {res.pendingCost > 0 && <p className="small" style={{ color: 'var(--error)', marginTop: 8 }}>{res.pendingCost} venda(s) sem custo de fabricação: resultado superestimado.</p>}
            {res.estimatedCost > 0 && <p className="small muted" style={{ marginTop: 4 }}>{res.estimatedCost} venda(s) com custo estimado (orçamento, ou OP sem mão de obra real apurada).</p>}
            <p className="small muted" style={{ marginTop: 8 }}>Compras de insumos (estoque) e de equipamentos (investimento) não são despesas do período: o material vira custo quando vendido; a impressora, via depreciação no custo das peças.</p>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Sustentação da estrutura</h2></div>
          <div className="card-body stack">
            <dl className="dl">
              <dt>Despesas indiretas mensais previstas</dt><dd className="right">{fmtBRL(fixedMonthly)}</dd>
              <dt>Margem de contribuição média ({monthLabel(ym)})</dt><dd className="right">{fmtPct(res.contributionPct)}</dd>
              <dt><b>Receita mensal necessária (ponto de equilíbrio)</b></dt><dd className="right"><b>{be ? fmtBRL(be) : '—'}</b></dd>
              <dt>Investido em equipamentos/ativos</dt><dd className="right">{fmtBRL(inv.assets)}</dd>
              <dt>Aportes de capital</dt><dd className="right">{fmtBRL(inv.contributions)}</dd>
            </dl>
            {!be && <p className="small muted">O ponto de equilíbrio exige vendas no período (para a margem média) e despesas indiretas cadastradas.</p>}
          </div>
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h2>Fluxo de caixa realizado</h2><span className="muted small">últimos meses</span></div>
          {flow.length === 0 ? <div className="card-body muted">Nenhum pagamento ou recebimento registrado.</div> : (
            <table className="tbl"><thead><tr><th>Mês</th><th className="num">Entradas</th><th className="num">Saídas</th><th className="num">Saldo do mês</th></tr></thead><tbody>
              {flow.map((r) => <tr key={r.month}><td>{monthLabel(r.month)}</td><td className="num">{fmtBRL(r.in)}</td><td className="num">{fmtBRL(r.out)}</td><td className="num" style={{ color: r.net.isNegative() ? 'var(--error)' : undefined }}>{fmtBRL(r.net)}</td></tr>)}
            </tbody></table>)}
        </div>
        <div className="card">
          <div className="card-head"><h2>Despesas por categoria · {monthLabel(ym)}</h2></div>
          {expenses.length === 0 ? <div className="card-body muted">Nenhuma despesa no período.</div> : (
            <div className="card-body stack" style={{ gap: 10 }}>
              {expenses.map((e) => { const max = expenses[0].amount; return (
                <div key={e.category.id}><div className="row" style={{ justifyContent: 'space-between' }}><span>{e.category.name}</span><b className="num">{fmtBRL(e.amount)}</b></div>
                  <div className="bar"><i style={{ width: `${max.isZero() ? 0 : e.amount.div(max).times(100).toNumber()}%` }} /></div></div>); })}
            </div>)}
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Contas</h2></div>
        <table className="tbl"><tbody>{db.accounts.map((a) => <tr key={a.id}><td>{a.name}</td><td className="num"><b>{fmtBRL(accountBalance(db, a.id))}</b></td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

/* ---------------- Títulos ---------------- */
function Titulos() {
  const { db } = useStore();
  const today = todayISO();
  const [dir, setDir] = useState<'' | 'in' | 'out'>('');
  const [status, setStatus] = useState('aberto');
  const [sel, setSel] = useState<FinTitle | null>(null);
  const rows = db.titles.filter((t) => (!dir || t.direction === dir) && (!status || t.status === status));
  const total = rows.reduce((a, t) => a.plus(titleOpen(t).times(t.direction === 'in' ? 1 : -1)), ZERO);
  return (
    <div className="card">
      <DataTable rows={rows} rowKey={(t) => t.id} onRowClick={setSel} initialSort={{ key: 'v', dir: 1 }}
        search={(t) => `${t.description} ${db.parties.find((p) => p.id === t.partyId)?.name ?? ''}`}
        toolbar={<>
          <Combobox compact ariaLabel="Tipo de título" value={dir} onChange={(v) => setDir(v as typeof dir)} placeholder="Pagar e receber" options={[{ value: 'out', label: 'A pagar' }, { value: 'in', label: 'A receber' }]} />
          <Combobox compact ariaLabel="Situação do título" value={status} onChange={setStatus} placeholder="Todas as situações" options={[{ value: 'aberto', label: 'Em aberto' }, { value: 'liquidado', label: 'Liquidados' }, { value: 'cancelado', label: 'Cancelados' }]} />
        </>}
        empty={<Empty title="Nenhum título neste filtro" text="Compras a prazo, vendas e lançamentos manuais geram títulos automaticamente." />}
        columns={[
          { key: 'v', header: 'Vencimento', render: (t) => <span className="nowrap">{fmtDate(t.dueDate)} {t.status === 'aberto' && t.dueDate < today && <Badge tone="error">vencido</Badge>}</span>, sort: (t) => t.dueDate },
          { key: 'k', header: 'Tipo', render: (t) => t.direction === 'in' ? <Badge tone="success">receber</Badge> : <Badge tone="warning">pagar</Badge> },
          { key: 'd', header: 'Descrição', render: (t) => <><b>{t.description}</b><div className="muted small">{db.finCategories.find((c) => c.id === t.categoryId)?.name}</div></>, sort: (t) => t.description },
          { key: 'a', header: 'Valor', num: true, render: (t) => fmtBRL(t.amount), sort: (t) => D(t.amount).toNumber() },
          { key: 'o', header: 'Em aberto', num: true, render: (t) => fmtBRL(titleOpen(t)) },
          { key: 's', header: 'Situação', render: (t) => <Badge tone={t.status === 'liquidado' ? 'success' : t.status === 'cancelado' ? 'neutral' : 'info'}>{t.status}</Badge> },
        ]}
        footer={rows.length ? <tr><td colSpan={4}>Saldo em aberto do filtro (receber − pagar)</td><td className="num">{fmtBRL(total)}</td><td /></tr> : undefined} />
      {sel && <TitleModal title={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function TitleModal({ title, onClose }: { title: FinTitle; onClose: () => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const t = db.titles.find((x) => x.id === title.id)!;
  const open = titleOpen(t);
  const [f, set] = useForm({ date: todayISO(), amount: open.toFixed(2).replace('.', ','), accountId: db.accounts.find((a) => a.active)?.id ?? '', method: t.method ?? '' });
  const verb = t.direction === 'in' ? 'recebimento' : 'pagamento';
  const settle = () => run((d) => settleTitle(d, { titleId: t.id, date: f.date, amount: dec(f.amount) ?? '0', accountId: f.accountId, method: f.method }), `${verb[0].toUpperCase() + verb.slice(1)} registrado.`);
  const reverse = async (sid: string) => {
    const reason = await confirm({ title: `Estornar ${verb}?`, danger: true, confirmLabel: 'Estornar', reasonLabel: 'Motivo do estorno', text: 'O valor volta a ficar em aberto. O registro original é mantido no histórico.' });
    if (reason) run((d) => reverseSettlement(d, t.id, sid, reason), 'Estorno registrado.');
  };
  const cancel = async () => {
    const reason = await confirm({ title: 'Cancelar título?', danger: true, confirmLabel: 'Cancelar título', reasonLabel: 'Motivo', text: t.origin.kind !== 'manual' ? `Este título foi gerado por uma ${t.origin.kind}. Prefira cancelar a ${t.origin.kind} de origem para manter estoque e financeiro consistentes.` : 'O título deixará de compor saldos e resultados.' });
    if (reason) run((d) => cancelTitle(d, t.id, reason), 'Título cancelado.');
  };
  const cat = db.finCategories.find((c) => c.id === t.categoryId);
  return (
    <Modal wide title={t.description} subtitle={`${t.direction === 'in' ? 'Conta a receber' : 'Conta a pagar'} · ${cat?.name} (${cat ? NATURE_LABEL[cat.nature] : ''})`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button>{t.status !== 'cancelado' && titlePaid(t).isZero() && <button className="btn danger" onClick={cancel}>Cancelar título</button>}</>}>
      <div className="stack">
        {t.status === 'cancelado' && <Alert tone="error" title="Cancelado">{t.cancelReason}</Alert>}
        <dl className="dl">
          <dt>Valor</dt><dd>{fmtBRL(t.amount)}</dd><dt>Competência</dt><dd>{fmtDate(t.competenceDate)}</dd><dt>Vencimento</dt><dd>{fmtDate(t.dueDate)}</dd>
          <dt>Pago/recebido</dt><dd>{fmtBRL(titlePaid(t))}</dd><dt>Em aberto</dt><dd><b>{fmtBRL(open)}</b></dd>
          {t.partyId && <><dt>{t.direction === 'in' ? 'Cliente' : 'Fornecedor'}</dt><dd>{db.parties.find((p) => p.id === t.partyId)?.name}</dd></>}
          <dt>Origem</dt><dd>{t.origin.kind === 'compra' ? `Compra ${db.purchases.find((p) => p.id === t.origin.id)?.number}` : t.origin.kind === 'venda' ? `Venda ${db.sales.find((s) => s.id === t.origin.id)?.number}` : 'Lançamento manual'}</dd>
        </dl>
        {t.settlements.length > 0 && <div className="card"><table className="tbl"><thead><tr><th>Data</th><th>Conta</th><th className="num">Valor</th><th /></tr></thead><tbody>
          {t.settlements.map((s) => <tr key={s.id} className={s.reversed ? 'muted' : ''}><td>{fmtDate(s.date)}</td><td>{db.accounts.find((a) => a.id === s.accountId)?.name} {s.method && <span className="muted small">· {s.method}</span>}</td>
            <td className="num">{s.reversed ? <s>{fmtBRL(s.amount)}</s> : fmtBRL(s.amount)}</td>
            <td className="right">{s.reversed ? <span className="small">estornado: {s.reversed.reason}</span> : <button className="btn ghost sm" onClick={() => reverse(s.id)}>Estornar</button>}</td></tr>)}
        </tbody></table></div>}
        {t.status === 'aberto' && (
          <div className="card"><div className="card-body">
            <h3 style={{ marginBottom: 10 }}>Registrar {verb}</h3>
            <div className="grid g4" style={{ alignItems: 'end' }}>
              <DateField label="Data" value={f.date} onChange={set('date')} />
              <NumField label="Valor" suffix="R$" value={f.amount} onChange={set('amount')} hint="Pode ser parcial" />
              <SelectField label="Conta" value={f.accountId} onChange={set('accountId')} placeholder="— selecione —" options={db.accounts.filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))} />
              <button className="btn primary" onClick={settle}>Confirmar {verb}</button>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>A liquidação baixa o saldo deste título; não cria nova despesa ou receita.</p>
          </div></div>
        )}
      </div>
      {confirmEl}
    </Modal>
  );
}

/* ---------------- Condições de pagamento (compartilhado) ---------------- */
function useTerms(defaultDate: string) {
  const { db } = useStore();
  const [p, set] = useForm({ mode: 'avista' as PaymentTerms['mode'], accountId: db.accounts.find((a) => a.active)?.id ?? '', method: 'PIX', installments: '1', firstDue: addDays(defaultDate, 30), intervalDays: '30' });
  const toTerms = (date: string): PaymentTerms => p.mode === 'avista'
    ? { mode: 'avista', accountId: p.accountId || undefined, method: p.method, installments: 1, firstDue: date, intervalDays: 30 }
    : { mode: 'aprazo', method: p.method, installments: num(p.installments) ?? 0, firstDue: p.firstDue, intervalDays: num(p.intervalDays) ?? 0 };
  const fields = (labelIn: boolean) => (
    <div className="grid g4">
      <SelectField label="Condição" value={p.mode} onChange={(v) => set('mode')(v as PaymentTerms['mode'])} options={[{ value: 'avista', label: labelIn ? 'À vista (recebido agora)' : 'À vista (pago agora)' }, { value: 'aprazo', label: labelIn ? 'A prazo (conta a receber)' : 'A prazo (conta a pagar)' }]} />
      <TextField label="Forma" value={p.method} onChange={set('method')} placeholder="PIX, cartão, boleto…" />
      {p.mode === 'avista' ? <SelectField label="Conta" value={p.accountId} onChange={set('accountId')} placeholder="— selecione —" options={db.accounts.filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))} />
        : <><NumField label="Parcelas" value={p.installments} onChange={set('installments')} /><DateField label="1º vencimento" value={p.firstDue} onChange={set('firstDue')} /><NumField label="Intervalo" suffix="dias" value={p.intervalDays} onChange={set('intervalDays')} /></>}
    </div>
  );
  return { toTerms, fields };
}

function ManualForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ categoryId: db.finCategories.find((c) => c.nature === 'despesa_fixa')?.id ?? '', description: '', amount: '', date: todayISO(), partyId: '', notes: '' });
  const terms = useTerms(f.date);
  const cat = db.finCategories.find((c) => c.id === f.categoryId);
  const submit = () => run((d) => createManualTitle(d, { categoryId: f.categoryId, description: f.description, amount: dec(f.amount) ?? '0', competenceDate: f.date, partyId: f.partyId || undefined, terms: terms.toTerms(f.date), notes: f.notes }),
    'Lançamento registrado.').then((r) => r.ok && onClose());
  return (
    <Modal wide title="Novo lançamento financeiro" subtitle="Despesas, receitas avulsas, investimentos e aportes. Compras de insumos e vendas têm telas próprias integradas." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Lançar</button></>}>
      <div className="stack">
        <div className="grid g3">
          <SelectField label="Categoria" required value={f.categoryId} onChange={set('categoryId')} options={db.finCategories.filter((c) => !c.system).map((c) => ({ value: c.id, label: `${c.direction === 'in' ? '↓' : '↑'} ${c.name}` }))} hint={cat ? NATURE_LABEL[cat.nature] : undefined} />
          <TextField label="Descrição" required value={f.description} onChange={set('description')} />
          <NumField label="Valor total" suffix="R$" required value={f.amount} onChange={set('amount')} />
          <DateField label="Data de competência" value={f.date} onChange={set('date')} hint="Quando a despesa/receita ocorreu" />
          <SelectField label="Fornecedor / cliente" value={f.partyId} onChange={set('partyId')} placeholder="—" options={db.parties.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
        {cat?.nature === 'investimento' && <Alert tone="info">Investimento em ativo: não entra no resultado do período nem no custo de uma peça. Ele é recuperado pela depreciação por hora cadastrada na impressora.</Alert>}
        {terms.fields(cat?.direction === 'in')}
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

/* ---------------- Vendas ---------------- */
function Vendas({ onNew }: { onNew: () => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const cancel = async (s: Sale) => {
    const reason = await confirm({ title: `Cancelar venda ${s.number}?`, danger: true, confirmLabel: 'Cancelar venda', reasonLabel: 'Motivo', text: 'Os títulos gerados serão cancelados. Recebimentos devem ser estornados antes.' });
    if (reason) run((d) => cancelSale(d, s.id, reason), 'Venda cancelada.');
  };
  return (
    <div className="card">
      <DataTable rows={[...db.sales].reverse()} rowKey={(s) => s.id} search={(s) => `${s.number} ${s.description} ${db.parties.find((p) => p.id === s.customerId)?.name ?? ''}`}
        empty={<Empty title="Nenhuma venda registrada" text="Ao registrar uma venda, o sistema gera contas a receber, encargos do canal e calcula a margem com o custo realizado (OP) ou estimado (orçamento)." action={<button className="btn primary" onClick={onNew}>Registrar venda</button>} />}
        columns={[
          { key: 'n', header: 'Venda', render: (s) => <span className="mono">{s.number}</span>, sort: (s) => s.number },
          { key: 'd', header: 'Data', render: (s) => fmtDate(s.date), sort: (s) => s.date },
          { key: 'p', header: 'Produto', render: (s) => <><b>{s.description}</b><div className="muted small">{s.qty} un · {db.parties.find((p) => p.id === s.customerId)?.name ?? ''} · {db.channels.find((c) => c.id === s.channelId)?.name ?? 'sem canal'}</div></> },
          { key: 'r', header: 'Receita', num: true, render: (s) => fmtBRL(saleGross(s)) },
          { key: 'f', header: 'Encargos', num: true, render: (s) => fmtBRL(s.fees.total) },
          { key: 'c', header: 'Custo', num: true, render: (s) => { const e = saleEconomics(s); return e.cogs ? <>{fmtBRL(e.cogs)} <Badge tone={s.costStatus === 'realizado' ? 'success' : 'warning'}>{s.costStatus}</Badge></> : <Badge tone="error">pendente</Badge>; } },
          { key: 'm', header: 'Contribuição', num: true, render: (s) => { const e = saleEconomics(s); return e.contribution ? <span style={{ color: e.contribution.isNegative() ? 'var(--error)' : undefined }}>{fmtBRL(e.contribution)} ({fmtPct(e.revenue.isZero() ? null : e.contribution.div(e.revenue))})</span> : '—'; } },
          { key: 's', header: '', render: (s) => s.status === 'cancelada' ? <Badge>cancelada</Badge> : <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); cancel(s); }}>Cancelar</button> },
        ]} />
      {confirmEl}
    </div>
  );
}

export function SaleForm({ onClose, preset }: { onClose: () => void; preset?: { finishedGoodId?: string; orderId?: string; quoteId?: string; itemId?: string } }) {
  const { db, run } = useStore();
  const [f, set, setF] = useForm(() => {
    const base = { date: todayISO(), description: '', projectId: '', customerId: '', quoteId: '', quoteItemId: '', orderId: '', finishedGoodId: '', qty: '1', unitPrice: '', discount: '', freightCharged: '', freightCost: '',
      channelId: db.channels.find((c) => c.active)?.id ?? '', feesWithheld: true, manualUnitCost: '', notes: '' };
    // Peça do estoque separada para um pedido aprovado
    const pq = db.quotes.find((x) => x.id === preset?.quoteId);
    if (pq) {
      const it = quoteItem(pq, preset?.itemId);
      return { ...base, quoteId: pq.id, quoteItemId: it.itemId, finishedGoodId: it.finishedGoodId ?? '', description: it.name, projectId: pq.projectId ?? '', customerId: pq.customerId ?? '',
        qty: String(it.input.quantity), unitPrice: it.summary.unitPrice ? it.summary.unitPrice.replace('.', ',') : '', channelId: it.input.channelId ?? base.channelId };
    }
    const fg = db.finishedGoods.find((x) => x.id === preset?.finishedGoodId);
    if (fg) return { ...base, finishedGoodId: fg.id, description: fg.description, projectId: fg.projectId ?? '', unitPrice: fg.suggestedPrice ? fg.suggestedPrice.replace('.', ',') : '' };
    const o = db.orders.find((x) => x.id === preset?.orderId);
    if (o) {
      const q = db.quotes.find((x) => x.id === o.quoteId);
      const it = q ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) : undefined;
      const price = it?.summary.unitPrice ?? null;
      return { ...base, orderId: o.id, quoteId: q?.id ?? '', quoteItemId: it?.itemId ?? '', description: o.description, projectId: o.projectId ?? '', customerId: o.customerId ?? q?.customerId ?? '',
        qty: String(o.actual?.qtyApproved ?? o.qtyPlanned), unitPrice: price ? price.replace('.', ',') : '', channelId: it?.input.channelId ?? base.channelId };
    }
    return base;
  });
  const terms = useTerms(f.date);
  const fgOptions = db.finishedGoods.map((g) => ({ g, available: finishedGoodBalance(db, g.id).available }))
    .filter((x) => x.available > 0 || x.g.id === f.finishedGoodId)
    .map(({ g, available }) => ({ value: g.id, label: `${g.code} · ${g.description} · ${available} disponível(is)` }));
  const pickFinished = (id: string) => {
    const g = db.finishedGoods.find((x) => x.id === id);
    setF((s) => g ? { ...s, finishedGoodId: id, orderId: '', quoteId: '', description: g.description, projectId: g.projectId ?? s.projectId,
      unitPrice: g.suggestedPrice ? g.suggestedPrice.replace('.', ',') : s.unitPrice } : { ...s, finishedGoodId: '' });
  };
  const pickQuote = (key: string) => {
    const [qid, iid] = key.split('|');
    const q = db.quotes.find((x) => x.id === qid);
    if (!q) { setF((s) => ({ ...s, quoteId: '', quoteItemId: '' })); return; }
    const it = quoteItem(q, iid);
    const order = db.orders.find((o) => o.quoteId === q.id && o.quoteItemId === it.itemId && o.status === 'concluida');
    setF((s) => ({ ...s, quoteId: q.id, quoteItemId: it.itemId, description: it.name, projectId: q.projectId ?? s.projectId, customerId: q.customerId ?? s.customerId,
      qty: String(order?.actual?.qtyApproved ?? it.input.quantity), unitPrice: it.summary.unitPrice ? it.summary.unitPrice.replace('.', ',') : s.unitPrice,
      channelId: it.input.channelId ?? s.channelId, orderId: order?.id ?? '', finishedGoodId: it.finishedGoodId ?? (order ? '' : s.finishedGoodId) }));
  };
  const quoteOptions = db.quotes.filter((q) => q.status !== 'recusado').flatMap((q) => quoteItems(q).filter((it) => itemState(db, q, it.itemId) !== 'recusado')
    .map((it) => ({ value: `${q.id}|${it.itemId}`, label: `${q.number} · ${it.name}` })));
  const preview = useMemo(() => {
    const qty = num(f.qty) ?? 0;
    const price = parseBR(f.unitPrice);
    if (!price || qty <= 0) return null;
    const gross = cents(price.times(qty).minus(parseBR(f.discount) ?? 0));
    const ch = channelRates(db.channels.find((c) => c.id === f.channelId) ?? null);
    const fees = ch ? cents(gross.times(ch.rates).plus(ch.fixedFee)) : ZERO;
    let cost: ReturnType<typeof resolveSaleCost> = { unitCost: null, status: 'pendente' };
    try { cost = resolveSaleCost(db, { finishedGoodId: f.finishedGoodId || undefined, orderId: f.orderId || undefined, quoteId: f.quoteId || undefined, quoteItemId: f.quoteItemId || undefined, manualUnitCost: dec(f.manualUnitCost) }); } catch { /* ignora na prévia */ }
    const freightNet = (parseBR(f.freightCharged) ?? ZERO).minus(parseBR(f.freightCost) ?? ZERO);
    const receivable = gross.plus(parseBR(f.freightCharged) ?? 0).minus(f.feesWithheld ? fees : 0);
    const cogs = cost.unitCost ? cents(cost.unitCost.times(qty)) : null;
    return { gross, fees, receivable, cost, contribution: cogs ? gross.minus(fees).plus(freightNet).minus(cogs) : null, cogs };
  }, [f, db]);
  const submit = () => run((d) => registerSale(d, {
    date: f.date, description: f.description, projectId: f.projectId || undefined, customerId: f.customerId || undefined, quoteId: f.quoteId || undefined, quoteItemId: f.quoteItemId || undefined, orderId: f.orderId || undefined,
    finishedGoodId: f.finishedGoodId || undefined, qty: num(f.qty) ?? 0, unitPrice: dec(f.unitPrice) ?? '0', discount: dec(f.discount) ?? '0', freightCharged: dec(f.freightCharged) ?? '0', freightCost: dec(f.freightCost) ?? '0',
    channelId: f.channelId || undefined, feesWithheld: f.feesWithheld, manualUnitCost: dec(f.manualUnitCost), payment: terms.toTerms(f.date), notes: f.notes,
  }), 'Venda registrada e financeiro atualizado.').then((r) => r.ok && onClose());
  const done = db.orders.filter((o) => o.status === 'concluida');
  return (
    <Modal wide title="Registrar venda" subtitle="Gera conta a receber (ou recebimento à vista), encargos do canal e o snapshot do custo para a margem." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Registrar venda</button></>}>
      <div className="stack">
        <div className="grid g3">
          <SelectField label="A partir do orçamento (peça)" value={f.quoteId ? `${f.quoteId}|${f.quoteItemId}` : ''} onChange={pickQuote} placeholder="— nenhum —" options={quoteOptions} hint="Preenche produto, quantidade, preço e canal" />
          <SelectField label="Ordem de produção (custo realizado)" value={f.orderId} onChange={(v) => setF((s) => ({ ...s, orderId: v, finishedGoodId: v ? '' : s.finishedGoodId }))} placeholder="— nenhuma —" options={done.map((o) => ({ value: o.id, label: `${o.number} · ${o.description}` }))} />
          <SelectField label="Peça pronta do estoque" value={f.finishedGoodId} onChange={pickFinished} placeholder="— nenhuma —" options={fgOptions} hint="Baixa o saldo de pronta-entrega" />
          <DateField label="Data da venda" required value={f.date} onChange={set('date')} />
          <TextField label="Produto / descrição" required value={f.description} onChange={set('description')} />
          <SelectField label="Projeto" value={f.projectId} onChange={set('projectId')} placeholder="—" options={db.projects.map((p) => ({ value: p.id, label: p.name }))} hint="Agrupa o resultado por produto" />
          <SelectField label="Cliente" value={f.customerId} onChange={set('customerId')} placeholder="—" options={db.parties.filter((p) => p.kind === 'cliente').map((p) => ({ value: p.id, label: p.name }))} />
          <NumField label="Quantidade" required value={f.qty} onChange={set('qty')} />
          <NumField label="Preço unitário" suffix="R$" required value={f.unitPrice} onChange={set('unitPrice')} />
          <NumField label="Desconto total" suffix="R$" value={f.discount} onChange={set('discount')} />
          <SelectField label="Canal de venda" value={f.channelId} onChange={set('channelId')} placeholder="— sem encargos —" options={db.channels.map((c) => ({ value: c.id, label: c.name }))} />
          <NumField label="Frete cobrado do cliente" suffix="R$" value={f.freightCharged} onChange={set('freightCharged')} />
          <NumField label="Frete pago pela empresa" suffix="R$" value={f.freightCost} onChange={set('freightCost')} hint="Gera conta a pagar" />
        </div>
        <Check label="Encargos retidos pelo canal (marketplace/gateway repassa o valor líquido)" checked={f.feesWithheld} onChange={set('feesWithheld')} />
        {!f.quoteId && !f.orderId && !f.finishedGoodId && <NumField label="Custo unitário de fabricação (estimado)" suffix="R$" value={f.manualUnitCost} onChange={set('manualUnitCost')} hint="Sem orçamento/OP vinculados, informe o custo para calcular a margem. Vazio = margem pendente." />}
        {preview && (
          <div className="card"><div className="card-body">
            <dl className="dl">
              <dt>Receita de produtos</dt><dd className="right">{fmtBRL(preview.gross)}</dd>
              <dt>Encargos do canal</dt><dd className="right">− {fmtBRL(preview.fees)}</dd>
              <dt>Custo de fabricação</dt><dd className="right">{preview.cogs ? <>− {fmtBRL(preview.cogs)} <Badge tone={preview.cost.status === 'realizado' ? 'success' : 'warning'}>{preview.cost.status}</Badge></> : <Badge tone="error">pendente</Badge>}</dd>
              <dt><b>Margem de contribuição</b></dt><dd className="right"><b>{preview.contribution ? fmtBRL(preview.contribution) : '—'}</b></dd>
              <dt>Valor a receber</dt><dd className="right">{fmtBRL(preview.receivable)}</dd>
            </dl>
          </div></div>
        )}
        <p className="section-title">Recebimento</p>
        {terms.fields(true)}
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
        <p className="small muted">Ao escolher uma peça pronta do estoque, a venda baixa o saldo de pronta-entrega (cancelar a venda devolve as peças ao saldo).</p>
      </div>
    </Modal>
  );
}

/* ---------------- Resultado por produto ---------------- */
function Resultado() {
  const { db } = useStore();
  const rows = resultByProject(db);
  const salesCount = db.sales.filter((s) => s.status === 'ativa').length;
  return (
    <div className="stack">
      {salesCount > 0 && salesCount < 5 && <Alert tone="info">Apenas {salesCount} venda(s) registrada(s): use os números como acompanhamento, não como ranking conclusivo.</Alert>}
      <div className="card">
        <DataTable rows={rows} rowKey={(r) => r.key} initialSort={{ key: 'mc', dir: -1 }}
          empty={<Empty title="Sem vendas para analisar" text="O resultado por produto aparece conforme as vendas são registradas (vincule-as a um projeto para agrupar corretamente)." />}
          columns={[
            { key: 'n', header: 'Produto / projeto', render: (r) => <b>{r.name}</b>, sort: (r) => r.name },
            { key: 'q', header: 'Qtd. vendida', num: true, render: (r) => r.qty, sort: (r) => r.qty },
            { key: 'r', header: 'Receita', num: true, render: (r) => fmtBRL(r.revenue), sort: (r) => r.revenue.toNumber() },
            { key: 'f', header: 'Encargos', num: true, render: (r) => fmtBRL(r.fees) },
            { key: 'c', header: 'Custos variáveis', num: true, render: (r) => fmtBRL(r.cogs) },
            { key: 'mc', header: 'Margem de contribuição', num: true, render: (r) => <span style={{ color: r.contribution.isNegative() ? 'var(--error)' : undefined }}>{fmtBRL(r.contribution)}</span>, sort: (r) => r.contribution.toNumber() },
            { key: 'p', header: 'MC %', num: true, render: (r) => fmtPct(r.contributionPct), sort: (r) => r.contributionPct?.toNumber() ?? -999 },
            { key: 'u', header: 'Por unidade', num: true, render: (r) => fmtBRL(r.unitContribution) },
            { key: 's', header: 'Apuração', render: (r) => <Badge tone={r.status === 'realizado' ? 'success' : r.status === 'estimado' ? 'warning' : 'error'}>{r.status === 'parcial' ? 'parcial' : r.status}</Badge> },
          ]} />
      </div>
      <p className="small muted">Custos fixos não são distribuídos por produto aqui: a margem de contribuição mostra quanto cada produto ajuda a pagar a estrutura. Produtos com MC baixa ou negativa precisam de revisão de preço ou processo.</p>
    </div>
  );
}


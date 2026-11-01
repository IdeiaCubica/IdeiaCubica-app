/** Financeiro → Extrato e Fechamento mensal. */
import { Fragment, useState } from 'react';
import { useStore } from '../store';
import type { FinTitle } from '../../domain/types';
import { CLOSING_LABEL, cashStatement, closeMonth, closingChanges, monthRange, monthReport, statementCsv } from '../../domain/reports';
import { fmtDate, fmtDateTime, todayISO } from '../../domain/core';
import { D, fmtBRL, fmtNum, fmtPct } from '../../domain/money';
import { Alert, Badge, Combobox, DataTable, Empty, Kpi, Modal, TextArea } from '../components/ui';
import { TitleModal } from './Financeiro';

const monthLabel = (ym: string) => { const [y, m] = ym.split('-'); return `${m}/${y}`; };
const MonthPicker = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <input type="month" className="month-input" aria-label="Mês" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
);

/* ---------------- Extrato ---------------- */
export function Extrato() {
  const { db } = useStore();
  const [ym, setYm] = useState(todayISO().slice(0, 7));
  const [accountId, setAccountId] = useState('');
  const [sel, setSel] = useState<FinTitle | null>(null);
  const { from, to } = monthRange(ym);
  const st = cashStatement(db, { from, to, accountId: accountId || undefined });
  const download = () => {
    const url = URL.createObjectURL(new Blob([statementCsv(st)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `extrato-${ym}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="stack">
      <div className="row">
        <MonthPicker value={ym} onChange={setYm} />
        <div style={{ width: 240 }}><Combobox ariaLabel="Conta" value={accountId} onChange={setAccountId} placeholder="Todas as contas" options={db.accounts.map((a) => ({ value: a.id, label: a.name }))} /></div>
        <button className="btn secondary" style={{ marginLeft: 'auto' }} onClick={download} disabled={!st.rows.length}>Baixar planilha (CSV)</button>
      </div>
      <div className="kpis">
        <Kpi label={`Saldo em ${fmtDate(from)}`} value={fmtBRL(st.opening)} />
        <Kpi label="Entradas" value={<span className="stmt-in">+ {fmtBRL(st.totalIn)}</span>} hint={`${st.rows.filter((r) => r.amountIn.gt(0)).length} recebimento(s)`} />
        <Kpi label="Saídas" value={<span className="stmt-out">− {fmtBRL(st.totalOut)}</span>} hint={`${st.rows.filter((r) => r.amountOut.gt(0)).length} pagamento(s)`} />
        <Kpi label={`Saldo em ${fmtDate(to)}`} value={fmtBRL(st.closing)} accent />
      </div>
      <div className="card">
        <DataTable rows={st.rows} rowKey={(r) => r.settlementId} onRowClick={(r) => setSel(db.titles.find((t) => t.id === r.titleId) ?? null)}
          search={(r) => `${r.description} ${r.detail} ${r.category} ${r.party}`}
          empty={<Empty title={`Sem entradas ou saídas em ${monthLabel(ym)}`} text="O extrato mostra o dinheiro que entrou ou saiu de fato: recebimentos de vendas, pagamentos de compras e despesas pagas." />}
          columns={[
            { key: 'd', header: 'Data', render: (r) => fmtDate(r.date), sort: (r) => r.date },
            { key: 'x', header: 'Descrição', render: (r) => <><b>{r.description}</b>{r.detail && <div className="muted small">{r.detail}</div>}</> },
            { key: 'c', header: 'Categoria', render: (r) => <>{r.category}{r.party && <div className="muted small">{r.party}</div>}</>, sort: (r) => r.category },
            { key: 'a', header: 'Conta', render: (r) => <>{r.account}{r.method && <div className="muted small">{r.method}</div>}</> },
            { key: 'i', header: 'Entrada', num: true, render: (r) => (r.amountIn.gt(0) ? <span className="stmt-in">+ {fmtBRL(r.amountIn)}</span> : ''), sort: (r) => r.amountIn.toNumber() },
            { key: 'o', header: 'Saída', num: true, render: (r) => (r.amountOut.gt(0) ? <span className="stmt-out">− {fmtBRL(r.amountOut)}</span> : ''), sort: (r) => r.amountOut.toNumber() },
            { key: 'b', header: 'Saldo', num: true, render: (r) => <b>{fmtBRL(r.balance)}</b> },
          ]} />
      </div>
      <p className="small muted">Extrato = dinheiro que entrou ou saiu de fato no mês (pagamentos e recebimentos registrados; estornos não aparecem). Compras e vendas a prazo entram aqui no dia em que forem pagas. Clique numa linha para ver o lançamento.</p>
      {sel && <TitleModal title={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

/* ---------------- Fechamento mensal ---------------- */
export function Fechamento() {
  const { db, run } = useStore();
  const [ym, setYm] = useState(() => { const t = todayISO(); return t.slice(0, 7); });
  const [closing, setClosing] = useState(false);
  const [notes, setNotes] = useState('');
  const r = monthReport(db, ym);
  const changes = closingChanges(db, ym);
  const res = r.result;
  const neg = (d: { isNegative: () => boolean }) => (d.isNegative() ? { color: 'var(--error)' } : undefined);
  const doClose = () => run((d) => closeMonth(d, ym, notes), `Mês ${monthLabel(ym)} fechado.`).then((x) => { if (x.ok) { setClosing(false); setNotes(''); } });
  const history = [...db.monthClosings].sort((a, b) => b.month.localeCompare(a.month));
  return (
    <div className="stack closing-doc">
      <div className="row">
        <MonthPicker value={ym} onChange={setYm} />
        {r.closing ? <Badge tone="success">Fechado em {fmtDateTime(r.closing.closedAt)}</Badge> : <Badge>Mês aberto</Badge>}
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setClosing(true)}>{r.closing ? 'Refazer fechamento' : `Fechar ${monthLabel(ym)}`}</button>
      </div>
      {changes.length > 0 && <Alert tone="warning" title="Houve lançamentos depois do fechamento">
        {changes.map((c) => `${CLOSING_LABEL[c.key] ?? c.key}: fechado ${c.key.startsWith('pecas') ? c.closed : fmtBRL(c.closed)} → hoje ${c.key.startsWith('pecas') ? c.now : fmtBRL(c.now)}`).join(' · ')}. Use “Refazer fechamento” se estiverem corretos.
      </Alert>}
      {r.closing?.notes && <Alert tone="info" title="Observações do fechamento">{r.closing.notes}</Alert>}

      <div className="kpis">
        <Kpi label="Vendas do mês" value={fmtBRL(res.revenue)} hint={`${r.salesCount} venda(s) · ${r.piecesSoldQty} peça(s)`} />
        <Kpi label="Lucro (resultado do mês)" value={<span style={neg(res.operating)}>{fmtBRL(res.operating)}</span>} hint={res.revenue.isZero() ? '—' : `${fmtPct(res.operating.div(res.revenue))} das vendas`} accent />
        <Kpi label="Dinheiro: entrou − saiu" value={<span style={neg(r.cash.totalIn.minus(r.cash.totalOut))}>{fmtBRL(r.cash.totalIn.minus(r.cash.totalOut))}</span>} hint={`saldo final ${fmtBRL(r.cash.closing)}`} />
        <Kpi label="Peças produzidas" value={r.production.approved} hint={`${r.production.orders} produção(ões) · ${r.production.rejected} refugo(s)`} />
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h2>Resultado de {monthLabel(ym)}</h2><Badge tone={res.status === 'realizado' ? 'success' : res.status === 'estimado' ? 'warning' : 'error'}>{res.status === 'parcial' ? 'custos pendentes' : res.status}</Badge></div>
          <div className="card-body">
            <dl className="dl">
              <dt>Receita de vendas</dt><dd className="right">{fmtBRL(res.revenue)}</dd>
              <dt>Tributos e taxas de venda</dt><dd className="right">− {fmtBRL(res.fees)}</dd>
              <dt>Frete (cobrado − pago)</dt><dd className="right">{fmtBRL(res.freightNet)}</dd>
              <dt>Custo das peças vendidas</dt><dd className="right">− {fmtBRL(res.cogs)}</dd>
              <dt className="total">Margem de contribuição</dt><dd className="right total">{fmtBRL(res.contribution)} ({fmtPct(res.contributionPct)})</dd>
              <dt>Despesas fixas</dt><dd className="right">− {fmtBRL(res.fixed)}</dd>
              {(res.otherIn.gt(0) || res.otherOut.gt(0)) && <><dt>Outras receitas − despesas</dt><dd className="right">{fmtBRL(res.otherIn.minus(res.otherOut))}</dd></>}
              <dt className="total">Resultado do mês</dt><dd className="right total" style={neg(res.operating)}>{fmtBRL(res.operating)}</dd>
            </dl>
            {res.pendingCost > 0 && <p className="small" style={{ color: 'var(--error)', marginTop: 8 }}>{res.pendingCost} venda(s) sem custo de fabricação: o lucro está maior do que o real.</p>}
            <p className="small muted" style={{ marginTop: 8 }}>Competência: vendas e despesas do mês, mesmo que pagas em outro mês. Compras de material e de equipamentos não são despesa do mês (o material entra no custo quando a peça é vendida).</p>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Caixa de {monthLabel(ym)}</h2></div>
          <div className="card-body">
            <dl className="dl">
              <dt>Saldo no início do mês</dt><dd className="right">{fmtBRL(r.cash.opening)}</dd>
              {r.cashInByCategory.map((c) => <Fragment key={`i${c.category}`}><dt className="stmt-in">+ {c.category}</dt><dd className="right stmt-in">{fmtBRL(c.amount)}</dd></Fragment>)}
              {r.cashOutByCategory.map((c) => <Fragment key={`o${c.category}`}><dt className="stmt-out">− {c.category}</dt><dd className="right stmt-out">{fmtBRL(c.amount)}</dd></Fragment>)}
              <dt className="total">Saldo no fim do mês</dt><dd className="right total">{fmtBRL(r.cash.closing)}</dd>
            </dl>
            <dl className="dl" style={{ marginTop: 12 }}>
              <dt>A receber de clientes (até o fim do mês)</dt><dd className="right">{fmtBRL(r.receivable)}</dd>
              <dt>A pagar (até o fim do mês)</dt><dd className="right">{fmtBRL(r.payable)}</dd>
              <dt>Valor do estoque de material (hoje)</dt><dd className="right">{fmtBRL(r.inventoryNow)}</dd>
            </dl>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><h2>Resultado por peça vendida</h2><p className="muted small">Quanto cada peça vendeu e deixou de lucro no mês.</p></div></div>
        <DataTable rows={r.piecesSold} rowKey={(p) => p.name} initialSort={{ key: 'l', dir: -1 }}
          empty={<Empty title="Nenhuma venda no mês" />}
          columns={[
            { key: 'n', header: 'Peça', render: (p) => <b>{p.name}</b>, sort: (p) => p.name },
            { key: 'q', header: 'Qtd.', num: true, render: (p) => p.qty, sort: (p) => p.qty },
            { key: 'r', header: 'Receita', num: true, render: (p) => fmtBRL(p.revenue), sort: (p) => p.revenue.toNumber() },
            { key: 'c', header: 'Custo', num: true, render: (p) => <>{fmtBRL(p.cogs)}{p.pendingCost && <Badge tone="error">pendente</Badge>}</> },
            { key: 'l', header: 'Lucro', num: true, render: (p) => <b style={neg(p.contribution)}>{fmtBRL(p.contribution)}</b>, sort: (p) => p.contribution.toNumber() },
            { key: 'm', header: 'Margem', num: true, render: (p) => fmtPct(p.marginPct), sort: (p) => p.marginPct?.toNumber() ?? 0 },
          ]} />
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><div><h2>Despesas do mês</h2><p className="muted small">Lançamentos de saída com competência no mês (inclui compras de material, para conferência).</p></div></div>
          <DataTable rows={r.expenses} rowKey={(e) => e.title.id}
            empty={<Empty title="Nenhuma despesa no mês" />}
            columns={[
              { key: 'd', header: 'Despesa', render: (e) => <><b>{e.title.description}</b>{e.detail && <div className="muted small">{e.detail}</div>}</> },
              { key: 'c', header: 'Categoria', render: (e) => e.category, sort: (e) => e.category },
              { key: 'v', header: 'Valor', num: true, render: (e) => fmtBRL(e.amount), sort: (e) => e.amount.toNumber() },
            ]} />
        </div>
        <div className="card">
          <div className="card-head"><div><h2>Material consumido</h2><p className="muted small">Filamento e insumos usados nas produções do mês (inclui perdas).</p></div></div>
          <DataTable rows={r.production.consumption} rowKey={(c) => c.label}
            empty={<Empty title="Nenhum consumo no mês" />}
            columns={[
              { key: 'm', header: 'Insumo', render: (c) => c.label },
              { key: 'q', header: 'Quantidade', num: true, render: (c) => `${fmtNum(c.qty)} ${c.unit}` },
              { key: 'v', header: 'Custo', num: true, render: (c) => fmtBRL(c.cost), sort: (c) => c.cost.toNumber() },
            ]} />
        </div>
      </div>

      {history.length > 0 && <div className="card">
        <div className="card-head"><h2>Meses fechados</h2></div>
        <table className="tbl"><thead><tr><th>Mês</th><th className="num">Vendas</th><th className="num">Custo das peças</th><th className="num">Despesas fixas</th><th className="num">Resultado</th><th className="num">Saldo de caixa</th><th>Fechado em</th></tr></thead><tbody>
          {history.map((c) => <tr key={c.id} onClick={() => setYm(c.month)} style={{ cursor: 'pointer' }}>
            <td><b>{monthLabel(c.month)}</b></td><td className="num">{fmtBRL(c.figures.receita)}</td><td className="num">{fmtBRL(c.figures.cpv)}</td><td className="num">{fmtBRL(c.figures.despesasFixas)}</td>
            <td className="num"><b style={neg(D(c.figures.resultado))}>{fmtBRL(c.figures.resultado)}</b></td><td className="num">{fmtBRL(c.figures.saldoFinal)}</td><td className="small">{fmtDateTime(c.closedAt)}</td></tr>)}
        </tbody></table>
      </div>}

      {closing && <Modal title={r.closing ? `Refazer o fechamento de ${monthLabel(ym)}` : `Fechar ${monthLabel(ym)}`} onClose={() => setClosing(false)}
        subtitle="Registra os números do mês como estão agora (vendas, custos, despesas, resultado e caixa). Se algo for lançado depois, a tela avisa a diferença."
        footer={<><button className="btn ghost" onClick={() => setClosing(false)}>Cancelar</button><button className="btn primary" onClick={doClose}>Confirmar fechamento</button></>}>
        <div className="stack">
          <dl className="dl">
            <dt>Vendas</dt><dd className="right">{fmtBRL(res.revenue)}</dd>
            <dt>Resultado do mês</dt><dd className="right"><b style={neg(res.operating)}>{fmtBRL(res.operating)}</b></dd>
            <dt>Saldo de caixa no fim do mês</dt><dd className="right">{fmtBRL(r.cash.closing)}</dd>
          </dl>
          {res.pendingCost > 0 && <Alert tone="warning">{res.pendingCost} venda(s) sem custo de fabricação. Se puder, informe o custo antes de fechar.</Alert>}
          <TextArea label="Observações (opcional)" value={notes} onChange={setNotes} />
        </div>
      </Modal>}
    </div>
  );
}

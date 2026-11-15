/**
 * Vendas por pedido (v1.29): o pedido completo (todas as peças do orçamento), entregue ou não,
 * com o recebimento do pedido como um todo (% de cada peça ou valor rateado).
 */
import { useState } from 'react';
import { useStore } from '../store';
import type { FinTitle, Sale } from '../../domain/types';
import { pedidoPaymentPlan, receivePedidoPayment, salesPedidos, type Pedido, type PedidoLine } from '../../domain/pedidos';
import { cancelSale, saleEconomics } from '../../domain/sales';
import { orderPurgeReport } from '../../domain/medicao';
import { fmtDate, todayISO } from '../../domain/core';
import { Decimal, ZERO, fmtBRL, fmtPct, sum } from '../../domain/money';
import { Alert, Badge, Combobox, DataTable, DateField, Empty, Kpi, Modal, NumField, SelectField, TextField, num, useConfirm, useForm, type Tone } from '../components/ui';
import { SaleForm, TitleModal } from './Financeiro';
import { PurgeTable } from './Producao';

const pctTxt = (d: Decimal) => `${d.toDecimalPlaces(2).toString().replace('.', ',')}%`;
const piece = (d: Decimal) => (d.toDecimalPlaces(2).eq(d) ? fmtBRL(d) : `R$ ${d.toDecimalPlaces(3).toFixed(3).replace('.', ',')}`);
const DELIVERY: Record<Pedido['delivery'], { label: string; tone: Tone }> = {
  entregue: { label: 'Entregue', tone: 'success' }, parcial: { label: 'Entregue em parte', tone: 'info' }, a_entregar: { label: 'Não entregue', tone: 'warning' }, cancelado: { label: 'Cancelado', tone: 'neutral' },
};
const PAYMENT: Record<Pedido['payment'], { label: string; tone: Tone }> = {
  pago: { label: 'Pago', tone: 'success' }, parcial: { label: 'Recebido em parte', tone: 'info' }, a_receber: { label: 'A receber', tone: 'warning' }, cancelado: { label: 'Cancelado', tone: 'neutral' },
};

export function PedidosVendas({ onNew }: { onNew: () => void }) {
  const { db } = useStore();
  const today = todayISO();
  const [delivery, setDelivery] = useState('nao');
  const [payment, setPayment] = useState('');
  const [ym, setYm] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const customer = (id?: string) => db.parties.find((p) => p.id === id)?.name ?? '';
  const all = salesPedidos(db, today);
  const rows = all.filter((p) => {
    if (delivery === 'nao' && !(p.delivery === 'a_entregar' || p.delivery === 'parcial')) return false;
    if (delivery === 'entregue' && p.delivery !== 'entregue') return false;
    if (delivery === 'cancelado' ? p.delivery !== 'cancelado' : delivery !== 'todos' && p.delivery === 'cancelado') return false;
    if (payment === 'atrasado' ? !p.overdue : payment && p.payment !== payment) return false;
    return !ym || p.date.startsWith(ym);
  });
  const live = rows.filter((p) => p.delivery !== 'cancelado');
  const current = openKey ? all.find((p) => p.key === openKey) : undefined;
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Pedidos" value={String(live.length)} hint={`${live.reduce((s, p) => s + p.qty, 0)} peça(s)`} accent />
        <Kpi label="Valor dos pedidos" value={fmtBRL(sum(live.map((p) => p.total)))} />
        <Kpi label="Recebido" value={fmtBRL(sum(live.map((p) => p.received)))} />
        <Kpi label="A receber" value={fmtBRL(sum(live.map((p) => p.open)))}
          hint={live.some((p) => p.overdue) ? <span style={{ color: 'var(--error)' }}>{live.filter((p) => p.overdue).length} em atraso</span> : 'nada em atraso'} />
      </div>
      <div className="card">
        <DataTable rows={rows} rowKey={(p) => p.key} onRowClick={(p) => setOpenKey(p.key)}
          search={(p) => `${p.number} ${customer(p.customerId)} ${p.lines.map((l) => `${l.number} ${l.label}`).join(' ')}`}
          toolbar={<>
            <Combobox compact ariaLabel="Entrega" value={delivery} onChange={(v) => setDelivery(v || 'todos')} placeholder="Todos" options={[{ value: 'nao', label: 'Não entregues' }, { value: 'entregue', label: 'Entregues' }, { value: 'todos', label: 'Todos' }, { value: 'cancelado', label: 'Cancelados' }]} />
            <Combobox compact ariaLabel="Pagamento" value={payment} onChange={setPayment} placeholder="Todos os pagamentos" options={[{ value: 'a_receber', label: 'A receber' }, { value: 'parcial', label: 'Recebido em parte' }, { value: 'pago', label: 'Pago' }, { value: 'atrasado', label: 'Em atraso' }]} />
            <input type="month" aria-label="Mês do pedido" value={ym} onChange={(e) => setYm(e.target.value)} className="month-input" />
          </>}
          empty={<Empty title="Nenhum pedido neste filtro" text="Pedidos entram aqui quando a peça do orçamento vai para produção como Venda, ou quando uma venda é registrada." action={<button className="btn primary" onClick={onNew}>Registrar venda</button>} />}
          columns={[
            { key: 'n', header: 'Pedido', render: (p) => <span className="mono">{p.number}</span>, sort: (p) => p.number },
            { key: 'd', header: 'Data', render: (p) => fmtDate(p.date), sort: (p) => p.date },
            { key: 'c', header: 'Cliente / peças', render: (p) => <><b>{customer(p.customerId) || 'sem cliente'}</b><div className="muted small">{p.lines.filter((l) => !l.cancelled).length} modelo(s) · {p.qty} peça(s): {p.lines.filter((l) => !l.cancelled).map((l) => l.label).join(', ')}</div>{p.pendingItems.length > 0 && <div className="small" style={{ color: 'var(--warning, #b26b00)' }}>⚠ {p.pendingItems.length} peça(s) do orçamento fora do pedido: {fmtBRL(p.pendingTotal)} (não aprovadas ou não enviadas)</div>}</> },
            { key: 'e', header: 'Entrega', render: (p) => <Badge tone={DELIVERY[p.delivery].tone}>{DELIVERY[p.delivery].label}</Badge>, sort: (p) => p.delivery },
            { key: 't', header: 'Valor', num: true, render: (p) => fmtBRL(p.total), sort: (p) => p.total.toNumber() },
            { key: 'r', header: 'Recebido', num: true, render: (p) => <>{fmtBRL(p.received)}<div className="muted small">{pctTxt(p.receivedPct)}</div></>, sort: (p) => p.received.toNumber() },
            { key: 'o', header: 'A receber', render: (p) => <><Badge tone={p.overdue ? 'error' : PAYMENT[p.payment].tone}>{p.overdue ? 'Em atraso' : PAYMENT[p.payment].label}</Badge>
              {p.open.gt(0) && <div className="muted small">{fmtBRL(p.open)}{p.nextDue ? ` · vence ${fmtDate(p.nextDue)}` : ''}</div>}</>, sort: (p) => p.open.toNumber() },
            { key: 'a', header: '', render: (p) => <button className="btn secondary sm" onClick={(e) => { e.stopPropagation(); setOpenKey(p.key); }}>{p.open.gt(0) ? 'Receber' : 'Abrir'}</button> },
          ]} />
      </div>
      {current && <PedidoModal pedido={current} onClose={() => setOpenKey(null)} />}
    </div>
  );
}

function PedidoModal({ pedido: p, onClose }: { pedido: Pedido; onClose: () => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [editing, setEditing] = useState<Sale | null>(null);
  const [title, setTitle] = useState<FinTitle | null>(null);
  const [f, set] = useForm({ mode: 'pct', value: '50', date: todayISO(), accountId: db.accounts.find((a) => a.active)?.id ?? '', method: 'PIX' });
  const mode = f.mode as 'pct' | 'valor';
  const v = num(f.value) ?? 0;
  const plan = v > 0 ? pedidoPaymentPlan(p, { mode, value: String(v) }) : { amount: ZERO, lines: [], leftover: ZERO };
  const tooMuch = plan.amount.gt(p.open);
  const customer = db.parties.find((x) => x.id === p.customerId)?.name;
  const submit = () => run((d) => receivePedidoPayment(d, p.key, { mode, value: String(v), date: f.date, accountId: f.accountId, method: f.method }, todayISO()),
    `Recebimento de ${fmtBRL(plan.amount)} registrado no pedido.`).then((r) => r.ok && set('value')(''));
  const cancel = async (s: Sale) => {
    const reason = await confirm({ title: `Cancelar venda ${s.number}?`, danger: true, confirmLabel: 'Cancelar venda', reasonLabel: 'Motivo', text: 'Os títulos gerados serão cancelados. Recebimentos devem ser estornados antes. A peça volta para “Produzidas” no quadro de produção.' });
    if (reason) run((d) => cancelSale(d, s.id, reason), 'Venda cancelada.');
  };
  const lineStatus = (l: PedidoLine) => l.cancelled ? <Badge tone="neutral">Cancelada</Badge>
    : l.delivered ? <Badge tone="success">Entregue</Badge>
    : <Badge tone="warning">{l.order?.status === 'concluida' ? 'Produzido · a entregar' : l.order?.status === 'em_producao' ? 'Produzindo' : 'Em produção'}</Badge>;
  const planFor = (l: PedidoLine) => plan.lines.find((x) => x.line.key === l.key)?.amount ?? ZERO;
  return (
    <Modal wide title={`Pedido ${p.number}`} subtitle={`${customer ?? 'sem cliente'} · ${p.qty} peça(s) · ${fmtBRL(p.total)} · ${DELIVERY[p.delivery].label}`} onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>Fechar</button>}>
      <div className="stack">
        {p.pendingItems.length > 0 && <Alert tone="warning" title={`Peças do orçamento que ainda não estão neste pedido: ${fmtBRL(p.pendingTotal)}`}>
          {p.pendingItems.map((x) => `${x.name} (${x.qty} un · ${fmtBRL(x.price)} · ${x.state})`).join(" · ")}. Elas não estão cobradas nem em Contas a receber. Se o cliente fechou, aprove e envie para produção (Venda) no orçamento{p.quoteId ? <> — <a href={`#/orcamentos/${p.quoteId}`}>abrir orçamento</a></> : null}.
        </Alert>}
        <div className="kpis">
          <Kpi label="Valor do pedido" value={fmtBRL(p.total)} hint={`${p.qty} peça(s)`} />
          <Kpi label="Recebido" value={fmtBRL(p.received)} hint={pctTxt(p.receivedPct)} />
          <Kpi label="A receber" value={fmtBRL(p.open)} hint={p.nextDue ? `próximo vencimento ${fmtDate(p.nextDue)}` : undefined} />
        </div>
        <div className="card"><table className="tbl"><thead><tr><th>Peça</th><th>Situação</th><th className="num">Qtd</th><th className="num">Valor</th><th className="num">Por peça</th><th className="num">Recebido</th><th className="num">A receber</th><th /></tr></thead><tbody>
          {p.lines.map((l) => {
            const e = l.sale ? saleEconomics(l.sale) : null;
            return (
              <tr key={l.key} className={l.cancelled ? 'muted' : ''}>
                <td><b>{l.label}</b><div className="muted small mono">{l.number}{e?.contribution ? ` · lucro ${fmtBRL(e.contribution)} (${fmtPct(e.revenue.isZero() ? null : e.contribution.div(e.revenue))})` : ''}</div></td>
                <td>{lineStatus(l)}</td>
                <td className="num">{l.qty}</td>
                <td className="num">{fmtBRL(l.total)}</td>
                <td className="num">{piece(l.total.div(Math.max(1, l.qty)))}</td>
                <td className="num">{fmtBRL(l.received)}<div className="muted small">{piece(l.received.div(Math.max(1, l.qty)))}/peça</div></td>
                <td className="num">{fmtBRL(l.open)}<div className="muted small">{piece(l.open.div(Math.max(1, l.qty)))}/peça</div></td>
                <td className="right"><span className="row" style={{ gap: 4, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                  {!l.cancelled && l.titles[0] && <button className="btn ghost sm" onClick={() => setTitle(l.titles.find((t) => t.status === 'aberto') ?? l.titles[0])}>Recebimentos</button>}
                  {l.sale && !l.cancelled && <button className="btn ghost sm" onClick={() => setEditing(l.sale!)}>Editar</button>}
                  {l.sale && !l.cancelled && <button className="btn ghost sm" onClick={() => cancel(l.sale!)}>Cancelar</button>}
                </span></td>
              </tr>
            );
          })}
        </tbody></table></div>

        {p.open.gt(0) && <div className="card"><div className="card-body stack">
          <h3 style={{ margin: 0 }}>Receber do pedido (sinal ou parte)</h3>
          <div className="grid g4" style={{ alignItems: 'end' }}>
            <SelectField label="Como" value={f.mode} onChange={(x) => { set('mode')(x); set('value')(x === 'pct' ? '50' : ''); }} options={[{ value: 'pct', label: '% do pedido (de cada peça)' }, { value: 'valor', label: 'Valor (R$)' }]} />
            <NumField label={mode === 'pct' ? 'Percentual recebido' : 'Valor recebido'} suffix={mode === 'pct' ? '%' : 'R$'} value={f.value} onChange={set('value')} />
            <DateField label="Data do recebimento" value={f.date} onChange={set('date')} />
            <SelectField label="Conta" value={f.accountId} onChange={set('accountId')} placeholder="— selecione —" options={db.accounts.filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))} />
          </div>
          <div className="grid g4"><TextField label="Forma" value={f.method} onChange={set('method')} placeholder="PIX, cartão…" /></div>
          {plan.amount.gt(0) && <div className="card"><table className="tbl"><thead><tr><th>Peça</th><th className="num">Recebe agora</th><th className="num">Por peça</th><th className="num">Fica a receber</th></tr></thead><tbody>
            {p.lines.filter((l) => !l.cancelled && l.open.gt(0)).map((l) => { const a = planFor(l); return (
              <tr key={l.key}><td>{l.label} <span className="muted small">({l.qty} peça{l.qty === 1 ? '' : 's'})</span></td><td className="num">{fmtBRL(a)}</td><td className="num">{piece(a.div(Math.max(1, l.qty)))}</td><td className="num">{fmtBRL(Decimal.max(ZERO, l.open.minus(a)))}</td></tr>); })}
            <tr><td><b>Total</b></td><td className="num"><b>{fmtBRL(plan.amount)}</b></td><td /><td className="num">{fmtBRL(Decimal.max(ZERO, p.open.minus(plan.amount)))}</td></tr>
          </tbody></table></div>}
          {tooMuch && <Alert tone="error">O recebimento é maior do que falta receber no pedido ({fmtBRL(p.open)}).</Alert>}
          <p className="small muted" style={{ margin: 0 }}>{mode === 'pct'
            ? 'Por %: cada peça do pedido recebe o mesmo percentual do seu valor (ex.: 50% de um pedido de 10 peças = metade de cada peça recebida; fica a receber a outra metade de cada uma).'
            : 'Por valor: o valor é rateado entre as peças na proporção do que cada uma ainda tem a receber.'} Entra no financeiro como recebimento, no extrato da conta na data informada. Peças ainda em produção: na entrega, a venda aproveita o que já foi recebido.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={submit} disabled={!plan.amount.gt(0) || tooMuch || !f.accountId}>Registrar recebimento</button></div>
        </div></div>}

        {p.lines.map((l) => { const o = l.order ?? (l.sale?.orderId ? db.orders.find((x) => x.id === l.sale!.orderId) : undefined); const r = o ? orderPurgeReport(db, o) : null; return r ? (
          <div key={`purga-${l.key}`} className="stack">
            <h3 style={{ margin: 0 }}>Purga real · {l.label}</h3>
            <PurgeTable report={r} />
          </div>) : null; })}
      </div>
      {editing && <SaleForm sale={editing} onClose={() => setEditing(null)} />}
      {title && <TitleModal title={title} onClose={() => setTitle(null)} />}
      {confirmEl}
    </Modal>
  );
}

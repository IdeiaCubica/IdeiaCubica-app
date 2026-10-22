import { useStore } from '../store';
import { navigate } from '../App';
import { depreciationPerHour } from '../../domain/catalog';
import { cashBalance, openTotals } from '../../domain/finance';
import { inventoryValue, purchaseAlerts } from '../../domain/inventory';
import { managementResult } from '../../domain/sales';
import { latestVersion, materialCostPolicy } from '../../domain/quotes';
import { ORDER_STATUS_LABEL } from '../../domain/production';
import { todayISO } from '../../domain/core';
import { fmtBRL, fmtNum, fmtPct } from '../../domain/money';
import { Alert, Badge, Kpi, PageHead } from '../components/ui';
import { QUOTE_STATUS } from './Orcamentos';

export function Painel() {
  const { db } = useStore();
  const today = todayISO();
  const s = db.settings;
  const steps = [
    { done: !!s.energyTariff, label: 'Tarifa de energia (R$/kWh)', go: 'parametros/gerais' },
    { done: !!s.laborHourCost, label: 'Custo da hora de trabalho', go: 'parametros/gerais' },
    { done: !!s.productiveHoursPerMonth, label: 'Horas produtivas por mês (rateio de despesas indiretas)', go: 'parametros/gerais' },
    { done: db.printers.some((p) => depreciationPerHour(p) && p.kwhPerHour && p.maintenancePerHour), label: 'Impressora com depreciação, energia e manutenção', go: 'parametros/impressoras' },
    { done: db.channels.length > 0, label: 'Canal de venda com tributos e taxas', go: 'parametros/canais' },
    { done: !!s.defaultPrinterId && !!s.defaultChannelId && !!s.defaultMarkupPct, label: 'Padrões do orçamento (impressora, canal e markup)', go: 'parametros/gerais' },
    { done: db.materials.some((m) => m.filament && materialCostPolicy(db, m.id).unitCost), label: 'Filamento cadastrado com preço', go: 'cadastros/materiais' },
    { done: db.accounts.length > 0, label: 'Conta financeira (banco/caixa)', go: 'config/contas' },
  ];
  const pending = steps.filter((x) => !x.done);
  const ym = today.slice(0, 7);
  const res = managementResult(db, `${ym}-01`, `${ym}-31`);
  const open = openTotals(db, today);
  const reorder = purchaseAlerts(db);
  const shortage = reorder.filter((r) => r.status === 'falta');
  const activeOrders = db.orders.filter((o) => !['concluida', 'cancelada'].includes(o.status));
  const recentQuotes = [...db.quotes].reverse().slice(0, 5);

  return (
    <>
      <PageHead eyebrow={db.settings.companyName} title="Painel" text="Do pensamento à realidade, em 3 dimensões."
        actions={<><button className="btn secondary" onClick={() => navigate('compras')}>Registrar compra</button><button className="btn primary" onClick={() => navigate('orcamentos/novo')}>Novo orçamento</button></>} />
      <div className="stack">
        {pending.length > 0 && (
          <div className="card">
            <div className="card-head"><div><h2>Configuração inicial</h2><p className="muted small">Sem estes dados, os orçamentos ficam marcados como incompletos — o sistema não assume valores padrão.</p></div>
              <Badge tone="warning">{steps.length - pending.length} de {steps.length}</Badge></div>
            <div className="card-body">
              <div className="bar" style={{ marginBottom: 14 }}><i style={{ width: `${((steps.length - pending.length) / steps.length) * 100}%`, background: 'var(--ic-ideia)' }} /></div>
              <div className="grid g2" style={{ gap: 8 }}>
                {steps.map((x) => (
                  <button key={x.label} className="btn ghost" style={{ justifyContent: 'flex-start', height: 'auto', padding: '8px 10px' }} onClick={() => navigate(x.go)}>
                    <span style={{ color: x.done ? 'var(--success)' : 'var(--n-400)', fontWeight: 700 }}>{x.done ? '✓' : '○'}</span>
                    <span style={{ textDecoration: x.done ? 'line-through' : undefined, color: x.done ? 'var(--muted)' : undefined, whiteSpace: 'normal', textAlign: 'left' }}>{x.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="kpis">
          <Kpi accent label="Saldo de caixa" value={fmtBRL(cashBalance(db))} />
          <Kpi label="A receber" value={fmtBRL(open.receivable)} hint={open.overdueIn.gt(0) ? `${fmtBRL(open.overdueIn)} vencido` : undefined} />
          <Kpi label="A pagar" value={fmtBRL(open.payable)} hint={open.overdueOut.gt(0) ? `${fmtBRL(open.overdueOut)} vencido` : undefined} />
          <Kpi label="Receita do mês" value={fmtBRL(res.revenue)} hint={`${res.salesCount} venda(s)`} />
          <Kpi label="Margem de contribuição do mês" value={fmtBRL(res.contribution)} hint={res.salesCount ? `${fmtPct(res.contributionPct)} · ${res.status}` : 'sem vendas'} />
          <Kpi label="Estoque (custo)" value={fmtBRL(inventoryValue(db))} />
        </div>
        {(open.overdueIn.gt(0) || open.overdueOut.gt(0)) && <Alert tone="warning" title="Títulos vencidos">Há contas vencidas. <a href="#/financeiro/titulos">Ver contas a pagar e receber</a></Alert>}
        {shortage.length > 0 && <Alert tone="error" title={`Comprar já: falta material para ordens abertas (${shortage.length})`}>{shortage.map((r) => `${r.material.name} (faltam ${fmtNum(r.suggestedQty)} ${r.material.unit})`).join(', ')}. <a href="#/estoque/reposicao">Ver reposição</a></Alert>}
        {reorder.length > shortage.length && <Alert tone="warning" title={`Abaixo do ponto de pedido (${reorder.length - shortage.length})`}>{reorder.filter((r) => r.status === 'repor').map((r) => r.material.name).join(', ')}. <a href="#/estoque/reposicao">Ver reposição</a></Alert>}
        <div className="grid g2">
          <div className="card">
            <div className="card-head"><h2>Produção em andamento</h2><a href="#/producao/ordens" className="small">ver todas</a></div>
            {activeOrders.length === 0 ? <div className="card-body muted">Nenhuma ordem em aberto.</div> : (
              <table className="tbl"><tbody>{activeOrders.slice(0, 6).map((o) => (
                <tr key={o.id} className="clickable" onClick={() => navigate('producao/ordens')}><td className="mono">{o.number}</td><td>{o.description}</td><td className="num">{o.qtyPlanned} un</td><td><Badge tone={o.status === 'aguardando_material' ? 'error' : 'info'}>{ORDER_STATUS_LABEL[o.status]}</Badge></td></tr>
              ))}</tbody></table>)}
          </div>
          <div className="card">
            <div className="card-head"><h2>Orçamentos recentes</h2><a href="#/orcamentos" className="small">ver todos</a></div>
            {recentQuotes.length === 0 ? <div className="card-body muted">Nenhum orçamento ainda. <a href="#/orcamentos/novo">Criar o primeiro</a></div> : (
              <table className="tbl"><tbody>{recentQuotes.map((q) => { const v = latestVersion(q); return (
                <tr key={q.id} className="clickable" onClick={() => navigate(`orcamentos/${q.id}`)}><td className="mono">{q.number}</td><td>{q.name}</td><td className="num">{fmtBRL(v.summary.unitPrice)}</td><td><Badge tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</Badge></td></tr>); })}</tbody></table>)}
          </div>
        </div>
      </div>
    </>
  );
}

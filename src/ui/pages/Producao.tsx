import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { navigate } from '../App';
import type { OrderStatus, ProductionOrder, Project } from '../../domain/types';
import {
  ORDER_STATUS_LABEL, QUEUE_STATUSES, addProjectFileVersion, byDelivery, cancelOrder, checkAvailability, compareOrder, completeOrder, createManualOrder, deleteOrder, orderDeleteBlock, produceForStockNow, setOrderImage,
  moveOrderStatus, orderDelivery, orderReservations, productionQueue, queueShortages, reserveOrderMaterials, returnOrderToQuote,
  saveProject, startOrder, stockEstimate, updateOrderPlanning,
} from '../../domain/production';
import { lotBalance, lotLabel, reorderAnalysis } from '../../domain/inventory';
import { materialLabel } from '../../domain/catalog';
import { ImagePicker } from '../components/ImagePicker';
import { saleEconomics } from '../../domain/sales';
import { quoteItemAt, quoteItems } from '../../domain/quotes';
import { clientQuoteSettings } from '../../domain/clientQuote';
import { fmtDuration } from '../../domain/conversions';
import { BusinessError, addDays as addDaysISO, fmtDate, fmtDateTime, todayISO } from '../../domain/core';
import { Decimal, ZERO, fmtBRL, fmtNum, fmtPct, sum } from '../../domain/money';
import { Alert, Badge, Check, Combobox, DataTable, DateField, Empty, Kpi, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, TimeField, num, useConfirm, useForm, type Tone } from '../components/ui';
import { QUOTE_STATUS } from './Orcamentos';
import { SaleForm } from './Financeiro';

type Tab = 'quadro' | 'pedidos' | 'estoque' | 'ordens' | 'projetos';
const STATUS_TONE: Record<OrderStatus, Tone> = {
  planejada: 'neutral', aguardando_material: 'error', pronta: 'info', em_producao: 'primary', aguardando_acabamento: 'warning', em_inspecao: 'warning', concluida: 'success', cancelada: 'neutral',
};
const PURPOSE_LABEL = { pedido: 'Pedido', estoque: 'Estoque' } as const;
const purposeOf = (o: ProductionOrder) => o.purpose ?? 'pedido';

export function Producao({ param }: { param?: string }) {
  const { db } = useStore();
  // Peças prontas foram para o módulo Estoque.
  useEffect(() => { if (param === 'pronta-entrega') navigate('estoque/pecas'); }, [param]);
  const tab: Tab = param === 'ordens' || param === 'projetos' || param === 'pedidos' || param === 'estoque' ? param : 'quadro';
  const active = db.orders.filter((o) => !['concluida', 'cancelada'].includes(o.status)).length;
  const openOrders = db.orders.filter((o) => purposeOf(o) === 'pedido' && ['fila', 'producao', 'pronto'].includes(orderDelivery(db, o))).length
    + db.finishedGoods.reduce((s, g) => s + (g.allocations?.length ?? 0), 0);
  const openStock = db.orders.filter((o) => purposeOf(o) === 'estoque' && !['concluida', 'cancelada'].includes(o.status)).length;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead eyebrow="Módulo 5" title="Produção" text="Pedidos a partir de orçamento e produções para estoque, organizados pela data de entrega. Reserva e baixa de material sem duplicidade."
        actions={<><button className="btn secondary" onClick={() => setCreating(true)} disabled={!db.materials.length}>Nova produção para estoque</button>
          <button className="btn primary" onClick={() => navigate('orcamentos/aprovados')}>Pedido a partir de orçamento</button></>} />
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`producao/${t}`)} tabs={[
        { id: 'quadro', label: 'Quadro (Kanban)', count: active || undefined },
        { id: 'pedidos', label: 'Pedidos a partir de orçamento', count: openOrders || undefined },
        { id: 'estoque', label: 'Produções para estoque', count: openStock || undefined },
        { id: 'ordens', label: 'Histórico' },
        { id: 'projetos', label: 'Projetos / produtos', count: db.projects.length },
      ]} />
      {tab === 'quadro' && <Quadro />}
      {tab === 'pedidos' && <Pedidos />}
      {tab === 'estoque' && <ProducoesEstoque onNew={() => setCreating(true)} />}
      {tab === 'ordens' && <Ordens />}
      {tab === 'projetos' && <Projetos />}
      {creating && <StockProductionForm onClose={() => setCreating(false)} />}
    </>
  );
}

/* ================================================================== */
/* Quadro Kanban                                                       */
/* ================================================================== */
type Column = 'fila' | 'producao' | 'acabamento' | 'concluidas';
const COLUMNS: { id: Column; title: string; hint: string }[] = [
  { id: 'fila', title: 'A produzir', hint: 'Pela data de entrega: as próximas entregas ficam no topo.' },
  { id: 'producao', title: 'Em produção', hint: 'Imprimindo agora.' },
  { id: 'acabamento', title: 'Acabamento / inspeção', hint: 'Pós-processo e conferência.' },
  { id: 'concluidas', title: 'Produzidas', hint: 'Concluídas nos últimos 30 dias.' },
];
const columnOf = (o: ProductionOrder): Column | null =>
  QUEUE_STATUSES.includes(o.status) ? 'fila' : o.status === 'em_producao' ? 'producao'
  : o.status === 'aguardando_acabamento' || o.status === 'em_inspecao' ? 'acabamento' : o.status === 'concluida' ? 'concluidas' : null;

function Quadro() {
  const { db, run, toast } = useStore();
  const [sel, setSel] = useState<ProductionOrder | null>(null);
  const [completing, setCompleting] = useState<ProductionOrder | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const since = addDaysISO(todayISO(), -30);
  const cards: Record<Column, ProductionOrder[]> = {
    fila: productionQueue(db),
    producao: db.orders.filter((o) => columnOf(o) === 'producao').sort(byDelivery),
    acabamento: db.orders.filter((o) => columnOf(o) === 'acabamento').sort(byDelivery),
    concluidas: db.orders.filter((o) => o.status === 'concluida' && (o.finishedAt ?? '') >= since).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')),
  };
  const queueHours = cards.fila.reduce((s, o) => s + (o.plannedHours ?? 0), 0);

  /** Soltar um cartão numa coluna. A ordem dentro da coluna é sempre a data de entrega. */
  const drop = (col: Column) => {
    const o = db.orders.find((x) => x.id === dragId);
    setDragId(null); setOver(null);
    if (!o) return;
    const from = columnOf(o);
    if (col === from) return;
    if (col === 'fila') return void toast('warning', 'Um pedido já iniciado não volta para “A produzir”.');
    if (col === 'producao') {
      if (from === 'fila') return void run((d) => startOrder(d, o.id), `${o.number}: produção iniciada (material reservado).`);
      return void run((d) => moveOrderStatus(d, o.id, 'em_producao'));
    }
    if (col === 'acabamento') {
      if (from === 'fila') return void toast('warning', 'Inicie a produção antes de mandar para o acabamento.');
      return void run((d) => moveOrderStatus(d, o.id, 'aguardando_acabamento'));
    }
    if (col === 'concluidas') {
      if (from === 'fila') return void toast('warning', 'Inicie a produção antes de concluir.');
      setCompleting(o);
    }
  };
  return (
    <>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <Kpi label="Na fila" value={cards.fila.length} hint={queueHours ? `${fmtDuration(queueHours)} de impressão previstas` : 'sem horas previstas'} />
        <Kpi label="Em produção" value={cards.producao.length} />
        <Kpi label="Acabamento / inspeção" value={cards.acabamento.length} />
        <Kpi label="Produzidas (30 dias)" value={cards.concluidas.reduce((s, o) => s + (o.actual?.qtyApproved ?? 0), 0)} hint="peças aprovadas" accent />
      </div>
      <div className="kanban">
        {COLUMNS.map((c) => (
          <section key={c.id} className={`kb-col${over === c.id ? ' over' : ''}`} aria-label={c.title}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setOver(c.id); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={(e) => { e.preventDefault(); drop(c.id); }}>
            <header><h3>{c.title}</h3><span className="kb-count">{cards[c.id].length}</span></header>
            <p className="small muted">{c.hint}</p>
            <div className="kb-list">
              {cards[c.id].length === 0 && <div className="kb-empty">Nada aqui</div>}
              {cards[c.id].map((o) => (
                <KanbanCard key={o.id} order={o} dragging={dragId === o.id}
                  onDragStart={() => setDragId(o.id)} onDragEnd={() => { setDragId(null); setOver(null); }}
                  onOpen={() => setSel(o)} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Cada coluna é ordenada pela data de entrega (próximas no topo; sem data por último). Arraste os cartões entre as colunas:
        soltar em <b>Em produção</b> reserva o material e inicia; soltar em <b>Produzidas</b> abre a conclusão com o consumo real. No celular, abra o cartão para mudar o status.
      </p>
      {sel && <OrderModal order={sel} onClose={() => setSel(null)} />}
      {completing && <CompleteForm order={completing} onClose={() => setCompleting(null)} />}
    </>
  );
}

function KanbanCard({ order: o, dragging, onDragStart, onDragEnd, onOpen }: {
  order: ProductionOrder; dragging: boolean; onDragStart: () => void; onDragEnd: () => void; onOpen: () => void;
}) {
  const { db } = useStore();
  const customer = db.parties.find((p) => p.id === o.customerId);
  const printer = db.printers.find((p) => p.id === o.printerId);
  const shortage = QUEUE_STATUSES.includes(o.status) && (queueShortages(db).has(o.id) || checkAvailability(db, o).some((a) => a.shortage.gt(0)));
  const today = todayISO();
  const late = o.dueDate && o.status !== 'concluida' && o.dueDate < today;
  const soon = o.dueDate && !late && o.status !== 'concluida' && o.dueDate <= addDaysISO(today, 3);
  const q = o.quoteId ? db.quotes.find((x) => x.id === o.quoteId) : undefined;
  const image = q ? quoteItemAt(q, o.quoteVersion, o.quoteItemId)?.image : undefined;
  return (
    <article className={`kb-card${dragging ? ' dragging' : ''}`} draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', o.id); onDragStart(); }}
      onDragEnd={onDragEnd}>
      <button className="kb-open" onClick={onOpen} aria-label={`Abrir ${o.number}`}>
        <div className={`kb-due${late ? ' late' : soon ? ' soon' : ''}`}>{o.dueDate ? `Entrega ${fmtDate(o.dueDate)}` : 'Sem data de entrega'}</div>
        <div className="kb-top">
          <span className="mono small">{o.number}</span>
          <Badge tone={purposeOf(o) === 'pedido' ? 'info' : 'neutral'}>{PURPOSE_LABEL[purposeOf(o)]}</Badge>
        </div>
        <div className="kb-body">
          {image && <img src={image} alt="" className="kb-thumb" />}
          <div>
            <b>{o.description}</b>
            <div className="small muted">{customer ? customer.name : purposeOf(o) === 'estoque' ? 'Para pronta-entrega' : 'Sem cliente'}</div>
          </div>
        </div>
        <div className="kb-meta small">
          <span>{o.actual ? `${o.actual.qtyApproved}/${o.qtyPlanned} pç` : `${o.qtyPlanned} pç`}</span>
          {o.plannedHours !== null && <span>{fmtDuration(o.plannedHours)}</span>}
          {printer && <span>{printer.name}</span>}
        </div>
        <div className="kb-tags">
          {o.status !== 'em_producao' && o.status !== 'concluida' && <Badge tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge>}
          {shortage && <Badge tone="error">falta material</Badge>}
          {late && <Badge tone="error">atrasado</Badge>}
        </div>
      </button>
    </article>
  );
}

/* ================================================================== */
/* Pedidos de clientes                                                 */
/* ================================================================== */
const DELIVERY: Record<ReturnType<typeof orderDelivery> | 'separado', { label: string; tone: Tone }> = {
  fila: { label: 'A produzir', tone: 'neutral' }, producao: { label: 'Em produção', tone: 'primary' },
  pronto: { label: 'Pronto para entregar', tone: 'warning' }, separado: { label: 'Pedido aprovado (estoque)', tone: 'warning' },
  entregue: { label: 'Entregue / vendido', tone: 'success' }, cancelado: { label: 'Cancelado / retornado', tone: 'neutral' },
};

type PedidoRow = {
  key: string; number: string; description: string; qty: number; customerId?: string; quoteId?: string; itemId?: string; dueDate?: string;
  value: string | null; image?: string | null; d: ReturnType<typeof orderDelivery> | 'separado'; order?: ProductionOrder; fgCode?: string;
};

function Pedidos() {
  const { db } = useStore();
  const [sel, setSel] = useState<ProductionOrder | null>(null);
  const [selling, setSelling] = useState<PedidoRow | null>(null);
  const [card, setCard] = useState<PedidoRow | null>(null);
  const [filter, setFilter] = useState('abertos');
  const fromOrders: PedidoRow[] = db.orders.filter((o) => purposeOf(o) === 'pedido').map((o) => {
    const q = db.quotes.find((x) => x.id === o.quoteId);
    const it = q ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) : undefined;
    return { key: o.id, number: o.number, description: o.description, qty: o.qtyPlanned, customerId: o.customerId, quoteId: o.quoteId, itemId: o.quoteItemId, dueDate: o.dueDate,
      value: it?.summary.orderPrice ?? null, image: it?.image, d: orderDelivery(db, o), order: o };
  });
  // Pedidos aprovados de peças do estoque: não precisam produzir, já estão separadas.
  const fromStock: PedidoRow[] = db.finishedGoods.flatMap((g) => (g.allocations ?? []).map((a) => {
    const q = db.quotes.find((x) => x.id === a.quoteId);
    const it = q ? quoteItems(q).find((x) => x.itemId === a.itemId) : undefined;
    return { key: a.id, number: q?.number ?? '—', description: it?.name ?? g.description, qty: a.qty, customerId: a.customerId, quoteId: a.quoteId, itemId: a.itemId, dueDate: a.dueDate,
      value: it?.summary.orderPrice ?? null, image: g.image, d: 'separado' as const, fgCode: g.code };
  }));
  const open = (d: PedidoRow['d']) => ['fila', 'producao', 'pronto', 'separado'].includes(d);
  const rows = [...fromOrders, ...fromStock]
    .filter((r) => filter === 'todos' || (filter === 'abertos' ? open(r.d) : r.d === filter))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.number.localeCompare(b.number));
  const customerName = (id?: string) => db.parties.find((p) => p.id === id)?.name;
  return (
    <div className="card">
      <div className="card-head"><div><h2>Pedidos a partir de orçamento</h2><p className="muted small">Cada peça aprovada vira um pedido, com a data de entrega. Ao entregar, registre a venda e imprima o cartão de agradecimento.</p></div>
        <button className="btn secondary" onClick={() => navigate('orcamentos/aprovados')}>Peças aprovadas sem pedido</button></div>
      <DataTable rows={rows} rowKey={(r) => r.key} onRowClick={(r) => r.order ? setSel(r.order) : r.quoteId && navigate(`orcamentos/${r.quoteId}`)}
        search={(r) => `${r.number} ${r.description} ${customerName(r.customerId) ?? ''}`}
        toolbar={<Combobox compact ariaLabel="Filtrar pedidos" value={filter} onChange={(v) => setFilter(v || 'abertos')}
          options={[{ value: 'abertos', label: 'Em aberto' }, { value: 'todos', label: 'Todos' }, ...Object.entries(DELIVERY).map(([value, v]) => ({ value, label: v.label }))]} />}
        empty={<Empty title="Nenhum pedido neste filtro" text="Abra um orçamento, marque as peças que o cliente aprovou e clique em “Enviar para produção” informando a data de entrega." />}
        columns={[
          { key: 'e', header: 'Entrega', render: (r) => r.dueDate ? <b className={r.dueDate < todayISO() && open(r.d) ? 'err-text' : ''}>{fmtDate(r.dueDate)}</b> : '—', sort: (r) => r.dueDate ?? '9999' },
          { key: 'n', header: 'Pedido', render: (r) => <span className="mono">{r.number}</span>, sort: (r) => r.number },
          { key: 'c', header: 'Cliente', render: (r) => customerName(r.customerId) ?? <span className="muted">não informado</span> },
          { key: 'd', header: 'Peça', render: (r) => <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>{r.image ? <img src={r.image} alt="" className="kb-thumb" /> : null}<div><b>{r.description}</b>
            <div className="muted small">{r.qty} peça(s){r.order?.quoteId ? ` · orçamento ${db.quotes.find((q) => q.id === r.order!.quoteId)?.number ?? ''}` : ''}{r.fgCode ? ` · do estoque ${r.fgCode}` : ''}</div></div></div> },
          { key: 'v', header: 'Valor', num: true, render: (r) => (r.value ? fmtBRL(r.value) : '—') },
          { key: 's', header: 'Situação', render: (r) => <Badge tone={DELIVERY[r.d].tone}>{DELIVERY[r.d].label}</Badge> },
          { key: 'a', header: '', render: (r) => <div className="row" style={{ flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
            {(r.d === 'pronto' || r.d === 'separado') && <button className="btn primary sm" onClick={() => setSelling(r)}>Registrar venda</button>}
            {r.d !== 'cancelado' && <button className="btn ghost sm" onClick={() => setCard(r)}>Cartão de agradecimento</button>}
          </div> },
        ]} />
      {sel && <OrderModal order={sel} onClose={() => setSel(null)} />}
      {selling && <SaleForm preset={selling.order ? { orderId: selling.order.id } : { quoteId: selling.quoteId, itemId: selling.itemId }} onClose={() => setSelling(null)} />}
      {card && <ThankYouCardDialog customerName={customerName(card.customerId)} orderNumber={card.number} onClose={() => setCard(null)} />}
    </div>
  );
}

/* ================================================================== */
/* Produções para estoque                                              */
/* ================================================================== */
function ProducoesEstoque({ onNew }: { onNew: () => void }) {
  const { db } = useStore();
  const [sel, setSel] = useState<ProductionOrder | null>(null);
  const [filter, setFilter] = useState('abertas');
  const rows = db.orders.filter((o) => purposeOf(o) === 'estoque')
    .filter((o) => filter === 'todas' || (filter === 'abertas' ? !['concluida', 'cancelada'].includes(o.status) : o.status === filter))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="card">
      <div className="card-head"><div><h2>Produções para estoque</h2><p className="muted small">Sem orçamento prévio: o sistema calcula o custo da peça e o valor sugerido de venda. Ao concluir, as peças vão para Estoque → Peças produzidas, prontas para orçar a quem pedir.</p></div>
        <button className="btn primary" onClick={onNew} disabled={!db.materials.length}>Nova produção para estoque</button></div>
      <DataTable rows={rows} rowKey={(o) => o.id} onRowClick={setSel} search={(o) => `${o.number} ${o.description}`}
        toolbar={<Combobox compact ariaLabel="Filtrar produções" value={filter} onChange={(v) => setFilter(v || 'abertas')}
          options={[{ value: 'abertas', label: 'Em aberto' }, { value: 'todas', label: 'Todas' }, ...Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label }))]} />}
        empty={<Empty title="Nenhuma produção para estoque" text="Use “Nova produção para estoque” para produzir peças de pronta-entrega." action={<button className="btn primary" onClick={onNew}>Nova produção para estoque</button>} />}
        columns={[
          { key: 'n', header: 'Produção', render: (o) => <span className="mono">{o.number}</span>, sort: (o) => o.number },
          { key: 'd', header: 'Peça', render: (o) => <><b>{o.description}</b><div className="muted small">{o.actual ? `${o.actual.qtyApproved}/${o.qtyPlanned}` : o.qtyPlanned} peça(s){o.plannedHours !== null ? ` · ${fmtDuration(o.plannedHours)}` : ''}</div></> },
          { key: 'c', header: 'Custo por peça', num: true, render: (o) => { const fg = db.finishedGoods.find((g) => g.id === o.finishedGoodId); return fg?.unitCost ? <>{fmtBRL(fg.unitCost)}<div className="muted small">real</div></> : o.estimate?.summary.unitCost ? <>{fmtBRL(o.estimate.summary.unitCost)}<div className="muted small">estimado</div></> : '—'; } },
          { key: 'p', header: 'Valor sugerido', num: true, render: (o) => o.estimate?.summary.unitPrice ? <b>{fmtBRL(o.estimate.summary.unitPrice)}</b> : <span className="muted">—</span> },
          { key: 's', header: 'Situação', render: (o) => <Badge tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge>, sort: (o) => o.status },
          { key: 'f', header: 'Estoque', render: (o) => o.finishedGoodId ? <a href="#/estoque/pecas" onClick={(e) => e.stopPropagation()}>{db.finishedGoods.find((g) => g.id === o.finishedGoodId)?.code}</a> : '—' },
        ]} />
      {sel && <OrderModal order={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

/* ================================================================== */
/* Todas as ordens                                                     */
/* ================================================================== */
function Ordens() {
  const { db } = useStore();
  const [sel, setSel] = useState<ProductionOrder | null>(null);
  const [filter, setFilter] = useState('todas');
  const rows = [...db.orders].reverse().filter((o) => filter === 'todas' || (filter === 'abertas' ? !['concluida', 'cancelada'].includes(o.status) : o.status === filter));
  return (
    <div className="card">
      <div className="card-head"><div><h2>Histórico de pedidos e produções</h2><p className="muted small">Tudo o que já passou pela produção, com filtros por situação.</p></div></div>
      <DataTable rows={rows} rowKey={(o) => o.id} onRowClick={setSel} search={(o) => `${o.number} ${o.description} ${db.parties.find((p) => p.id === o.customerId)?.name ?? ''}`}
        toolbar={<Combobox compact ariaLabel="Filtrar ordens" value={filter} onChange={(v) => setFilter(v || 'todas')}
          options={[{ value: 'todas', label: 'Todas' }, { value: 'abertas', label: 'Em aberto' }, ...Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label }))]} />}
        empty={<Empty title="Nada neste filtro" text="Pedidos nascem das peças aprovadas no orçamento; produções para estoque, do botão “Nova produção para estoque”." />}
        columns={[
          { key: 'n', header: 'Número', render: (o) => <span className="mono">{o.number}</span>, sort: (o) => o.number },
          { key: 'd', header: 'Descrição', render: (o) => <><b>{o.description}</b><div className="muted small">{o.quoteId ? `Orçamento ${db.quotes.find((q) => q.id === o.quoteId)?.number ?? '(excluído)'} v${o.quoteVersion}` : purposeOf(o) === 'estoque' ? 'Para estoque' : 'Manual'}{o.dueDate ? ` · entrega ${fmtDate(o.dueDate)}` : ''}</div></> },
          { key: 't', header: 'Tipo', render: (o) => <Badge tone={purposeOf(o) === 'pedido' ? 'info' : 'neutral'}>{PURPOSE_LABEL[purposeOf(o)]}</Badge> },
          { key: 'p', header: 'Impressora', render: (o) => db.printers.find((p) => p.id === o.printerId)?.name ?? '—' },
          { key: 'q', header: 'Qtd.', num: true, render: (o) => o.actual ? `${o.actual.qtyApproved}/${o.qtyPlanned}` : o.qtyPlanned },
          { key: 'h', header: 'Tempo prev.', num: true, render: (o) => o.plannedHours !== null ? fmtDuration(o.plannedHours) : '—' },
          { key: 's', header: 'Situação', render: (o) => <Badge tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge>, sort: (o) => o.status },
          { key: 'c', header: 'Criada', render: (o) => fmtDate(o.createdAt), sort: (o) => o.createdAt },
          { key: 'f', header: 'Produzida', render: (o) => o.finishedAt ? fmtDate(o.finishedAt) : '—', sort: (o) => o.finishedAt ?? '' },
        ]} />
      {sel && <OrderModal order={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function OrderModal({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const { db, run, toast } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [completing, setCompleting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const o = db.orders.find((x) => x.id === order.id)!;
  const avail = checkAvailability(db, o);
  const reserved = orderReservations(db, o.id);
  const lotName = (id: string) => { const l = db.lots.find((x) => x.id === id); return l ? lotLabel(db, l) : 'Lote removido'; };
  const matOf = (materialId: string, lotId?: string) => db.materials.find((m) => m.id === (materialId || db.lots.find((l) => l.id === lotId)?.materialId));
  const lineName = (materialId: string, lotId?: string) => lotId ? lotName(lotId) : `${matOf(materialId)?.name ?? 'Material removido'} (lotes por ordem de entrada)`;
  const [card, setCard] = useState(false);
  const cancel = async () => {
    const reason = await confirm({ title: `Cancelar ${o.number}?`, danger: true, confirmLabel: 'Cancelar', reasonLabel: 'Motivo', text: 'As reservas de material serão liberadas.' });
    if (reason) run((d) => cancelOrder(d, o.id, reason), 'Cancelado e reservas liberadas.');
  };
  const delBlock = orderDeleteBlock(db, o);
  const remove = async () => {
    const reason = await confirm({ title: `Excluir ${o.number} por completo?`, danger: true, confirmLabel: 'Excluir definitivamente', reasonLabel: 'Motivo da exclusão',
      text: `${o.number} · ${o.description} sai do sistema: reservas e baixas de material são desfeitas (o filamento volta ao estoque)${o.finishedGoodId ? ', as peças produzidas desta produção são apagadas' : ''}${o.quoteId ? ' e a peça volta a “Aprovada” no orçamento' : ''}. Fica registrado só na trilha de auditoria.` });
    if (!reason) return;
    const r = await run((d) => deleteOrder(d, o.id, reason), `${o.number} excluído.`);
    if (r.ok) onClose();
  };
  const backToQuote = async () => {
    const reason = await confirm({ title: `Retornar ${o.number} para o orçamento?`, confirmLabel: 'Retornar para o orçamento', reasonLabel: 'Motivo (ex.: cliente mudou a cor)',
      text: 'O pedido é cancelado, o material reservado é liberado e a peça volta a ficar “Aprovada” e editável no orçamento. Depois é só enviar para produção de novo.' });
    if (!reason) return;
    const r = await run((d) => returnOrderToQuote(d, o.id, reason), 'Pedido retornado para o orçamento.');
    if (r.ok && o.quoteId) { onClose(); navigate(`orcamentos/${o.quoteId}`); }
  };
  const reserveAction = () => run((d) => reserveOrderMaterials(d, o.id)).then((r) => {
    if (!r.ok) return;
    if (r.value.ok) toast('success', 'Material reservado: pronto para produção.');
    else toast('warning', 'Material insuficiente: ficou "Aguardando material". Nada foi reservado.');
  });
  const open = !['concluida', 'cancelada'].includes(o.status);
  const kind = purposeOf(o) === 'pedido' ? 'Pedido' : 'Produção para estoque';
  return (
    <Modal wide title={`${o.number} · ${o.description}`} subtitle={`${kind} · ${ORDER_STATUS_LABEL[o.status]} · ${db.printers.find((p) => p.id === o.printerId)?.name ?? 'sem impressora'} · ${o.qtyPlanned} peça(s)`} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Fechar</button>
        <button className="btn ghost danger-text" onClick={remove} disabled={!!delBlock} title={delBlock ?? 'Apaga este pedido/produção do sistema'}>Excluir</button>
        {open && o.quoteId && <button className="btn secondary" onClick={backToQuote}>Retornar para o orçamento</button>}
        {open && !o.quoteId && <button className="btn danger" onClick={cancel}>Cancelar</button>}
        {purposeOf(o) === 'pedido' && o.status !== 'cancelada' && <button className="btn ghost" onClick={() => setCard(true)}>Cartão de agradecimento</button>}
        {(o.status === 'planejada' || o.status === 'aguardando_material') && <button className="btn secondary" onClick={reserveAction}>Reservar material</button>}
        {(o.status === 'planejada' || o.status === 'aguardando_material' || o.status === 'pronta') && <button className="btn primary" onClick={() => run((d) => startOrder(d, o.id), 'Produção iniciada.')}>Iniciar produção</button>}
        {o.status === 'em_producao' && <button className="btn secondary" onClick={() => run((d) => moveOrderStatus(d, o.id, 'aguardando_acabamento'))}>Aguardando acabamento</button>}
        {(o.status === 'em_producao' || o.status === 'aguardando_acabamento') && <button className="btn secondary" onClick={() => run((d) => moveOrderStatus(d, o.id, 'em_inspecao'))}>Em inspeção</button>}
        {['em_producao', 'aguardando_acabamento', 'em_inspecao'].includes(o.status) && <button className="btn primary" onClick={() => setCompleting(true)}>Concluir e baixar consumo</button>}
      </>}>
      <div className="stack">
        {o.status === 'cancelada' && <Alert tone="error" title="Cancelada">{o.cancelReason}</Alert>}
        <div className="row small muted">
          <span>Criada {fmtDateTime(o.createdAt)}</span>{o.startedAt && <span>· Início {fmtDateTime(o.startedAt)}</span>}{o.finishedAt && <span>· Término {fmtDateTime(o.finishedAt)}</span>}
        </div>
        <div className="row">
          <Badge tone={purposeOf(o) === 'pedido' ? 'info' : 'neutral'}>{purposeOf(o) === 'pedido' ? 'Pedido a partir de orçamento' : 'Produção para estoque'}</Badge>
          {o.customerId && <span>Cliente: <b>{db.parties.find((p) => p.id === o.customerId)?.name ?? '—'}</b></span>}
          <span>Entrega: <b>{o.dueDate ? fmtDate(o.dueDate) : 'sem data'}</b></span>
          {o.plannedHours !== null && <span>Tempo previsto: <b>{fmtDuration(o.plannedHours)}</b></span>}
          {o.quoteId && <a href={`#/orcamentos/${o.quoteId}`}>Orçamento {db.quotes.find((q) => q.id === o.quoteId)?.number ?? '(excluído)'}</a>}
          {open && <button className="btn ghost sm" onClick={() => setPlanning(true)}>Alterar entrega e impressora</button>}
        </div>
        {o.estimate && <div className="row small">
          <span>Custo estimado por peça: <b>{fmtBRL(o.estimate.summary.unitCost)}</b></span>
          <span>Valor sugerido de venda: <b>{fmtBRL(o.estimate.summary.unitPrice)}</b></span>
        </div>}
        {purposeOf(o) === 'estoque' && o.status !== 'cancelada' && <ImagePicker value={o.image ?? db.finishedGoods.find((g) => g.id === o.finishedGoodId)?.image ?? null}
          onChange={(img) => run((d) => setOrderImage(d, o.id, img), img ? 'Foto salva.' : 'Foto removida.')} hint="Vai também para as peças prontas desta produção." />}
        {o.finishedGoodId && <Alert tone="success">Peças aprovadas enviadas ao estoque ({db.finishedGoods.find((g) => g.id === o.finishedGoodId)?.code}). <a href="#/estoque/pecas">Ver peças produzidas</a></Alert>}
        <h3>Material previsto</h3>
        <div className="card"><table className="tbl"><thead><tr><th>Material</th><th className="num">Previsto</th><th className="num">Disponível p/ esta OP</th><th>Situação</th></tr></thead><tbody>
          {avail.map((a, i) => <tr key={i}><td>{lineName(a.materialId, a.lotId)}</td><td className="num">{fmtNum(a.needed)} {matOf(a.materialId, a.lotId)?.unit ?? ''}</td><td className="num">{fmtNum(a.available)}</td>
            <td>{!open ? '—' : a.shortage.gt(0) ? <Badge tone="error">faltam {fmtNum(a.shortage)}</Badge> : o.status === 'planejada' || o.status === 'aguardando_material' ? <Badge tone="success">disponível</Badge> : <Badge tone="info">reservado</Badge>}</td></tr>)}
        </tbody></table></div>
        {reserved.length > 0 && <p className="small muted">Reservado: {reserved.map((r) => `${lotName(r.lotId)} — ${fmtNum(r.qty)}`).join(' · ')}</p>}
        {o.status === 'concluida' && <Comparison order={o} />}
        {o.notes && <p className="muted">{o.notes}</p>}
      </div>
      {completing && <CompleteForm order={o} onClose={() => setCompleting(false)} />}
      {planning && <PlanningForm order={o} onClose={() => setPlanning(false)} />}
      {card && <ThankYouCardDialog customerName={db.parties.find((p) => p.id === o.customerId)?.name} orderNumber={o.number} onClose={() => setCard(false)} />}
      {confirmEl}
    </Modal>
  );
}

function PlanningForm({ order: o, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ dueDate: o.dueDate ?? '', printerId: o.printerId ?? '', notes: o.notes ?? '' });
  const submit = () => {
    if (o.quoteId && !f.dueDate) return void run(() => { throw new BusinessError('Pedido a partir de orçamento precisa de data de entrega.'); });
    run((d) => updateOrderPlanning(d, o.id, { purpose: purposeOf(o), customerId: o.customerId, dueDate: f.dueDate, printerId: f.printerId || undefined, notes: f.notes }), 'Atualizado. O quadro se reorganiza pela nova data.').then((r) => r.ok && onClose());
  };
  return (
    <Modal title={`Planejamento de ${o.number}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></>}>
      <div className="grid g2">
        <DateField label="Data de entrega" required={!!o.quoteId} value={f.dueDate} onChange={set('dueDate')} />
        <SelectField label="Impressora" value={f.printerId} onChange={set('printerId')} placeholder="—" options={db.printers.map((p) => ({ value: p.id, label: p.name }))} />
      </div>
      <div style={{ marginTop: 12 }}><TextArea label="Observações" value={f.notes} onChange={set('notes')} /></div>
    </Modal>
  );
}

function Comparison({ order }: { order: ProductionOrder }) {
  const { db } = useStore();
  const c = compareOrder(db, order);
  const a = order.actual!;
  if (!c.real) return null;
  const diff = (est: Decimal | null, real: Decimal | null) => {
    if (!est || !real || est.isZero()) return '—';
    const p = real.minus(est).div(est);
    return <span style={{ color: p.gt(0.05) ? 'var(--error)' : p.lt(-0.05) ? 'var(--success)' : undefined }}>{p.gt(0) ? '+' : ''}{fmtPct(p)}</span>;
  };
  return (
    <>
      <h3>Previsto × realizado</h3>
      <div className="card"><table className="tbl"><thead><tr><th>Indicador</th><th className="num">Previsto</th><th className="num">Realizado</th><th className="num">Desvio</th></tr></thead><tbody>
        <tr><td>Material (incl. perdas)</td><td className="num">{fmtNum(c.estimated.materialQty)}</td><td className="num">{fmtNum(c.real.materialQty)}</td><td className="num">{diff(c.estimated.materialQty, c.real.materialQty)}</td></tr>
        <tr><td>Horas de máquina (incl. perdidas)</td><td className="num">{fmtNum(c.estimated.hours)}</td><td className="num">{fmtNum(c.real.hours)}</td><td className="num">{diff(c.estimated.hours, c.real.hours)}</td></tr>
        <tr><td>Peças aprovadas / planejadas</td><td className="num">{order.qtyPlanned}</td><td className="num">{a.qtyApproved} (+{a.qtyRejected} rejeitadas)</td><td /></tr>
        <tr><td>Custo total do pedido</td><td className="num">{fmtBRL(c.estimated.total)}</td><td className="num">{fmtBRL(c.real.total)}</td><td className="num">{diff(c.estimated.total, c.real.total)}</td></tr>
        <tr><td><b>Custo por peça aprovada</b></td><td className="num">{fmtBRL(c.estimated.unit)}</td><td className="num"><b>{fmtBRL(c.real.unit)}</b></td><td className="num">{diff(c.estimated.unit, c.real.unit)}</td></tr>
      </tbody></table></div>
      {c.real.laborEstimated && <Alert tone="info">Mão de obra real não informada: o realizado usa os tempos do orçamento (estimado).</Alert>}
      {!c.real.result.complete && <Alert tone="warning">Custo realizado parcial: {c.real.result.pending.join(' ')}</Alert>}
      {a.failures.length > 0 && <><h3>Falhas registradas</h3><ul className="small">{a.failures.map((f) => <li key={f.id}>{f.description} — {fmtNum(f.qtyLost)} perdidos, {fmtNum(f.hoursLost)} h</li>)}</ul></>}
    </>
  );
}

function CompleteForm({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const { db, run } = useStore();
  // Ponto de partida: os lotes efetivamente reservados para a OP (o usuário corrige com o consumo real).
  const [mats, setMats] = useState(() => {
    const res = orderReservations(db, order.id);
    const base = res.length ? res.map((r) => ({ lotId: r.lotId, qty: r.qty.toNumber() }))
      : order.plannedMaterials.map((m) => ({ lotId: m.lotId ?? db.lots.find((l) => l.materialId === m.materialId && lotBalance(db, l.id).physical.gt(0))?.id ?? '', qty: m.qty }));
    return base.map((m) => ({ lotId: m.lotId, qty: String(m.qty).replace('.', ',') }));
  });
  const [f, set] = useForm({ hours: order.plannedHours as number | null, approved: String(order.qtyPlanned), rejected: '0', labor: '', notes: '', location: '' });
  const [fails, setFails] = useState<{ description: string; lotId: string; qtyLost: string; hoursLost: number | null }[]>([]);
  const lotOpts = db.lots.filter((l) => lotBalance(db, l.id).physical.gt(0) || mats.some((m) => m.lotId === l.id)).map((l) => ({ value: l.id, label: lotLabel(db, l) }));
  const toStock = purposeOf(order) === 'estoque';
  const submit = () => run((d) => completeOrder(d, order.id, {
    materials: mats.map((m) => ({ lotId: m.lotId, qty: num(m.qty) ?? 0 })).filter((m) => m.lotId),
    hours: f.hours ?? -1, qtyApproved: num(f.approved) ?? -1, qtyRejected: num(f.rejected) ?? -1, laborMinutes: f.labor.trim() ? num(f.labor) : null,
    failures: fails.map((x) => ({ description: x.description, lotId: x.lotId || undefined, qtyLost: num(x.qtyLost) ?? 0, hoursLost: x.hoursLost ?? 0 })), notes: f.notes,
    location: f.location,
  }), toStock ? 'OP concluída: consumo baixado e peças aprovadas enviadas ao estoque de pronta-entrega.' : 'OP concluída: reservas liberadas e consumo real baixado.').then((r) => r.ok && onClose());
  return (
    <Modal wide title={`Concluir ${order.number}`} subtitle="Informe o consumo REAL. Esta baixa acontece uma única vez." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Voltar</button><button className="btn primary" onClick={submit}>Concluir e baixar estoque</button></>}>
      <div className="stack">
        <p className="section-title">Consumo real das peças produzidas (sem as falhas)</p>
        {mats.map((m, i) => (
          <div key={i} className="line-item">
            <SelectField label="Lote utilizado" value={m.lotId} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, lotId: v } : x)))} placeholder="— selecione —" options={lotOpts} />
            <NumField label="Quantidade" value={m.qty} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, qty: v } : x)))} />
            <button className="btn ghost sm" onClick={() => setMats((r) => r.filter((_, k) => k !== i))} aria-label="Remover">✕</button>
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setMats((r) => [...r, { lotId: '', qty: '' }])}>+ Outro lote</button></div>
        <div className="grid g4">
          <TimeField label="Tempo real de impressão (total)" value={f.hours} onChange={set('hours')} />
          <NumField label="Peças aprovadas" value={f.approved} onChange={set('approved')} />
          <NumField label="Peças rejeitadas" value={f.rejected} onChange={set('rejected')} />
          <NumField label="Mão de obra real (total)" suffix="min" value={f.labor} onChange={set('labor')} hint="Vazio = usar estimativa do orçamento" />
        </div>
        {toStock && <TextField label="Onde as peças prontas ficarão guardadas" value={f.location} onChange={set('location')} placeholder="Ex.: prateleira A, caixa 3" hint="As peças aprovadas entram em Produção → Peças prontas com a data de hoje." />}
        <p className="section-title">Falhas e reimpressões</p>
        {fails.map((x, i) => (
          <div key={i} className="grid g4" style={{ alignItems: 'end' }}>
            <TextField label="O que aconteceu" value={x.description} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, description: v } : y)))} placeholder="Ex.: descolou da mesa" />
            <SelectField label="Lote do material perdido" value={x.lotId} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, lotId: v } : y)))} placeholder="—" options={lotOpts} />
            <NumField label="Material perdido" value={x.qtyLost} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, qtyLost: v } : y)))} />
            <TimeField label="Tempo perdido" value={x.hoursLost} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, hoursLost: v } : y)))} />
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setFails((r) => [...r, { description: '', lotId: mats[0]?.lotId ?? '', qtyLost: '', hoursLost: null }])}>+ Registrar falha</button></div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

/** Produção para estoque: sem orçamento; o sistema calcula custo e valor sugerido de venda na hora. */
function StockProductionForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ description: '', projectId: '', printerId: db.settings.defaultPrinterId ?? db.printers[0]?.id ?? '', qty: '1', hoursPerUnit: null as number | null, notes: '', done: false, location: '' });
  const [mats, setMats] = useState([{ materialId: db.materials.find((m) => m.active && m.filament)?.id ?? '', qtyPerUnit: '' }]);
  const [image, setImage] = useState<string | null>(null);
  const qty = num(f.qty) ?? 0;
  const matOpts = db.materials.filter((m) => m.active).map((m) => {
    const r = reorderAnalysis(db, m);
    return { value: m.id, label: `${materialLabel(m)} · disp. ${fmtNum(r.available)} ${m.unit}` };
  });
  const planned = mats.filter((m) => m.materialId && (num(m.qtyPerUnit) ?? 0) > 0).map((m) => ({ materialId: m.materialId, qty: (num(m.qtyPerUnit) ?? 0) * Math.max(qty, 0) }));
  const plannedHours = f.hoursPerUnit !== null ? f.hoursPerUnit * Math.max(qty, 0) : null;
  const estimate = useMemo(() => {
    if (!(qty > 0) || !planned.length) return null;
    try { return stockEstimate(db, { qtyPlanned: qty, plannedMaterials: planned, plannedHours, printerId: f.printerId || undefined }); } catch { return null; }
  }, [db, qty, JSON.stringify(planned), plannedHours, f.printerId]);
  const submit = () => {
    const input = { description: f.description, purpose: 'estoque' as const, projectId: f.projectId || undefined, printerId: f.printerId || undefined, qtyPlanned: qty, plannedMaterials: planned, plannedHours, notes: f.notes, image };
    run((d) => f.done ? produceForStockNow(d, { ...input, location: f.location }) : createManualOrder(d, input),
      f.done ? 'Peças lançadas em Estoque → Peças produzidas e material baixado do estoque.' : 'Produção para estoque criada: custo e valor sugerido calculados.').then((r) => r.ok && onClose());
  };
  const s = estimate?.summary;
  return (
    <Modal wide title="Nova produção para estoque" subtitle="Peças de pronta-entrega, sem orçamento prévio. Os valores usam os seus Parâmetros de Custos (markup, canal, falhas)." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>{f.done ? 'Lançar peças e baixar material' : 'Criar produção'}</button></>}>
      <div className="stack">
        <div className="seg" role="radiogroup" aria-label="Situação das peças">
          <button type="button" role="radio" aria-checked={!f.done} className={`btn sm ${!f.done ? 'primary' : 'ghost'}`} onClick={() => set('done')(false)}>Vou produzir (entra no quadro)</button>
          <button type="button" role="radio" aria-checked={f.done} className={`btn sm ${f.done ? 'primary' : 'ghost'}`} onClick={() => set('done')(true)}>Já produzi (baixar material agora)</button>
        </div>
        {f.done && <Alert tone="info" title="Peças já produzidas">O material informado abaixo sai do estoque agora (lotes mais antigos primeiro) e as peças entram em Estoque → Peças produzidas com o custo real dos lotes.</Alert>}
        <div className="grid g3">
          <TextField label="Peça" required value={f.description} onChange={set('description')} placeholder="Ex.: Dragão articulado" />
          <NumField label="Quantidade a produzir" required value={f.qty} onChange={set('qty')} suffix="un" />
          <SelectField label="Impressora" value={f.printerId} onChange={set('printerId')} placeholder="—" options={db.printers.map((p) => ({ value: p.id, label: p.name }))} />
          <TimeField label="Tempo de impressão de 1 peça" value={f.hoursPerUnit} onChange={set('hoursPerUnit')} />
          <SelectField label="Projeto" value={f.projectId} onChange={set('projectId')} placeholder="— nenhum —" options={db.projects.map((p) => ({ value: p.id, label: p.name }))} />
          {f.done && <TextField label="Onde estão guardadas" value={f.location} onChange={set('location')} placeholder="Ex.: prateleira 2" />}
        </div>
        <ImagePicker value={image} onChange={setImage} hint="Opcional. Vai para Estoque → Peças produzidas e para os orçamentos feitos com esta peça." />
        <p className="section-title">Material por peça</p>
        {mats.map((m, i) => (
          <div key={i} className="line-item">
            <SelectField label="Material" value={m.materialId} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, materialId: v } : x)))} placeholder="— selecione —" options={matOpts} />
            <NumField label={`Por peça${db.materials.find((x) => x.id === m.materialId) ? ` (${db.materials.find((x) => x.id === m.materialId)!.unit})` : ''}`} value={m.qtyPerUnit} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, qtyPerUnit: v } : x)))} />
            <button className="btn ghost sm" onClick={() => setMats((r) => r.filter((_, k) => k !== i))} aria-label="Remover">✕</button>
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setMats((r) => [...r, { materialId: '', qtyPerUnit: '' }])}>+ Material</button></div>
        <div className="kpis">
          <Kpi label="Custo por peça" value={s?.unitCost ? fmtBRL(s.unitCost) : '—'} hint={s ? (s.complete ? 'estimado com seus parâmetros' : 'parcial: faltam parâmetros') : 'informe material, peso e quantidade'} />
          <Kpi label="Valor sugerido de venda" value={s?.unitPrice ? fmtBRL(s.unitPrice) : '—'} hint={db.settings.defaultMarkupPct ? `markup ${fmtNum(db.settings.defaultMarkupPct)}%` : 'defina o markup em Parâmetros'} accent />
          <Kpi label="Lote inteiro" value={s?.totalCost ? fmtBRL(s.totalCost) : '—'} hint={plannedHours !== null ? `${fmtDuration(plannedHours)} de impressão` : ''} />
        </div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Cartão de agradecimento (modelo da marca)                           */
/* ================================================================== */
function ThankYouCardDialog({ customerName, orderNumber, onClose }: { customerName?: string; orderNumber: string; onClose: () => void }) {
  const { db, toast } = useStore();
  const ig = (clientQuoteSettings(db).instagram || 'ideiacubica').replace(/^@/, '');
  const [personal, setPersonal] = useState(false);
  const first = customerName?.trim().split(/\s+/)[0];
  useEffect(() => {
    const original = document.title;
    const before = () => { document.title = `Cartão de agradecimento ${orderNumber}${customerName ? ` - ${customerName}` : ''}`; };
    const after = () => { document.title = original; };
    window.addEventListener('beforeprint', before); window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); document.title = original; };
  }, [orderNumber, customerName]);
  const print = () => { toast('info', 'Na janela que abrir, escolha “Salvar como PDF” ou a sua impressora. Imprima frente e verso.'); setTimeout(() => window.print(), 50); };
  const card = <ThankYouCard instagram={ig} name={personal ? first : undefined} />;
  const preview = <ThankYouCard instagram={ig} name={personal ? first : undefined} scaled />;
  return (
    <Modal wide title="Cartão de agradecimento" subtitle={`${orderNumber}${customerName ? ` · ${customerName}` : ''} · frente e verso, 12 × 12 cm`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button><button className="btn primary" onClick={print}>Imprimir / salvar PDF</button></>}>
      <div className="stack">
        {first && <Check label={`Personalizar com o nome: “Obrigada, ${first}!”`} checked={personal} onChange={setPersonal} />}
        <div className="ty-preview">{preview}</div>
        <p className="small muted">Segue o modelo oficial: frente com o padrão da marca e “Seu pedido chegou! · Feito e embalado com carinho!”, verso amarelo com o agradecimento e o Instagram @{ig}.</p>
      </div>
      {createPortal(<div className="cq-print-root ty-print">{card}</div>, document.body)}
    </Modal>
  );
}

function ThankYouCard({ instagram, name, scaled }: { instagram: string; name?: string; scaled?: boolean }) {
  const wrap = (node: ReactNode) => (scaled ? <div className="ty-scale">{node}</div> : node);
  // ids únicos: a pré-visualização e a cópia de impressão ficam na página ao mesmo tempo
  const uid = scaled ? 'p' : 'i';
  return (
    <>
      {wrap(<div className="ty-page ty-front">
        <svg viewBox="0 0 400 400" width="100%" height="100%" aria-label="Seu pedido chegou! Feito e embalado com carinho!">
          <defs>
            <pattern id={`ty-pat-${uid}`} width="57.14" height="57.14" patternUnits="userSpaceOnUse">
              <image href="/brand/10_icone_simbolo_transparente.svg" x="1" y="1" width="55" height="55" />
            </pattern>
            <path id={`ty-top-${uid}`} d="M 84 200 A 116 116 0 0 1 316 200" />
            <path id={`ty-bot-${uid}`} d="M 62 200 A 138 138 0 0 0 338 200" />
          </defs>
          <rect width="400" height="400" fill="#f5f1e6" />
          <rect width="400" height="400" fill={`url(#ty-pat-${uid})`} />
          <circle cx="200" cy="200" r="152" fill="#fff" />
          <text className="ty-arc"><textPath href={`#ty-top-${uid}`} startOffset="50%" textAnchor="middle">Seu pedido chegou!</textPath></text>
          <text className="ty-arc"><textPath href={`#ty-bot-${uid}`} startOffset="50%" textAnchor="middle">Feito e embalado com carinho!</textPath></text>
          <image href="/brand/10_icone_simbolo_transparente.svg" x="74" y="132" width="132" height="132" />
          <text x="204" y="194" className="ty-word">ideia</text>
          <text x="204" y="228" className="ty-word">cúbica</text>
          <text x="205" y="245" className="ty-tag">IMPRESSÃO 3D</text>
        </svg>
      </div>)}
      {wrap(<div className="ty-page ty-back">
        <h2>{name ? `Obrigada, ${name}!` : 'Obrigada!'}</h2>
        <p>Ficamos muito felizes com seu pedido que foi preparado com todo o cuidado para chegar até você.</p>
        <p>Esperamos que goste!<br /><b>Compartilhe sua experiência com a gente. Vamos adorar saber o que achou!</b></p>
        <p><b>Não se esqueça de nos marcar nas redes sociais:<br />@{instagram}</b></p>
      </div>)}
    </>
  );
}

/* ================================================================== */
/* Projetos                                                            */
/* ================================================================== */
const COMMERCIAL: Record<Project['commercialUse'], { label: string; tone: Tone }> = {
  proprio: { label: 'Modelo próprio', tone: 'success' }, autorizado: { label: 'Uso comercial autorizado', tone: 'success' },
  verificar: { label: 'Verificar licença', tone: 'warning' }, nao_autorizado: { label: 'Uso comercial NÃO autorizado', tone: 'error' },
};

function Projetos() {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<Project | 'novo' | null>(null);
  const [view, setView] = useState<Project | null>(null);
  return (
    <div className="card">
      <div className="card-head"><div><h2>Projetos / produtos</h2><p className="muted small">Visão por produto: arquivos, versões, produção, vendas e rentabilidade.</p></div><button className="btn primary" onClick={() => setEdit('novo')}>Novo projeto</button></div>
      <DataTable rows={db.projects} rowKey={(p) => p.id} onRowClick={setView} search={(p) => `${p.code} ${p.name} ${p.creator ?? ''}`}
        empty={<Empty title="Nenhum projeto cadastrado" text="Cadastre cada produto/arquivo para acompanhar histórico de produção, vendas e resultado." action={<button className="btn primary" onClick={() => setEdit('novo')}>Cadastrar projeto</button>} />}
        columns={[
          { key: 'c', header: 'Código', render: (p) => <span className="mono">{p.code}</span>, sort: (p) => p.code },
          { key: 'n', header: 'Produto', render: (p) => <><b>{p.name}</b><div className="muted small">{p.creator ? `por ${p.creator}` : ''}</div></>, sort: (p) => p.name },
          { key: 'l', header: 'Licença', render: (p) => <Badge tone={COMMERCIAL[p.commercialUse].tone}>{COMMERCIAL[p.commercialUse].label}</Badge> },
          { key: 'v', header: 'Versão atual', render: (p) => p.files.length ? p.files[p.files.length - 1].version : '—' },
          { key: 'o', header: 'OPs', num: true, render: (p) => db.orders.filter((o) => o.projectId === p.id).length },
          { key: 's', header: 'Vendidas', num: true, render: (p) => db.sales.filter((s) => s.projectId === p.id && s.status === 'ativa').reduce((a, s) => a + s.qty, 0) },
        ]} />
      {edit && <ProjectForm item={edit === 'novo' ? undefined : edit} onClose={() => setEdit(null)} onSave={(v, id) => run((d) => saveProject(d, v, id), 'Projeto salvo.').then((r) => r.ok && setEdit(null))} />}
      {view && <ProjectDetail project={view} onClose={() => setView(null)} onEdit={() => { setEdit(view); setView(null); }} />}
    </div>
  );
}

function ProjectForm({ item, onClose, onSave }: { item?: Project; onClose: () => void; onSave: (v: Parameters<typeof saveProject>[1], id?: string) => void }) {
  const { db } = useStore();
  const [f, set] = useForm({ code: item?.code ?? '', name: item?.name ?? '', sourceUrl: item?.sourceUrl ?? '', creator: item?.creator ?? '', license: item?.license ?? '',
    commercialUse: item?.commercialUse ?? 'verificar', recommendedMaterial: item?.recommendedMaterial ?? '', colors: item?.colors ?? '', printerId: item?.printerId ?? '', printProfile: item?.printProfile ?? '', notes: item?.notes ?? '' });
  return (
    <Modal wide title={item ? 'Editar projeto' : 'Novo projeto'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave({ ...f, commercialUse: f.commercialUse as Project['commercialUse'], printerId: f.printerId || undefined }, item?.id)}>Salvar</button></>}>
      <div className="grid g3">
        <TextField label="Nome do produto" required value={f.name} onChange={set('name')} />
        <TextField label="Identificador interno" value={f.code} onChange={set('code')} hint="Vazio = automático" />
        <TextField label="Link de origem" value={f.sourceUrl} onChange={set('sourceUrl')} placeholder="https://makerworld.com/..." />
        <TextField label="Criador do modelo" value={f.creator} onChange={set('creator')} />
        <TextField label="Licença publicada" value={f.license} onChange={set('license')} placeholder="Ex.: Standard Digital File License" />
        <SelectField label="Uso comercial" value={f.commercialUse} onChange={(v) => set('commercialUse')(v as Project['commercialUse'])} options={Object.entries(COMMERCIAL).map(([value, v]) => ({ value, label: v.label }))} />
        <TextField label="Material recomendado" value={f.recommendedMaterial} onChange={set('recommendedMaterial')} />
        <TextField label="Cores" value={f.colors} onChange={set('colors')} />
        <SelectField label="Impressora compatível" value={f.printerId} onChange={set('printerId')} placeholder="—" options={db.printers.map((p) => ({ value: p.id, label: p.name }))} />
        <TextField label="Perfil de impressão" value={f.printProfile} onChange={set('printProfile')} placeholder="Ex.: 0.16mm High Quality" />
      </div>
      <div style={{ marginTop: 12 }}><TextArea label="Observações" value={f.notes} onChange={set('notes')} /></div>
    </Modal>
  );
}

function ProjectDetail({ project, onClose, onEdit }: { project: Project; onClose: () => void; onEdit: () => void }) {
  const { db, run } = useStore();
  const p = db.projects.find((x) => x.id === project.id)!;
  const [fv, setFv] = useForm({ version: '', fileName: '', date: todayISO(), notes: '' });
  const quotes = db.quotes.filter((q) => q.projectId === p.id);
  const orders = db.orders.filter((o) => o.projectId === p.id);
  const sales = db.sales.filter((s) => s.projectId === p.id && s.status === 'ativa');
  const produced = orders.reduce((a, o) => a + (o.actual?.qtyApproved ?? 0), 0);
  const realCosts = orders.filter((o) => o.status === 'concluida').map((o) => compareOrder(db, o).real?.total ?? ZERO);
  const eco = sales.map(saleEconomics);
  const revenue = sum(eco.map((e) => e.revenue));
  const contribution = sum(eco.map((e) => e.contribution ?? ZERO));
  const sold = sales.reduce((a, s) => a + s.qty, 0);
  const pending = sales.some((s) => s.costStatus !== 'realizado');
  return (
    <Modal wide title={`${p.code} · ${p.name}`} subtitle={p.sourceUrl ?? undefined} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button><button className="btn primary" onClick={onEdit}>Editar</button></>}>
      <div className="stack">
        {p.commercialUse !== 'proprio' && p.commercialUse !== 'autorizado' && <Alert tone={p.commercialUse === 'nao_autorizado' ? 'error' : 'warning'}>{COMMERCIAL[p.commercialUse].label}. Confirme a licença antes de vender peças deste modelo.</Alert>}
        <div className="kpis">
          <Kpi label="Produzidas (aprovadas)" value={produced} />
          <Kpi label="Vendidas" value={sold} />
          <Kpi label="Receita acumulada" value={fmtBRL(revenue)} />
          <Kpi label="Custo real de produção" value={fmtBRL(sum(realCosts))} hint={`${realCosts.length} OP(s) concluída(s)`} />
          <Kpi label="Margem de contribuição" value={fmtBRL(contribution)} hint={pending ? 'inclui custos estimados' : 'realizado'} />
          <Kpi label="Por unidade vendida" value={sold ? fmtBRL(contribution.div(sold)) : '—'} />
        </div>
        <h3>Arquivos e versões</h3>
        {p.files.length > 0 && <div className="card"><table className="tbl"><thead><tr><th>Versão</th><th>Arquivo</th><th>Data</th><th>Notas</th></tr></thead><tbody>
          {p.files.map((f) => <tr key={f.id}><td><b>{f.version}</b></td><td className="mono">{f.fileName}</td><td>{fmtDate(f.date)}</td><td className="small">{f.notes}</td></tr>)}</tbody></table></div>}
        <div className="grid g4" style={{ alignItems: 'end' }}>
          <TextField label="Nova versão" value={fv.version} onChange={setFv('version')} placeholder="v2" />
          <TextField label="Nome do arquivo" value={fv.fileName} onChange={setFv('fileName')} placeholder="peca_v2.3mf" />
          <TextField label="O que mudou" value={fv.notes} onChange={setFv('notes')} />
          <button className="btn secondary" onClick={() => run((d) => addProjectFileVersion(d, p.id, fv), 'Versão registrada.')}>Registrar versão</button>
        </div>
        <p className="small muted">O arquivo em si permanece na sua pasta de modelos; o sistema registra nome e versão para rastreabilidade. Upload de arquivos será possível com o Supabase Storage.</p>
        <h3>Orçamentos e produção</h3>
        <div className="card"><table className="tbl"><tbody>
          {quotes.map((q) => <tr key={q.id} className="clickable" onClick={() => navigate(`orcamentos/${q.id}`)}><td className="mono">{q.number}</td><td>{q.name}</td><td>v{q.versions.length}</td><td><Badge tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</Badge></td></tr>)}
          {orders.map((o) => <tr key={o.id}><td className="mono">{o.number}</td><td>{o.description}</td><td>{o.actual ? `${o.actual.qtyApproved} aprovadas` : `${o.qtyPlanned} planejadas`}</td><td><Badge tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge></td></tr>)}
          {!quotes.length && !orders.length && <tr><td className="muted">Nenhum orçamento ou OP vinculado. Vincule o projeto ao criar o orçamento.</td></tr>}
        </tbody></table></div>
      </div>
    </Modal>
  );
}


import { useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { FinishedGood, OrderStatus, ProductionOrder, Project } from '../../domain/types';
import {
  ORDER_STATUS_LABEL, QUEUE_STATUSES, addProjectFileVersion, cancelOrder, checkAvailability, compareOrder, completeOrder, createManualOrder, daysInStock,
  finishedGoodBalance, moveInQueue, moveOrderStatus, orderDelivery, orderReservations, productionQueue, queueShortages, registerFinishedGood, reserveOrderMaterials,
  saveProject, startOrder, updateOrderPlanning, writeOffFinishedGood,
} from '../../domain/production';
import { lotBalance, lotLabel, reorderAnalysis } from '../../domain/inventory';
import { saleEconomics } from '../../domain/sales';
import { latestVersion } from '../../domain/quotes';
import { fmtDuration } from '../../domain/conversions';
import { addDays as addDaysISO, fmtDate, fmtDateTime, todayISO } from '../../domain/core';
import { D, Decimal, ZERO, fmtBRL, fmtNum, fmtPct, sum } from '../../domain/money';
import { Alert, Badge, Check, Combobox, DataTable, DateField, Empty, Kpi, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, TimeField, dec, num, useConfirm, useForm, type Tone } from '../components/ui';
import { QUOTE_STATUS } from './Orcamentos';
import { SaleForm } from './Financeiro';

type Tab = 'quadro' | 'pedidos' | 'pronta-entrega' | 'ordens' | 'projetos';
const STATUS_TONE: Record<OrderStatus, Tone> = {
  planejada: 'neutral', aguardando_material: 'error', pronta: 'info', em_producao: 'primary', aguardando_acabamento: 'warning', em_inspecao: 'warning', concluida: 'success', cancelada: 'neutral',
};
const PURPOSE_LABEL = { pedido: 'Pedido', estoque: 'Estoque' } as const;
const purposeOf = (o: ProductionOrder) => o.purpose ?? 'pedido';

export function Producao({ param }: { param?: string }) {
  const { db } = useStore();
  const tab: Tab = param === 'ordens' || param === 'projetos' || param === 'pedidos' || param === 'pronta-entrega' ? param : 'quadro';
  const active = db.orders.filter((o) => !['concluida', 'cancelada'].includes(o.status)).length;
  const openOrders = db.orders.filter((o) => purposeOf(o) === 'pedido' && ['fila', 'producao', 'pronto'].includes(orderDelivery(db, o))).length;
  const fgCount = db.finishedGoods.filter((g) => finishedGoodBalance(db, g.id).available > 0).length;
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead eyebrow="Módulo 5" title="Produção" text="Fila de produção, pedidos de clientes e peças prontas para venda. Reserva e baixa de material sem duplicidade."
        actions={<><button className="btn secondary" onClick={() => setCreating(true)} disabled={!db.materials.length}>Nova OP manual</button>
          <button className="btn primary" onClick={() => navigate('orcamentos')}>OP a partir de orçamento</button></>} />
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`producao/${t}`)} tabs={[
        { id: 'quadro', label: 'Quadro (Kanban)', count: active || undefined },
        { id: 'pedidos', label: 'Pedidos de clientes', count: openOrders || undefined },
        { id: 'pronta-entrega', label: 'Peças prontas (estoque)', count: fgCount || undefined },
        { id: 'ordens', label: 'Todas as ordens' },
        { id: 'projetos', label: 'Projetos / produtos', count: db.projects.length },
      ]} />
      {tab === 'quadro' && <Quadro />}
      {tab === 'pedidos' && <Pedidos />}
      {tab === 'pronta-entrega' && <ProntaEntrega />}
      {tab === 'ordens' && <Ordens />}
      {tab === 'projetos' && <Projetos />}
      {creating && <ManualOrderForm onClose={() => setCreating(false)} />}
    </>
  );
}

/* ================================================================== */
/* Quadro Kanban                                                       */
/* ================================================================== */
type Column = 'fila' | 'producao' | 'acabamento' | 'concluidas';
const COLUMNS: { id: Column; title: string; hint: string }[] = [
  { id: 'fila', title: 'Sequência (fila)', hint: 'Arraste para mudar a ordem. A primeira é a próxima a imprimir.' },
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
    producao: db.orders.filter((o) => columnOf(o) === 'producao'),
    acabamento: db.orders.filter((o) => columnOf(o) === 'acabamento'),
    concluidas: db.orders.filter((o) => o.status === 'concluida' && (o.finishedAt ?? '') >= since).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')),
  };
  const queueHours = cards.fila.reduce((s, o) => s + (o.plannedHours ?? 0), 0);

  /** Soltar um card numa coluna (e, na fila, antes de outro card). */
  const drop = (col: Column, beforeId?: string) => {
    const o = db.orders.find((x) => x.id === dragId);
    setDragId(null); setOver(null);
    if (!o) return;
    const from = columnOf(o);
    if (col === 'fila') {
      if (from !== 'fila') return void toast('warning', 'Uma ordem já iniciada não volta para a fila.');
      const queue = cards.fila.filter((x) => x.id !== o.id);
      const idx = beforeId ? queue.findIndex((x) => x.id === beforeId) : queue.length;
      return void run((d) => moveInQueue(d, o.id, idx < 0 ? queue.length : idx));
    }
    if (col === from) return;
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
  const move = (o: ProductionOrder, delta: number) => {
    const idx = cards.fila.findIndex((x) => x.id === o.id);
    run((d) => moveInQueue(d, o.id, idx + delta));
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
              {cards[c.id].length === 0 && <div className="kb-empty">Nenhuma ordem</div>}
              {cards[c.id].map((o, i) => (
                <KanbanCard key={o.id} order={o} position={c.id === 'fila' ? i + 1 : undefined}
                  dragging={dragId === o.id}
                  onDragStart={() => setDragId(o.id)} onDragEnd={() => { setDragId(null); setOver(null); }}
                  onDropBefore={c.id === 'fila' ? () => drop('fila', o.id) : undefined}
                  onOpen={() => setSel(o)}
                  onUp={c.id === 'fila' && i > 0 ? () => move(o, -1) : undefined}
                  onDown={c.id === 'fila' && i < cards.fila.length - 1 ? () => move(o, 1) : undefined} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Arraste os cartões entre as colunas: soltar em <b>Em produção</b> reserva o material e inicia a OP; soltar em <b>Produzidas</b> abre a conclusão com o consumo real.
        No celular, use as setas ▲▼ para mudar a sequência e abra o cartão para mudar o status.
      </p>
      {sel && <OrderModal order={sel} onClose={() => setSel(null)} />}
      {completing && <CompleteForm order={completing} onClose={() => setCompleting(null)} />}
    </>
  );
}

function KanbanCard({ order: o, position, dragging, onDragStart, onDragEnd, onDropBefore, onOpen, onUp, onDown }: {
  order: ProductionOrder; position?: number; dragging: boolean; onDragStart: () => void; onDragEnd: () => void;
  onDropBefore?: () => void; onOpen: () => void; onUp?: () => void; onDown?: () => void;
}) {
  const { db } = useStore();
  const customer = db.parties.find((p) => p.id === o.customerId);
  const printer = db.printers.find((p) => p.id === o.printerId);
  const shortage = QUEUE_STATUSES.includes(o.status) && (queueShortages(db).has(o.id) || checkAvailability(db, o).some((a) => a.shortage.gt(0)));
  const late = o.dueDate && o.status !== 'concluida' && o.dueDate < todayISO();
  const image = o.quoteId ? db.quotes.find((q) => q.id === o.quoteId)?.image : undefined;
  return (
    <article className={`kb-card${dragging ? ' dragging' : ''}`} draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', o.id); onDragStart(); }}
      onDragEnd={onDragEnd}
      onDragOver={onDropBefore ? (e) => e.preventDefault() : undefined}
      onDrop={onDropBefore ? (e) => { e.preventDefault(); e.stopPropagation(); onDropBefore(); } : undefined}>
      <button className="kb-open" onClick={onOpen} aria-label={`Abrir ${o.number}`}>
        <div className="kb-top">
          {position !== undefined && <span className="kb-pos">{position}º</span>}
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
          {o.dueDate && <span className={late ? 'err-text' : ''}>entrega {fmtDate(o.dueDate)}</span>}
        </div>
        <div className="kb-tags">
          {o.status !== 'em_producao' && o.status !== 'concluida' && <Badge tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge>}
          {shortage && <Badge tone="error">falta material</Badge>}
          {late && <Badge tone="error">atrasada</Badge>}
        </div>
      </button>
      {(onUp || onDown || position !== undefined) && (
        <div className="kb-arrows">
          <button className="btn ghost sm" onClick={onUp} disabled={!onUp} aria-label="Subir na fila">▲</button>
          <button className="btn ghost sm" onClick={onDown} disabled={!onDown} aria-label="Descer na fila">▼</button>
        </div>
      )}
    </article>
  );
}

/* ================================================================== */
/* Pedidos de clientes                                                 */
/* ================================================================== */
const DELIVERY: Record<ReturnType<typeof orderDelivery>, { label: string; tone: Tone }> = {
  fila: { label: 'Na fila', tone: 'neutral' }, producao: { label: 'Em produção', tone: 'primary' },
  pronto: { label: 'Pronto para entregar', tone: 'warning' }, entregue: { label: 'Entregue / vendido', tone: 'success' }, cancelado: { label: 'Cancelado', tone: 'neutral' },
};

function Pedidos() {
  const { db } = useStore();
  const [sel, setSel] = useState<ProductionOrder | null>(null);
  const [selling, setSelling] = useState<ProductionOrder | null>(null);
  const [filter, setFilter] = useState('abertos');
  const rows = db.orders.filter((o) => purposeOf(o) === 'pedido')
    .map((o) => ({ o, d: orderDelivery(db, o) }))
    .filter((r) => filter === 'todos' || (filter === 'abertos' ? ['fila', 'producao', 'pronto'].includes(r.d) : r.d === filter))
    .sort((a, b) => (a.o.dueDate ?? '9999').localeCompare(b.o.dueDate ?? '9999') || a.o.createdAt.localeCompare(b.o.createdAt));
  return (
    <div className="card">
      <div className="card-head"><div><h2>Pedidos de clientes</h2><p className="muted small">O que cada cliente encomendou, prazo e situação. Ao entregar, registre a venda para baixar o pedido.</p></div></div>
      <DataTable rows={rows} rowKey={(r) => r.o.id} onRowClick={(r) => setSel(r.o)}
        search={(r) => `${r.o.number} ${r.o.description} ${db.parties.find((p) => p.id === r.o.customerId)?.name ?? ''}`}
        toolbar={<Combobox compact ariaLabel="Filtrar pedidos" value={filter} onChange={(v) => setFilter(v || 'abertos')}
          options={[{ value: 'abertos', label: 'Em aberto' }, { value: 'todos', label: 'Todos' }, ...Object.entries(DELIVERY).map(([value, v]) => ({ value, label: v.label }))]} />}
        empty={<Empty title="Nenhum pedido neste filtro" text="Gere a OP a partir de um orçamento com cliente, ou crie uma OP manual do tipo “Pedido de cliente”." />}
        columns={[
          { key: 'n', header: 'OP', render: (r) => <span className="mono">{r.o.number}</span>, sort: (r) => r.o.number },
          { key: 'c', header: 'Cliente', render: (r) => db.parties.find((p) => p.id === r.o.customerId)?.name ?? <span className="muted">não informado</span> },
          { key: 'd', header: 'Pedido', render: (r) => <><b>{r.o.description}</b><div className="muted small">{r.o.qtyPlanned} peça(s){r.o.quoteId ? ` · orçamento ${db.quotes.find((q) => q.id === r.o.quoteId)?.number}` : ''}</div></> },
          { key: 'v', header: 'Valor', num: true, render: (r) => { const q = db.quotes.find((x) => x.id === r.o.quoteId); const p = q ? latestVersion(q).summary.orderPrice : null; return p ? fmtBRL(p) : '—'; } },
          { key: 'e', header: 'Entrega', render: (r) => r.o.dueDate ? <span className={r.o.dueDate < todayISO() && r.d !== 'entregue' ? 'err-text' : ''}>{fmtDate(r.o.dueDate)}</span> : '—', sort: (r) => r.o.dueDate ?? '9999' },
          { key: 's', header: 'Situação', render: (r) => <Badge tone={DELIVERY[r.d].tone}>{DELIVERY[r.d].label}</Badge> },
          { key: 'a', header: '', render: (r) => r.d === 'pronto' ? <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); setSelling(r.o); }}>Registrar venda</button> : null },
        ]} />
      {sel && <OrderModal order={sel} onClose={() => setSel(null)} />}
      {selling && <SaleForm preset={{ orderId: selling.id }} onClose={() => setSelling(null)} />}
    </div>
  );
}

/* ================================================================== */
/* Peças prontas (pronta-entrega)                                      */
/* ================================================================== */
function ProntaEntrega() {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [onlyBalance, setOnlyBalance] = useState(true);
  const [selling, setSelling] = useState<FinishedGood | null>(null);
  const [adding, setAdding] = useState(false);
  const today = todayISO();
  const rows = db.finishedGoods.map((g) => ({ g, b: finishedGoodBalance(db, g.id), days: daysInStock(g, today) }))
    .filter((r) => !onlyBalance || r.b.available > 0);
  const withBalance = db.finishedGoods.map((g) => ({ g, b: finishedGoodBalance(db, g.id), days: daysInStock(g, today) })).filter((r) => r.b.available > 0);
  const pieces = withBalance.reduce((s, r) => s + r.b.available, 0);
  const value = withBalance.reduce((s, r) => s.plus(r.g.unitCost ? D(r.g.unitCost).times(r.b.available) : ZERO), ZERO);
  const stale = withBalance.filter((r) => r.days > 60).length;
  const writeOff = async (g: FinishedGood) => {
    const reason = await confirm({ title: `Dar baixa em 1 peça de ${g.code}?`, danger: true, confirmLabel: 'Dar baixa', reasonLabel: 'Motivo (avaria, brinde, uso próprio…)', text: 'Use para peças que saíram sem venda. Para várias peças, repita.' });
    if (reason) run((d) => writeOffFinishedGood(d, g.id, 1, reason), 'Baixa registrada.');
  };
  const ageTone = (d: number): Tone => (d > 90 ? 'error' : d > 60 ? 'warning' : d > 30 ? 'info' : 'success');
  return (
    <>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <Kpi label="Peças disponíveis" value={pieces} hint={`${withBalance.length} item(ns)`} accent />
        <Kpi label="Valor em estoque (custo)" value={fmtBRL(value)} hint="Custo de fabricação das peças paradas" />
        <Kpi label="Paradas há mais de 60 dias" value={stale} hint={stale ? 'Considere promoção ou outro canal' : 'Nenhuma'} />
      </div>
      <div className="card">
        <div className="card-head"><div><h2>Peças prontas para venda</h2><p className="muted small">Entram aqui automaticamente ao concluir uma OP do tipo “Estoque”. A idade conta a partir da data de produção.</p></div>
          <button className="btn secondary" onClick={() => setAdding(true)}>Cadastrar peças já existentes</button></div>
        <DataTable rows={rows} rowKey={(r) => r.g.id} search={(r) => `${r.g.code} ${r.g.description} ${r.g.location ?? ''}`}
          toolbar={<Check label="Somente com saldo" checked={onlyBalance} onChange={setOnlyBalance} />}
          initialSort={{ key: 'idade', dir: -1 }}
          empty={<Empty title="Nenhuma peça pronta em estoque" text="Crie uma OP do tipo “Estoque (pronta-entrega)” e conclua: as peças aprovadas aparecem aqui." />}
          columns={[
            { key: 'c', header: 'Código', render: (r) => <span className="mono">{r.g.code}</span>, sort: (r) => r.g.code },
            { key: 'd', header: 'Peça', render: (r) => <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>{r.g.image && <img src={r.g.image} alt="" className="kb-thumb" />}<div><b>{r.g.description}</b>
              <div className="muted small">{r.g.orderId ? `OP ${db.orders.find((o) => o.id === r.g.orderId)?.number ?? ''}` : 'cadastro manual'}{r.g.location ? ` · ${r.g.location}` : ''}</div></div></div> },
            { key: 'p', header: 'Produzida em', render: (r) => fmtDate(r.g.producedAt), sort: (r) => r.g.producedAt },
            { key: 'idade', header: 'Parada há', num: true, sort: (r) => r.days, render: (r) => <Badge tone={ageTone(r.days)}>{r.days} dia{r.days === 1 ? '' : 's'}</Badge> },
            { key: 'q', header: 'Disponível', num: true, sort: (r) => r.b.available, render: (r) => <><b>{r.b.available}</b><div className="muted small">de {r.b.produced} · {r.b.sold} vendida(s){r.b.adjusted ? ` · ${r.b.adjusted} baixa(s)` : ''}</div></> },
            { key: 'u', header: 'Custo unit.', num: true, render: (r) => r.g.unitCost ? <>{fmtBRL(r.g.unitCost)}<div className="muted small">{r.g.costStatus}</div></> : <Badge tone="warning">pendente</Badge> },
            { key: 's', header: 'Preço sugerido', num: true, render: (r) => r.g.suggestedPrice ? fmtBRL(r.g.suggestedPrice) : '—' },
            { key: 'a', header: '', render: (r) => r.b.available > 0 ? <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn primary sm" onClick={() => setSelling(r.g)}>Vender</button>
              <button className="btn ghost sm" onClick={() => writeOff(r.g)}>Baixa</button></div> : null },
          ]} />
      </div>
      {selling && <SaleForm preset={{ finishedGoodId: selling.id }} onClose={() => setSelling(null)} />}
      {adding && <FinishedGoodForm onClose={() => setAdding(false)} />}
      {confirmEl}
    </>
  );
}

function FinishedGoodForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ description: '', projectId: '', qty: '1', unitCost: '', suggestedPrice: '', producedAt: todayISO(), location: '', notes: '' });
  const submit = () => run((d) => registerFinishedGood(d, {
    description: f.description, projectId: f.projectId || undefined, qty: num(f.qty) ?? 0, unitCost: dec(f.unitCost), suggestedPrice: dec(f.suggestedPrice),
    producedAt: f.producedAt, location: f.location, notes: f.notes,
  }), 'Peças cadastradas no estoque de pronta-entrega.').then((r) => r.ok && onClose());
  return (
    <Modal title="Cadastrar peças prontas já existentes" subtitle="Para peças produzidas antes de usar o sistema. Não movimenta o estoque de materiais." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Cadastrar</button></>}>
      <div className="grid g2">
        <TextField label="Peça / descrição" required value={f.description} onChange={set('description')} />
        <SelectField label="Projeto" value={f.projectId} onChange={set('projectId')} placeholder="— nenhum —" options={db.projects.map((p) => ({ value: p.id, label: p.name }))} />
        <NumField label="Quantidade" required value={f.qty} onChange={set('qty')} />
        <DateField label="Data de produção" required value={f.producedAt} onChange={set('producedAt')} />
        <NumField label="Custo unitário de fabricação" suffix="R$" value={f.unitCost} onChange={set('unitCost')} hint="Estimado. Vazio = margem pendente na venda." />
        <NumField label="Preço sugerido" suffix="R$" value={f.suggestedPrice} onChange={set('suggestedPrice')} />
        <TextField label="Local de armazenamento" value={f.location} onChange={set('location')} placeholder="Ex.: prateleira A" />
      </div>
      <div style={{ marginTop: 12 }}><TextArea label="Observações" value={f.notes} onChange={set('notes')} /></div>
    </Modal>
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
      <div className="card-head"><div><h2>Todas as ordens de produção</h2><p className="muted small">Histórico completo, com filtros por situação.</p></div></div>
      <DataTable rows={rows} rowKey={(o) => o.id} onRowClick={setSel} search={(o) => `${o.number} ${o.description} ${db.parties.find((p) => p.id === o.customerId)?.name ?? ''}`}
        toolbar={<Combobox compact ariaLabel="Filtrar ordens" value={filter} onChange={(v) => setFilter(v || 'todas')}
          options={[{ value: 'todas', label: 'Todas' }, { value: 'abertas', label: 'Em aberto' }, ...Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label }))]} />}
        empty={<Empty title="Nenhuma ordem neste filtro" text="Abra um orçamento salvo e clique em “Gerar ordem de produção”." />}
        columns={[
          { key: 'n', header: 'OP', render: (o) => <span className="mono">{o.number}</span>, sort: (o) => o.number },
          { key: 'd', header: 'Descrição', render: (o) => <><b>{o.description}</b><div className="muted small">{o.quoteId ? `Orçamento ${db.quotes.find((q) => q.id === o.quoteId)?.number} v${o.quoteVersion}` : 'Manual'}</div></> },
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
  const cancel = async () => {
    const reason = await confirm({ title: `Cancelar ${o.number}?`, danger: true, confirmLabel: 'Cancelar ordem', reasonLabel: 'Motivo', text: 'As reservas de material serão liberadas.' });
    if (reason) run((d) => cancelOrder(d, o.id, reason), 'Ordem cancelada e reservas liberadas.');
  };
  const reserveAction = () => run((d) => reserveOrderMaterials(d, o.id)).then((r) => {
    if (!r.ok) return;
    if (r.value.ok) toast('success', 'Material reservado: OP pronta para produção.');
    else toast('warning', 'Material insuficiente: a OP ficou "Aguardando material". Nada foi reservado.');
  });
  const open = !['concluida', 'cancelada'].includes(o.status);
  return (
    <Modal wide title={`${o.number} · ${o.description}`} subtitle={`${ORDER_STATUS_LABEL[o.status]} · ${db.printers.find((p) => p.id === o.printerId)?.name ?? 'sem impressora'} · ${o.qtyPlanned} peça(s)`} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Fechar</button>
        {open && <button className="btn danger" onClick={cancel}>Cancelar OP</button>}
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
          <Badge tone={purposeOf(o) === 'pedido' ? 'info' : 'neutral'}>{purposeOf(o) === 'pedido' ? 'Pedido de cliente' : 'Estoque (pronta-entrega)'}</Badge>
          {o.customerId && <span>Cliente: <b>{db.parties.find((p) => p.id === o.customerId)?.name ?? '—'}</b></span>}
          {o.dueDate && <span>Entrega: <b>{fmtDate(o.dueDate)}</b></span>}
          {o.plannedHours !== null && <span>Tempo previsto: <b>{fmtDuration(o.plannedHours)}</b></span>}
          {open && <button className="btn ghost sm" onClick={() => setPlanning(true)}>Alterar tipo, cliente e prazo</button>}
        </div>
        {o.finishedGoodId && <Alert tone="success">Peças aprovadas enviadas ao estoque de pronta-entrega ({db.finishedGoods.find((g) => g.id === o.finishedGoodId)?.code}). <a href="#/producao/pronta-entrega">Ver peças prontas</a></Alert>}
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
      {confirmEl}
    </Modal>
  );
}

function PlanningForm({ order: o, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ purpose: purposeOf(o) as 'pedido' | 'estoque', customerId: o.customerId ?? '', dueDate: o.dueDate ?? '', printerId: o.printerId ?? '', notes: o.notes ?? '' });
  const submit = () => run((d) => updateOrderPlanning(d, o.id, { ...f, customerId: f.customerId || undefined, printerId: f.printerId || undefined }), 'Ordem atualizada.').then((r) => r.ok && onClose());
  return (
    <Modal title={`Planejamento de ${o.number}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></>}>
      <div className="grid g2">
        <SelectField label="Tipo" value={f.purpose} onChange={(v) => set('purpose')((v || 'pedido') as 'pedido' | 'estoque')}
          options={[{ value: 'pedido', label: 'Pedido de cliente' }, { value: 'estoque', label: 'Estoque (pronta-entrega)' }]} />
        {f.purpose === 'pedido' && <SelectField label="Cliente" value={f.customerId} onChange={set('customerId')} placeholder="— não informado —" options={db.parties.filter((p) => p.kind === 'cliente').map((p) => ({ value: p.id, label: p.name }))} />}
        <DateField label="Data de entrega" value={f.dueDate} onChange={set('dueDate')} />
        <SelectField label="Impressora" value={f.printerId} onChange={set('printerId')} placeholder="—" options={db.printers.map((p) => ({ value: p.id, label: p.name }))} />
      </div>
      <div style={{ marginTop: 12 }}><TextArea label="Observações" value={f.notes} onChange={set('notes')} /></div>
      <p className="small muted">OP do tipo Estoque envia as peças aprovadas para “Peças prontas” ao concluir.</p>
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

function ManualOrderForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ description: '', purpose: 'estoque' as 'pedido' | 'estoque', customerId: '', dueDate: '', projectId: '', printerId: db.settings.defaultPrinterId ?? db.printers[0]?.id ?? '', qty: '1', hours: null as number | null, notes: '' });
  const [mats, setMats] = useState([{ materialId: '', qty: '' }]);
  const matOpts = db.materials.filter((m) => m.active).map((m) => {
    const r = reorderAnalysis(db, m);
    return { value: m.id, label: `${m.name} · disp. ${fmtNum(r.available)} ${m.unit}` };
  });
  const submit = () => run((d) => createManualOrder(d, {
    description: f.description, purpose: f.purpose, customerId: f.customerId || undefined, dueDate: f.dueDate || undefined,
    projectId: f.projectId || undefined, printerId: f.printerId || undefined, qtyPlanned: num(f.qty) ?? 0,
    plannedMaterials: mats.filter((m) => m.materialId).map((m) => ({ materialId: m.materialId, qty: num(m.qty) ?? 0 })), plannedHours: f.hours, notes: f.notes,
  }), 'Ordem criada e colocada no fim da fila.').then((r) => r.ok && onClose());
  return (
    <Modal wide title="Nova ordem de produção manual" subtitle="Sem orçamento vinculado: a comparação previsto × realizado usará os parâmetros atuais." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Criar ordem</button></>}>
      <div className="stack">
        <div className="grid g3">
          <TextField label="Descrição" required value={f.description} onChange={set('description')} />
          <SelectField label="Tipo" value={f.purpose} onChange={(v) => set('purpose')((v || 'estoque') as 'pedido' | 'estoque')}
            options={[{ value: 'estoque', label: 'Estoque (pronta-entrega)' }, { value: 'pedido', label: 'Pedido de cliente' }]} />
          {f.purpose === 'pedido'
            ? <SelectField label="Cliente" value={f.customerId} onChange={set('customerId')} placeholder="— não informado —" options={db.parties.filter((p) => p.kind === 'cliente').map((p) => ({ value: p.id, label: p.name }))} />
            : <SelectField label="Projeto" value={f.projectId} onChange={set('projectId')} placeholder="— nenhum —" options={db.projects.map((p) => ({ value: p.id, label: p.name }))} />}
          <NumField label="Quantidade planejada" required value={f.qty} onChange={set('qty')} />
          <TimeField label="Tempo previsto de impressão (total)" value={f.hours} onChange={set('hours')} />
          <SelectField label="Impressora" value={f.printerId} onChange={set('printerId')} placeholder="—" options={db.printers.map((p) => ({ value: p.id, label: p.name }))} />
          {f.purpose === 'pedido' && <DateField label="Data de entrega" value={f.dueDate} onChange={set('dueDate')} />}
        </div>
        <p className="section-title">Material previsto (total da OP)</p>
        <p className="small muted">A reserva usa os lotes do material por ordem de entrada. Se faltar, a OP fica “Aguardando material” e o Estoque sinaliza a compra.</p>
        {mats.map((m, i) => (
          <div key={i} className="line-item">
            <SelectField label="Material" value={m.materialId} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, materialId: v } : x)))} placeholder="— selecione —" options={matOpts} />
            <NumField label={`Quantidade${db.materials.find((x) => x.id === m.materialId) ? ` (${db.materials.find((x) => x.id === m.materialId)!.unit})` : ''}`} value={m.qty} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, qty: v } : x)))} />
            <button className="btn ghost sm" onClick={() => setMats((r) => r.filter((_, k) => k !== i))} aria-label="Remover">✕</button>
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setMats((r) => [...r, { materialId: '', qty: '' }])}>+ Material</button></div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
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


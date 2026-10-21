import { useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { OrderStatus, ProductionOrder, Project } from '../../domain/types';
import { ORDER_STATUS_LABEL, addProjectFileVersion, cancelOrder, checkAvailability, compareOrder, completeOrder, createManualOrder, moveOrderStatus, orderReservations, reserveOrderMaterials, saveProject, startOrder } from '../../domain/production';
import { lotBalance, lotLabel } from '../../domain/inventory';
import { saleEconomics } from '../../domain/sales';
import { fmtDate, fmtDateTime, todayISO } from '../../domain/core';
import { Decimal, ZERO, fmtBRL, fmtNum, fmtPct, sum, toInputBR } from '../../domain/money';
import { Alert, Badge, Combobox, DataTable, Empty, Kpi, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, num, useConfirm, useForm, type Tone } from '../components/ui';
import { QUOTE_STATUS } from './Orcamentos';

type Tab = 'ordens' | 'projetos';
const STATUS_TONE: Record<OrderStatus, Tone> = {
  planejada: 'neutral', aguardando_material: 'error', pronta: 'info', em_producao: 'primary', aguardando_acabamento: 'warning', em_inspecao: 'warning', concluida: 'success', cancelada: 'neutral',
};

export function Producao({ param }: { param?: string }) {
  const { db } = useStore();
  const tab = (param as Tab) || 'ordens';
  const active = db.orders.filter((o) => !['concluida', 'cancelada'].includes(o.status)).length;
  return (
    <>
      <PageHead eyebrow="Módulo 5" title="Produção" text="Ordens de produção com reserva e baixa de material sem duplicidade, falhas e comparação previsto × realizado." />
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`producao/${t}`)} tabs={[
        { id: 'ordens', label: 'Ordens de produção', count: active || undefined }, { id: 'projetos', label: 'Projetos / produtos', count: db.projects.length },
      ]} />
      {tab === 'ordens' && <Ordens />}
      {tab === 'projetos' && <Projetos />}
    </>
  );
}

/* ================================================================== */
/* Ordens                                                              */
/* ================================================================== */
function Ordens() {
  const { db } = useStore();
  const [sel, setSel] = useState<ProductionOrder | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('abertas');
  const rows = [...db.orders].reverse().filter((o) => filter === 'todas' || (filter === 'abertas' ? !['concluida', 'cancelada'].includes(o.status) : o.status === filter));
  return (
    <div className="card">
      <div className="card-head"><div><h2>Ordens de produção</h2><p className="muted small">Gere OPs a partir de um orçamento salvo (recomendado) ou manualmente.</p></div>
        <div className="row"><button className="btn secondary" onClick={() => setCreating(true)} disabled={!db.lots.length}>OP manual</button><button className="btn primary" onClick={() => navigate('orcamentos')}>A partir de orçamento</button></div></div>
      <DataTable rows={rows} rowKey={(o) => o.id} onRowClick={setSel} search={(o) => `${o.number} ${o.description}`}
        toolbar={<Combobox compact ariaLabel="Filtrar ordens" value={filter} onChange={(v) => setFilter(v || 'abertas')}
          options={[{ value: 'abertas', label: 'Em aberto' }, { value: 'todas', label: 'Todas' }, ...Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label }))]} />}
        empty={<Empty title="Nenhuma ordem neste filtro" text="Abra um orçamento salvo e clique em “Gerar ordem de produção”." />}
        columns={[
          { key: 'n', header: 'OP', render: (o) => <span className="mono">{o.number}</span>, sort: (o) => o.number },
          { key: 'd', header: 'Descrição', render: (o) => <><b>{o.description}</b><div className="muted small">{o.quoteId ? `Orçamento ${db.quotes.find((q) => q.id === o.quoteId)?.number} v${o.quoteVersion}` : 'Manual'}</div></> },
          { key: 'p', header: 'Impressora', render: (o) => db.printers.find((p) => p.id === o.printerId)?.name ?? '—' },
          { key: 'q', header: 'Qtd.', num: true, render: (o) => o.actual ? `${o.actual.qtyApproved}/${o.qtyPlanned}` : o.qtyPlanned },
          { key: 'h', header: 'Horas prev.', num: true, render: (o) => fmtNum(o.plannedHours, 1) },
          { key: 's', header: 'Situação', render: (o) => <Badge tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge>, sort: (o) => o.status },
          { key: 'c', header: 'Criada', render: (o) => fmtDate(o.createdAt), sort: (o) => o.createdAt },
        ]} />
      {sel && <OrderModal order={sel} onClose={() => setSel(null)} />}
      {creating && <ManualOrderForm onClose={() => setCreating(false)} />}
    </div>
  );
}

function OrderModal({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const { db, run, toast } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [completing, setCompleting] = useState(false);
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
      {confirmEl}
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
  const [f, set] = useForm({ hours: toInputBR(order.plannedHours), approved: String(order.qtyPlanned), rejected: '0', labor: '', notes: '' });
  const [fails, setFails] = useState<{ description: string; lotId: string; qtyLost: string; hoursLost: string }[]>([]);
  const lotOpts = db.lots.filter((l) => lotBalance(db, l.id).physical.gt(0) || mats.some((m) => m.lotId === l.id)).map((l) => ({ value: l.id, label: lotLabel(db, l) }));
  const submit = () => run((d) => completeOrder(d, order.id, {
    materials: mats.map((m) => ({ lotId: m.lotId, qty: num(m.qty) ?? 0 })).filter((m) => m.lotId),
    hours: num(f.hours) ?? -1, qtyApproved: num(f.approved) ?? -1, qtyRejected: num(f.rejected) ?? -1, laborMinutes: f.labor.trim() ? num(f.labor) : null,
    failures: fails.map((x) => ({ description: x.description, lotId: x.lotId || undefined, qtyLost: num(x.qtyLost) ?? 0, hoursLost: num(x.hoursLost) ?? 0 })), notes: f.notes,
  }), 'OP concluída: reservas liberadas e consumo real baixado.').then((r) => r.ok && onClose());
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
          <NumField label="Horas reais de impressão" suffix="h" value={f.hours} onChange={set('hours')} />
          <NumField label="Peças aprovadas" value={f.approved} onChange={set('approved')} />
          <NumField label="Peças rejeitadas" value={f.rejected} onChange={set('rejected')} />
          <NumField label="Mão de obra real (total)" suffix="min" value={f.labor} onChange={set('labor')} hint="Vazio = usar estimativa do orçamento" />
        </div>
        <p className="section-title">Falhas e reimpressões</p>
        {fails.map((x, i) => (
          <div key={i} className="grid g4" style={{ alignItems: 'end' }}>
            <TextField label="O que aconteceu" value={x.description} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, description: v } : y)))} placeholder="Ex.: descolou da mesa" />
            <SelectField label="Lote do material perdido" value={x.lotId} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, lotId: v } : y)))} placeholder="—" options={lotOpts} />
            <NumField label="Material perdido" value={x.qtyLost} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, qtyLost: v } : y)))} />
            <NumField label="Horas perdidas" suffix="h" value={x.hoursLost} onChange={(v) => setFails((r) => r.map((y, k) => (k === i ? { ...y, hoursLost: v } : y)))} />
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setFails((r) => [...r, { description: '', lotId: mats[0]?.lotId ?? '', qtyLost: '', hoursLost: '' }])}>+ Registrar falha</button></div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

function ManualOrderForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ description: '', projectId: '', printerId: db.printers[0]?.id ?? '', qty: '1', hours: '', notes: '' });
  const [mats, setMats] = useState([{ lotId: '', qty: '' }]);
  const lotOpts = db.lots.filter((l) => lotBalance(db, l.id).available.gt(0)).map((l) => ({ value: l.id, label: `${lotLabel(db, l)} · disp. ${fmtNum(lotBalance(db, l.id).available)}` }));
  const submit = () => run((d) => createManualOrder(d, { description: f.description, projectId: f.projectId || undefined, printerId: f.printerId || undefined, qtyPlanned: num(f.qty) ?? 0,
    plannedMaterials: mats.filter((m) => m.lotId).map((m) => ({ lotId: m.lotId, qty: num(m.qty) ?? 0 })), plannedHours: num(f.hours), notes: f.notes }), 'Ordem criada.').then((r) => r.ok && onClose());
  return (
    <Modal wide title="Nova ordem de produção manual" subtitle="Sem orçamento vinculado: a comparação previsto × realizado usará os parâmetros atuais." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Criar ordem</button></>}>
      <div className="stack">
        <div className="grid g3">
          <TextField label="Descrição" required value={f.description} onChange={set('description')} />
          <SelectField label="Projeto" value={f.projectId} onChange={set('projectId')} placeholder="— nenhum —" options={db.projects.map((p) => ({ value: p.id, label: p.name }))} />
          <SelectField label="Impressora" value={f.printerId} onChange={set('printerId')} placeholder="—" options={db.printers.map((p) => ({ value: p.id, label: p.name }))} />
          <NumField label="Quantidade planejada" required value={f.qty} onChange={set('qty')} />
          <NumField label="Horas previstas (total)" suffix="h" value={f.hours} onChange={set('hours')} />
        </div>
        <p className="section-title">Material previsto (total da OP)</p>
        {mats.map((m, i) => (
          <div key={i} className="line-item">
            <SelectField label="Lote" value={m.lotId} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, lotId: v } : x)))} placeholder="— selecione —" options={lotOpts} />
            <NumField label="Quantidade" value={m.qty} onChange={(v) => setMats((r) => r.map((x, k) => (k === i ? { ...x, qty: v } : x)))} />
            <button className="btn ghost sm" onClick={() => setMats((r) => r.filter((_, k) => k !== i))} aria-label="Remover">✕</button>
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setMats((r) => [...r, { lotId: '', qty: '' }])}>+ Material</button></div>
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


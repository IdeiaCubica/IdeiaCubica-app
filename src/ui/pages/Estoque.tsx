import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { Lot, MovementType } from '../../domain/types';
import { adjustInventory, deleteInitialStock, inventoryValue, isUntouchedLot, lotBalance, registerInitialStock, registerLoss, reorderAnalysis, unitCostFromTotal, updateInitialStock } from '../../domain/inventory';
import { fmtDate, todayISO } from '../../domain/core';
import { D, fmtBRL, fmtNum, parseBR, toInputBR } from '../../domain/money';
import { perGramToPerKg, perKgToPerGram } from '../../domain/conversions';
import { Alert, Badge, Check, Combobox, DataTable, DateField, Empty, Field, Kpi, Modal, NumField, PageHead, SelectField, Tabs, TextField, num, useConfirm, useForm } from '../components/ui';
import { materialDesc } from './Cadastros';
import { PecasProntas, finishedStockSummary } from './PecasProntas';

type Tab = 'lotes' | 'pecas' | 'movimentos' | 'reposicao';
const TABS: Tab[] = ['lotes', 'pecas', 'movimentos', 'reposicao'];

export const MOV_LABEL: Record<MovementType, { label: string; sign: 1 | -1 | 0; tone: 'success' | 'error' | 'warning' | 'info' | 'neutral' }> = {
  entrada: { label: 'Entrada', sign: 1, tone: 'success' }, consumo: { label: 'Consumo', sign: -1, tone: 'info' },
  perda: { label: 'Perda', sign: -1, tone: 'error' }, ajuste_pos: { label: 'Ajuste +', sign: 1, tone: 'warning' },
  ajuste_neg: { label: 'Ajuste −', sign: -1, tone: 'warning' }, devolucao: { label: 'Devolução/estorno', sign: -1, tone: 'neutral' },
  reserva: { label: 'Reserva', sign: 0, tone: 'neutral' }, liberacao: { label: 'Liberação de reserva', sign: 0, tone: 'neutral' },
};

const STATUS_ORDER = { falta: 0, repor: 1, sem_parametros: 2, ok: 3 } as const;

export function Estoque({ param }: { param?: string }) {
  const { db } = useStore();
  const [tab, setTabState] = useState<Tab>(TABS.includes(param as Tab) ? (param as Tab) : 'lotes');
  const setTab = (t: Tab) => { setTabState(t); navigate(t === 'lotes' ? 'estoque' : `estoque/${t}`); };
  useEffect(() => { if (TABS.includes(param as Tab)) setTabState(param as Tab); else if (!param) setTabState('lotes'); }, [param]);
  const [initial, setInitial] = useState(false);
  const reorder = db.materials.filter((m) => m.active).map((m) => reorderAnalysis(db, m));
  const toBuy = reorder.filter((r) => r.status === 'repor' || r.status === 'falta').length;
  const missing = reorder.filter((r) => r.status === 'falta');
  const withBalance = db.lots.filter((l) => lotBalance(db, l.id).physical.gt(0)).length;
  const fg = finishedStockSummary(db);
  return (
    <>
      <PageHead eyebrow="Módulo 4" title="Gestão de estoque" text="Materiais de produção e peças produzidas para venda. Saldos calculados a partir das movimentações."
        actions={<button className="btn secondary" onClick={() => setInitial(true)} disabled={!db.materials.length}>Lançar estoque inicial</button>} />
      <div className="kpis" style={{ marginBottom: 18 }}>
        <Kpi label="Materiais em estoque" value={fmtBRL(inventoryValue(db))} hint={`${withBalance} lote(s) com saldo · custo de aquisição`} accent />
        <button type="button" className="kpi-btn" onClick={() => setTab('pecas')} aria-label="Ver peças produzidas em estoque">
          <Kpi label="Peças produzidas em estoque" value={fg.pieces} hint={`${fmtBRL(fg.invested)} investidos · potencial ${fmtBRL(fg.potential)}`} />
        </button>
        <Kpi label="Materiais a repor" value={toBuy} hint={toBuy ? 'Veja a aba Reposição' : 'Nenhuma reposição sugerida'} />
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'lotes', label: 'Materiais (lotes e saldos)' }, { id: 'pecas', label: 'Peças produzidas', count: fg.pieces || undefined },
        { id: 'movimentos', label: 'Movimentações', count: db.movements.length }, { id: 'reposicao', label: 'Reposição', count: toBuy || undefined },
      ]} />
      {tab === 'lotes' && <Lotes />}
      {tab === 'pecas' && <PecasProntas />}
      {tab === 'movimentos' && <Movimentos />}
      {tab === 'reposicao' && (
        <div className="card">
          {missing.length > 0 && <div className="card-body"><Alert tone="error" title="Falta material para ordens de produção abertas">
            {missing.map((r) => `${r.material.name}: faltam ${fmtNum(r.projected.abs())} ${r.material.unit}`).join(' · ')}
          </Alert></div>}
          <DataTable rows={reorder} rowKey={(r) => r.material.id}
            empty={<Empty title="Nenhum material ativo" />}
            initialSort={{ key: 's', dir: 1 }}
            columns={[
              { key: 'm', header: 'Material', render: (r) => <><b>{r.material.name}</b><div className="muted small">{materialDesc(db, r.material)}</div></> },
              { key: 'p', header: 'Físico', num: true, render: (r) => `${fmtNum(r.physical)} ${r.material.unit}` },
              { key: 'r', header: 'Reservado', num: true, render: (r) => fmtNum(r.reserved) },
              { key: 'a', header: 'Disponível', num: true, render: (r) => fmtNum(r.available) },
              { key: 'd', header: 'Ordens a reservar', num: true, render: (r) => r.plannedDemand.gt(0) ? fmtNum(r.plannedDemand) : '—' },
              { key: 'pj', header: 'Projetado', num: true, sort: (r) => r.projected.toNumber(), render: (r) => <span className={r.projected.isNegative() ? 'err-text' : ''}>{fmtNum(r.projected)}</span> },
              { key: 'c', header: 'Consumo médio/dia', num: true, render: (r) => r.avgDailyUse ? fmtNum(r.avgDailyUse, 1) : <span className="muted">sem histórico</span> },
              { key: 'pp', header: 'Ponto de pedido', num: true, render: (r) => r.reorderPoint ? fmtNum(r.reorderPoint) : '—' },
              { key: 'sq', header: 'Sugestão de compra', num: true, render: (r) => r.suggestedQty?.gt(0) ? <b>{fmtNum(r.suggestedQty)} {r.material.unit}</b> : '—' },
              { key: 's', header: 'Situação', sort: (r) => STATUS_ORDER[r.status], render: (r) =>
                r.status === 'falta' ? <Badge tone="error" title={r.note}>comprar já</Badge>
                : r.status === 'repor' ? <Badge tone="warning" title={r.note}>repor</Badge>
                : r.status === 'ok' ? <Badge tone="success">ok</Badge> : <Badge title={r.note}>sem parâmetros</Badge> },
            ]} />
          <div className="card-body"><p className="small muted">
            <b>Projetado</b> = disponível (físico − reservado) − material previsto em ordens de produção ainda não reservadas (pedidos e peças para estoque).
            {' '}<b>Comprar já</b>: o projetado ficou negativo — falta material para as ordens abertas. <b>Repor</b>: o projetado está abaixo do ponto de pedido
            (estoque mínimo + segurança + consumo médio diário dos últimos 90 dias × prazo de reposição). Defina mínimo e prazo em Cadastros → Materiais.
            Compras são registradas no recebimento.
          </p></div>
        </div>
      )}
      {initial && <InitialStockForm onClose={() => setInitial(false)} />}
    </>
  );
}

function Lotes() {
  const { db } = useStore();
  const [onlyBalance, setOnlyBalance] = useState(true);
  const [sel, setSel] = useState<Lot | null>(null);
  const rows = db.lots.map((l) => ({ lot: l, mat: db.materials.find((m) => m.id === l.materialId)!, b: lotBalance(db, l.id) }))
    .filter((r) => !onlyBalance || r.b.physical.gt(0));
  return (
    <div className="card">
      <DataTable rows={rows} rowKey={(r) => r.lot.id} onRowClick={(r) => setSel(r.lot)}
        search={(r) => `${r.lot.code} ${r.mat?.name} ${r.mat ? materialDesc(db, r.mat) : ''} ${r.lot.batchNumber ?? ''}`}
        toolbar={<Check label="Somente com saldo" checked={onlyBalance} onChange={setOnlyBalance} />}
        empty={<Empty title="Nenhum lote em estoque" text="Lotes são criados ao registrar compras (menu Compras) ou ao lançar estoque inicial de materiais que você já possui." />}
        columns={[
          { key: 'l', header: 'Lote', render: (r) => <span className="mono">{r.lot.code}</span>, sort: (r) => r.lot.code },
          { key: 'm', header: 'Material', render: (r) => <><b>{r.mat?.filament?.colorHex && <i className="swatch" style={{ background: r.mat.filament.colorHex }} />}{r.mat?.name}</b><div className="muted small">{r.mat ? materialDesc(db, r.mat) : ''}</div></>, sort: (r) => r.mat?.name ?? '' },
          { key: 'd', header: 'Entrada', render: (r) => fmtDate(r.lot.date), sort: (r) => r.lot.date },
          { key: 'i', header: 'Inicial', num: true, render: (r) => fmtNum(r.lot.initialQty) },
          { key: 'c', header: 'Consumido', num: true, render: (r) => fmtNum(r.b.consumed.plus(r.b.lost)) },
          { key: 'p', header: 'Físico', num: true, render: (r) => fmtNum(r.b.physical), sort: (r) => r.b.physical.toNumber() },
          { key: 'r', header: 'Reservado', num: true, render: (r) => r.b.reserved.gt(0) ? fmtNum(r.b.reserved) : '—' },
          { key: 'a', header: 'Disponível', num: true, render: (r) => <b>{fmtNum(r.b.available)} {r.mat?.unit}</b>, sort: (r) => r.b.available.toNumber() },
          { key: 'u', header: 'Custo', num: true, render: (r) => r.mat?.unit === 'g' ? `${fmtBRL(perGramToPerKg(r.lot.unitCost))}/kg` : `${fmtBRL(r.lot.unitCost, 4)}/${r.mat?.unit ?? ''}` },
          { key: 'v', header: 'Valor', num: true, render: (r) => fmtBRL(r.b.physical.times(D(r.lot.unitCost))), sort: (r) => r.b.physical.times(D(r.lot.unitCost)).toNumber() },
        ]} />
      {sel && <LotModal lot={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function LotModal({ lot: lotIn, onClose }: { lot: Lot; onClose: () => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [editing, setEditing] = useState(false);
  const lot = db.lots.find((l) => l.id === lotIn.id) ?? lotIn;
  const mat = db.materials.find((m) => m.id === lot.materialId)!;
  const b = lotBalance(db, lot.id);
  const correctable = lot.origin === 'estoque_inicial' && isUntouchedLot(db, lot.id);
  const remove = async () => {
    const reason = await confirm({ title: `Excluir o lançamento ${lot.code}?`, danger: true, confirmLabel: 'Excluir lançamento', reasonLabel: 'Motivo',
      text: 'O lote e sua entrada no estoque são removidos (fica registrado na auditoria). Só é possível porque ele ainda não foi usado.' });
    if (reason) run((d) => deleteInitialStock(d, lot.id, reason), 'Lançamento de estoque excluído.').then((r) => r.ok && onClose());
  };
  const [mode, setMode] = useState<'hist' | 'inventario' | 'perda'>('hist');
  const [f, set] = useForm({ counted: '', reason: '', lossQty: '', weighed: '' });
  const movs = db.movements.filter((m) => m.lotId === lot.id).reverse();
  const spool = mat.filament?.spoolWeightG;
  const weighedNet = spool && num(f.weighed) !== null ? (num(f.weighed)! - spool) : null;
  const doInventory = () => {
    const counted = weighedNet ?? num(f.counted);
    if (counted === null) return;
    run((d) => adjustInventory(d, { lotId: lot.id, countedQty: counted, reason: f.reason }), 'Ajuste de inventário registrado.').then((r) => r.ok && onClose());
  };
  const doLoss = () => run((d) => registerLoss(d, { lotId: lot.id, qty: num(f.lossQty) ?? 0, reason: f.reason }), 'Perda registrada.').then((r) => r.ok && onClose());
  return (
    <Modal wide title={`Lote ${lot.code} · ${mat.name}`} subtitle={`${materialDesc(db, mat)} · entrada em ${fmtDate(lot.date)} · ${mat.unit === 'g' ? `${fmtBRL(perGramToPerKg(lot.unitCost))}/kg` : `${fmtBRL(lot.unitCost, 4)}/${mat.unit}`}`} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Fechar</button>
        {correctable && <button className="btn danger" onClick={remove}>Excluir lançamento</button>}
        {correctable && <button className="btn primary" onClick={() => setEditing(true)}>Editar lançamento</button>}
      </>}>
      <div className="stack">
        {lot.origin === 'estoque_inicial' && !correctable && <Alert tone="info">Este lançamento já foi usado (consumo, reserva, perda ou ajuste). Para corrigir a quantidade, use <b>Inventário (contagem)</b>.</Alert>}
        {lot.origin === 'compra' && <Alert tone="info">Lote de compra: para corrigir valor ou quantidade, cancele a compra em <a href="#/compras">Compras</a> e registre de novo.</Alert>}
        <div className="kpis">
          <Kpi label="Saldo físico" value={`${fmtNum(b.physical)} ${mat.unit}`} />
          <Kpi label="Reservado" value={`${fmtNum(b.reserved)} ${mat.unit}`} />
          <Kpi label="Disponível" value={`${fmtNum(b.available)} ${mat.unit}`} />
          <Kpi label="Consumido + perdas" value={`${fmtNum(b.consumed.plus(b.lost))} ${mat.unit}`} />
        </div>
        <Tabs value={mode} onChange={setMode} tabs={[{ id: 'hist', label: 'Histórico' }, { id: 'inventario', label: 'Inventário (contagem)' }, { id: 'perda', label: 'Registrar perda' }]} />
        {mode === 'hist' && (
          <div className="card"><table className="tbl"><thead><tr><th>Data</th><th>Tipo</th><th className="num">Quantidade</th><th>Origem / motivo</th></tr></thead><tbody>
            {movs.map((m) => { const t = MOV_LABEL[m.type]; return (
              <tr key={m.id}><td>{fmtDate(m.date)}</td><td><Badge tone={t.tone}>{t.label}</Badge></td><td className="num">{t.sign === 1 ? '+' : t.sign === -1 ? '−' : ''}{fmtNum(m.qty)}</td><td className="small">{refLabel(db, m.ref)}{m.reason ? ` — ${m.reason}` : ''}</td></tr>); })}
          </tbody></table></div>
        )}
        {mode === 'inventario' && (
          <div className="stack">
            <p className="muted">Informe a quantidade física encontrada. A diferença em relação ao sistema ({fmtNum(b.physical)} {mat.unit}) gera um ajuste rastreável.</p>
            <div className="grid g3">
              {spool ? <NumField label="Peso na balança (com carretel)" suffix="g" value={f.weighed} onChange={set('weighed')} hint={`Carretel vazio: ${fmtNum(spool)} g${weighedNet !== null ? ` → líquido ${fmtNum(weighedNet)} g` : ''}`} /> : null}
              {!(spool && f.weighed) && <NumField label="Quantidade contada" suffix={mat.unit} value={f.counted} onChange={set('counted')} />}
              <TextField label="Justificativa" required value={f.reason} onChange={set('reason')} placeholder="Ex.: pesagem mensal" />
            </div>
            <div><button className="btn primary" onClick={doInventory}>Registrar ajuste</button></div>
          </div>
        )}
        {mode === 'perda' && (
          <div className="stack">
            <p className="muted">Use para desperdícios fora de uma ordem de produção (ex.: filamento úmido descartado, carretel danificado). Falhas de impressão são registradas na conclusão da OP.</p>
            <div className="grid g3">
              <NumField label="Quantidade perdida" suffix={mat.unit} value={f.lossQty} onChange={set('lossQty')} />
              <TextField label="Motivo" required value={f.reason} onChange={set('reason')} />
            </div>
            <div><button className="btn danger" onClick={doLoss}>Registrar perda</button></div>
          </div>
        )}
      </div>
      {editing && <InitialStockForm lot={lot} onClose={() => setEditing(false)} />}
      {confirmEl}
    </Modal>
  );
}

function refLabel(db: ReturnType<typeof useStore>['db'], ref: { kind: string; id?: string }) {
  if (ref.kind === 'compra') return `Compra ${db.purchases.find((p) => p.id === ref.id)?.number ?? ''}`;
  if (ref.kind === 'op') return `Ordem ${db.orders.find((o) => o.id === ref.id)?.number ?? ''}`;
  return ({ estoque_inicial: 'Estoque inicial', inventario: 'Inventário', perda: 'Perda avulsa', manual: 'Manual' } as Record<string, string>)[ref.kind] ?? ref.kind;
}

function Movimentos() {
  const { db } = useStore();
  const [type, setType] = useState('');
  const rows = [...db.movements].reverse().filter((m) => !type || m.type === type);
  return (
    <div className="card">
      <DataTable rows={rows} rowKey={(m) => m.id}
        search={(m) => `${db.materials.find((x) => x.id === m.materialId)?.name} ${db.lots.find((l) => l.id === m.lotId)?.code} ${m.reason ?? ''}`}
        toolbar={<Combobox compact ariaLabel="Tipo de movimentação" value={type} onChange={setType} placeholder="Todos os tipos" options={Object.entries(MOV_LABEL).map(([value, v]) => ({ value, label: v.label }))} />}
        empty={<Empty title="Nenhuma movimentação" />}
        columns={[
          { key: 'd', header: 'Data', render: (m) => fmtDate(m.date), sort: (m) => m.date + m.createdAt },
          { key: 't', header: 'Tipo', render: (m) => <Badge tone={MOV_LABEL[m.type].tone}>{MOV_LABEL[m.type].label}</Badge> },
          { key: 'm', header: 'Material', render: (m) => db.materials.find((x) => x.id === m.materialId)?.name },
          { key: 'l', header: 'Lote', render: (m) => <span className="mono">{db.lots.find((l) => l.id === m.lotId)?.code}</span> },
          { key: 'q', header: 'Quantidade', num: true, render: (m) => { const s = MOV_LABEL[m.type].sign; return `${s === 1 ? '+' : s === -1 ? '−' : ''}${fmtNum(m.qty)} ${db.materials.find((x) => x.id === m.materialId)?.unit ?? ''}`; } },
          { key: 'r', header: 'Origem / motivo', render: (m) => <span className="small">{refLabel(db, m.ref)}{m.reason ? ` — ${m.reason}` : ''}</span> },
        ]} />
    </div>
  );
}

type CostMode = 'total' | 'kg' | 'unit';

/**
 * Lançar (ou corrigir) estoque inicial. O custo é digitado como VALOR TOTAL PAGO
 * (padrão) ou R$/kg para filamento — nunca R$ por grama, que causava erros de 1.000×.
 */
function InitialStockForm({ onClose, lot }: { onClose: () => void; lot?: Lot }) {
  const { db, run } = useStore();
  const editing = !!lot;
  const [f, set] = useForm(() => ({
    materialId: lot?.materialId ?? db.materials[0]?.id ?? '', qty: lot ? toInputBR(lot.initialQty) : '',
    mode: 'total' as CostMode, amount: lot ? toInputBR(D(lot.unitCost).times(lot.initialQty).toDecimalPlaces(2).toString()) : '',
    date: lot?.date ?? todayISO(), batchNumber: lot?.batchNumber ?? '', notes: lot?.notes ?? '',
  }));
  const mat = db.materials.find((m) => m.id === f.materialId);
  const qty = num(f.qty);
  const amount = parseBR(f.amount);
  const grams = mat?.unit === 'g';
  // Custo por unidade de estoque, conforme a forma digitada
  const unitCost = !amount || !mat ? null
    : f.mode === 'total' ? (qty && qty > 0 ? unitCostFromTotal(amount, qty) : null)
    : f.mode === 'kg' ? (grams ? perKgToPerGram(amount) : amount.div(1000))
    : amount;
  const perKg = unitCost && grams ? perGramToPerKg(unitCost) : null;
  const suspicious = perKg && (perKg.gt(1000) || perKg.lt(10));
  const submit = () => {
    if (!unitCost) return;
    const payload = { qty: qty ?? 0, unitCost: unitCost.toString(), date: f.date, batchNumber: f.batchNumber || undefined, notes: f.notes || undefined };
    run((d) => (editing ? updateInitialStock(d, lot!.id, payload) : registerInitialStock(d, { ...payload, materialId: f.materialId })),
      editing ? 'Estoque inicial corrigido.' : 'Estoque inicial lançado.').then((r) => r.ok && onClose());
  };
  return (
    <Modal title={editing ? `Corrigir estoque inicial · ${lot!.code}` : 'Lançar estoque inicial'} subtitle="Para materiais que você já possuía antes do sistema (inclusive carretéis parcialmente usados)." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={!unitCost}>{editing ? 'Salvar correção' : 'Lançar'}</button></>}>
      <div className="stack">
        <Alert tone="info">Não gera lançamento financeiro (a compra já ocorreu antes). Para compras novas, use <b>Registrar compra</b>.</Alert>
        {editing ? <Field label="Material"><div className="readonly-value">{mat ? `${mat.code} · ${mat.name}` : '—'}</div></Field>
          : <SelectField label="Material" required value={f.materialId} onChange={set('materialId')} options={db.materials.map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} />}
        <div className="grid g2">
          <NumField label="Quantidade atual" suffix={mat?.unit} required value={f.qty} onChange={set('qty')} hint={mat?.filament?.spoolWeightG ? `Pese e desconte o carretel (${fmtNum(mat.filament.spoolWeightG)} g). 1 carretel cheio = ${fmtNum(mat.filament.netWeightG)} g.` : grams ? '1 carretel de 1 kg = 1000 g' : undefined} />
          <DateField label="Data" value={f.date} onChange={set('date')} />
          <SelectField label="Como informar o custo" value={f.mode} onChange={(v) => set('mode')((v || 'total') as CostMode)}
            options={[{ value: 'total', label: 'Valor total pago por essa quantidade' }, ...(grams ? [{ value: 'kg', label: 'Preço por kg (R$/kg)' }] : []), { value: 'unit', label: `Preço por ${mat?.unit ?? 'unidade'}` }]} />
          <NumField label={f.mode === 'total' ? 'Valor total pago' : f.mode === 'kg' ? 'Preço por kg' : `Preço por ${mat?.unit ?? 'unidade'}`} suffix={f.mode === 'kg' ? 'R$/kg' : f.mode === 'unit' ? `R$/${mat?.unit ?? ''}` : 'R$'} required
            value={f.amount} onChange={set('amount')} hint={f.mode === 'total' ? 'Ex.: carretel de 1 kg por R$ 73,58 → quantidade 1000 g e valor 73,58' : undefined} />
          <TextField label="Lote do fabricante" value={f.batchNumber} onChange={set('batchNumber')} />
        </div>
        {unitCost && <div className="card"><div className="card-body">
          Custo que será usado nos orçamentos: <b>{grams ? `${fmtBRL(perKg)}/kg` : `${fmtBRL(unitCost, 4)}/${mat?.unit}`}</b>
          {grams && <span className="muted"> ({fmtBRL(unitCost, 5)} por grama)</span>}
          {qty ? <> · valor do lote <b>{fmtBRL(unitCost.times(qty))}</b></> : null}
        </div></div>}
        {suspicious && <Alert tone="warning" title="Confira o valor">
          {fmtBRL(perKg)}/kg está fora do normal para filamento (em geral entre R$ 60 e R$ 300/kg). Verifique a quantidade em gramas e se o valor é o total pago.
        </Alert>}
        <TextField label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

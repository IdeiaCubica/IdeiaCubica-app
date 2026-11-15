/**
 * Módulo Purgas (v1.29): estoque de purga por cor (uma linha por cor), cadastro manual, reaproveitamento,
 * descarte, peças feitas com purga e o resultado apartado das purgas.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { PurgeMove, PurgeStock } from '../../domain/types';
import { addManualPurge, colorCostPerG, createPurgePiece, deletePurgeMove, deletePurgePiece, purgeBalance, purgeOverview, purgeResult, takePurge } from '../../domain/purges';
import { finishedGoodBalance } from '../../domain/production';
import { fmtDate, todayISO } from '../../domain/core';
import { D, Decimal, fmtBRL, fmtNum } from '../../domain/money';
import { Alert, Badge, DataTable, DateField, Empty, Field, Kpi, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, dec, num, useConfirm, useForm } from '../components/ui';
import { ImagePicker } from '../components/ImagePicker';
import { SaleForm } from './Financeiro';

type Tab = 'cores' | 'pecas' | 'movimentos';
const TABS: Tab[] = ['cores', 'pecas', 'movimentos'];
const KIND_LABEL: Record<PurgeMove['kind'], string> = { manual: 'Cadastro manual', producao: 'Produção', reaproveitado: 'Reaproveitado', peca: 'Peça de purga', descarte: 'Descarte' };
const perKg = (d: Decimal) => `${fmtBRL(d.times(1000))}/kg`;

export function Purgas({ param }: { param?: string }) {
  const { db } = useStore();
  const [tab, setTabState] = useState<Tab>(TABS.includes(param as Tab) ? (param as Tab) : 'cores');
  const setTab = (t: Tab) => { setTabState(t); navigate(t === 'cores' ? 'purgas' : `purgas/${t}`); };
  useEffect(() => { if (TABS.includes(param as Tab)) setTabState(param as Tab); else if (!param) setTabState('cores'); }, [param]);
  const [adding, setAdding] = useState(false);
  const [piece, setPiece] = useState(false);
  const ov = purgeOverview(db);
  const res = purgeResult(db);
  return (
    <>
      <PageHead eyebrow="Purgas" title="Gestão de purgas" text="Filamento que sobra da impressão (torre, “poop”, brim, suportes), por cor. Some o cadastro manual com a purga medida na produção, registre o que foi reaproveitado e transforme em peças para vender."
        actions={<><button className="btn secondary" onClick={() => setPiece(true)} disabled={!ov.rows.some((r) => r.b.g > 0)}>Nova peça de purga</button><button className="btn primary" onClick={() => setAdding(true)}>Cadastrar purga</button></>} />
      <div className="kpis" style={{ marginBottom: 18 }}>
        <Kpi label="Parado em purgas" value={fmtBRL(ov.value)} hint={`${fmtNum(ov.g)} g em ${ov.rows.filter((r) => r.b.g > 0).length} cor(es) · preço do filamento`} accent />
        <Kpi label="Purga gerada (desperdício)" value={fmtBRL(ov.generatedValue)} hint={`${fmtNum(ov.generatedG)} g no total`} />
        <Kpi label="Reaproveitado" value={fmtBRL(ov.reusedValue)} hint={`${fmtNum(ov.reusedG)} g · ${ov.generatedG > 0 ? `${fmtNum((ov.reusedG / ov.generatedG) * 100)}% da purga` : '—'}`} />
        <Kpi label="Resultado das purgas" value={fmtBRL(res.result)} hint={`${res.soldQty} peça(s) vendida(s) · receita ${fmtBRL(res.revenue)}`} />
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'cores', label: 'Purga por cor', count: ov.rows.length || undefined },
        { id: 'pecas', label: 'Peças de purga', count: res.pieces.length || undefined },
        { id: 'movimentos', label: 'Lançamentos', count: db.purgeMoves.length || undefined },
      ]} />
      {tab === 'cores' && <Cores />}
      {tab === 'pecas' && <Pecas onNew={() => setPiece(true)} />}
      {tab === 'movimentos' && <Lancamentos />}
      {adding && <ManualForm onClose={() => setAdding(false)} />}
      {piece && <PieceForm onClose={() => setPiece(false)} />}
    </>
  );
}

function Cores() {
  const { db } = useStore();
  const [taking, setTaking] = useState<{ p: PurgeStock; kind: 'reaproveitado' | 'descarte' } | null>(null);
  const ov = purgeOverview(db);
  return (
    <div className="stack">
      <div className="card">
        <DataTable rows={ov.rows} rowKey={(r) => r.p.id} search={(r) => r.p.color}
          empty={<Empty title="Nenhuma purga ainda" text="Cadastre a purga que você já tem guardada, ou informe a purga por cor ao medir a peça na produção (Em produção → Acabamento)." />}
          columns={[
            { key: 'c', header: 'Cor', render: (r) => <b>{r.p.color}</b>, sort: (r) => r.p.color },
            { key: 'in', header: 'Entradas', num: true, render: (r) => <>{fmtNum(r.b.by.manual + r.b.by.producao)} g<div className="muted small">manual {fmtNum(r.b.by.manual)} · produção {fmtNum(r.b.by.producao)}</div></> },
            { key: 'out', header: 'Saídas', num: true, render: (r) => <>{fmtNum(r.b.by.reaproveitado + r.b.by.peca + r.b.by.descarte)} g<div className="muted small">reaprov. {fmtNum(r.b.by.reaproveitado + r.b.by.peca)} · descarte {fmtNum(r.b.by.descarte)}</div></> },
            { key: 's', header: 'Saldo', num: true, render: (r) => <b>{fmtNum(r.b.g)} g</b>, sort: (r) => r.b.g },
            { key: 'cm', header: 'Custo médio', num: true, render: (r) => (r.b.g > 0 ? perKg(r.b.avgPerG) : '—') },
            { key: 'v', header: 'Parado', num: true, render: (r) => fmtBRL(r.b.value), sort: (r) => r.b.value.toNumber() },
            { key: 'a', header: '', render: (r) => r.b.g > 0 ? <span className="row" style={{ gap: 4, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
              <button className="btn secondary sm" onClick={() => setTaking({ p: r.p, kind: 'reaproveitado' })}>Reaproveitei</button>
              <button className="btn ghost sm" onClick={() => setTaking({ p: r.p, kind: 'descarte' })}>Descartar</button></span> : null },
          ]} />
      </div>
      <Alert tone="info" title="Como a purga pesa no resultado">
        A purga é filamento que já saiu do estoque e entrou no custo real do pedido que a gerou: ela já reduz o lucro da empresa (desperdício).
        “Parado em purgas” mostra quanto desse dinheiro está guardado em material que ainda pode ser aproveitado.
        Quando vira peça e é vendida, a venda entra no mesmo financeiro e no resultado da empresa; o custo da peça de purga é só o gasto adicional (o filamento já foi custeado), e o resultado das purgas aparece à parte.
      </Alert>
      {taking && <TakeForm purge={taking.p} kind={taking.kind} onClose={() => setTaking(null)} />}
    </div>
  );
}

function ManualForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const colors = [...new Set([...db.purgeStocks.map((p) => p.color), ...db.materials.filter((m) => m.filament?.color).map((m) => m.filament!.color!)])];
  const [f, set] = useForm({ color: '', g: '', date: todayISO(), costPerKg: '', note: '' });
  const suggested = f.color.trim() ? colorCostPerG(db, f.color) : null;
  const exists = db.purgeStocks.find((p) => p.key === f.color.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase());
  const submit = () => run((d) => addManualPurge(d, { color: f.color, g: num(f.g) ?? 0, date: f.date, costPerKg: dec(f.costPerKg), note: f.note }), 'Purga cadastrada.').then((r) => r.ok && onClose());
  return (
    <Modal title="Cadastrar purga" subtitle="Soma à purga da cor (uma por cor: se a cor já existe, soma nela; se não, cria)." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Cadastrar</button></>}>
      <div className="stack">
        <div className="grid g2">
          <Field label="Cor *" hint={f.color.trim() ? (exists ? `Soma na purga ${exists.color} (saldo ${fmtNum(purgeBalance(db, exists.id).g)} g)` : 'Cor nova: cria a purga desta cor') : 'Escolha ou digite a cor'}>
            <input list="purge-colors-manual" value={f.color} onChange={(e) => set('color')(e.target.value)} placeholder="Ex.: Azul" aria-label="Cor da purga" />
            <datalist id="purge-colors-manual">{colors.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <NumField label="Quantidade" suffix="g" required value={f.g} onChange={set('g')} />
          <DateField label="Data" value={f.date} onChange={set('date')} />
          <NumField label="Preço do filamento" suffix="R$/kg" value={f.costPerKg} onChange={set('costPerKg')}
            hint={suggested && suggested.gt(0) ? `Vazio = ${perKg(suggested)} (filamento cadastrado desta cor)` : 'Vazio = sem valor (cadastre um filamento desta cor para valorizar)'} />
        </div>
        <TextArea label="Observações" value={f.note} onChange={set('note')} />
      </div>
    </Modal>
  );
}

function TakeForm({ purge, kind, onClose }: { purge: PurgeStock; kind: 'reaproveitado' | 'descarte'; onClose: () => void }) {
  const { db, run } = useStore();
  const bal = purgeBalance(db, purge.id);
  const [f, set] = useForm({ g: '', date: todayISO(), note: '' });
  const g = num(f.g) ?? 0;
  const submit = () => run((d) => takePurge(d, { purgeId: purge.id, g, date: f.date, kind, note: f.note }), kind === 'descarte' ? 'Descarte registrado.' : 'Reaproveitamento registrado.').then((r) => r.ok && onClose());
  return (
    <Modal title={`${kind === 'descarte' ? 'Descartar' : 'Reaproveitar'} purga ${purge.color}`} subtitle={`Saldo: ${fmtNum(bal.g)} g · ${fmtBRL(bal.value)} parados`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={!(g > 0) || g > bal.g}>Registrar</button></>}>
      <div className="stack">
        <div className="grid g2">
          <NumField label="Quantidade" suffix="g" required value={f.g} onChange={set('g')} hint={g > 0 ? `≈ ${fmtBRL(bal.avgPerG.times(g))} (custo médio)` : undefined} />
          <DateField label="Data" value={f.date} onChange={set('date')} />
        </div>
        <TextArea label={kind === 'descarte' ? 'Motivo' : 'Para que foi reaproveitado'} value={f.note} onChange={set('note')} />
        <p className="small muted" style={{ margin: 0 }}>{kind === 'descarte' ? 'Descarte: a purga sai do estoque e o valor fica como desperdício definitivo.' : 'Reaproveitamento avulso. Para uma peça que vai ser vendida, use “Nova peça de purga” (aparece no resultado das purgas).'}</p>
      </div>
    </Modal>
  );
}

function PieceForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const stocks = db.purgeStocks.map((p) => ({ p, b: purgeBalance(db, p.id) })).filter((x) => x.b.g > 0);
  const [f, set] = useForm({ description: '', qty: '1', date: todayISO(), extraCost: '', suggestedPrice: '', location: '', notes: '' });
  const [uses, setUses] = useState([{ purgeId: stocks[0]?.p.id ?? '', g: '' }]);
  const [image, setImage] = useState<string | null>(null);
  const value = uses.reduce((s, u) => { const st = stocks.find((x) => x.p.id === u.purgeId); return st ? s.plus(st.b.avgPerG.times(num(u.g) ?? 0)) : s; }, D(0));
  const qty = num(f.qty) ?? 0;
  const extra = num(f.extraCost) ?? 0;
  const submit = () => run((d) => createPurgePiece(d, {
    description: f.description, qty: Math.round(qty), date: f.date, uses: uses.map((u) => ({ purgeId: u.purgeId, g: num(u.g) ?? 0 })),
    extraCost: dec(f.extraCost), suggestedPrice: dec(f.suggestedPrice), location: f.location, image, notes: f.notes,
  }), 'Peça de purga criada: está no estoque de peças prontas para vender.').then((r) => r.ok && onClose());
  return (
    <Modal wide title="Nova peça de purga" subtitle="Peça feita com a purga guardada. Entra no estoque de peças prontas e pode ser vendida normalmente." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Criar peça</button></>}>
      <div className="stack">
        <div className="grid g3">
          <TextField label="Descrição da peça" required value={f.description} onChange={set('description')} placeholder="Ex.: chaveiro mesclado" />
          <NumField label="Quantidade de peças" required value={f.qty} onChange={set('qty')} />
          <DateField label="Data" value={f.date} onChange={set('date')} />
        </div>
        <p className="section-title" style={{ margin: 0 }}>Purga usada (por cor)</p>
        {uses.map((u, i) => { const st = stocks.find((x) => x.p.id === u.purgeId); return (
          <div key={i} className="grid g3" style={{ alignItems: 'end' }}>
            <SelectField label="Cor" value={u.purgeId} onChange={(v) => setUses((r) => r.map((x, k) => (k === i ? { ...x, purgeId: v } : x)))} options={stocks.map((x) => ({ value: x.p.id, label: `${x.p.color} · saldo ${fmtNum(x.b.g)} g` }))} />
            <NumField label="Gramas usadas" suffix="g" value={u.g} onChange={(v) => setUses((r) => r.map((x, k) => (k === i ? { ...x, g: v } : x)))} hint={st && num(u.g) ? `≈ ${fmtBRL(st.b.avgPerG.times(num(u.g) ?? 0))} de material recuperado` : undefined} />
            {uses.length > 1 ? <button className="btn ghost sm" onClick={() => setUses((r) => r.filter((_, k) => k !== i))}>✕ Remover</button> : <span />}
          </div>); })}
        <div><button className="btn secondary sm" onClick={() => setUses((r) => [...r, { purgeId: stocks.find((x) => !r.some((y) => y.purgeId === x.p.id))?.p.id ?? '', g: '' }])} disabled={uses.length >= stocks.length}>+ Outra cor</button></div>
        <div className="grid g3">
          <NumField label="Gasto adicional (todas as peças)" suffix="R$" value={f.extraCost} onChange={set('extraCost')} hint="Argola, tinta, energia, mão de obra… É o custo da peça (o filamento já foi custeado)." />
          <NumField label="Preço sugerido de 1 peça" suffix="R$" value={f.suggestedPrice} onChange={set('suggestedPrice')} />
          <TextField label="Onde fica guardada" value={f.location} onChange={set('location')} />
        </div>
        <ImagePicker value={image} onChange={setImage} />
        {qty > 0 && <Alert tone="info">Material recuperado: <b>{fmtBRL(value)}</b> ({fmtBRL(value.div(Math.max(1, qty)))} por peça). Custo da peça para o resultado: <b>{fmtBRL(D(extra).div(Math.max(1, qty)))}</b> por peça (só o gasto adicional).</Alert>}
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

function Pecas({ onNew }: { onNew: () => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [selling, setSelling] = useState<string | null>(null);
  const res = purgeResult(db);
  const remove = async (id: string, code: string) => {
    const ok = await confirm({ title: `Excluir a peça de purga ${code}?`, danger: true, confirmLabel: 'Excluir peça', text: 'A peça sai do estoque e a purga usada volta para o estoque de purgas. Só é possível sem vendas.' });
    if (ok !== null) run((d) => deletePurgePiece(d, id), 'Peça de purga excluída; purga devolvida.');
  };
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Material recuperado" value={fmtBRL(res.materialRecovered)} hint={`${res.pieces.length} lote(s) de peças de purga`} />
        <Kpi label="Receita das purgas" value={fmtBRL(res.revenue)} hint={`${res.soldQty} peça(s) vendida(s)`} />
        <Kpi label="Taxas e gastos adicionais" value={fmtBRL(res.fees.plus(res.extraCosts).minus(res.freightNet))} />
        <Kpi label="Resultado das purgas" value={fmtBRL(res.result)} hint="receita − taxas − gastos adicionais" accent />
      </div>
      <div className="card">
        <DataTable rows={res.pieces} rowKey={(g) => g.id} search={(g) => `${g.code} ${g.description}`}
          empty={<Empty title="Nenhuma peça de purga" text="Transforme a purga guardada em peças para vender." action={<button className="btn primary" onClick={onNew}>Nova peça de purga</button>} />}
          columns={[
            { key: 'c', header: 'Peça', render: (g) => <><span className="mono">{g.code}</span> <b>{g.description}</b><div className="muted small">{g.purge!.uses.map((u) => `${u.color} ${fmtNum(u.g)} g`).join(' · ')} · {fmtDate(g.producedAt)}</div></> },
            { key: 'q', header: 'Peças', num: true, render: (g) => { const b = finishedGoodBalance(db, g.id); return <>{b.available} disp.<div className="muted small">{g.qtyProduced} feitas · {b.sold} vendidas</div></>; } },
            { key: 'm', header: 'Material recuperado', num: true, render: (g) => fmtBRL(g.purge!.materialValue) },
            { key: 'x', header: 'Custo da peça', num: true, render: (g) => <>{fmtBRL(g.unitCost)}<div className="muted small">gasto adicional</div></> },
            { key: 'r', header: 'Vendido', num: true, render: (g) => { const s = res.sales.filter((x) => x.finishedGoodId === g.id); return s.length ? fmtBRL(s.reduce((a, x) => a.plus(D(x.unitPrice).times(x.qty).minus(D(x.discount))), D(0))) : <span className="muted">—</span>; } },
            { key: 'a', header: '', render: (g) => { const b = finishedGoodBalance(db, g.id); return <span className="row" style={{ gap: 4, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
              {b.available > 0 && <button className="btn secondary sm" onClick={() => setSelling(g.id)}>Vender</button>}
              {b.sold === 0 && <button className="btn ghost sm" onClick={() => remove(g.id, g.code)}>Excluir</button>}</span>; } },
          ]} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>A venda de peça de purga vai para Vendas e para o mesmo financeiro (contas a receber, extrato). No resultado da empresa entra como uma venda comum; aqui aparece separada para medir quanto a purga está rendendo.</p>
      {selling && <SaleForm preset={{ finishedGoodId: selling }} onClose={() => setSelling(null)} />}
      {confirmEl}
    </div>
  );
}

function Lancamentos() {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const rows = [...db.purgeMoves].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  const color = (id: string) => db.purgeStocks.find((p) => p.id === id)?.color ?? '—';
  const remove = async (m: PurgeMove) => {
    const ok = await confirm({ title: 'Excluir este lançamento de purga?', danger: true, confirmLabel: 'Excluir', text: `${KIND_LABEL[m.kind]} · ${color(m.purgeId)} · ${fmtNum(m.g)} g. O saldo da cor é recalculado.` });
    if (ok !== null) run((d) => deletePurgeMove(d, m.id), 'Lançamento excluído.');
  };
  return (
    <div className="card">
      <DataTable rows={rows} rowKey={(m) => m.id} search={(m) => `${color(m.purgeId)} ${KIND_LABEL[m.kind]} ${m.note ?? ''}`}
        empty={<Empty title="Nenhum lançamento" text="Os lançamentos aparecem aqui: cadastros, purga da produção, reaproveitamentos, peças e descartes." />}
        columns={[
          { key: 'd', header: 'Data', render: (m) => fmtDate(m.date), sort: (m) => m.date },
          { key: 'c', header: 'Cor', render: (m) => <b>{color(m.purgeId)}</b> },
          { key: 'k', header: 'Tipo', render: (m) => <Badge tone={m.kind === 'manual' || m.kind === 'producao' ? 'info' : m.kind === 'descarte' ? 'error' : 'success'}>{KIND_LABEL[m.kind]}</Badge> },
          { key: 'g', header: 'Gramas', num: true, render: (m) => `${m.kind === 'manual' || m.kind === 'producao' ? '+' : '−'}${fmtNum(m.g)} g` },
          { key: 'v', header: 'Valor', num: true, render: (m) => fmtBRL(D(m.costPerG).times(m.g)) },
          { key: 'o', header: 'Origem / obs.', render: (m) => <span className="small">{m.orderId ? `Pedido ${db.orders.find((o) => o.id === m.orderId)?.number ?? ''}` : m.finishedGoodId ? `Peça ${db.finishedGoods.find((g) => g.id === m.finishedGoodId)?.code ?? ''}` : ''}{m.note ? ` ${m.note}` : ''}</span> },
          { key: 'a', header: '', render: (m) => (m.kind === 'producao' || m.kind === 'peca' ? null : <button className="btn ghost sm" onClick={() => remove(m)}>Excluir</button>) },
        ]} />
      {confirmEl}
    </div>
  );
}

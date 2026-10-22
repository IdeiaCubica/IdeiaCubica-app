import { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { PaymentTerms, Purchase, Unit } from '../../domain/types';
import { allocate, cancelPurchase, registerPurchase, unitAcquisitionCost, type PurchaseEquipmentInput, type PurchaseItemInput } from '../../domain/purchases';
import { saveMaterial } from '../../domain/catalog';
import { MaterialForm } from './Cadastros';
import { titleOpen } from '../../domain/finance';
import { addDays, compatibleUnits, convertQty, fmtDate, todayISO } from '../../domain/core';
import { D, fmtBRL, fmtNum, parseBR, sum } from '../../domain/money';
import { perGramToPerKg } from '../../domain/conversions';
import { Alert, Badge, Combobox, DataTable, DateField, Empty, Field, Modal, NumField, PageHead, SelectField, TextArea, TextField, dec, num, useConfirm, useForm } from '../components/ui';

export function Compras() {
  return (
    <>
      <PageHead eyebrow="Compras" title="Compras da empresa" text="Todos os insumos de produção (filamento, etiquetas, embalagens…) e equipamentos (impressora, ferramentas). Cada compra gera o estoque com custo próprio e o lançamento financeiro numa única operação." />
      <ComprasLista />
    </>
  );
}

/* ---------------- Compras ---------------- */
function ComprasLista() {
  const { db } = useStore();
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<Purchase | null>(null);
  const supplier = (id?: string) => db.parties.find((p) => p.id === id)?.name ?? '—';
  const itemsLabel = (p: Purchase) => [...p.items.map((it) => db.materials.find((m) => m.id === it.materialId)?.name ?? '—'), ...(p.equipment ?? []).map((e) => e.description)].join(', ');
  return (
    <div className="card">
      <div className="card-head"><h2>Compras registradas</h2>
        <button className="btn primary" onClick={() => setCreating(true)}>Registrar compra</button></div>
      <DataTable rows={[...db.purchases].reverse()} rowKey={(p) => p.id} onRowClick={setView} search={(p) => `${p.number} ${supplier(p.supplierId)} ${itemsLabel(p)}`}
        empty={<Empty title="Nenhuma compra registrada" text="Registre qualquer compra: insumos de produção vão para o estoque com o custo de cada lote; equipamentos entram como investimento. Insumos novos podem ser cadastrados dentro da própria compra."
          action={<button className="btn primary" onClick={() => setCreating(true)}>Registrar compra</button>} />}
        columns={[
          { key: 'n', header: 'Compra', render: (p) => <span className="mono">{p.number}</span>, sort: (p) => p.number },
          { key: 'd', header: 'Data', render: (p) => fmtDate(p.date), sort: (p) => p.date },
          { key: 's', header: 'Fornecedor', render: (p) => supplier(p.supplierId) },
          { key: 'i', header: 'Itens', render: (p) => itemsLabel(p) },
          { key: 't', header: 'Total', num: true, render: (p) => fmtBRL(p.total), sort: (p) => D(p.total).toNumber() },
          { key: 'pg', header: 'Pagamento', render: (p) => p.payment.mode === 'avista' ? 'À vista' : `${p.payment.installments}x a prazo` },
          { key: 'st', header: 'Situação', render: (p) => p.status === 'ativa' ? <Badge tone="success">ativa</Badge> : <Badge tone="error">cancelada</Badge> },
        ]} />
      {creating && <PurchaseForm onClose={() => setCreating(false)} />}
      {view && <PurchaseDetail purchase={view} onClose={() => setView(null)} />}
    </div>
  );
}

type PrinterLink = 'nenhuma' | 'nova' | 'existente';
interface ItemRow {
  kind: 'insumo' | 'equipamento';
  materialId: string; qty: string; unit: Unit; price: string; batchNumber: string;
  // equipamento
  description: string; printerLink: PrinterLink; printerId: string; printerName: string; manufacturer: string; model: string;
}
const newRow = (kind: ItemRow['kind'], materialId = '', unit: Unit = 'un'): ItemRow => ({
  kind, materialId, qty: kind === 'equipamento' ? '1' : '', unit, price: '', batchNumber: '',
  description: '', printerLink: 'nenhuma', printerId: '', printerName: '', manufacturer: '', model: '',
});

function PurchaseForm({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const active = db.materials.filter((m) => m.active);
  const catName = (id: string) => db.categories.find((c) => c.id === id)?.name ?? 'Sem categoria';
  // Todos os insumos ativos, de todas as categorias, ordenados por categoria e nome.
  const materialOptions = [...active].sort((a, b) => catName(a.categoryId).localeCompare(catName(b.categoryId)) || a.name.localeCompare(b.name))
    .map((x) => ({ value: x.id, label: `${catName(x.categoryId)} · ${x.name}${x.filament ? ` (${x.filament.materialType} ${x.filament.color})` : ''}` }));
  const [f, set] = useForm({ date: todayISO(), supplierId: '', freight: '', otherCosts: '', notes: '' });
  const [items, setItems] = useState<ItemRow[]>([newRow('insumo')]);
  const [creatingFor, setCreatingFor] = useState<number | null>(null);
  const [pay, setPay] = useForm({ mode: 'avista' as PaymentTerms['mode'], accountId: db.accounts.find((a) => a.active)?.id ?? '', method: 'PIX', installments: '1', firstDue: addDays(todayISO(), 30), intervalDays: '30' });
  const setItem = (i: number, patch: Partial<ItemRow>) => setItems((rows) => rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const pickMaterial = (i: number, id: string) => setItem(i, { materialId: id, unit: db.materials.find((x) => x.id === id)?.unit ?? 'un' });

  // Prévia com as MESMAS funções de domínio usadas no registro (rateio por valor entre todos os itens).
  const preview = useMemo(() => {
    const prices = items.map((it) => parseBR(it.price) ?? D(0));
    const freight = allocate(parseBR(f.freight) ?? D(0), prices);
    const other = allocate(parseBR(f.otherCosts) ?? D(0), prices);
    const lines = items.map((it, i) => {
      if (it.kind === 'equipamento') return prices[i].gt(0) ? { equipmentTotal: prices[i].plus(freight[i]).plus(other[i]), freight: freight[i] } : null;
      const m = db.materials.find((x) => x.id === it.materialId);
      const q = num(it.qty);
      if (!m || !q || q <= 0) return null;
      try {
        const qty = convertQty(q, it.unit, m.unit);
        return { unitCost: unitAcquisitionCost(prices[i], freight[i], other[i], qty), unit: m.unit, freight: freight[i] };
      } catch { return null; }
    });
    const total = sum(prices).plus(parseBR(f.freight) ?? 0).plus(parseBR(f.otherCosts) ?? 0);
    return { lines, total };
  }, [items, f.freight, f.otherCosts, db.materials]);

  const submit = () => {
    const parsed: PurchaseItemInput[] = items.filter((it) => it.kind === 'insumo')
      .map((it) => ({ materialId: it.materialId, qty: num(it.qty) ?? 0, unit: it.unit, price: dec(it.price) ?? '', batchNumber: it.batchNumber || undefined }));
    const equipment: PurchaseEquipmentInput[] = items.filter((it) => it.kind === 'equipamento').map((it) => ({
      description: it.description || (it.printerLink === 'nova' ? it.printerName : it.printerLink === 'existente' ? db.printers.find((p) => p.id === it.printerId)?.name ?? '' : ''),
      qty: num(it.qty) ?? 0, price: dec(it.price) ?? '',
      printer: it.printerLink === 'nova' ? { mode: 'nova', name: it.printerName, manufacturer: it.manufacturer, model: it.model }
        : it.printerLink === 'existente' ? { mode: 'existente', printerId: it.printerId } : undefined,
    }));
    const terms: PaymentTerms = pay.mode === 'avista'
      ? { mode: 'avista', accountId: pay.accountId || undefined, method: pay.method, installments: 1, firstDue: f.date, intervalDays: 30 }
      : { mode: 'aprazo', method: pay.method, installments: num(pay.installments) ?? 0, firstDue: pay.firstDue, intervalDays: num(pay.intervalDays) ?? 0 };
    run((d) => registerPurchase(d, { date: f.date, supplierId: f.supplierId || undefined, items: parsed, equipment, freight: dec(f.freight) ?? '0', otherCosts: dec(f.otherCosts) ?? '0', payment: terms, notes: f.notes }),
      equipment.length ? 'Compra registrada: estoque, equipamentos e financeiro atualizados.' : 'Compra registrada: lote criado, estoque atualizado e financeiro lançado.').then((r) => r.ok && onClose());
  };

  return (
    <Modal wide title="Registrar compra" subtitle="Qualquer compra da empresa: insumos de produção (filamento, etiquetas, embalagens…) vão para o estoque; equipamentos (impressora, ferramentas) são investimento." onClose={onClose}
      footer={<><span className="muted" style={{ marginRight: 'auto' }}>Total: <b>{fmtBRL(preview.total)}</b></span><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Registrar compra</button></>}>
      <div className="stack">
        <div className="grid g3">
          <DateField label="Data da compra" required value={f.date} onChange={set('date')} />
          <SelectField label="Fornecedor" value={f.supplierId} onChange={set('supplierId')} placeholder="— não informado —" options={db.parties.filter((p) => p.kind === 'fornecedor').map((p) => ({ value: p.id, label: p.name }))} hint={<a href="#/cadastros/fornecedores" onClick={onClose}>Cadastrar fornecedor</a>} />
        </div>
        <p className="section-title">Itens</p>
        {items.map((it, i) => {
          const m = db.materials.find((x) => x.id === it.materialId);
          const pv = preview.lines[i];
          return (
            <div key={i} className="card" style={{ padding: 20 }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="seg" role="radiogroup" aria-label={`Tipo do item ${i + 1}`}>
                  {(['insumo', 'equipamento'] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={it.kind === k} className={`btn sm ${it.kind === k ? 'primary' : 'ghost'}`}
                      onClick={() => setItem(i, { ...newRow(k), price: it.price })}>{k === 'insumo' ? 'Insumo (vai para o estoque)' : 'Equipamento / impressora'}</button>
                  ))}
                </div>
                {items.length > 1 && <button className="btn ghost sm" onClick={() => setItems((r) => r.filter((_, k) => k !== i))}>Remover item</button>}
              </div>
              {it.kind === 'insumo' ? (<>
                <div className="grid g4" style={{ alignItems: 'end' }}>
                  <Field label="Insumo" hint={<button type="button" className="link-btn" onClick={() => setCreatingFor(i)}>+ Cadastrar novo insumo</button>}>
                    <Combobox ariaLabel="Insumo" value={it.materialId} onChange={(v) => pickMaterial(i, v)} placeholder="— digite para buscar —" options={materialOptions} />
                  </Field>
                  <div className="row" style={{ alignItems: 'end', flexWrap: 'nowrap', gap: 8 }}>
                    <NumField label="Quantidade recebida" value={it.qty} onChange={(v) => setItem(i, { qty: v })} />
                    {m && <div className="field" style={{ width: 110, flexShrink: 0 }}><Combobox ariaLabel="Unidade" value={it.unit} onChange={(v) => v && setItem(i, { unit: v as Unit })}
                      options={compatibleUnits(m.unit).map((u) => ({ value: u, label: u }))} /></div>}
                  </div>
                  <NumField label="Valor pago no item (total)" suffix="R$" value={it.price} onChange={(v) => setItem(i, { price: v })} />
                  <TextField label="Lote / nota (opcional)" value={it.batchNumber} onChange={(v) => setItem(i, { batchNumber: v })} />
                </div>
                <p className="small muted" style={{ margin: '12px 0 0' }}>
                  {m && !m.filament && m.unit === 'un' ? 'Informe a quantidade em unidades (ex.: pacote com 100 etiquetas = 100). · ' : ''}
                  {m?.filament?.netWeightG ? `1 carretel = ${fmtNum(m.filament.netWeightG)} g · ` : ''}
                  {pv && 'unitCost' in pv ? <>Custo de aquisição: <b style={{ color: 'var(--text)' }}>{fmtBRL(pv.unitCost, 4)}/{pv.unit}</b>{pv.unit === 'g' && <> ({fmtBRL(perGramToPerKg(pv.unitCost))}/kg)</>} · frete atribuído {fmtBRL(pv.freight)}</> : 'Informe quantidade e valor para ver o custo unitário.'}
                </p>
              </>) : (<>
                <div className="grid g4" style={{ alignItems: 'end' }}>
                  <TextField label="Descrição" value={it.description} onChange={(v) => setItem(i, { description: v })} placeholder="Ex.: Bambu Lab A1, alicate de corte" />
                  <NumField label="Quantidade" value={it.qty} onChange={(v) => setItem(i, { qty: v })} />
                  <NumField label="Valor pago (total)" suffix="R$" value={it.price} onChange={(v) => setItem(i, { price: v })} />
                  <SelectField label="É uma impressora?" value={it.printerLink} onChange={(v) => setItem(i, { printerLink: (v || 'nenhuma') as PrinterLink, qty: v && v !== 'nenhuma' ? '1' : it.qty })}
                    options={[{ value: 'nenhuma', label: 'Não (ferramenta / outro equipamento)' }, { value: 'nova', label: 'Sim, cadastrar nova impressora' }, ...(db.printers.length ? [{ value: 'existente', label: 'Sim, impressora já cadastrada' }] : [])]} />
                </div>
                {it.printerLink === 'nova' && <div className="grid g3" style={{ marginTop: 12 }}>
                  <TextField label="Nome da impressora" required value={it.printerName} onChange={(v) => setItem(i, { printerName: v })} placeholder="Ex.: A1 nº 2" />
                  <TextField label="Fabricante" value={it.manufacturer} onChange={(v) => setItem(i, { manufacturer: v })} placeholder="Bambu Lab" />
                  <TextField label="Modelo" value={it.model} onChange={(v) => setItem(i, { model: v })} placeholder="A1" />
                </div>}
                {it.printerLink === 'existente' && <div className="grid g3" style={{ marginTop: 12 }}>
                  <SelectField label="Impressora" value={it.printerId} onChange={(v) => setItem(i, { printerId: v })} placeholder="— selecione —" options={db.printers.map((p) => ({ value: p.id, label: `${p.name}${p.acquisitionValue ? ` · aquisição atual ${fmtBRL(p.acquisitionValue)}` : ''}` }))} />
                </div>}
                <p className="small muted" style={{ margin: '12px 0 0' }}>
                  Equipamento é investimento: não entra no estoque de insumos nem como despesa do mês.
                  {it.printerLink !== 'nenhuma' && ' O custo total (valor + frete atribuído) vira o valor de aquisição da impressora, base da depreciação por hora nos orçamentos.'}
                  {pv && 'equipmentTotal' in pv && <> Custo total: <b style={{ color: 'var(--text)' }}>{fmtBRL(pv.equipmentTotal)}</b> (frete atribuído {fmtBRL(pv.freight)}).</>}
                </p>
              </>)}
            </div>
          );
        })}
        <div className="row">
          <button className="btn secondary sm" onClick={() => setItems((r) => [...r, newRow('insumo')])}>+ Adicionar insumo</button>
          <button className="btn secondary sm" onClick={() => setItems((r) => [...r, newRow('equipamento')])}>+ Adicionar equipamento</button>
        </div>
        <div className="grid g3">
          <NumField label="Frete da compra" suffix="R$" value={f.freight} onChange={set('freight')} hint="Rateado entre os itens pelo valor da mercadoria" />
          <NumField label="Outros custos de aquisição" suffix="R$" value={f.otherCosts} onChange={set('otherCosts')} hint="Ex.: taxa de importação. Não inclua despesas já lançadas em outro lugar." />
        </div>
        <p className="section-title">Pagamento</p>
        <div className="grid g4">
          <SelectField label="Condição" value={pay.mode} onChange={(v) => setPay('mode')(v as PaymentTerms['mode'])} options={[{ value: 'avista', label: 'À vista (sai do caixa agora)' }, { value: 'aprazo', label: 'A prazo (gera conta a pagar)' }]} />
          <TextField label="Forma de pagamento" value={pay.method} onChange={setPay('method')} placeholder="PIX, cartão, boleto…" />
          {pay.mode === 'avista' ? (
            <SelectField label="Conta de saída" required value={pay.accountId} onChange={setPay('accountId')} placeholder="— selecione —" options={db.accounts.filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))} hint={db.accounts.length === 0 ? <a href="#/config/contas" onClick={onClose}>Cadastre uma conta financeira</a> : undefined} />
          ) : (<>
            <NumField label="Parcelas" value={pay.installments} onChange={setPay('installments')} />
            <DateField label="1º vencimento" value={pay.firstDue} onChange={setPay('firstDue')} />
            <NumField label="Intervalo" suffix="dias" value={pay.intervalDays} onChange={setPay('intervalDays')} />
          </>)}
        </div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
      {creatingFor !== null && <MaterialForm onClose={() => setCreatingFor(null)}
        onSave={(v) => run((d) => saveMaterial(d, v), 'Insumo cadastrado.').then((r) => { if (r.ok) { pickMaterial(creatingFor, r.value.id); setCreatingFor(null); } })} />}
    </Modal>
  );
}

function PurchaseDetail({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const p = db.purchases.find((x) => x.id === purchase.id)!;
  const titles = db.titles.filter((t) => t.origin.kind === 'compra' && t.origin.id === p.id);
  const cancel = async () => {
    const reason = await confirm({ title: `Cancelar compra ${p.number}?`, danger: true, confirmLabel: 'Cancelar compra', reasonLabel: 'Motivo do cancelamento',
      text: 'O estoque recebido será estornado (devolução) e os títulos cancelados. O histórico é preservado. Só é possível se o material não foi usado e não houver pagamentos ativos.' });
    if (reason) run((d) => cancelPurchase(d, p.id, reason), 'Compra cancelada com estorno.');
  };
  return (
    <Modal wide title={`Compra ${p.number}`} subtitle={`${fmtDate(p.date)} · ${db.parties.find((x) => x.id === p.supplierId)?.name ?? 'fornecedor não informado'}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button>{p.status === 'ativa' && <button className="btn danger" onClick={cancel}>Cancelar compra</button>}</>}>
      <div className="stack">
        {p.status === 'cancelada' && <Alert tone="error" title="Compra cancelada">{p.cancelReason}</Alert>}
        {p.items.length > 0 && <><h3>Insumos (estoque)</h3>
        <div className="card"><table className="tbl"><thead><tr><th>Lote</th><th>Insumo</th><th className="num">Qtd.</th><th className="num">Mercadoria</th><th className="num">Frete</th><th className="num">Custo unitário</th></tr></thead><tbody>
          {p.items.map((it) => { const lot = db.lots.find((l) => l.id === it.lotId)!; const m = db.materials.find((x) => x.id === it.materialId); return (
            <tr key={it.lotId}><td className="mono">{lot.code}</td><td>{m?.name}<div className="muted small">{db.categories.find((c) => c.id === m?.categoryId)?.name}</div></td><td className="num">{fmtNum(it.qty)} {m?.unit}</td><td className="num">{fmtBRL(lot.cost.goods)}</td><td className="num">{fmtBRL(D(lot.cost.freight).plus(lot.cost.other))}</td><td className="num"><b>{fmtBRL(lot.unitCost, 4)}</b></td></tr>); })}
        </tbody></table></div></>}
        {(p.equipment ?? []).length > 0 && <><h3>Equipamentos (investimento)</h3>
        <div className="card"><table className="tbl"><thead><tr><th>Equipamento</th><th className="num">Qtd.</th><th className="num">Mercadoria</th><th className="num">Frete</th><th className="num">Custo total</th><th>Impressora</th></tr></thead><tbody>
          {p.equipment!.map((e) => <tr key={e.id}><td>{e.description}</td><td className="num">{e.qty}</td><td className="num">{fmtBRL(e.price)}</td><td className="num">{fmtBRL(D(e.freight).plus(e.other))}</td><td className="num"><b>{fmtBRL(e.total)}</b></td>
            <td>{e.printerId ? <>{db.printers.find((x) => x.id === e.printerId)?.name ?? 'removida'} <span className="muted small">{e.printerCreated ? '(cadastrada nesta compra)' : '(valor de aquisição atualizado)'}</span></> : '—'}</td></tr>)}
        </tbody></table></div></>}
        <p className="right"><b>Total da compra: {fmtBRL(p.total)}</b></p>
        <h3>Financeiro gerado</h3>
        <div className="card"><table className="tbl"><thead><tr><th>Título</th><th>Vencimento</th><th className="num">Valor</th><th className="num">Em aberto</th><th>Situação</th></tr></thead><tbody>
          {titles.map((t) => <tr key={t.id}><td>{t.description}</td><td>{fmtDate(t.dueDate)}</td><td className="num">{fmtBRL(t.amount)}</td><td className="num">{fmtBRL(titleOpen(t))}</td><td><Badge tone={t.status === 'liquidado' ? 'success' : t.status === 'cancelado' ? 'error' : 'warning'}>{t.status}</Badge></td></tr>)}
        </tbody></table></div>
        <p className="small muted">Pagamentos de compras a prazo são feitos em Financeiro → Contas a pagar; o pagamento liquida o título, sem gerar nova despesa.</p>
      </div>
      {confirmEl}
    </Modal>
  );
}

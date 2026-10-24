import { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { DB, Material, PaymentTerms, Purchase, Unit } from '../../domain/types';
import { allocate, cancelPurchase, purchaseEditBlock, purchaseLotUsed, registerPurchase, unitAcquisitionCost, unusualLots, unusualUnitCost, updatePurchase, type PurchaseEquipmentInput, type PurchaseInput, type PurchaseItemInput } from '../../domain/purchases';
import { materialLabel, saveMaterial } from '../../domain/catalog';
import { MaterialForm } from './Cadastros';
import { titleOpen } from '../../domain/finance';
import { addDays, compatibleUnits, convertQty, fmtDate, todayISO } from '../../domain/core';
import { D, fmtBRL, fmtNum, parseBR, sum, toInputBR } from '../../domain/money';
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
  const [editing, setEditing] = useState<Purchase | null>(null);
  const supplier = (id?: string) => db.parties.find((p) => p.id === id)?.name ?? '—';
  const itemsLabel = (p: Purchase) => [...p.items.map((it) => { const m = db.materials.find((m) => m.id === it.materialId); return m ? materialLabel(m) : '—'; }), ...(p.equipment ?? []).map((e) => e.description)].join(', ');
  const suspicious = unusualLots(db).filter((x) => x.purchase?.status === 'ativa');
  return (
    <div className="stack">
      {suspicious.length > 0 && <Alert tone="error" title={`${suspicious.length} lote(s) de compra com custo improvável`}>
        Quase sempre é a quantidade digitada na unidade errada (ex.: 1 g em vez de 1 kg). Esses custos entram nos orçamentos — corrija editando a compra:
        <ul style={{ margin: '6px 0 0' }}>{suspicious.map(({ lot, mat, purchase }) => (
          <li key={lot.id}><button type="button" className="link-btn" onClick={() => purchase && setEditing(purchase)}>{purchase?.number} · {materialLabel(mat)}</button> — {fmtNum(lot.initialQty)} {mat.unit} a {mat.unit === 'g' ? `${fmtBRL(perGramToPerKg(lot.unitCost))}/kg` : `${fmtBRL(lot.unitCost, 4)}/${mat.unit}`}</li>
        ))}</ul>
      </Alert>}
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
            { key: 't', header: 'Total', num: true, render: (p) => <>{fmtBRL(p.total)}{D(p.discount ?? 0).gt(0) && <div className="muted small">desconto {fmtBRL(p.discount!)}</div>}</>, sort: (p) => D(p.total).toNumber() },
            { key: 'pg', header: 'Pagamento', render: (p) => p.payment.mode === 'avista' ? 'À vista' : `${p.payment.installments}x a prazo` },
            { key: 'st', header: 'Situação', render: (p) => p.status === 'ativa' ? <Badge tone="success">ativa</Badge> : <Badge tone="error">cancelada</Badge> },
          ]} />
      </div>
      {creating && <PurchaseForm onClose={() => setCreating(false)} />}
      {editing && <PurchaseForm purchase={editing} onClose={() => setEditing(null)} />}
      {view && !editing && <PurchaseDetail purchase={view} onClose={() => setView(null)} onEdit={() => { setEditing(view); setView(null); }} />}
    </div>
  );
}

type PrinterLink = 'nenhuma' | 'nova' | 'existente';
/** 'carretel' é uma unidade de digitação: convertida em gramas pelo peso líquido do carretel. */
type RowUnit = Unit | 'carretel';
interface ItemRow {
  kind: 'insumo' | 'equipamento';
  materialId: string; qty: string; unit: RowUnit; price: string; batchNumber: string;
  /** Edição: lote existente (quando já usado, o insumo não pode mudar). */
  lotId?: string; locked?: boolean;
  // equipamento
  description: string; printerLink: PrinterLink; printerId: string; printerName: string; manufacturer: string; model: string;
  eqId?: string; eqPrinterLabel?: string;
}
const newRow = (kind: ItemRow['kind'], materialId = '', unit: RowUnit = 'un'): ItemRow => ({
  kind, materialId, qty: kind === 'equipamento' ? '1' : '', unit, price: '', batchNumber: '',
  description: '', printerLink: 'nenhuma', printerId: '', printerName: '', manufacturer: '', model: '',
});

/** Unidade de digitação padrão: filamento por carretel (ou kg), nunca grama — evita o erro de 1.000×. */
export function defaultPurchaseUnit(m: Material | undefined): RowUnit {
  if (!m) return 'un';
  if (m.unit === 'g') return m.filament?.netWeightG ? 'carretel' : 'kg';
  return m.unit;
}
function unitOptions(m: Material) {
  const units: { value: RowUnit; label: string }[] = [];
  if (m.unit === 'g' && m.filament?.netWeightG) units.push({ value: 'carretel', label: `carretel (${fmtNum(m.filament.netWeightG)} g)` });
  for (const u of compatibleUnits(m.unit)) units.push({ value: u, label: u === 'g' ? 'g (gramas)' : u === 'kg' ? 'kg (quilos)' : u });
  return units;
}
/** Quantidade digitada → quantidade e unidade aceitas pelo domínio. */
function rowQty(it: ItemRow, m: Material | undefined): { qty: number; unit: Unit } | null {
  const q = num(it.qty);
  if (!m || !q || q <= 0) return null;
  if (it.unit === 'carretel') return m.filament?.netWeightG ? { qty: q * m.filament.netWeightG, unit: 'g' } : null;
  return { qty: q, unit: it.unit };
}

function rowsFromPurchase(db: DB, p: Purchase): ItemRow[] {
  const rows: ItemRow[] = p.items.map((it) => {
    const m = db.materials.find((x) => x.id === it.materialId);
    const kg = m?.unit === 'g';
    return { ...newRow('insumo', it.materialId, kg ? 'kg' : (m?.unit ?? 'un')), qty: toInputBR(kg ? it.qty / 1000 : it.qty), price: toInputBR(it.price, 2),
      batchNumber: it.batchNumber ?? '', lotId: it.lotId, locked: purchaseLotUsed(db, it.lotId) };
  });
  for (const e of p.equipment ?? []) {
    rows.push({ ...newRow('equipamento'), description: e.description, qty: String(e.qty), price: toInputBR(e.price, 2), eqId: e.id,
      eqPrinterLabel: e.printerId ? `${db.printers.find((x) => x.id === e.printerId)?.name ?? 'impressora'} ${e.printerCreated ? '(cadastrada nesta compra)' : '(valor de aquisição atualizado)'}` : undefined });
  }
  return rows.length ? rows : [newRow('insumo')];
}

function PurchaseForm({ onClose, purchase }: { onClose: () => void; purchase?: Purchase }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const editing = !!purchase;
  const block = purchase ? purchaseEditBlock(db, purchase) : null;
  const active = db.materials.filter((m) => m.active || purchase?.items.some((it) => it.materialId === m.id));
  const catName = (id: string) => db.categories.find((c) => c.id === id)?.name ?? 'Sem categoria';
  // Todos os insumos ativos, de todas as categorias, ordenados por categoria e nome.
  const materialOptions = [...active].sort((a, b) => catName(a.categoryId).localeCompare(catName(b.categoryId)) || a.name.localeCompare(b.name))
    .map((x) => ({ value: x.id, label: `${catName(x.categoryId)} · ${materialLabel(x)}` }));
  const [f, set] = useForm(() => ({
    date: purchase?.date ?? todayISO(), supplierId: purchase?.supplierId ?? '', freight: purchase ? toInputBR(purchase.freight, 2) : '',
    otherCosts: purchase ? toInputBR(purchase.otherCosts, 2) : '', discount: purchase?.discount && D(purchase.discount).gt(0) ? toInputBR(purchase.discount, 2) : '', notes: purchase?.notes ?? '',
  }));
  const [items, setItems] = useState<ItemRow[]>(() => purchase ? rowsFromPurchase(db, purchase) : [newRow('insumo')]);
  const [creatingFor, setCreatingFor] = useState<number | null>(null);
  const pt = purchase?.payment;
  const [pay, setPay] = useForm(() => ({
    mode: (pt?.mode ?? 'avista') as PaymentTerms['mode'], accountId: pt?.accountId ?? db.accounts.find((a) => a.active)?.id ?? '', method: pt?.method ?? 'PIX',
    installments: String(pt?.installments ?? 1), firstDue: pt?.mode === 'aprazo' ? pt.firstDue : addDays(todayISO(), 30), intervalDays: String(pt?.intervalDays ?? 30),
  }));
  const setItem = (i: number, patch: Partial<ItemRow>) => setItems((rows) => rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const pickMaterial = (i: number, id: string) => setItem(i, { materialId: id, unit: defaultPurchaseUnit(db.materials.find((x) => x.id === id)) });

  // Prévia com as MESMAS funções de domínio usadas no registro (rateio por valor entre todos os itens).
  const preview = useMemo(() => {
    const prices = items.map((it) => parseBR(it.price) ?? D(0));
    const freight = allocate(parseBR(f.freight) ?? D(0), prices);
    const other = allocate(parseBR(f.otherCosts) ?? D(0), prices);
    const discount = allocate(parseBR(f.discount) ?? D(0), prices);
    const lines = items.map((it, i) => {
      if (it.kind === 'equipamento') return prices[i].gt(0) ? { equipmentTotal: prices[i].plus(freight[i]).plus(other[i]).minus(discount[i]), freight: freight[i], discount: discount[i] } : null;
      const m = db.materials.find((x) => x.id === it.materialId);
      const rq = rowQty(it, m);
      if (!m || !rq) return null;
      try {
        const qty = convertQty(rq.qty, rq.unit, m.unit);
        const unitCost = unitAcquisitionCost(prices[i], freight[i], other[i], qty, discount[i]);
        return { unitCost, unit: m.unit, qtyStock: qty, freight: freight[i], discount: discount[i], warning: unusualUnitCost(m, unitCost) };
      } catch { return null; }
    });
    const goods = sum(prices);
    const total = goods.plus(parseBR(f.freight) ?? 0).plus(parseBR(f.otherCosts) ?? 0).minus(parseBR(f.discount) ?? 0);
    return { lines, goods, total };
  }, [items, f.freight, f.otherCosts, f.discount, db.materials]);
  const warnings = preview.lines.flatMap((l, i) => l && 'warning' in l && l.warning ? [`Item ${i + 1}: ${l.warning}`] : []);

  const submit = async () => {
    const parsed: PurchaseItemInput[] = items.filter((it) => it.kind === 'insumo').map((it) => {
      const rq = rowQty(it, db.materials.find((x) => x.id === it.materialId));
      return { materialId: it.materialId, qty: rq?.qty ?? 0, unit: rq?.unit, price: dec(it.price) ?? '', batchNumber: it.batchNumber || undefined, lotId: it.lotId };
    });
    const equipment: PurchaseEquipmentInput[] = items.filter((it) => it.kind === 'equipamento').map((it) => ({
      description: it.description || (it.printerLink === 'nova' ? it.printerName : it.printerLink === 'existente' ? db.printers.find((p) => p.id === it.printerId)?.name ?? '' : ''),
      qty: num(it.qty) ?? 0, price: dec(it.price) ?? '', id: it.eqId,
      printer: it.eqId ? undefined : it.printerLink === 'nova' ? { mode: 'nova', name: it.printerName, manufacturer: it.manufacturer, model: it.model }
        : it.printerLink === 'existente' ? { mode: 'existente', printerId: it.printerId } : undefined,
    }));
    const terms: PaymentTerms = pay.mode === 'avista'
      ? { mode: 'avista', accountId: pay.accountId || undefined, method: pay.method, installments: 1, firstDue: f.date, intervalDays: 30 }
      : { mode: 'aprazo', method: pay.method, installments: num(pay.installments) ?? 0, firstDue: pay.firstDue, intervalDays: num(pay.intervalDays) ?? 0 };
    if (warnings.length) {
      const ok = await confirm({ title: 'Custo improvável — confira antes de salvar', confirmLabel: 'Os valores estão certos, salvar',
        text: <>{warnings.map((w, i) => <p key={i} style={{ margin: '0 0 8px' }}>{w}</p>)}<p className="muted small" style={{ margin: 0 }}>Esse custo vai para o estoque e para os orçamentos. Se a unidade estiver errada, volte e troque (carretel, kg ou g).</p></> });
      if (ok === null) return;
    }
    const input: PurchaseInput = { date: f.date, supplierId: f.supplierId || undefined, items: parsed, equipment, freight: dec(f.freight) ?? '0', otherCosts: dec(f.otherCosts) ?? '0', discount: dec(f.discount) ?? '0', payment: terms, notes: f.notes };
    const r = purchase
      ? await run((d) => updatePurchase(d, purchase.id, input), 'Compra corrigida: lotes, custos e financeiro recalculados.')
      : await run((d) => registerPurchase(d, input), equipment.length ? 'Compra registrada: estoque, equipamentos e financeiro atualizados.' : 'Compra registrada: lote criado, estoque atualizado e financeiro lançado.');
    if (r.ok) onClose();
  };

  return (
    <Modal wide title={editing ? `Editar compra ${purchase!.number}` : 'Registrar compra'} subtitle={editing ? 'Corrija o que foi digitado errado. Estoque, custo dos lotes e financeiro são recalculados juntos.' : 'Qualquer compra da empresa: insumos de produção (filamento, etiquetas, embalagens…) vão para o estoque; equipamentos (impressora, ferramentas) são investimento.'} onClose={onClose}
      footer={<><span className="muted" style={{ marginRight: 'auto' }}>Total: <b>{fmtBRL(preview.total)}</b>{(parseBR(f.discount) ?? D(0)).gt(0) && <> (mercadorias {fmtBRL(preview.goods)} − desconto {fmtBRL(parseBR(f.discount)!)})</>}</span><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={!!block}>{editing ? 'Salvar correção' : 'Registrar compra'}</button></>}>
      <div className="stack">
        {block && <Alert tone="warning" title="Edição bloqueada">{block}</Alert>}
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
                {it.lotId || it.eqId ? <span className="muted small">{it.lotId ? `Lote ${db.lots.find((l) => l.id === it.lotId)?.code ?? ''}${it.locked ? ' · já usado na produção: o insumo não muda e a quantidade não pode ficar abaixo do que já saiu' : ''}` : 'Equipamento desta compra'}</span> : (
                <div className="seg" role="radiogroup" aria-label={`Tipo do item ${i + 1}`}>
                  {(['insumo', 'equipamento'] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={it.kind === k} className={`btn sm ${it.kind === k ? 'primary' : 'ghost'}`}
                      onClick={() => setItem(i, { ...newRow(k), price: it.price })}>{k === 'insumo' ? 'Insumo (vai para o estoque)' : 'Equipamento / impressora'}</button>
                  ))}
                </div>)}
                {items.length > 1 && !it.locked && <button className="btn ghost sm" onClick={() => setItems((r) => r.filter((_, k) => k !== i))}>Remover item</button>}
              </div>
              {it.kind === 'insumo' ? (<>
                <div className="grid g4" style={{ alignItems: 'end' }}>
                  <Field label="Insumo" hint={it.locked ? undefined : <button type="button" className="link-btn" onClick={() => setCreatingFor(i)}>+ Cadastrar novo insumo</button>}>
                    <Combobox ariaLabel="Insumo" value={it.materialId} onChange={(v) => !it.locked && pickMaterial(i, v)} placeholder="— digite para buscar —" options={materialOptions} />
                  </Field>
                  <div className="row" style={{ alignItems: 'end', flexWrap: 'nowrap', gap: 8 }}>
                    <NumField label="Quantidade recebida" value={it.qty} onChange={(v) => setItem(i, { qty: v })} />
                    {m && <div className="field" style={{ width: 150, flexShrink: 0 }}><Combobox ariaLabel="Unidade" value={it.unit} onChange={(v) => v && setItem(i, { unit: v as RowUnit })}
                      options={unitOptions(m)} /></div>}
                  </div>
                  <NumField label="Valor pago no item (total)" suffix="R$" value={it.price} onChange={(v) => setItem(i, { price: v })} hint="Preço cheio do item; o desconto da compra vai no campo abaixo" />
                  <TextField label="Lote / nota (opcional)" value={it.batchNumber} onChange={(v) => setItem(i, { batchNumber: v })} />
                </div>
                <p className="small muted" style={{ margin: '12px 0 0' }}>
                  {m && !m.filament && m.unit === 'un' ? 'Informe a quantidade em unidades (ex.: pacote com 100 etiquetas = 100). · ' : ''}
                  {pv && 'unitCost' in pv ? <>Entra no estoque: <b style={{ color: 'var(--text)' }}>{fmtNum(pv.qtyStock)} {pv.unit}</b> · custo de aquisição <b style={{ color: 'var(--text)' }}>{pv.unit === 'g' ? `${fmtBRL(perGramToPerKg(pv.unitCost))}/kg` : `${fmtBRL(pv.unitCost, 4)}/${pv.unit}`}</b>{pv.unit === 'g' && <> ({fmtBRL(pv.unitCost, 5)}/g)</>} · frete atribuído {fmtBRL(pv.freight)}{pv.discount.gt(0) && <> · desconto atribuído {fmtBRL(pv.discount)}</>}</> : 'Informe quantidade e valor para ver o custo unitário.'}
                </p>
                {pv && 'warning' in pv && pv.warning && <Alert tone="error" title="Confira a quantidade e a unidade">{pv.warning}</Alert>}
              </>) : (<>
                <div className="grid g4" style={{ alignItems: 'end' }}>
                  <TextField label="Descrição" value={it.description} onChange={(v) => setItem(i, { description: v })} placeholder="Ex.: Bambu Lab A1, alicate de corte" />
                  <NumField label="Quantidade" value={it.qty} onChange={(v) => setItem(i, { qty: v })} />
                  <NumField label="Valor pago (total)" suffix="R$" value={it.price} onChange={(v) => setItem(i, { price: v })} />
                  {it.eqId ? <Field label="Impressora"><div className="readonly-value">{it.eqPrinterLabel ?? 'não vinculada'}</div></Field> :
                  <SelectField label="É uma impressora?" value={it.printerLink} onChange={(v) => setItem(i, { printerLink: (v || 'nenhuma') as PrinterLink, qty: v && v !== 'nenhuma' ? '1' : it.qty })}
                    options={[{ value: 'nenhuma', label: 'Não (ferramenta / outro equipamento)' }, { value: 'nova', label: 'Sim, cadastrar nova impressora' }, ...(db.printers.length ? [{ value: 'existente', label: 'Sim, impressora já cadastrada' }] : [])]} />}
                </div>
                {!it.eqId && it.printerLink === 'nova' && <div className="grid g3" style={{ marginTop: 12 }}>
                  <TextField label="Nome da impressora" required value={it.printerName} onChange={(v) => setItem(i, { printerName: v })} placeholder="Ex.: A1 nº 2" />
                  <TextField label="Fabricante" value={it.manufacturer} onChange={(v) => setItem(i, { manufacturer: v })} placeholder="Bambu Lab" />
                  <TextField label="Modelo" value={it.model} onChange={(v) => setItem(i, { model: v })} placeholder="A1" />
                </div>}
                {!it.eqId && it.printerLink === 'existente' && <div className="grid g3" style={{ marginTop: 12 }}>
                  <SelectField label="Impressora" value={it.printerId} onChange={(v) => setItem(i, { printerId: v })} placeholder="— selecione —" options={db.printers.map((p) => ({ value: p.id, label: `${p.name}${p.acquisitionValue ? ` · aquisição atual ${fmtBRL(p.acquisitionValue)}` : ''}` }))} />
                </div>}
                <p className="small muted" style={{ margin: '12px 0 0' }}>
                  Equipamento é investimento: não entra no estoque de insumos nem como despesa do mês.
                  {(it.printerLink !== 'nenhuma' || it.eqPrinterLabel) && ' O custo total (valor + frete − desconto atribuídos) vira o valor de aquisição da impressora, base da depreciação por hora nos orçamentos.'}
                  {pv && 'equipmentTotal' in pv && <> Custo total: <b style={{ color: 'var(--text)' }}>{fmtBRL(pv.equipmentTotal)}</b> (frete atribuído {fmtBRL(pv.freight)}{pv.discount.gt(0) && <>, desconto {fmtBRL(pv.discount)}</>}).</>}
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
          <NumField label="Desconto na compra" suffix="R$" value={f.discount} onChange={set('discount')} hint="Cupom ou desconto do fornecedor. Rateado pelo valor dos itens: reduz o custo dos lotes e o valor pago; o preço do cadastro não muda." />
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
      {confirmEl}
    </Modal>
  );
}

function PurchaseDetail({ purchase, onClose, onEdit }: { purchase: Purchase; onClose: () => void; onEdit: () => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const p = db.purchases.find((x) => x.id === purchase.id)!;
  const titles = db.titles.filter((t) => t.origin.kind === 'compra' && t.origin.id === p.id);
  const block = purchaseEditBlock(db, p);
  const cancel = async () => {
    const reason = await confirm({ title: `Cancelar compra ${p.number}?`, danger: true, confirmLabel: 'Cancelar compra', reasonLabel: 'Motivo do cancelamento',
      text: 'O estoque recebido será estornado (devolução) e os títulos cancelados. O histórico é preservado. Só é possível se o material não foi usado e não houver pagamentos ativos.' });
    if (reason) run((d) => cancelPurchase(d, p.id, reason), 'Compra cancelada com estorno.');
  };
  return (
    <Modal wide title={`Compra ${p.number}`} subtitle={`${fmtDate(p.date)} · ${db.parties.find((x) => x.id === p.supplierId)?.name ?? 'fornecedor não informado'}${p.editedAt ? ` · editada em ${fmtDate(p.editedAt.slice(0, 10))}` : ''}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button>{p.status === 'ativa' && <button className="btn danger" onClick={cancel}>Cancelar compra</button>}
        {p.status === 'ativa' && <button className="btn primary" onClick={onEdit} disabled={!!block} title={block ?? undefined}>Editar compra</button>}</>}>
      <div className="stack">
        {p.status === 'cancelada' && <Alert tone="error" title="Compra cancelada">{p.cancelReason}</Alert>}
        {p.status === 'ativa' && block && <Alert tone="info" title="Para editar">{block}</Alert>}
        {p.items.length > 0 && <><h3>Insumos (estoque)</h3>
        <div className="card"><table className="tbl"><thead><tr><th>Lote</th><th>Insumo</th><th className="num">Qtd.</th><th className="num">Mercadoria</th><th className="num">Frete/outros</th><th className="num">Desconto</th><th className="num">Custo unitário</th></tr></thead><tbody>
          {p.items.map((it) => { const lot = db.lots.find((l) => l.id === it.lotId)!; const m = db.materials.find((x) => x.id === it.materialId); const warn = unusualUnitCost(m, lot.unitCost); return (
            <tr key={it.lotId}><td className="mono">{lot.code}</td><td>{m ? materialLabel(m) : '—'}<div className="muted small">{db.categories.find((c) => c.id === m?.categoryId)?.name}</div></td><td className="num">{fmtNum(it.qty)} {m?.unit}</td><td className="num">{fmtBRL(lot.cost.goods)}</td><td className="num">{fmtBRL(D(lot.cost.freight).plus(lot.cost.other))}</td><td className="num">{D(lot.cost.discount ?? 0).gt(0) ? `− ${fmtBRL(lot.cost.discount!)}` : '—'}</td>
              <td className="num"><b className={warn ? 'err-text' : ''}>{m?.unit === 'g' ? `${fmtBRL(perGramToPerKg(lot.unitCost))}/kg` : `${fmtBRL(lot.unitCost, 4)}/${m?.unit ?? ''}`}</b>{warn && <div className="small err-text">custo improvável</div>}</td></tr>); })}
        </tbody></table></div></>}
        {(p.equipment ?? []).length > 0 && <><h3>Equipamentos (investimento)</h3>
        <div className="card"><table className="tbl"><thead><tr><th>Equipamento</th><th className="num">Qtd.</th><th className="num">Mercadoria</th><th className="num">Frete</th><th className="num">Desconto</th><th className="num">Custo total</th><th>Impressora</th></tr></thead><tbody>
          {p.equipment!.map((e) => <tr key={e.id}><td>{e.description}</td><td className="num">{e.qty}</td><td className="num">{fmtBRL(e.price)}</td><td className="num">{fmtBRL(D(e.freight).plus(e.other))}</td><td className="num">{D(e.discount ?? 0).gt(0) ? `− ${fmtBRL(e.discount!)}` : '—'}</td><td className="num"><b>{fmtBRL(e.total)}</b></td>
            <td>{e.printerId ? <>{db.printers.find((x) => x.id === e.printerId)?.name ?? 'removida'} <span className="muted small">{e.printerCreated ? '(cadastrada nesta compra)' : '(valor de aquisição atualizado)'}</span></> : '—'}</td></tr>)}
        </tbody></table></div></>}
        <p className="right">{D(p.discount ?? 0).gt(0) && <span className="muted">Desconto: − {fmtBRL(p.discount!)} · </span>}<b>Total da compra: {fmtBRL(p.total)}</b></p>
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

import { useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { AddressParts, Category, DB, DeliveryKit, Material, NamedItem, Party, Unit } from '../../domain/types';
import { AddressFields } from '../components/AddressFields';
import { deleteMaterial, deleteNamed, materialLabel, materialUsage, namedUsage, nextMaterialCode, normalizeSigla, priceHistory, saveCategory, saveMaterial, saveNamed, saveParty, suggestSigla, type NamedList } from '../../domain/catalog';
import { lotBalance, materialBalance, reorderAnalysis } from '../../domain/inventory';
import { materialCostPolicy } from '../../domain/quotes';
import { correctLot, purchaseEditBlock, unusualUnitCost } from '../../domain/purchases';
import { deleteDeliveryKit, kitUnitCost, saveDeliveryKit } from '../../domain/deliveryKits';
import { filamentTemplateCsv, importFilaments, previewFilamentImport } from '../../domain/filamentImport';
import { UNIT_LABEL, fmtDate, fmtDocument, fmtPhone } from '../../domain/core';
import { D, Decimal, fmtBRL, fmtNum, parseBR, toInputBR } from '../../domain/money';
import { perGramToPerKg, perKgToPerGram } from '../../domain/conversions';
import { Alert, Badge, Check, Combobox, DataTable, Empty, Field, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, dec, num, useConfirm, useForm } from '../components/ui';

type Tab = 'materiais' | 'kits' | 'clientes' | 'fornecedores' | 'marcas' | 'fabricantes';
export const FILAMENT_TYPES = ['PLA', 'PLA Silk', 'PLA Matte', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'Nylon', 'Outro'];

export function Cadastros({ param }: { param?: string }) {
  const { db } = useStore();
  const tab = (param as Tab) || 'materiais';
  return (
    <>
      <PageHead eyebrow="Cadastros" title="Cadastros" text="Materiais, clientes, fornecedores, marcas e fabricantes usados em orçamentos, compras, produção e vendas." />
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`cadastros/${t}`)} tabs={[
        { id: 'materiais', label: 'Materiais', count: db.materials.length },
        { id: 'kits', label: 'Kits de entrega', count: db.deliveryKits.length || undefined },
        { id: 'clientes', label: 'Clientes', count: db.parties.filter((p) => p.kind === 'cliente').length },
        { id: 'fornecedores', label: 'Fornecedores', count: db.parties.filter((p) => p.kind === 'fornecedor').length },
        { id: 'marcas', label: 'Marcas', count: db.brands.length },
        { id: 'fabricantes', label: 'Fabricantes', count: db.manufacturers.length },
      ]} />
      {tab === 'materiais' && <Materiais />}
      {tab === 'kits' && <DeliveryKits />}
      {tab === 'clientes' && <Parties kind="cliente" />}
      {tab === 'fornecedores' && <Parties kind="fornecedor" />}
      {tab === 'marcas' && <NamedListManager list="brands" title="Marcas" singular="marca" usedIn="materiais" />}
      {tab === 'fabricantes' && <NamedListManager list="manufacturers" title="Fabricantes" singular="fabricante" usedIn="materiais" />}
    </>
  );
}

export function materialDesc(db: DB, m: Material) {
  const cat = db.categories.find((c) => c.id === m.categoryId);
  const brand = db.brands.find((b) => b.id === m.brandId)?.name ?? m.filament?.brand;
  if (m.filament) return `${m.filament.materialType} · ${m.filament.color}${brand ? ' · ' + brand : ''}`;
  return `${cat?.name ?? ''}${brand ? ' · ' + brand : ''}`;
}

/** Opções de uma lista simples para as listas pesquisáveis (inclui o item atual mesmo se inativo). */
const namedOptions = (items: NamedItem[], current?: string) =>
  items.filter((x) => x.active || x.id === current).map((x) => ({ value: x.id, label: x.active ? x.name : `${x.name} (inativo)` }));

/* ---------------- Listas simples (marcas, fabricantes, fontes de captação) ---------------- */
export function NamedListManager({ list, title, singular, usedIn }: { list: NamedList; title: string; singular: string; usedIn: string }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<NamedItem | null>(null);
  const items = db[list];
  const add = () => run((d) => saveNamed(d, list, { name, active: true }), `${singular[0].toUpperCase() + singular.slice(1)} cadastrada.`).then((r) => r.ok && setName(''));
  const remove = async (it: NamedItem) => {
    const ok = await confirm({ title: `Excluir "${it.name}"?`, danger: true, confirmLabel: 'Excluir', text: 'Itens em uso não podem ser excluídos — desative-os para que não apareçam mais nas listas.' });
    if (ok !== null) run((d) => deleteNamed(d, list, it.id), 'Excluído.');
  };
  return (
    <div className="card">
      <div className="card-head"><div><h2>{title}</h2><p className="muted small">Aparecem como lista suspensa nos cadastros de {usedIn}.</p></div></div>
      <div className="card-body">
        <form className="row" style={{ alignItems: 'end', flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); add(); }}>
          <div style={{ flex: 1 }}><TextField label={`Nova ${singular}`} value={name} onChange={setName} placeholder="Digite o nome" /></div>
          <button className="btn primary" type="submit">Adicionar</button>
        </form>
      </div>
      <DataTable rows={items} rowKey={(x) => x.id} search={(x) => x.name} initialSort={{ key: 'n', dir: 1 }}
        empty={<Empty title={`Nenhuma ${singular} cadastrada`} text="Digite o nome acima e clique em Adicionar." />}
        columns={[
          { key: 'n', header: 'Nome', render: (x) => <b>{x.name}</b>, sort: (x) => x.name.toLowerCase() },
          { key: 'u', header: 'Em uso', num: true, render: (x) => namedUsage(db, list, x.id) },
          { key: 's', header: 'Situação', render: (x) => x.active ? <Badge tone="success">ativa</Badge> : <Badge>inativa</Badge> },
          { key: 'a', header: '', render: (x) => <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <button className="btn ghost sm" onClick={() => setEdit(x)}>Editar</button>
            <button className="btn ghost sm" onClick={() => run((d) => saveNamed(d, list, { name: x.name, active: !x.active }, x.id))}>{x.active ? 'Desativar' : 'Ativar'}</button>
            <button className="btn ghost sm" onClick={() => remove(x)}>Excluir</button>
          </div> },
        ]} />
      {edit && <RenameModal item={edit} title={`Editar ${singular}`} onClose={() => setEdit(null)} onSave={(n) => run((d) => saveNamed(d, list, { name: n, active: edit.active }, edit.id), 'Salvo.').then((r) => r.ok && setEdit(null))} />}
      {confirmEl}
    </div>
  );
}

function RenameModal({ item, title, onClose, onSave }: { item: NamedItem; title: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(item.name);
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave(name)}>Salvar</button></>}>
      <TextField label="Nome" required value={name} onChange={setName} autoFocus />
    </Modal>
  );
}

/** Preço exibido ao usuário: R$/kg para filamento, R$/unidade nos demais. */
export function priceLabel(m: Material, unitCost: Decimal.Value | null | undefined) {
  if (unitCost === null || unitCost === undefined) return null;
  return m.unit === 'g' ? `${fmtBRL(perGramToPerKg(unitCost))}/kg` : `${fmtBRL(unitCost, 4)}/${m.unit}`;
}

/* ---------------- Kits de entrega ---------------- */
function DeliveryKits() {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [edit, setEdit] = useState<DeliveryKit | 'novo' | null>(null);
  const remove = async (k: DeliveryKit) => {
    if (await confirm({ title: `Excluir o kit "${k.name}"?`, danger: true, confirmLabel: 'Excluir', text: 'Se o kit já foi usado em orçamentos ou vendas, ele fica inativo (o histórico é preservado).' }) === null) return;
    run((d) => deleteDeliveryKit(d, k.id), 'Kit removido.');
  };
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>Kits de entrega</h2><p className="muted small">Modelos de acessórios que acompanham o pedido (saquinho, cartão de agradecimento, adesivo, logo…). No orçamento, o custo do kit entra no preço das peças e <b>não aparece para o cliente</b>. Na venda, os itens saem do estoque.</p></div>
        <button className="btn primary" onClick={() => setEdit('novo')}>Novo kit</button>
      </div>
      <DataTable rows={db.deliveryKits} rowKey={(k) => k.id} onRowClick={setEdit}
        empty={<Empty title="Nenhum kit cadastrado" text="Cadastre os insumos do kit (ex.: saquinho, cartão) em Materiais e registre a compra; depois monte aqui os modelos de kit." action={<button className="btn primary" onClick={() => setEdit('novo')}>Cadastrar kit</button>} />}
        columns={[
          { key: 'n', header: 'Kit', render: (k) => <><b>{k.name}</b>{k.notes && <div className="muted small">{k.notes}</div>}</>, sort: (k) => k.name },
          { key: 'i', header: 'Itens', render: (k) => [...k.items.map((it) => { const m = db.materials.find((x) => x.id === it.materialId); return `${fmtNum(it.qty)} ${m?.unit ?? ''} ${m ? materialLabel(m) : 'insumo removido'}`; }), ...k.extras.map((e) => e.description)].join(' · ') },
          { key: 'c', header: 'Custo por kit', num: true, render: (k) => { const c = kitUnitCost(db, k); return c.missing.length ? <Badge tone="warning" title={c.missing.join(', ')}>sem preço</Badge> : <b>{fmtBRL(c.total)}</b>; } },
          { key: 's', header: 'Situação', render: (k) => k.active ? <Badge tone="success">ativo</Badge> : <Badge>inativo</Badge> },
          { key: 'a', header: '', render: (k) => <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); remove(k); }}>Excluir</button> },
        ]} />
      {edit && <DeliveryKitForm kit={edit === 'novo' ? undefined : edit} onClose={() => setEdit(null)} />}
      {confirmEl}
    </div>
  );
}

function DeliveryKitForm({ kit, onClose }: { kit?: DeliveryKit; onClose: () => void }) {
  const { db, run } = useStore();
  const [f, set] = useForm({ name: kit?.name ?? '', active: kit?.active ?? true, notes: kit?.notes ?? '' });
  const [items, setItems] = useState(() => kit?.items.map((it) => ({ materialId: it.materialId, qty: toInputBR(it.qty) })) ?? [{ materialId: '', qty: '1' }]);
  const [extras, setExtras] = useState(() => kit?.extras.map((e) => ({ description: e.description, cost: toInputBR(e.cost, 2) })) ?? []);
  const options = db.materials.filter((m) => m.active || items.some((it) => it.materialId === m.id)).map((m) => ({ value: m.id, label: `${m.code} · ${materialLabel(m)} (${m.unit})` }));
  const payload = { name: f.name, active: f.active, notes: f.notes || undefined, items: items.map((it) => ({ materialId: it.materialId, qty: num(it.qty) ?? 0 })), extras: extras.map((e) => ({ description: e.description, cost: dec(e.cost) ?? '' })) };
  let preview: ReturnType<typeof kitUnitCost> | null = null;
  try { preview = kitUnitCost(db, { id: '', createdAt: '', ...payload, items: payload.items.filter((i) => i.materialId && i.qty > 0), extras: payload.extras.filter((e) => e.cost).map((e) => ({ description: e.description, cost: e.cost })) }); } catch { preview = null; }
  const submit = () => run((d) => saveDeliveryKit(d, payload, kit?.id), kit ? 'Kit atualizado.' : 'Kit cadastrado.').then((r) => r.ok && onClose());
  return (
    <Modal wide title={kit ? `Editar kit "${kit.name}"` : 'Novo kit de entrega'} subtitle="Quantidades por kit, na unidade de cada insumo. O custo usa o preço atual (última compra ou referência)." onClose={onClose}
      footer={<><span className="muted" style={{ marginRight: 'auto' }}>Custo por kit: <b>{preview && !preview.missing.length ? fmtBRL(preview.total) : '—'}</b></span><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar kit</button></>}>
      <div className="stack">
        <div className="grid g2">
          <TextField label="Nome do kit" required value={f.name} onChange={set('name')} placeholder="Ex.: Kit presente (saquinho + cartão + adesivo)" />
          <Check label="Kit ativo (aparece nos orçamentos)" checked={f.active} onChange={set('active')} />
        </div>
        <p className="section-title">Itens do estoque</p>
        {items.map((it, i) => (
          <div key={i} className="line-item">
            <Field label="Insumo"><Combobox ariaLabel="Insumo do kit" value={it.materialId} onChange={(v) => setItems((r) => r.map((x, k) => (k === i ? { ...x, materialId: v } : x)))} placeholder="— digite para buscar —" options={options} /></Field>
            <NumField label="Quantidade por kit" value={it.qty} onChange={(v) => setItems((r) => r.map((x, k) => (k === i ? { ...x, qty: v } : x)))} suffix={db.materials.find((m) => m.id === it.materialId)?.unit} />
            <button className="btn ghost sm" onClick={() => setItems((r) => r.filter((_, k) => k !== i))} aria-label="Remover">✕</button>
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setItems((r) => [...r, { materialId: '', qty: '1' }])}>+ Item do estoque</button></div>
        <p className="section-title">Custos sem estoque (opcional)</p>
        {extras.map((e, i) => (
          <div key={i} className="line-item">
            <TextField label="Descrição" value={e.description} onChange={(v) => setExtras((r) => r.map((x, k) => (k === i ? { ...x, description: v } : x)))} placeholder="Ex.: impressão do cartão" />
            <NumField label="Custo por kit" suffix="R$" value={e.cost} onChange={(v) => setExtras((r) => r.map((x, k) => (k === i ? { ...x, cost: v } : x)))} />
            <button className="btn ghost sm" onClick={() => setExtras((r) => r.filter((_, k) => k !== i))} aria-label="Remover">✕</button>
          </div>
        ))}
        <div><button className="btn secondary sm" onClick={() => setExtras((r) => [...r, { description: '', cost: '' }])}>+ Custo sem estoque</button></div>
        {preview && preview.lines.length > 0 && <div className="card"><table className="tbl"><thead><tr><th>Item</th><th className="num">Qtd.</th><th className="num">Custo</th></tr></thead><tbody>
          {preview.lines.map((l, i) => <tr key={i}><td>{l.label}</td><td className="num">{fmtNum(l.qty)} {l.unit}</td><td className="num">{l.cost ? fmtBRL(l.cost, 4) : <Badge tone="warning">sem preço</Badge>}</td></tr>)}
        </tbody></table></div>}
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

/* ---------------- Importação de filamentos ---------------- */
function ImportFilamentsModal({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [text, setText] = useState('');
  const [update, setUpdate] = useState(false);
  const preview = text.trim() ? previewFilamentImport(db, text) : null;
  const rows = preview?.rows ?? [];
  const ok = rows.filter((r) => r.status === 'novo' || (update && r.status === 'existe'));
  const download = () => {
    const url = URL.createObjectURL(new Blob([filamentTemplateCsv()], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'modelo-importacao-filamentos.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (f: File) => setText(await f.text());
  const submit = () => run((d) => importFilaments(d, rows, { updateExisting: update }), 'Importação concluída.')
    .then((r) => { if (r.ok) onClose(); });
  return (
    <Modal wide title="Importar filamentos" subtitle="Cadastre vários filamentos de uma vez a partir de uma planilha (Excel ou Google Planilhas). Pesos sempre em gramas; preço em R$/kg." onClose={onClose}
      footer={<><span className="muted" style={{ marginRight: 'auto' }}>{rows.length ? `${ok.length} para gravar · ${rows.filter((r) => r.status === 'erro').length} com erro` : ''}</span>
        <button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={!ok.length}>Importar {ok.length || ''} filamento(s)</button></>}>
      <div className="stack">
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li><button type="button" className="link-btn" onClick={download}>Baixe o modelo da planilha</button> e preencha uma linha por filamento (cor e tipo diferentes = linhas diferentes).</li>
          <li>Colunas: <b>nome, tipo, cor</b> (obrigatórias), cor_hex (#RRGGBB), marca, fabricante, peso_liquido_g, carretel_vazio_g, preco_kg, estoque_minimo_g, observacoes.</li>
          <li>Escolha o arquivo .csv salvo, ou copie as células no Excel e cole abaixo (com o cabeçalho).</li>
        </ol>
        <div className="row" style={{ gap: 8 }}>
          <label className="btn secondary">Escolher arquivo .csv<input type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} /></label>
          {text && <button type="button" className="btn ghost" onClick={() => setText('')}>Limpar</button>}
        </div>
        <TextArea label="Ou cole aqui as células da planilha" value={text} onChange={setText} />
        {preview && preview.missingColumns.length > 0 && <Alert tone="error" title="Faltam colunas obrigatórias">Não encontrei: {preview.missingColumns.join(', ')}. A primeira linha precisa ser o cabeçalho (use o modelo).</Alert>}
        {rows.some((r) => r.status === 'existe') && <Check label="Atualizar os filamentos já cadastrados com os dados da planilha (preço de referência, pesos, cor, marca)" checked={update} onChange={setUpdate} />}
        {rows.length > 0 && <div className="card"><table className="tbl"><thead><tr><th>Linha</th><th>Filamento</th><th>Marca</th><th className="num">Peso líquido</th><th className="num">Preço</th><th>Situação</th></tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.line}>
              <td className="mono">{r.line}</td>
              <td>{r.colorHex && <i className="swatch" style={{ background: r.colorHex }} />}<b>{r.name || '—'}</b><div className="muted small">{r.materialType} · {r.color}</div></td>
              <td>{r.brand ?? '—'}</td>
              <td className="num">{r.netWeightG ? `${fmtNum(r.netWeightG)} g` : '—'}</td>
              <td className="num">{r.pricePerKg ? `${fmtBRL(r.pricePerKg)}/kg` : '—'}</td>
              <td>{r.status === 'erro' ? <><Badge tone="error">erro</Badge><div className="small err-text">{r.message}</div></>
                : r.status === 'existe' ? <><Badge tone={update ? 'info' : 'neutral'}>{update ? 'vai atualizar' : 'já existe — ignorado'}</Badge><div className="small muted">{r.message}</div></>
                : <Badge tone="success">novo</Badge>}</td>
            </tr>))}
        </tbody></table></div>}
        <p className="small muted" style={{ margin: 0 }}>Marcas e fabricantes que ainda não existem são cadastrados automaticamente. O preço da planilha vira o preço de referência do cadastro (usado nos orçamentos até a primeira compra).</p>
      </div>
    </Modal>
  );
}

/* ---------------- Materiais ---------------- */
function Materiais() {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<Material | 'novo' | null>(null);
  const [view, setView] = useState<Material | null>(null);
  const [copyOf, setCopyOf] = useState<Material | null>(null);
  const [importing, setImporting] = useState(false);
  const [cats, setCats] = useState(false);
  const [cat, setCat] = useState('');
  const rows = db.materials.filter((m) => !cat || m.categoryId === cat);
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>Materiais</h2><p className="muted small">Filamentos e demais insumos. O preço usado no orçamento vem da última compra ou, sem compras, do preço de referência. Saldos ficam em <a href="#/estoque">Estoque → Saldo por insumo</a>.</p></div>
        <div className="row"><button className="btn secondary" onClick={() => setCats(true)}>Categorias</button><button className="btn secondary" onClick={() => setImporting(true)}>Importar filamentos</button><button className="btn primary" onClick={() => setEdit('novo')}>Novo material</button></div>
      </div>
      <DataTable rows={rows} rowKey={(m) => m.id} onRowClick={setView}
        search={(m) => `${m.code} ${m.name} ${materialDesc(db, m)}`}
        toolbar={<Combobox compact ariaLabel="Filtrar por categoria" value={cat} onChange={setCat} placeholder="Todas as categorias" options={db.categories.map((c) => ({ value: c.id, label: c.name }))} />}
        empty={<Empty title="Nenhum material cadastrado" text="Comece pelos filamentos. Informe o preço de referência (R$/kg) para orçar antes da primeira compra." action={<button className="btn primary" onClick={() => setEdit('novo')}>Cadastrar material</button>} />}
        columns={[
          { key: 'c', header: 'Código', render: (m) => <span className="mono">{m.code}</span>, sort: (m) => m.code },
          { key: 'n', header: 'Material', render: (m) => <><b>{m.filament?.colorHex && <i className="swatch" style={{ background: m.filament.colorHex }} />}{m.name}</b><div className="muted small">{materialDesc(db, m)}</div></>, sort: (m) => m.name },
          { key: 'r', header: 'Preço de referência', num: true, render: (m) => m.referenceCost ? priceLabel(m, m.referenceCost) : <span className="muted">—</span> },
          { key: 'p', header: 'Preço nos orçamentos', num: true, render: (m) => { const pol = materialCostPolicy(db, m.id); const warn = unusualUnitCost(m, pol.unitCost); return pol.unitCost ? <><b className={warn ? 'err-text' : ''}>{priceLabel(m, pol.unitCost)}</b><div className="muted small">{pol.source}</div>{warn && <Badge tone="error" title={warn}>custo improvável — corrija a compra</Badge>}</> : <Badge tone="warning">sem preço</Badge>; } },
          { key: 's', header: 'Situação', render: (m) => {
            if (!m.active) return <Badge>inativo</Badge>;
            const r = reorderAnalysis(db, m);
            return r.status === 'falta' ? <Badge tone="error" title={r.note}>comprar já</Badge>
              : r.status === 'repor' ? <Badge tone="warning" title={r.note}>repor</Badge> : <Badge tone="success">ativo</Badge>;
          } },
        ]} />
      {edit && <MaterialForm material={edit === 'novo' ? undefined : edit} onClose={() => setEdit(null)}
        onSave={(v, id) => run((d) => saveMaterial(d, v, id), 'Material salvo.').then((r) => r.ok && setEdit(null))} />}
      {copyOf && <MaterialForm material={copyOf} copy onClose={() => setCopyOf(null)}
        onSave={(v) => run((d) => saveMaterial(d, v), 'Material relançado com cadastro novo.').then((r) => r.ok && setCopyOf(null))} />}
      {view && <MaterialDetail material={view} onClose={() => setView(null)} onEdit={() => { setEdit(view); setView(null); }}
        onRelaunch={(copy) => { setView(null); setCopyOf(copy); }} />}
      {cats && <CategoriesModal onClose={() => setCats(false)} />}
      {importing && <ImportFilamentsModal onClose={() => setImporting(false)} />}
    </div>
  );
}

function MaterialDetail({ material, onClose, onEdit, onRelaunch }: { material: Material; onClose: () => void; onEdit: () => void; onRelaunch: (copy: Material) => void }) {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const m = db.materials.find((x) => x.id === material.id) ?? material;
  const hist = priceHistory(db, m.id);
  const bal = materialBalance(db, m.id);
  const pol = materialCostPolicy(db, m.id);
  const u = materialUsage(db, m.id);
  const deletable = !u.lots && !u.quotes && !u.orders && !u.kits;
  const usage = [u.lots && `${u.lots} lote(s) no estoque${u.purchases ? ` de ${u.purchases} compra(s)` : ''}`, u.quotes && `${u.quotes} orçamento(s)`, u.orders && `${u.orders} produção(ões)`, u.kits && `${u.kits} kit(s)`].filter(Boolean).join(', ');
  const remove = async (again: boolean) => {
    const ok = await confirm({ title: again ? `Excluir "${m.name}" e relançar?` : `Excluir "${m.name}"?`, danger: true, confirmLabel: again ? 'Excluir e relançar' : 'Excluir',
      text: again ? 'O cadastro é apagado e abre um cadastro novo com os mesmos dados para você corrigir.' : 'O cadastro é apagado (fica só na trilha de auditoria).' });
    if (ok === null) return;
    const copy = structuredClone(m);
    const r = await run((d) => deleteMaterial(d, m.id), 'Material excluído.');
    if (r.ok) { if (again) onRelaunch(copy); else onClose(); }
  };
  const inactivateAndRelaunch = async () => {
    const ok = await confirm({ title: `Inativar "${m.name}" e relançar?`, confirmLabel: 'Inativar e relançar',
      text: `Este insumo tem histórico (${usage}), por isso não pode ser apagado. Ele fica inativo (some das listas, o histórico é mantido) e abre um cadastro novo com os mesmos dados. As compras novas devem usar o cadastro novo.` });
    if (ok === null) return;
    const copy = structuredClone(m);
    const r = await run((d) => { const x = d.materials.find((y) => y.id === m.id)!; x.active = false; }, 'Insumo antigo inativado.');
    if (r.ok) onRelaunch(copy);
  };
  return (
    <Modal wide title={`${m.code} · ${m.name}`} subtitle={materialDesc(db, m)} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button>
        {deletable ? <>
          <button className="btn ghost danger-text" onClick={() => remove(false)}>Excluir</button>
          <button className="btn secondary" onClick={() => remove(true)}>Excluir e relançar</button>
        </> : <button className="btn secondary" onClick={inactivateAndRelaunch} disabled={!m.active} title={m.active ? undefined : 'Já está inativo'}>Inativar e relançar</button>}
        <button className="btn secondary" onClick={() => navigate('estoque')}>Ver no estoque</button><button className="btn primary" onClick={onEdit}>Editar cadastro</button></>}>
      <div className="stack">
        {!deletable && <Alert tone="info" title="Este insumo tem histórico">
          {usage}. Para apagar o cadastro, primeiro exclua as compras ou estoques lançados por engano (<a href="#/compras" onClick={onClose}>Compras</a> → abrir a compra → <b>Excluir e relançar</b>).
          Se o problema é só no cadastro (nome, cor, preço de referência), use <b>Editar cadastro</b>.
        </Alert>}
        <div className="kpis">
          <div className="card kpi accent"><p className="l">Preço nos orçamentos</p><p className="v">{priceLabel(m, pol.unitCost) ?? '—'}</p><p className="h">{pol.source}</p></div>
          <div className="card kpi"><p className="l">Disponível</p><p className="v">{fmtNum(bal.available)} {m.unit}</p><p className="h">{fmtNum(bal.reserved)} reservado</p></div>
          <div className="card kpi"><p className="l">Valor em estoque</p><p className="v">{fmtBRL(bal.value)}</p><p className="h">custo histórico por lote</p></div>
        </div>
        <h3>Compras e histórico de custo</h3>
        <div className="card">
          <DataTable rows={[...hist].reverse()} rowKey={(h) => h.lot.id}
            empty={<Empty title="Sem compras" text="Registre uma compra (menu Compras) ou um estoque inicial (menu Estoque)." />}
            columns={[
              { key: 'l', header: 'Lote', render: (h) => <span className="mono">{h.lot.code}</span> },
              { key: 'd', header: 'Data', render: (h) => fmtDate(h.lot.date) },
              { key: 's', header: 'Fornecedor', render: (h) => h.supplier ?? '—' },
              { key: 'q', header: 'Qtd. inicial', num: true, render: (h) => `${fmtNum(h.lot.initialQty)} ${m.unit}` },
              { key: 'b', header: 'Saldo', num: true, render: (h) => `${fmtNum(lotBalance(db, h.lot.id).physical)} ${m.unit}` },
              { key: 'c', header: 'Custo', num: true, render: (h) => <b>{priceLabel(m, h.unitCost)}</b> },
            ]} />
        </div>
        {m.notes && <p className="muted">{m.notes}</p>}
      </div>
      {confirmEl}
    </Modal>
  );
}

/**
 * Custo de cada compra/estoque do insumo, corrigível aqui mesmo. Com compras registradas,
 * o orçamento usa o custo da última compra — por isso corrigir só o preço do cadastro não basta.
 */
function MaterialLotCosts({ material }: { material: Material }) {
  const { db, run } = useStore();
  const lots = db.lots.filter((l) => l.materialId === material.id).sort((a, b) => (b.date + b.code).localeCompare(a.date + a.code));
  const [edit, setEdit] = useState<{ lotId: string; qty: string; unit: string; price: string } | null>(null);
  const pol = materialCostPolicy(db, material.id);
  if (!lots.length) return null;
  const grams = material.unit === 'g';
  const perUnit = (v: Decimal.Value) => (grams ? `${fmtBRL(perGramToPerKg(v))}/kg` : `${fmtBRL(v, 4)}/${material.unit}`);
  const start = (lotId: string) => {
    const l = lots.find((x) => x.id === lotId)!;
    const it = db.purchases.find((p) => p.id === l.purchaseId)?.items.find((i) => i.lotId === l.id);
    const goods = it?.price ?? D(l.unitCost).times(l.initialQty).toDecimalPlaces(2).toString();
    // Filamento: sempre em gramas. Outros insumos em gramas: digitados em kg.
    const inKg = grams && !material.filament;
    setEdit({ lotId, qty: toInputBR(inKg ? l.initialQty / 1000 : l.initialQty), unit: inKg ? 'kg' : material.unit, price: toInputBR(goods, 2) });
  };
  const qtyStock = edit ? (num(edit.qty) ?? 0) * (edit.unit === 'kg' ? 1000 : edit.unit === 'carretel' ? (material.filament?.netWeightG ?? 0) : 1) : 0;
  const prevCost = edit && qtyStock > 0 && parseBR(edit.price) ? parseBR(edit.price)!.div(qtyStock) : null;
  const save = () => edit && run((d) => correctLot(d, edit.lotId, { qty: qtyStock, price: dec(edit.price) ?? '0' }), 'Custo corrigido: estoque, compra e financeiro recalculados.').then((r) => r.ok && setEdit(null));
  return (
    <div className="stack">
      <p className="section-title">Custo das compras deste insumo</p>
      <p className="small muted" style={{ margin: 0 }}>Preço usado hoje nos orçamentos: <b>{pol.unitCost ? perUnit(pol.unitCost) : '—'}</b> ({pol.source}).
        Se o custo de uma compra está errado, corrija aqui (quantidade recebida e valor pago). Orçamentos já salvos mostram o aviso “os custos mudaram” para você atualizar.</p>
      <div className="card"><table className="tbl"><thead><tr><th>Lote</th><th>Origem</th><th>Data</th><th className="num">Recebido</th><th className="num">Custo</th><th /></tr></thead><tbody>
        {lots.map((l) => {
          const p = db.purchases.find((x) => x.id === l.purchaseId);
          const warn = unusualUnitCost(material, l.unitCost);
          const block = p ? purchaseEditBlock(db, p) : null;
          return (
            <tr key={l.id}>
              <td className="mono">{l.code}</td>
              <td>{p ? `Compra ${p.number}` : 'Estoque inicial'}</td>
              <td>{fmtDate(l.date)}</td>
              <td className="num">{fmtNum(l.initialQty)} {material.unit}</td>
              <td className="num"><b className={warn ? 'err-text' : ''}>{perUnit(l.unitCost)}</b>{warn && <div className="small err-text">custo improvável</div>}</td>
              <td className="right">{block ? <span className="small muted" title={block}>bloqueado</span> : <button type="button" className="btn ghost sm" onClick={() => start(l.id)}>Corrigir</button>}</td>
            </tr>);
        })}
      </tbody></table></div>
      {edit && <div className="card"><div className="card-body stack">
        <b>Corrigir lote {lots.find((l) => l.id === edit.lotId)?.code}</b>
        <div className="grid g3" style={{ alignItems: 'end' }}>
          <div className="row" style={{ alignItems: 'end', flexWrap: 'nowrap', gap: 8 }}>
            <NumField label={material.filament ? 'Quantidade recebida (g)' : 'Quantidade recebida'} value={edit.qty} onChange={(v) => setEdit({ ...edit, qty: v })} suffix={material.filament ? 'g' : undefined}
              hint={material.filament ? `${fmtNum(qtyStock)} g = ${fmtNum(qtyStock / 1000, 3)} kg${material.filament.netWeightG ? ` = ${fmtNum(qtyStock / material.filament.netWeightG, 2)} carretel(is)` : ''}` : undefined} />
            {grams && !material.filament && <div className="field" style={{ width: 150, flexShrink: 0 }}><Combobox ariaLabel="Unidade" value={edit.unit} onChange={(v) => v && setEdit({ ...edit, unit: v })}
              options={[{ value: 'kg', label: 'kg (quilos)' }, { value: 'g', label: 'g (gramas)' }]} /></div>}
          </div>
          <NumField label="Valor pago pela mercadoria" suffix="R$" value={edit.price} onChange={(v) => setEdit({ ...edit, price: v })} hint="Sem frete (o frete da compra é rateado automaticamente)" />
          <Field label="Novo custo (sem frete)"><div className="readonly-value">{prevCost ? perUnit(prevCost) : '—'}</div></Field>
        </div>
        {prevCost && unusualUnitCost(material, prevCost) && <Alert tone="error" title="Ainda parece errado">{unusualUnitCost(material, prevCost)}</Alert>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn ghost" onClick={() => setEdit(null)}>Cancelar</button><button type="button" className="btn primary" onClick={save}>Salvar correção do custo</button></div>
      </div></div>}
    </div>
  );
}

export function MaterialForm({ material, copy, onClose, onSave }: { material?: Material; copy?: boolean; onClose: () => void; onSave: (v: Parameters<typeof saveMaterial>[1], id?: string) => void }) {
  const { db } = useStore();
  const fil = material?.filament;
  // Tudo que é controlado em gramas tem o preço digitado em R$/kg (gravado em R$/g).
  const initialInGrams = material ? material.unit === 'g' : true;
  const [f, set] = useForm({
    // Relançar (copy): mesmos dados num cadastro novo, com código novo.
    code: copy ? '' : material?.code ?? '', name: material?.name ?? '', categoryId: material?.categoryId ?? db.categories.find((c) => c.isFilament)?.id ?? '',
    // Filamento é sempre em gramas; para os demais insumos o padrão é unidade.
    unit: material?.unit ?? 'un', active: material?.active ?? true, brandId: material?.brandId ?? '', manufacturerId: material?.manufacturerId ?? '',
    materialType: fil?.materialType ?? 'PLA', color: fil?.color ?? '', colorHex: fil?.colorHex ?? '#0d1925',
    netWeightG: toInputBR(fil?.netWeightG ?? null), spoolWeightG: toInputBR(fil?.spoolWeightG ?? null),
    referencePrice: material?.referenceCost ? toInputBR(initialInGrams ? perGramToPerKg(material.referenceCost) : material.referenceCost, 4) : '',
    minStock: toInputBR(material?.minStock ?? null), leadTimeDays: toInputBR(material?.leadTimeDays ?? null), location: material?.location ?? '', notes: material?.notes ?? '',
    costSource: (material?.costSource ?? 'compra') as 'compra' | 'cadastro',
  });
  const selCat = db.categories.find((c) => c.id === f.categoryId);
  const isFil = selCat?.isFilament ?? false;
  const inGrams = isFil || f.unit === 'g';
  const refValue = parseBR(f.referencePrice);
  const refSuspicious = inGrams && refValue && (refValue.gt(1000) || refValue.lt(5));
  const submit = () => {
    const ref = dec(f.referencePrice);
    onSave({
      code: f.code, name: f.name, categoryId: f.categoryId, unit: isFil ? 'g' : (f.unit as Unit), active: f.active,
      brandId: f.brandId || undefined, manufacturerId: f.manufacturerId || undefined,
      filament: isFil ? { materialType: f.materialType, color: f.color, colorHex: f.colorHex,
        netWeightG: num(f.netWeightG), spoolWeightG: num(f.spoolWeightG), grossWeightG: material?.filament?.grossWeightG ?? null, diameterMm: material?.filament?.diameterMm ?? null } : undefined,
      referenceCost: ref === null ? null : inGrams ? perKgToPerGram(ref).toString() : ref,
      minStock: num(f.minStock), safetyStock: material?.safetyStock ?? null, leadTimeDays: num(f.leadTimeDays), location: f.location, notes: f.notes,
      costSource: copy ? undefined : f.costSource,
    }, copy ? undefined : material?.id);
  };
  const unitLabel = isFil ? 'g' : f.unit;
  return (
    <Modal wide title={copy ? 'Relançar material (novo cadastro)' : material ? 'Editar material' : 'Novo material'} subtitle={copy ? 'Dados copiados do cadastro anterior. Corrija o que estava errado e salve: será criado um cadastro novo, com código novo.' : undefined} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar material</button></>}>
      <div className="stack">
        <div className="grid g3">
          <SelectField label="Categoria" required value={f.categoryId} onChange={set('categoryId')} options={db.categories.filter((c) => c.active || c.id === f.categoryId).map((c) => ({ value: c.id, label: c.name }))} />
          <TextField label="Nome / descrição" required value={f.name} onChange={set('name')} placeholder={isFil ? 'Ex.: PLA Preto Fosco Marca X' : 'Ex.: Caixa kraft 15×15×10'} />
          <TextField label="Código interno" value={f.code} onChange={set('code')} placeholder={!material && selCat ? nextMaterialCode(db, selCat) : undefined}
            hint={material ? 'Código do cadastro' : selCat ? `Vazio = ${nextMaterialCode(db, selCat)} (sigla ${selCat.code ?? ''} + sequência)` : 'Vazio = gerado pela sigla da categoria'} />
          <SelectField label="Marca" value={f.brandId} onChange={set('brandId')} placeholder="— digite para buscar —" options={namedOptions(db.brands, f.brandId)}
            hint={db.brands.length === 0 ? <a href="#/cadastros/marcas">Cadastre as marcas</a> : undefined} />
          <SelectField label="Fabricante" value={f.manufacturerId} onChange={set('manufacturerId')} placeholder="— digite para buscar —" options={namedOptions(db.manufacturers, f.manufacturerId)}
            hint={db.manufacturers.length === 0 ? <a href="#/cadastros/fabricantes">Cadastre os fabricantes</a> : undefined} />
        </div>
        {isFil ? (
          <div className="grid g4">
            <SelectField label="Tipo de material" required value={f.materialType} onChange={set('materialType')} options={FILAMENT_TYPES.map((t) => ({ value: t, label: t }))} />
            <TextField label="Cor" required value={f.color} onChange={set('color')} />
            <div className="field"><label>Cor (amostra)</label><input type="color" value={f.colorHex} onChange={(e) => set('colorHex')(e.target.value)} /></div>
            <NumField label="Preço do filamento" suffix="R$/kg" value={f.referencePrice} onChange={set('referencePrice')} hint={f.costSource === 'cadastro' ? 'Usado em todos os orçamentos (opção marcada abaixo).' : 'Usado nos orçamentos até existir compra registrada; depois vale o custo da última compra (corrija abaixo).'} />
            <NumField label="Peso líquido do carretel" suffix="g" value={f.netWeightG} onChange={set('netWeightG')} />
            <NumField label="Carretel vazio" suffix="g" value={f.spoolWeightG} onChange={set('spoolWeightG')} hint="Permite pesar o carretel no inventário" />
          </div>
        ) : (
          <div className="grid g3">
            <SelectField label="Unidade de controle" value={f.unit} onChange={(v) => set('unit')(v as Unit)} options={(Object.keys(UNIT_LABEL) as Unit[]).map((u) => ({ value: u, label: UNIT_LABEL[u] }))} hint="Não pode ser alterada após existirem compras." />
            <NumField label="Preço de referência" suffix={inGrams ? 'R$/kg' : `R$/${f.unit}`} value={f.referencePrice} onChange={set('referencePrice')}
              hint={inGrams ? 'Preço por quilo (ex.: pacote de 1 kg por R$ 73,58 → 73,58). Usado enquanto não houver compra registrada.' : `Preço por ${UNIT_LABEL[f.unit as Unit]?.toLowerCase() ?? f.unit} (ex.: pacote com 100 por R$ 30 → 0,30). Usado enquanto não houver compra registrada.`} />
            <TextField label="Localização" value={f.location} onChange={set('location')} />
          </div>
        )}
        {material && !copy && <Check label={<>Usar <b>este preço do cadastro</b> nos orçamentos (em vez do custo da última compra)</>} checked={f.costSource === 'cadastro'} onChange={(v) => set('costSource')(v ? 'cadastro' : 'compra')} />}
        {refSuspicious && <Alert tone="warning" title="Confira o preço">R$ {f.referencePrice}/kg está fora do normal para material controlado em gramas (em geral R$ 20 a R$ 300/kg). O campo é o preço por <b>quilo</b>.</Alert>}
        <div className="grid g3">
          <NumField label="Estoque mínimo" suffix={unitLabel} value={f.minStock} onChange={set('minStock')} />
          <NumField label="Prazo de reposição" suffix="dias" value={f.leadTimeDays} onChange={set('leadTimeDays')} />
        </div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
        <Check label="Cadastro ativo" checked={f.active} onChange={set('active')} />
        {material && !copy && <MaterialLotCosts material={material} />}
      </div>
    </Modal>
  );
}

function CategoriesModal({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [cat, setCat] = useState<Category | 'nova' | null>(null);
  return (
    <Modal title="Categorias de materiais" subtitle="Categorias marcadas como filamento são controladas em gramas e aparecem no orçamento." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button><button className="btn primary" onClick={() => setCat('nova')}>Nova categoria</button></>}>
      <div className="card">
        <DataTable rows={db.categories} rowKey={(c) => c.id} onRowClick={setCat} empty={null}
          columns={[
            { key: 'n', header: 'Categoria', render: (c) => <>{c.name} {!c.active && <Badge>inativa</Badge>}</>, sort: (c) => c.name },
            { key: 's', header: 'Sigla', render: (c) => <span className="mono">{c.code ?? '—'}</span>, sort: (c) => c.code ?? '' },
            { key: 'f', header: 'Tipo', render: (c) => c.isFilament ? <Badge tone="primary">filamento</Badge> : 'insumo geral' },
            { key: 'q', header: 'Materiais', num: true, render: (c) => db.materials.filter((m) => m.categoryId === c.id).length },
          ]} />
      </div>
      {cat && <CategoryForm item={cat === 'nova' ? undefined : cat} onClose={() => setCat(null)} onSave={(v, id) => run((d) => saveCategory(d, v, id), 'Categoria salva.').then((r) => r.ok && setCat(null))} />}
    </Modal>
  );
}

function CategoryForm({ item, onClose, onSave }: { item?: Category; onClose: () => void; onSave: (v: Omit<Category, 'id'>, id?: string) => void }) {
  const { db } = useStore();
  const [f, set] = useForm({ name: item?.name ?? '', code: item?.code ?? '', isFilament: item?.isFilament ?? false, active: item?.active ?? true });
  const sigla = normalizeSigla(f.code) || (f.name.trim() ? suggestSigla(db, f.name, item?.id) : '');
  return (
    <Modal title={item ? 'Editar categoria' : 'Nova categoria'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave({ ...f, code: f.code || undefined }, item?.id)}>Salvar</button></>}>
      <div className="stack">
        <TextField label="Nome" required value={f.name} onChange={set('name')} />
        <TextField label="Sigla" value={f.code} onChange={(v) => set('code')(normalizeSigla(v))} placeholder={sigla || 'Ex.: FL'}
          hint={sigla ? `Códigos dos insumos desta categoria: ${sigla}00001, ${sigla}00002… Vazio = ${suggestSigla(db, f.name || 'Insumo', item?.id)}.` : 'De 2 a 4 letras. Usada no código automático dos insumos.'} />
        <Check label="É filamento (material de impressão, controlado em gramas)" checked={f.isFilament} onChange={set('isFilament')} />
        <Check label="Ativa" checked={f.active} onChange={set('active')} />
      </div>
    </Modal>
  );
}

/* ---------------- Clientes e fornecedores ---------------- */
function Parties({ kind }: { kind: Party['kind'] }) {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<Party | 'novo' | null>(null);
  const [source, setSource] = useState('');
  const label = kind === 'cliente' ? 'cliente' : 'fornecedor';
  const isClient = kind === 'cliente';
  const rows = db.parties.filter((p) => p.kind === kind && (!source || p.sourceId === source));
  const sourceName = (id?: string) => db.leadSources.find((s) => s.id === id)?.name;
  const count = (p: Party) => isClient
    ? `${db.quotes.filter((q) => q.customerId === p.id).length} orçamento(s) · ${db.sales.filter((s) => s.customerId === p.id && s.status === 'ativa').length} venda(s)`
    : `${db.purchases.filter((x) => x.supplierId === p.id && x.status === 'ativa').length} compra(s)`;
  return (
    <div className="card">
      <div className="card-head"><h2>{isClient ? 'Clientes' : 'Fornecedores'}</h2><button className="btn primary" onClick={() => setEdit('novo')}>Novo {label}</button></div>
      <DataTable rows={rows} rowKey={(p) => p.id} onRowClick={setEdit} search={(p) => `${p.name} ${p.document ?? ''} ${p.phone ?? ''} ${p.address ?? ''} ${p.contact ?? ''}`}
        toolbar={isClient ? <Combobox compact ariaLabel="Filtrar por fonte de captação" value={source} onChange={setSource} placeholder="Todas as fontes" options={db.leadSources.map((s) => ({ value: s.id, label: s.name }))} /> : undefined}
        empty={<Empty title={`Nenhum ${label} cadastrado`} text={isClient ? 'Clientes aparecem nos orçamentos e nas vendas.' : 'Fornecedores aparecem nas compras.'} action={<button className="btn primary" onClick={() => setEdit('novo')}>Cadastrar {label}</button>} />}
        columns={[
          { key: 'n', header: 'Nome', render: (p) => <b>{p.name}</b>, sort: (p) => p.name.toLowerCase() },
          { key: 't', header: 'Telefone', render: (p) => <span className="nowrap">{p.phone ? fmtPhone(p.phone) : p.contact || '—'}</span> },
          { key: 'd', header: 'CPF/CNPJ', render: (p) => <span className="nowrap">{p.document ? fmtDocument(p.document) : '—'}</span> },
          ...(isClient ? [{ key: 'f', header: 'Fonte', render: (p: Party) => sourceName(p.sourceId) ?? '—', sort: (p: Party) => sourceName(p.sourceId) ?? '' }] : []),
          { key: 'e', header: 'Endereço', render: (p) => <span className="small">{p.address || '—'}</span> },
          { key: 'h', header: 'Histórico', render: (p) => <span className="muted small">{count(p)}</span> },
        ]} />
      {edit && <PartyForm item={edit === 'novo' ? undefined : edit} kind={kind} onClose={() => setEdit(null)}
        onSave={(v, id) => run((d) => saveParty(d, v, id), 'Cadastro salvo.').then((r) => r.ok && setEdit(null))} />}
    </div>
  );
}

/** Cadastro de cliente ou fornecedor — só o nome é obrigatório; endereço com busca por CEP. */
export function PartyForm({ item, kind, onClose, onSave }: { item?: Party; kind: Party['kind']; onClose: () => void; onSave: (v: Omit<Party, 'id'>, id?: string) => void }) {
  const { db } = useStore();
  const isClient = kind === 'cliente';
  const [f, set] = useForm({
    name: item?.name ?? '', phone: item?.phone ? fmtPhone(item.phone) : (item?.contact ?? ''),
    document: item?.document ? fmtDocument(item.document) : '', sourceId: item?.sourceId ?? '', notes: item?.notes ?? '',
  });
  const [addr, setAddr] = useState<AddressParts>(item?.addressParts ?? {});
  const legacyAddress = !item?.addressParts && item?.address ? item.address : null;
  const submit = () => onSave({ kind, name: f.name, addressParts: addr, address: legacyAddress ?? undefined, phone: f.phone, document: f.document, sourceId: f.sourceId || undefined, notes: f.notes, contact: item?.contact }, item?.id);
  return (
    <Modal wide title={item ? `Editar ${kind}` : isClient ? 'Novo cliente' : 'Novo fornecedor'} subtitle="Só o nome é obrigatório; preencha o que tiver." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></>}>
      <div className="stack">
        <div className="grid g2">
          <TextField label={isClient ? 'Nome completo' : 'Nome / razão social'} required value={f.name} onChange={set('name')} autoFocus />
          <TextField label="Telefone" value={f.phone} onChange={set('phone')} placeholder="(11) 98765-4321" type="tel" />
          <TextField label="CPF/CNPJ" value={f.document} onChange={set('document')} placeholder="000.000.000-00" hint="Opcional. Se preenchido, é validado." />
          {isClient && <SelectField label="Fonte de captação" value={f.sourceId} onChange={set('sourceId')} placeholder="— digite para buscar —"
            options={namedOptions(db.leadSources, f.sourceId)} hint={<>Como o cliente chegou até você. <a href="#/parametros/fontes" onClick={onClose}>Gerenciar fontes</a></>} />}
        </div>
        <AddressFields value={addr} onChange={setAddr} />
        {legacyAddress && <small className="muted">Endereço anterior (texto livre): {legacyAddress}. Ao preencher os campos acima, ele é substituído.</small>}
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

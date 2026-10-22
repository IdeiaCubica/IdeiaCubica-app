import { useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { AddressParts, Category, DB, Material, NamedItem, Party, Unit } from '../../domain/types';
import { AddressFields } from '../components/AddressFields';
import { deleteNamed, namedUsage, nextMaterialCode, normalizeSigla, priceHistory, saveCategory, saveMaterial, saveNamed, saveParty, suggestSigla, type NamedList } from '../../domain/catalog';
import { lotBalance, materialBalance, reorderAnalysis } from '../../domain/inventory';
import { materialCostPolicy } from '../../domain/quotes';
import { UNIT_LABEL, fmtDate, fmtDocument, fmtPhone } from '../../domain/core';
import { Decimal, fmtBRL, fmtNum, parseBR, toInputBR } from '../../domain/money';
import { perGramToPerKg, perKgToPerGram } from '../../domain/conversions';
import { Alert, Badge, Check, Combobox, DataTable, Empty, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, dec, num, useConfirm, useForm } from '../components/ui';

type Tab = 'materiais' | 'clientes' | 'fornecedores' | 'marcas' | 'fabricantes';
export const FILAMENT_TYPES = ['PLA', 'PLA Silk', 'PLA Matte', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'Nylon', 'Outro'];

export function Cadastros({ param }: { param?: string }) {
  const { db } = useStore();
  const tab = (param as Tab) || 'materiais';
  return (
    <>
      <PageHead eyebrow="Cadastros" title="Cadastros" text="Materiais, clientes, fornecedores, marcas e fabricantes usados em orçamentos, compras, produção e vendas." />
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`cadastros/${t}`)} tabs={[
        { id: 'materiais', label: 'Materiais', count: db.materials.length },
        { id: 'clientes', label: 'Clientes', count: db.parties.filter((p) => p.kind === 'cliente').length },
        { id: 'fornecedores', label: 'Fornecedores', count: db.parties.filter((p) => p.kind === 'fornecedor').length },
        { id: 'marcas', label: 'Marcas', count: db.brands.length },
        { id: 'fabricantes', label: 'Fabricantes', count: db.manufacturers.length },
      ]} />
      {tab === 'materiais' && <Materiais />}
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

/* ---------------- Materiais ---------------- */
function Materiais() {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<Material | 'novo' | null>(null);
  const [view, setView] = useState<Material | null>(null);
  const [cats, setCats] = useState(false);
  const [cat, setCat] = useState('');
  const rows = db.materials.filter((m) => !cat || m.categoryId === cat);
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>Materiais</h2><p className="muted small">Filamentos e demais insumos. O preço usado no orçamento vem da última compra ou, sem compras, do preço de referência.</p></div>
        <div className="row"><button className="btn secondary" onClick={() => setCats(true)}>Categorias</button><button className="btn primary" onClick={() => setEdit('novo')}>Novo material</button></div>
      </div>
      <DataTable rows={rows} rowKey={(m) => m.id} onRowClick={setView}
        search={(m) => `${m.code} ${m.name} ${materialDesc(db, m)}`}
        toolbar={<Combobox compact ariaLabel="Filtrar por categoria" value={cat} onChange={setCat} placeholder="Todas as categorias" options={db.categories.map((c) => ({ value: c.id, label: c.name }))} />}
        empty={<Empty title="Nenhum material cadastrado" text="Comece pelos filamentos. Informe o preço de referência (R$/kg) para orçar antes da primeira compra." action={<button className="btn primary" onClick={() => setEdit('novo')}>Cadastrar material</button>} />}
        columns={[
          { key: 'c', header: 'Código', render: (m) => <span className="mono">{m.code}</span>, sort: (m) => m.code },
          { key: 'n', header: 'Material', render: (m) => <><b>{m.filament?.colorHex && <i className="swatch" style={{ background: m.filament.colorHex }} />}{m.name}</b><div className="muted small">{materialDesc(db, m)}</div></>, sort: (m) => m.name },
          { key: 'p', header: 'Preço nos orçamentos', num: true, render: (m) => { const pol = materialCostPolicy(db, m.id); return pol.unitCost ? <><b>{priceLabel(m, pol.unitCost)}</b><div className="muted small">{pol.source}</div></> : <Badge tone="warning">sem preço</Badge>; } },
          { key: 'f', header: 'Estoque disponível', num: true, render: (m) => { const b = materialBalance(db, m.id); const low = m.minStock !== null && m.minStock !== undefined && b.available.lt(m.minStock); return <span style={{ color: low ? 'var(--error)' : undefined }}>{fmtNum(b.available)} {m.unit}</span>; } },
          { key: 's', header: 'Situação', render: (m) => {
            if (!m.active) return <Badge>inativo</Badge>;
            const r = reorderAnalysis(db, m);
            return r.status === 'falta' ? <Badge tone="error" title={r.note}>comprar já</Badge>
              : r.status === 'repor' ? <Badge tone="warning" title={r.note}>repor</Badge> : <Badge tone="success">ativo</Badge>;
          } },
        ]} />
      {edit && <MaterialForm material={edit === 'novo' ? undefined : edit} onClose={() => setEdit(null)}
        onSave={(v, id) => run((d) => saveMaterial(d, v, id), 'Material salvo.').then((r) => r.ok && setEdit(null))} />}
      {view && <MaterialDetail material={view} onClose={() => setView(null)} onEdit={() => { setEdit(view); setView(null); }} />}
      {cats && <CategoriesModal onClose={() => setCats(false)} />}
    </div>
  );
}

function MaterialDetail({ material, onClose, onEdit }: { material: Material; onClose: () => void; onEdit: () => void }) {
  const { db } = useStore();
  const m = db.materials.find((x) => x.id === material.id) ?? material;
  const hist = priceHistory(db, m.id);
  const bal = materialBalance(db, m.id);
  const pol = materialCostPolicy(db, m.id);
  return (
    <Modal wide title={`${m.code} · ${m.name}`} subtitle={materialDesc(db, m)} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button><button className="btn secondary" onClick={() => navigate('estoque')}>Ver no estoque</button><button className="btn primary" onClick={onEdit}>Editar cadastro</button></>}>
      <div className="stack">
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
    </Modal>
  );
}

export function MaterialForm({ material, onClose, onSave }: { material?: Material; onClose: () => void; onSave: (v: Parameters<typeof saveMaterial>[1], id?: string) => void }) {
  const { db } = useStore();
  const fil = material?.filament;
  // Tudo que é controlado em gramas tem o preço digitado em R$/kg (gravado em R$/g).
  const initialInGrams = material ? material.unit === 'g' : true;
  const [f, set] = useForm({
    code: material?.code ?? '', name: material?.name ?? '', categoryId: material?.categoryId ?? db.categories.find((c) => c.isFilament)?.id ?? '',
    // Filamento é sempre em gramas; para os demais insumos o padrão é unidade.
    unit: material?.unit ?? 'un', active: material?.active ?? true, brandId: material?.brandId ?? '', manufacturerId: material?.manufacturerId ?? '',
    materialType: fil?.materialType ?? 'PLA', color: fil?.color ?? '', colorHex: fil?.colorHex ?? '#0d1925',
    netWeightG: toInputBR(fil?.netWeightG ?? null), spoolWeightG: toInputBR(fil?.spoolWeightG ?? null),
    referencePrice: material?.referenceCost ? toInputBR(initialInGrams ? perGramToPerKg(material.referenceCost) : material.referenceCost, 4) : '',
    minStock: toInputBR(material?.minStock ?? null), leadTimeDays: toInputBR(material?.leadTimeDays ?? null), location: material?.location ?? '', notes: material?.notes ?? '',
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
    }, material?.id);
  };
  const unitLabel = isFil ? 'g' : f.unit;
  return (
    <Modal wide title={material ? 'Editar material' : 'Novo material'} onClose={onClose}
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
            <NumField label="Preço do filamento" suffix="R$/kg" value={f.referencePrice} onChange={set('referencePrice')} hint="Usado nos orçamentos até existir compra registrada; depois vale o custo da última compra." />
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
        {refSuspicious && <Alert tone="warning" title="Confira o preço">R$ {f.referencePrice}/kg está fora do normal para material controlado em gramas (em geral R$ 20 a R$ 300/kg). O campo é o preço por <b>quilo</b>.</Alert>}
        <div className="grid g3">
          <NumField label="Estoque mínimo" suffix={unitLabel} value={f.minStock} onChange={set('minStock')} />
          <NumField label="Prazo de reposição" suffix="dias" value={f.leadTimeDays} onChange={set('leadTimeDays')} />
        </div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
        <Check label="Cadastro ativo" checked={f.active} onChange={set('active')} />
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

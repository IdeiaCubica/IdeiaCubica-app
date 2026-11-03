/**
 * Editor do catálogo: produtos, kits, seções/banners, aparência e contato, com pré-visualização
 * ao vivo (celular ou computador). Grava sozinho alguns instantes depois de cada alteração.
 * Nada aqui altera orçamentos ou peças: os produtos do catálogo são cópias.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { CatalogBanner, CatalogDoc, CatalogKit, CatalogProduct, CatalogRecord, SectionEntry } from '../../domain/catalogo';
import { productCandidates, productFromCandidate, type ProductCandidate } from '../../domain/catalogoFontes';
import {
  BADGES, SECTION_PRESETS, addProducts, addSection, catalogStatus, discountOf, kitReferencePrice, moveEntry, moveEntryToSection, moveSection,
  publicSnapshot, removeKit, removeProduct, removeSection, saveKit, updateProduct,
} from '../../domain/catalogo';
import { themeOf, type ThemeId } from '../../domain/catalogThemes';
import { fmtBRL, fmtPct } from '../../domain/money';
import { catalogRepository } from '../../data/catalogRepo';
import { Alert, Badge, Check, DateField, Empty, Field, Modal, NumField, SelectField, Tabs, TextArea, TextField, dec, useConfirm } from '../components/ui';
import { ImagePicker } from '../components/ImagePicker';
import { CatalogView } from './CatalogView';
import { PublishDialog, ShareDialog } from './PublishDialogs';
import { STATUS_LABEL, ThemePicker } from '../pages/Catalogo';

type Tab = 'produtos' | 'kits' | 'secoes' | 'aparencia' | 'loja';
const br = (v: string | null | undefined) => (v ? v.replace('.', ',') : '');

export function CatalogEditor({ id }: { id: string }) {
  const { toast } = useStore();
  const repo = catalogRepository();
  const [rec, setRec] = useState<CatalogRecord | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('produtos');
  const [device, setDevice] = useState<'celular' | 'computador'>('celular');
  const [save, setSave] = useState<'salvo' | 'pendente' | 'salvando' | 'erro'>('salvo');
  const [publishing, setPublishing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const dirty = useRef(false);

  const load = () => repo.get(id).then(setRec).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setRec(null); });
  useEffect(() => { load(); }, [id]);

  // Gravação automática ~1 s depois da última alteração.
  useEffect(() => {
    if (!rec || !dirty.current) return;
    setSave('pendente');
    const t = setTimeout(() => {
      setSave('salvando');
      repo.save(rec).then(() => { dirty.current = false; setSave('salvo'); }).catch((e) => { setSave('erro'); toast('error', e instanceof Error ? e.message : String(e)); });
    }, 1000);
    return () => clearTimeout(t);
  }, [rec]);

  /** Altera uma cópia do catálogo; regra quebrada vira aviso e nada muda. */
  const edit = (fn: (draft: CatalogRecord) => void) => {
    if (!rec) return false;
    const draft = structuredClone(rec);
    try { fn(draft); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); return false; }
    dirty.current = true;
    setRec(draft);
    return true;
  };
  const doc = (fn: (d: CatalogDoc) => void) => edit((r) => fn(r.data));
  const preview = useMemo(() => (rec ? publicSnapshot(rec) : null), [rec]);

  if (rec === undefined) return <p className="muted">Carregando catálogo…</p>;
  if (!rec) return <Empty title="Catálogo não encontrado" text={error ?? undefined} action={<button className="btn secondary" onClick={() => navigate('catalogo')}>Voltar</button>} />;
  const st = catalogStatus(rec);
  const flush = async () => { if (dirty.current) { await repo.save(rec); dirty.current = false; setSave('salvo'); } };

  return (
    <>
      <div className="page-head cat-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <p className="eyebrow">Catálogo · {themeOf(rec.theme).name}</p>
          <input className="cat-title-input" value={rec.name} aria-label="Nome do catálogo" maxLength={120} onChange={(e) => edit((r) => { r.name = e.target.value; })} onBlur={(e) => { if (!e.target.value.trim()) edit((r) => { r.name = 'Catálogo sem nome'; }); }} />
        </div>
        <div className="row">
          <Badge tone={STATUS_LABEL[st].tone}>{STATUS_LABEL[st].label}</Badge>
          <span className="small muted" aria-live="polite">{save === 'salvo' ? 'Tudo salvo' : save === 'salvando' ? 'Salvando…' : save === 'erro' ? 'Erro ao salvar' : 'Alterações não salvas…'}</span>
          <button className="btn ghost" onClick={async () => { await flush(); navigate('catalogo'); }}>Voltar</button>
          {st === 'publicado' && <button className="btn secondary" onClick={async () => { await flush(); setSharing(true); }}>Link e compartilhar</button>}
          <button className="btn primary" onClick={async () => { await flush(); setPublishing(true); }}>{st === 'publicado' ? 'Atualizar publicação' : 'Publicar catálogo'}</button>
        </div>
      </div>
      {st === 'publicado' && <div style={{ marginBottom: 12 }}><Alert tone="info">O cliente vê a última versão <b>publicada</b>. Depois de editar, clique em <b>Atualizar publicação</b> (o link continua o mesmo).</Alert></div>}

      <div className="cat-editor">
        <div className="cat-panel">
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[
            { id: 'produtos', label: 'Produtos', count: rec.data.products.length || undefined },
            { id: 'kits', label: 'Kits', count: rec.data.kits.length || undefined },
            { id: 'secoes', label: 'Seções e banners' },
            { id: 'aparencia', label: 'Aparência' },
            { id: 'loja', label: 'Loja e contato' },
          ]} />
          {tab === 'produtos' && <ProductsTab doc={rec.data} edit={doc} />}
          {tab === 'kits' && <KitsTab doc={rec.data} edit={doc} />}
          {tab === 'secoes' && <SectionsTab doc={rec.data} edit={doc} />}
          {tab === 'aparencia' && <LookTab rec={rec} edit={edit} />}
          {tab === 'loja' && <StoreTab doc={rec.data} edit={doc} />}
        </div>

        <div className="cat-preview-col">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <b>Pré-visualização</b>
            <div className="seg" role="group" aria-label="Tamanho da tela">
              <button type="button" className={device === 'celular' ? 'on' : ''} onClick={() => setDevice('celular')}>Celular</button>
              <button type="button" className={device === 'computador' ? 'on' : ''} onClick={() => setDevice('computador')}>Computador</button>
            </div>
          </div>
          <div className={`cat-preview ${device}`}>{preview && <CatalogView catalog={preview} frame />}</div>
        </div>
      </div>

      {publishing && <PublishDialog rec={rec} onClose={() => setPublishing(false)} onDone={(r) => { setPublishing(false); setRec((cur) => (cur ? { ...cur, links: r.links, status: r.status } : cur)); setSharing(true); }} />}
      {sharing && <ShareDialog rec={rec} onClose={() => setSharing(false)} onChanged={() => repo.get(id).then((r) => r && setRec((cur) => (cur ? { ...cur, links: r.links, status: r.status } : cur)))} />}
    </>
  );
}

/* ------------------------------------------------------------------ Produtos */
function entryName(doc: CatalogDoc, e: SectionEntry) {
  return e.type === 'produto' ? doc.products.find((p) => p.id === e.id)?.name : doc.kits.find((k) => k.id === e.id)?.name;
}

function ProductsTab({ doc, edit }: { doc: CatalogDoc; edit: (fn: (d: CatalogDoc) => void) => boolean }) {
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<CatalogProduct | null>(null);
  const [confirm, confirmEl] = useConfirm();
  const remove = async (p: CatalogProduct) => {
    const inKits = doc.kits.filter((k) => k.productIds.includes(p.id)).map((k) => k.name);
    const ok = await confirm({ title: `Remover "${p.name}" do catálogo?`, confirmLabel: 'Remover', danger: true,
      text: `Sai só deste catálogo; o orçamento e a peça original não mudam.${inKits.length ? ` Também sai dos kits: ${inKits.join(', ')}.` : ''}` });
    if (ok !== null) edit((d) => removeProduct(d, p.id));
  };
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="small muted" style={{ margin: 0 }}>Os produtos são cópias das peças: nome, descrição, foto e preços daqui não alteram o orçamento.</p>
        <button className="btn primary" onClick={() => setPicking(true)}>+ Adicionar produtos</button>
      </div>
      {doc.products.length === 0 ? <Empty title="Nenhum produto ainda" text="Adicione peças dos orçamentos ou do estoque de peças prontas." action={<button className="btn primary" onClick={() => setPicking(true)}>Adicionar produtos</button>} /> : (
        doc.sections.map((s) => {
          const entries = s.entries.map((e, i) => ({ e, i })).filter((x) => x.e.type === 'produto');
          if (!entries.length) return null;
          return (
            <div key={s.id} className="card">
              <div className="card-body stack" style={{ gap: 8 }}>
                <h3 style={{ margin: 0 }}>{s.title}</h3>
                {entries.map(({ e, i }) => {
                  const p = doc.products.find((x) => x.id === e.id);
                  if (!p) return null;
                  const off = discountOf(p.originalPrice, p.promoPrice);
                  return (
                    <div key={p.id} className="cat-row">
                      {p.image ? <img src={p.image} alt="" className="kb-thumb" /> : <span className="cat-thumb-ph" aria-hidden="true" />}
                      <div className="grow" style={{ minWidth: 0 }}>
                        <b>{p.name}</b>{p.badge && <> <Badge tone="warning">{p.badge}</Badge></>}
                        <div className="small muted">{!p.showPrice ? 'preço oculto' : p.promoPrice ? `de ${fmtBRL(p.originalPrice)} por ${fmtBRL(p.promoPrice)}${off ? ` (−${fmtPct(off, 0)})` : ''}` : p.originalPrice ? fmtBRL(p.originalPrice) : 'sem preço'}{p.source ? ` · origem ${p.source.label}` : ''}</div>
                      </div>
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        <button className="btn ghost sm" aria-label="Subir" onClick={() => edit((d) => moveEntry(d, s.id, i, -1))}>↑</button>
                        <button className="btn ghost sm" aria-label="Descer" onClick={() => edit((d) => moveEntry(d, s.id, i, 1))}>↓</button>
                        <button className="btn secondary sm" onClick={() => setEditing(p)}>Editar</button>
                        <button className="btn ghost sm danger-text" onClick={() => remove(p)}>Remover</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
      {picking && <ProductPicker doc={doc} onClose={() => setPicking(false)} onAdd={(ps, sectionId) => { if (edit((d) => addProducts(d, ps, sectionId))) setPicking(false); }} />}
      {editing && <ProductDialog doc={doc} product={editing} onClose={() => setEditing(null)} onSave={(patch, sectionId) => { if (edit((d) => { updateProduct(d, editing.id, patch); const cur = d.sections.find((s) => s.entries.some((x) => x.type === 'produto' && x.id === editing.id)); if (sectionId && cur?.id !== sectionId) moveEntryToSection(d, { type: 'produto', id: editing.id }, sectionId); })) setEditing(null); }} />}
      {confirmEl}
    </div>
  );
}

/** Busca e seleção das peças cadastradas (orçamentos e peças prontas). */
function ProductPicker({ doc, onClose, onAdd }: { doc: CatalogDoc; onClose: () => void; onAdd: (ps: CatalogProduct[], sectionId: string) => void }) {
  const { db } = useStore();
  const all = useMemo(() => productCandidates(db), [db]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | 'orcamento' | 'estoque'>('');
  const [sel, setSel] = useState<string[]>([]);
  const [sectionId, setSectionId] = useState(doc.sections[doc.sections.length - 1]?.id ?? '');
  const already = new Set(doc.products.map((p) => p.source && (p.source.kind === 'orcamento' ? `q:${p.source.quoteId}:${p.source.itemId}` : `e:${p.source.finishedGoodId}`)));
  const rows = all.filter((c) => (!kind || c.source.kind === kind) && (!q.trim() || `${c.name} ${c.detail}`.toLowerCase().includes(q.trim().toLowerCase())));
  const toggle = (k: string) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const add = () => onAdd(all.filter((c) => sel.includes(c.key)).map(productFromCandidate), sectionId);
  return (
    <Modal wide title="Adicionar produtos" subtitle="Escolha as peças. Cada uma entra como cópia: depois você ajusta nome, descrição, foto e preços só no catálogo." onClose={onClose}
      footer={<><span className="muted small" style={{ marginRight: 'auto' }}>{sel.length} selecionado(s)</span><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!sel.length} onClick={add}>Adicionar {sel.length || ''}</button></>}>
      <div className="stack">
        <div className="grid g3">
          <input type="search" className="search-lg" placeholder="Buscar peça, orçamento ou cliente…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar peça" autoFocus style={{ gridColumn: 'span 2' }} />
          <SelectField label="Origem" value={kind} onChange={(v) => setKind(v as typeof kind)} placeholder="Orçamentos e estoque" options={[{ value: 'orcamento', label: 'Peças dos orçamentos' }, { value: 'estoque', label: 'Peças prontas (estoque)' }]} />
        </div>
        <SelectField label="Colocar na seção" value={sectionId} onChange={setSectionId} options={doc.sections.map((s) => ({ value: s.id, label: s.title }))} />
        <div className="card tbl-scroll" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="tbl"><thead><tr><th></th><th>Peça</th><th>Origem</th><th className="num">Preço por peça</th></tr></thead><tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="muted">Nenhuma peça encontrada.</td></tr>}
            {rows.map((c: ProductCandidate) => (
              <tr key={c.key} style={{ cursor: 'pointer' }} className={sel.includes(c.key) ? 'diff-row' : ''} onClick={() => toggle(c.key)}>
                <td><input type="checkbox" checked={sel.includes(c.key)} onChange={() => toggle(c.key)} onClick={(e) => e.stopPropagation()} aria-label={`Selecionar ${c.name}`} /></td>
                <td><div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>{c.image ? <img src={c.image} alt="" className="kb-thumb" /> : <span className="cat-thumb-ph" aria-hidden="true" />}<div><b>{c.name}</b>{already.has(c.key) && <div className="small muted">já está no catálogo</div>}</div></div></td>
                <td className="small">{c.detail}</td>
                <td className="num">{c.price ? fmtBRL(c.price) : '—'}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </Modal>
  );
}

function BadgeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const preset = (BADGES as readonly string[]).includes(value);
  const [custom, setCustom] = useState(!!value && !preset);
  return (
    <div className="grid g2">
      <SelectField label="Selo promocional" value={custom ? '__custom' : value} onChange={(v) => { if (v === '__custom') { setCustom(true); onChange(''); } else { setCustom(false); onChange(v); } }}
        placeholder="— sem selo —" options={[...BADGES.map((b) => ({ value: b, label: b })), { value: '__custom', label: 'Texto personalizado…' }]} />
      {custom && <TextField label="Texto do selo" value={value} onChange={(v) => onChange(v.toUpperCase().slice(0, 40))} placeholder="Ex.: FEITO À MÃO" />}
    </div>
  );
}

function ProductDialog({ doc, product: p, onClose, onSave }: { doc: CatalogDoc; product: CatalogProduct; onClose: () => void; onSave: (patch: Partial<CatalogProduct>, sectionId: string) => void }) {
  const { db } = useStore();
  const original = useMemo(() => {
    const src = p.source;
    if (!src) return undefined;
    const key = src.kind === 'orcamento' ? `q:${src.quoteId}:${src.itemId}` : `e:${src.finishedGoodId}`;
    return productCandidates(db).find((c) => c.key === key);
  }, [db, p.source]);
  const [f, setF] = useState({ name: p.name, description: p.description, image: p.image, originalPrice: br(p.originalPrice), promoPrice: br(p.promoPrice), showPrice: p.showPrice, badge: p.badge ?? '' });
  const [sectionId, setSectionId] = useState(doc.sections.find((s) => s.entries.some((e) => e.type === 'produto' && e.id === p.id))?.id ?? doc.sections[0]?.id ?? '');
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const off = discountOf(dec(f.originalPrice), dec(f.promoPrice));
  return (
    <Modal wide title={`Produto: ${p.name}`} subtitle={original ? `Cópia de ${original.source.label}. As mudanças valem só neste catálogo.` : 'As mudanças valem só neste catálogo.'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave({ ...f, originalPrice: dec(f.originalPrice), promoPrice: dec(f.promoPrice), badge: f.badge || null }, sectionId)}>Salvar produto</button></>}>
      <div className="grid g2">
        <div className="stack">
          <TextField label="Nome comercial" required value={f.name} onChange={set('name')} />
          <TextArea label="Descrição" value={f.description} onChange={set('description')} placeholder="Medidas, cores, personalização, prazo…" />
          <div className="grid g2">
            <NumField label="Preço original" suffix="R$" value={f.originalPrice} onChange={set('originalPrice')} hint={original?.price ? `No orçamento: ${fmtBRL(original.price)}` : undefined} />
            <NumField label="Preço promocional" suffix="R$" value={f.promoPrice} onChange={set('promoPrice')} hint={off ? `Desconto de ${fmtPct(off, 0)}` : 'Vazio = sem promoção'} />
          </div>
          <Check label="Exibir preço no catálogo" checked={f.showPrice} onChange={set('showPrice')} />
          <BadgeField value={f.badge} onChange={set('badge')} />
          <SelectField label="Seção" value={sectionId} onChange={setSectionId} options={doc.sections.map((s) => ({ value: s.id, label: s.title }))} />
        </div>
        <div className="stack">
          <ImagePicker label="Foto no catálogo" value={f.image} onChange={set('image')} hint="Pode ser diferente da foto da peça original." />
          {original?.image && original.image !== f.image && <button type="button" className="btn ghost sm" onClick={() => set('image')(original.image)}>Usar a foto da peça original</button>}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Kits */
function KitsTab({ doc, edit }: { doc: CatalogDoc; edit: (fn: (d: CatalogDoc) => void) => boolean }) {
  const [editing, setEditing] = useState<CatalogKit | 'novo' | null>(null);
  const [confirm, confirmEl] = useConfirm();
  const remove = async (k: CatalogKit) => {
    const ok = await confirm({ title: `Excluir o kit "${k.name}"?`, confirmLabel: 'Excluir kit', danger: true, text: 'Os produtos continuam no catálogo.' });
    if (ok !== null) edit((d) => removeKit(d, k.id));
  };
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="small muted" style={{ margin: 0 }}>Junte dois ou mais produtos do catálogo numa oferta. Os preços dos produtos não mudam.</p>
        <button className="btn primary" disabled={doc.products.length < 2} onClick={() => setEditing('novo')}>+ Novo kit</button>
      </div>
      {doc.products.length < 2 && <Alert tone="info">Adicione ao menos dois produtos ao catálogo para montar um kit.</Alert>}
      {doc.kits.length === 0 ? <Empty title="Nenhum kit ainda" text="Ex.: KIT ESPECIAL DE NATAL — Produto A + Produto B + Produto C, de R$ 150,00 por R$ 119,90." /> : doc.kits.map((k) => {
        const off = discountOf(k.referencePrice, k.promoPrice);
        return (
          <div key={k.id} className="card"><div className="card-body cat-row">
            {k.image ? <img src={k.image} alt="" className="kb-thumb" /> : <span className="cat-thumb-ph" aria-hidden="true" />}
            <div className="grow" style={{ minWidth: 0 }}>
              <b>{k.name}</b>{k.badge && <> <Badge tone="warning">{k.badge}</Badge></>}
              <div className="small muted">{k.productIds.map((id) => doc.products.find((p) => p.id === id)?.name).filter(Boolean).join(' + ')}</div>
              <div className="small">{!k.showPrice ? 'preço oculto' : k.promoPrice ? `de ${fmtBRL(k.referencePrice)} por ${fmtBRL(k.promoPrice)}${off ? ` (−${fmtPct(off, 0)})` : ''}` : fmtBRL(k.referencePrice)}</div>
            </div>
            <button className="btn secondary sm" onClick={() => setEditing(k)}>Editar</button>
            <button className="btn ghost sm danger-text" onClick={() => remove(k)}>Excluir</button>
          </div></div>
        );
      })}
      {editing && <KitDialog doc={doc} kit={editing === 'novo' ? null : editing} onClose={() => setEditing(null)} onSave={(kit, sectionId) => { if (edit((d) => saveKit(d, kit, sectionId))) setEditing(null); }} />}
      {confirmEl}
    </div>
  );
}

function KitDialog({ doc, kit, onClose, onSave }: { doc: CatalogDoc; kit: CatalogKit | null; onClose: () => void; onSave: (k: Omit<CatalogKit, 'id'> & { id?: string }, sectionId?: string) => void }) {
  const [f, setF] = useState({ name: kit?.name ?? '', description: kit?.description ?? '', productIds: kit?.productIds ?? [], image: kit?.image ?? null, referencePrice: br(kit?.referencePrice), promoPrice: br(kit?.promoPrice), showPrice: kit?.showPrice ?? true, badge: kit?.badge ?? 'COMBO PROMOCIONAL' });
  const [sectionId, setSectionId] = useState(doc.sections.find((s) => /kit/i.test(s.title))?.id ?? doc.sections[0]?.id ?? '');
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const sumRef = kitReferencePrice(doc, f.productIds);
  const toggle = (id: string) => set('productIds')(f.productIds.includes(id) ? f.productIds.filter((x) => x !== id) : [...f.productIds, id]);
  const off = discountOf(dec(f.referencePrice) ?? sumRef, dec(f.promoPrice));
  const productImages = f.productIds.map((id) => doc.products.find((p) => p.id === id)).filter((p) => p?.image) as CatalogProduct[];
  return (
    <Modal wide title={kit ? `Kit: ${kit.name}` : 'Novo kit promocional'} subtitle="O kit aparece como oferta especial, com a composição e a vantagem em destaque." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={f.productIds.length < 2 || !f.name.trim()} onClick={() => onSave({ ...f, id: kit?.id, referencePrice: dec(f.referencePrice), promoPrice: dec(f.promoPrice), badge: f.badge || null }, kit ? undefined : sectionId)}>Salvar kit</button></>}>
      <div className="grid g2">
        <div className="stack">
          <TextField label="Nome do kit" required value={f.name} onChange={set('name')} placeholder="Ex.: KIT ESPECIAL DE NATAL" />
          <TextArea label="Descrição" value={f.description} onChange={set('description')} />
          <Field label={`Produtos do kit (${f.productIds.length} escolhido(s), mínimo 2)`}>
            <div className="cat-checklist">{doc.products.map((p) => (
              <label key={p.id} className="check"><input type="checkbox" checked={f.productIds.includes(p.id)} onChange={() => toggle(p.id)} />{p.name}{p.originalPrice ? <span className="muted small"> · {fmtBRL(p.originalPrice)}</span> : null}</label>
            ))}</div>
          </Field>
          <div className="grid g2">
            <NumField label="Preço de referência (De)" suffix="R$" value={f.referencePrice} onChange={set('referencePrice')} hint={sumRef ? `Vazio = soma dos produtos (${fmtBRL(sumRef)})` : 'Vazio = soma dos produtos'} />
            <NumField label="Preço promocional (Por)" suffix="R$" value={f.promoPrice} onChange={set('promoPrice')} hint={off ? `Desconto de ${fmtPct(off, 0)}` : undefined} />
          </div>
          <Check label="Exibir preço" checked={f.showPrice} onChange={set('showPrice')} />
          <BadgeField value={f.badge} onChange={set('badge')} />
          {!kit && <SelectField label="Seção" value={sectionId} onChange={setSectionId} options={doc.sections.map((s) => ({ value: s.id, label: s.title }))} />}
        </div>
        <div className="stack">
          <ImagePicker label="Imagem de destaque" value={f.image} onChange={set('image')} hint="Vazio = foto do primeiro produto." />
          {productImages.length > 0 && <Field label="Ou use a foto de um produto"><div className="row">{productImages.map((p) => (
            <button key={p.id} type="button" className={`cat-pick-img${f.image === p.image ? ' on' : ''}`} onClick={() => set('image')(p.image)} aria-label={`Usar foto de ${p.name}`}><img src={p.image!} alt="" /></button>
          ))}</div></Field>}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Seções e banners */
function BannerFields({ banner, onChange, label }: { banner: CatalogBanner | null; onChange: (b: CatalogBanner | null) => void; label: string }) {
  if (!banner) return <button type="button" className="btn ghost sm" onClick={() => onChange({ title: '', subtitle: '', image: null })}>+ {label}</button>;
  return (
    <div className="cat-banner-box stack">
      <div className="row" style={{ justifyContent: 'space-between' }}><b className="small">{label}</b><button type="button" className="btn ghost sm" onClick={() => onChange(null)}>Remover banner</button></div>
      <div className="grid g2">
        <TextField label="Título" value={banner.title} onChange={(v) => onChange({ ...banner, title: v.slice(0, 80) })} placeholder="Ex.: Frete grátis acima de R$ 100" />
        <TextField label="Subtítulo" value={banner.subtitle} onChange={(v) => onChange({ ...banner, subtitle: v.slice(0, 140) })} />
      </div>
      <ImagePicker label="Imagem de fundo (opcional)" value={banner.image} onChange={(img) => onChange({ ...banner, image: img })} hint="Sem imagem, o banner usa as cores da temática." />
    </div>
  );
}

function SectionsTab({ doc, edit }: { doc: CatalogDoc; edit: (fn: (d: CatalogDoc) => void) => boolean }) {
  const [title, setTitle] = useState('');
  const [confirm, confirmEl] = useConfirm();
  const remove = async (id: string, name: string) => {
    const ok = await confirm({ title: `Remover a seção "${name}"?`, confirmLabel: 'Remover seção', danger: true, text: 'Os produtos e kits dela passam para a primeira seção.' });
    if (ok !== null) edit((d) => removeSection(d, id));
  };
  return (
    <div className="stack">
      <div className="card"><div className="card-body stack">
        <h3 style={{ margin: 0 }}>Banner do cabeçalho</h3>
        <BannerFields label="Banner de destaque no topo" banner={doc.settings.headerBanner} onChange={(b) => edit((d) => { d.settings.headerBanner = b; })} />
      </div></div>
      {doc.sections.map((s, i) => (
        <div key={s.id} className="card"><div className="card-body stack">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="cat-section-input grow" value={s.title} aria-label="Nome da seção" onChange={(e) => edit((d) => { d.sections[i].title = e.target.value.slice(0, 80); })} />
            <button className="btn ghost sm" aria-label="Subir seção" onClick={() => edit((d) => moveSection(d, i, -1))}>↑</button>
            <button className="btn ghost sm" aria-label="Descer seção" onClick={() => edit((d) => moveSection(d, i, 1))}>↓</button>
            <button className="btn ghost sm danger-text" onClick={() => remove(s.id, s.title)} disabled={doc.sections.length < 2}>Remover</button>
          </div>
          {s.entries.length ? (
            <ol className="cat-entries">{s.entries.map((e, j) => (
              <li key={e.type + e.id}>
                <span className="grow">{e.type === 'kit' ? <Badge tone="info">kit</Badge> : null} {entryName(doc, e)}</span>
                <button className="btn ghost sm" aria-label="Subir" onClick={() => edit((d) => moveEntry(d, s.id, j, -1))}>↑</button>
                <button className="btn ghost sm" aria-label="Descer" onClick={() => edit((d) => moveEntry(d, s.id, j, 1))}>↓</button>
                <select aria-label="Mover para a seção" value={s.id} onChange={(ev) => edit((d) => moveEntryToSection(d, e, ev.target.value))}>
                  {doc.sections.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                </select>
              </li>
            ))}</ol>
          ) : <p className="small muted" style={{ margin: 0 }}>Seção vazia (não aparece para o cliente, a não ser que tenha banner).</p>}
          <BannerFields label="Banner antes desta seção" banner={s.banner} onChange={(b) => edit((d) => { d.sections[i].banner = b; })} />
        </div></div>
      ))}
      <div className="card"><div className="card-body stack">
        <h3 style={{ margin: 0 }}>Nova seção</h3>
        <div className="row">{SECTION_PRESETS.filter((p) => !doc.sections.some((s) => s.title === p)).map((p) => (
          <button key={p} type="button" className="btn ghost sm" onClick={() => edit((d) => { addSection(d, p); })}>+ {p}</button>
        ))}</div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow"><TextField label="Ou um nome seu" value={title} onChange={setTitle} placeholder="Ex.: Lembrancinhas" /></div>
          <button className="btn secondary" disabled={!title.trim()} onClick={() => { if (edit((d) => { addSection(d, title); })) setTitle(''); }}>Adicionar seção</button>
        </div>
      </div></div>
      {confirmEl}
    </div>
  );
}

/* ------------------------------------------------------------------ Aparência */
function LookTab({ rec, edit }: { rec: CatalogRecord; edit: (fn: (r: CatalogRecord) => void) => boolean }) {
  const t = themeOf(rec.theme);
  const s = rec.data.settings;
  const color = (label: string, key: 'primaryColor' | 'accentColor', fallback: string) => (
    <Field label={label} hint={s[key] ? 'Cor própria' : 'Cor da temática'}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input type="color" value={s[key] ?? fallback} onChange={(e) => edit((r) => { r.data.settings[key] = e.target.value; })} aria-label={label} />
        {s[key] && <button type="button" className="btn ghost sm" onClick={() => edit((r) => { r.data.settings[key] = null; })}>Usar a da temática</button>}
      </div>
    </Field>
  );
  return (
    <div className="stack">
      <div className="card"><div className="card-body stack">
        <h3 style={{ margin: 0 }}>Temática</h3>
        <p className="small muted" style={{ margin: 0 }}>Trocar a temática muda só o visual: produtos, preços, kits e textos continuam.</p>
        <ThemePicker value={rec.theme} onChange={(id) => edit((r) => { r.theme = id as ThemeId; })} />
      </div></div>
      <div className="card"><div className="card-body stack">
        <h3 style={{ margin: 0 }}>Cores principais</h3>
        <div className="grid g2">{color('Cor principal', 'primaryColor', t.colors.primary)}{color('Cor de destaque', 'accentColor', t.colors.accent)}</div>
      </div></div>
      <div className="card"><div className="card-body grid g2">
        <ImagePicker label="Logotipo" value={s.logo} onChange={(img) => edit((r) => { r.data.settings.logo = img; })} />
        <ImagePicker label="Imagem de capa" value={s.cover} onChange={(img) => edit((r) => { r.data.settings.cover = img; })} hint="Vazio = fundo da temática." />
      </div></div>
    </div>
  );
}

/* ------------------------------------------------------------------ Loja e contato */
function StoreTab({ doc, edit }: { doc: CatalogDoc; edit: (fn: (d: CatalogDoc) => void) => boolean }) {
  const s = doc.settings;
  const c = s.contact;
  const contact = (k: keyof typeof c) => (v: string) => edit((d) => { d.settings.contact[k] = v.slice(0, 120); });
  return (
    <div className="stack">
      <div className="card"><div className="card-body stack">
        <div className="grid g2">
          <TextField label="Nome da loja" value={s.storeName} onChange={(v) => edit((d) => { d.settings.storeName = v.slice(0, 80); })} />
          <DateField label="Ofertas válidas até (opcional)" value={s.campaignUntil ?? ''} onChange={(v) => edit((d) => { d.settings.campaignUntil = v || null; })} hint="Aparece para o cliente. A validade do link é definida ao publicar." />
        </div>
        <TextArea label="Texto de apresentação" value={s.intro} onChange={(v) => edit((d) => { d.settings.intro = v.slice(0, 400); })} placeholder="Ex.: Peças impressas em 3D, feitas sob encomenda. Personalizamos cores e nomes!" />
      </div></div>
      <div className="card"><div className="card-body stack">
        <h3 style={{ margin: 0 }}>Contato</h3>
        <p className="small muted" style={{ margin: 0 }}>O botão fixo do catálogo abre o WhatsApp (ou o primeiro contato preenchido) com a mensagem do produto.</p>
        <div className="grid g2">
          <TextField label="WhatsApp" value={c.whatsapp} onChange={contact('whatsapp')} placeholder="(11) 91234-5678" />
          <TextField label="Telefone" value={c.phone} onChange={contact('phone')} />
          <TextField label="Instagram" value={c.instagram} onChange={contact('instagram')} placeholder="@ideiacubica" />
          <TextField label="E-mail" value={c.email} onChange={contact('email')} />
          <TextField label="Site" value={c.site} onChange={contact('site')} />
        </div>
      </div></div>
    </div>
  );
}

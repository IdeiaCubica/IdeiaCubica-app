/** Catálogo digital: lista de catálogos, criação, duplicação, publicação e compartilhamento. */
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { CatalogRecord, CatalogStatus } from '../../domain/catalogo';
import { activeLink, catalogStatus, duplicateCatalog, newCatalog } from '../../domain/catalogo';
import { CATALOG_THEMES, themeOf } from '../../domain/catalogThemes';
import { fmtDate, fmtDateTime } from '../../domain/core';
import { catalogRepository } from '../../data/catalogRepo';
import { Alert, Badge, DataTable, Empty, Kpi, Modal, PageHead, TextField, useConfirm, type Tone } from '../components/ui';
import { CatalogEditor } from '../catalogo/CatalogEditor';
import { PublishDialog, ShareDialog } from '../catalogo/PublishDialogs';

export const STATUS_LABEL: Record<CatalogStatus, { label: string; tone: Tone }> = {
  rascunho: { label: 'Rascunho', tone: 'neutral' }, publicado: { label: 'Publicado', tone: 'success' }, expirado: { label: 'Expirado', tone: 'warning' },
};

/** Endereço público do catálogo. Em desenvolvimento (sem o redirecionamento da Vercel) usa a página direta. */
export const publicUrl = (slug: string) => (import.meta.env.DEV ? `${location.origin}/catalogo.html?c=${slug}` : `${location.origin}/c/${slug}`);

export function Catalogo({ param }: { param?: string }) {
  if (param) return <CatalogEditor key={param} id={param} />;
  return <CatalogList />;
}

export function useCatalogs() {
  const [list, setList] = useState<CatalogRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    catalogRepository().list().then((l) => { setList(l); setError(null); }).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setList([]); });
  }, []);
  useEffect(reload, [reload]);
  return { list, error, reload };
}

function CatalogList() {
  const { db, toast } = useStore();
  const { list, error, reload } = useCatalogs();
  const [confirm, confirmEl] = useConfirm();
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState<CatalogRecord | null>(null);
  const [sharing, setSharing] = useState<CatalogRecord | null>(null);
  const repo = catalogRepository();
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast('success', ok); reload(); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
  };
  const duplicate = async (c: CatalogRecord) => {
    const full = await repo.get(c.id);
    if (!full) return;
    const copy = duplicateCatalog(full);
    await act(() => repo.save(copy), `Cópia criada como rascunho: ${copy.name}.`);
  };
  const expire = async (c: CatalogRecord) => {
    const ok = await confirm({ title: `Expirar o link de "${c.name}"?`, confirmLabel: 'Expirar link', danger: true,
      text: 'O link deixa de funcionar na hora para os clientes. Você continua vendo e editando o catálogo aqui e pode reativar ou gerar um link novo depois.' });
    if (ok !== null) act(() => repo.expire(c.id), 'Link expirado: o catálogo não está mais acessível aos clientes.');
  };
  const remove = async (c: CatalogRecord) => {
    const ok = await confirm({ title: `Excluir o catálogo "${c.name}"?`, confirmLabel: 'Excluir catálogo', danger: true,
      text: 'O catálogo, seus links e estatísticas são apagados. O link deixa de funcionar. Os orçamentos e peças não são afetados.' });
    if (ok !== null) act(() => repo.remove(c.id), 'Catálogo excluído.');
  };
  const rows = list ?? [];
  const now = new Date();
  const published = rows.filter((c) => catalogStatus(c, now) === 'publicado');
  return (
    <>
      <PageHead eyebrow="Vendas" title="Catálogo" text="Monte vitrines digitais com as peças dos orçamentos, publique um link e compartilhe com os clientes — sem instalar nada, sem cadastro."
        actions={<button className="btn primary" onClick={() => setCreating(true)}>Novo catálogo</button>} />
      {error && <div style={{ marginBottom: 16 }}><Alert tone="error" title="Não foi possível carregar os catálogos">{error}</Alert></div>}
      <div className="kpis" style={{ marginBottom: 18 }}>
        <Kpi label="Catálogos" value={rows.length} hint={`${rows.filter((c) => catalogStatus(c, now) === 'rascunho').length} rascunho(s)`} />
        <Kpi label="Publicados agora" value={published.length} accent />
        <Kpi label="Visitas" value={rows.reduce((s, c) => s + (c.stats?.visits ?? 0), 0)} hint="em todos os catálogos" />
        <Kpi label="Cliques em contato" value={rows.reduce((s, c) => s + (c.stats?.contacts ?? 0), 0)} hint={`${rows.reduce((s, c) => s + (c.stats?.productViews ?? 0), 0)} produto(s) abertos`} />
      </div>
      <div className="card">
        <DataTable rows={rows} rowKey={(c) => c.id} onRowClick={(c) => navigate(`catalogo/${c.id}`)} search={(c) => `${c.name} ${themeOf(c.theme).name}`}
          empty={list === null ? <p className="muted" style={{ padding: 16 }}>Carregando…</p> : <Empty title="Nenhum catálogo ainda" text="Crie um catálogo, escolha a temática e adicione as peças dos seus orçamentos." action={<button className="btn primary" onClick={() => setCreating(true)}>Criar o primeiro catálogo</button>} />}
          columns={[
            { key: 'n', header: 'Catálogo', render: (c) => <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><span className="cat-swatch" style={{ background: themeOf(c.theme).hero }} aria-hidden="true" /><div><b>{c.name}</b><div className="muted small">{themeOf(c.theme).name} · {c.data.products.length} produto(s){c.data.kits.length ? ` · ${c.data.kits.length} kit(s)` : ''}</div></div></div>, sort: (c) => c.name },
            { key: 'd', header: 'Criado em', render: (c) => fmtDate(c.createdAt), sort: (c) => c.createdAt },
            { key: 's', header: 'Situação', render: (c) => { const st = catalogStatus(c, now); return <Badge tone={STATUS_LABEL[st].tone}>{STATUS_LABEL[st].label}</Badge>; }, sort: (c) => catalogStatus(c, now) },
            { key: 'v', header: 'Visitas', num: true, render: (c) => c.stats?.visits ?? 0, sort: (c) => c.stats?.visits ?? 0 },
            { key: 'x', header: 'Validade do link', render: (c) => { const l = activeLink(c); return !l ? <span className="muted">—</span> : l.expiresAt ? fmtDateTime(l.expiresAt) : 'sem expiração'; } },
            { key: 'a', header: '', render: (c) => { const st = catalogStatus(c, now); return (
              <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost sm" onClick={() => navigate(`catalogo/${c.id}`)}>Editar</button>
                <button className="btn ghost sm" onClick={() => duplicate(c)}>Duplicar</button>
                {st === 'publicado' && <button className="btn ghost sm" onClick={() => setSharing(c)}>Visualizar / compartilhar</button>}
                <button className="btn secondary sm" onClick={async () => setPublishing(await repo.get(c.id))}>{st === 'publicado' ? 'Atualizar publicação' : st === 'expirado' ? 'Reativar / publicar' : 'Publicar'}</button>
                {st === 'publicado' && <button className="btn ghost sm" onClick={() => expire(c)}>Expirar</button>}
                <button className="btn ghost sm danger-text" onClick={() => remove(c)}>Excluir</button>
              </span>); } },
          ]} />
      </div>
      <p className="small muted">O link é aleatório e só quem o recebe consegue abrir. Não existe lista pública de catálogos. Preços e textos do catálogo são próprios: mudar aqui não altera os orçamentos.</p>
      {creating && <NewCatalogDialog storeName={db.settings.companyName} onClose={() => setCreating(false)} />}
      {publishing && <PublishDialog rec={publishing} onClose={() => setPublishing(null)} onDone={(rec) => { setPublishing(null); reload(); setSharing(rec); }} />}
      {sharing && <ShareDialog rec={sharing} onClose={() => setSharing(null)} onChanged={reload} />}
      {confirmEl}
    </>
  );
}

/** Seletor de temática (cartões com a cara de cada uma). */
export function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div className="theme-grid" role="radiogroup" aria-label="Temática">
      {CATALOG_THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={value === t.id} className={`theme-card${value === t.id ? ' on' : ''}`} onClick={() => onChange(t.id)}>
          <span className="theme-hero" style={{ background: t.hero }}>{t.ornaments.slice(0, 2).join(' ')}</span>
          <span className="theme-name">{t.name}</span>
          <span className="theme-dots" aria-hidden="true">{[t.colors.primary, t.colors.accent, t.colors.bg].map((c) => <i key={c} style={{ background: c }} />)}</span>
        </button>
      ))}
    </div>
  );
}

function NewCatalogDialog({ storeName, onClose }: { storeName: string; onClose: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState('');
  const [theme, setTheme] = useState('natal');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const rec = newCatalog({ name, theme, storeName });
      await catalogRepository().save(rec);
      navigate(`catalogo/${rec.id}`);
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Modal wide title="Novo catálogo" subtitle="Dê um nome e escolha a temática. Você pode trocar a temática depois sem perder nada." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={create} disabled={busy || !name.trim()}>Criar e montar</button></>}>
      <div className="stack">
        <TextField label="Nome do catálogo" required value={name} onChange={setName} placeholder="Ex.: Natal 2026 — Presentes" autoFocus />
        <ThemePicker value={theme} onChange={setTheme} />
      </div>
    </Modal>
  );
}

/**
 * Persistência do catálogo digital — separada do documento principal do sistema.
 *
 *  - Supabase: tabelas catalogs / catalog_links / catalog_events (supabase/migrations/
 *    20261103000000_v1_12_catalogo.sql). Fotos reaproveitam a tabela app_images
 *    (cada foto uma vez, referência img:<sha256>). O cliente só usa as funções públicas
 *    get_public_catalog / get_public_catalog_image / track_catalog_event, que validam
 *    o link e a validade NO BANCO.
 *  - Local (desenvolvimento): tudo no localStorage deste navegador.
 */
import type { CatalogLink, CatalogRecord, CatalogStats, PublicCatalog } from '../domain/catalogo';
import { publicSnapshot, randomSlug } from '../domain/catalogo';
import type { ThemeId } from '../domain/catalogThemes';
import { nowISO } from '../domain/core';
import { getSupabase, usesSupabase } from './supabase';
import { IMG_REF, collectImageRefs, collectInlineImages, hydrateImages, sha256Hex, withImageRefs } from './images';

export type EventKind = 'visita' | 'produto' | 'contato' | 'compartilhar';
export type PublicResult = { status: 'ok'; catalog: PublicCatalog; expiresAt: string | null } | { status: 'expirado' | 'nao_encontrado' };

export interface CatalogRepository {
  readonly kind: 'local' | 'supabase';
  /** Lista (fotos ainda como referência — leve). */
  list(): Promise<CatalogRecord[]>;
  /** Catálogo completo, com as fotos, para editar. */
  get(id: string): Promise<CatalogRecord | null>;
  save(rec: CatalogRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** Publica a versão atual. newLink = gera outro endereço (o anterior deixa de funcionar e fica no histórico). */
  publish(rec: CatalogRecord, opts: { expiresAt: string | null; newLink: boolean }): Promise<CatalogLink>;
  /** Expira o link ativo agora (o catálogo continua editável aqui). */
  expire(id: string): Promise<void>;
  /** Volta a ativar o último link (mesmo endereço), com a validade informada. */
  reactivate(id: string, expiresAt: string | null): Promise<void>;
  /* --- página pública (sem login) --- */
  getPublic(slug: string): Promise<PublicResult>;
  publicImage(slug: string, ref: string): Promise<string | null>;
  track(slug: string, kind: EventKind, itemId?: string): Promise<void>;
}

const emptyStats = (): CatalogStats => ({ visits: 0, productViews: 0, contacts: 0, shares: 0, lastVisit: null });

/* ======================================================================= Supabase */
interface Row { id: string; name: string; theme: string; data: CatalogRecord['data']; status: CatalogRecord['status']; created_at: string; updated_at: string }
interface LinkRow { slug: string; catalog_id: string; expires_at: string | null; active: boolean; published_at: string; revoked_at: string | null }

function friendly(message: string): string {
  if (/catalog|relation .* does not exist|schema cache|PGRST20[25]|function .* does not exist/i.test(message)) {
    return 'O banco ainda não tem o Catálogo. Rode supabase/migrations/20261103000000_v1_12_catalogo.sql no SQL Editor do Supabase.';
  }
  if (/failed to fetch|network/i.test(message)) return 'Sem conexão com o servidor. Verifique a internet e tente novamente.';
  if (/permission|denied|42501|row-level security/i.test(message)) return 'Seu usuário não tem permissão para usar os catálogos.';
  return message;
}
const check = <T>(r: { data: T; error: { message: string; code?: string } | null }): T => {
  if (r.error) throw new Error(friendly(`${r.error.code ?? ''} ${r.error.message}`));
  return r.data;
};
const toLink = (l: LinkRow): CatalogLink => ({ slug: l.slug, expiresAt: l.expires_at, active: l.active, publishedAt: l.published_at, revokedAt: l.revoked_at });

class SupabaseCatalogRepository implements CatalogRepository {
  readonly kind = 'supabase' as const;
  private idOf = new Map<string, string>();

  /** Fotos (data URL) → tabela app_images; devolve a cópia com referências e os ids usados. */
  private async storeImages<T>(value: T): Promise<{ value: T; ids: string[] }> {
    const inline = [...collectInlineImages(value)];
    for (const s of inline) if (!this.idOf.has(s)) this.idOf.set(s, await sha256Hex(s));
    const rows = inline.map((s) => ({ id: this.idOf.get(s)!, data: s, bytes: s.length }));
    for (let i = 0; i < rows.length; i += 5) {
      check(await getSupabase().from('app_images').upsert(rows.slice(i, i + 5), { onConflict: 'id', ignoreDuplicates: true }));
    }
    const out = withImageRefs(value, this.idOf);
    return { value: out, ids: [...collectImageRefs(out)] };
  }

  private async hydrate(value: unknown) {
    const ids = [...collectImageRefs(value)];
    const images = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 40) {
      const rows = check(await getSupabase().from('app_images').select('id, data').in('id', ids.slice(i, i + 40))) as { id: string; data: string }[];
      for (const r of rows ?? []) { images.set(r.id, r.data); this.idOf.set(r.data, r.id); }
    }
    hydrateImages(value, images);
  }

  private async linksOf(ids?: string[]): Promise<LinkRow[]> {
    let q = getSupabase().from('catalog_links').select('slug, catalog_id, expires_at, active, published_at, revoked_at').order('published_at', { ascending: false });
    if (ids) q = q.in('catalog_id', ids);
    return (check(await q) as LinkRow[]) ?? [];
  }

  private record(r: Row, links: LinkRow[], stats?: CatalogStats): CatalogRecord {
    return { id: r.id, name: r.name, theme: r.theme as ThemeId, data: r.data, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
      links: links.filter((l) => l.catalog_id === r.id).map(toLink), stats };
  }

  async list(): Promise<CatalogRecord[]> {
    const rows = (check(await getSupabase().from('catalogs').select('id, name, theme, data, status, created_at, updated_at').order('created_at', { ascending: false })) as Row[]) ?? [];
    const links = await this.linksOf();
    const stats = new Map<string, CatalogStats>();
    const s = await getSupabase().rpc('catalog_stats');
    if (!s.error) for (const r of (s.data ?? []) as { catalog_id: string; visitas: number; produtos: number; contatos: number; compartilhamentos: number; ultima_visita: string | null }[]) {
      stats.set(r.catalog_id, { visits: Number(r.visitas), productViews: Number(r.produtos), contacts: Number(r.contatos), shares: Number(r.compartilhamentos), lastVisit: r.ultima_visita });
    }
    return rows.map((r) => this.record(r, links, stats.get(r.id) ?? emptyStats()));
  }

  async get(id: string): Promise<CatalogRecord | null> {
    const row = check(await getSupabase().from('catalogs').select('id, name, theme, data, status, created_at, updated_at').eq('id', id).maybeSingle()) as Row | null;
    if (!row) return null;
    await this.hydrate(row.data);
    return this.record(row, await this.linksOf([id]));
  }

  async save(rec: CatalogRecord): Promise<void> {
    const { value: data } = await this.storeImages(rec.data);
    check(await getSupabase().from('catalogs').upsert({ id: rec.id, name: rec.name, theme: rec.theme, data, status: rec.status, created_at: rec.createdAt, updated_at: nowISO() }));
  }

  async remove(id: string): Promise<void> {
    check(await getSupabase().from('catalogs').delete().eq('id', id));
  }

  async publish(rec: CatalogRecord, opts: { expiresAt: string | null; newLink: boolean }): Promise<CatalogLink> {
    await this.save(rec);
    const { value: snapshot, ids } = await this.storeImages(publicSnapshot(rec));
    const current = (await this.linksOf([rec.id])).find((l) => l.active);
    let slug: string;
    if (current && !opts.newLink) {
      slug = current.slug;
      check(await getSupabase().from('catalog_links').update({ snapshot, image_ids: ids, expires_at: opts.expiresAt, published_at: nowISO() }).eq('slug', slug));
    } else {
      if (current) check(await getSupabase().from('catalog_links').update({ active: false, revoked_at: nowISO() }).eq('slug', current.slug));
      slug = randomSlug();
      check(await getSupabase().from('catalog_links').insert({ slug, catalog_id: rec.id, snapshot, image_ids: ids, expires_at: opts.expiresAt, active: true }));
    }
    check(await getSupabase().from('catalogs').update({ status: 'publicado' }).eq('id', rec.id));
    return toLink((await this.linksOf([rec.id])).find((l) => l.slug === slug)!);
  }

  async expire(id: string): Promise<void> {
    check(await getSupabase().from('catalog_links').update({ active: false, revoked_at: nowISO() }).eq('catalog_id', id).eq('active', true));
    check(await getSupabase().from('catalogs').update({ status: 'expirado' }).eq('id', id));
  }

  async reactivate(id: string, expiresAt: string | null): Promise<void> {
    const last = (await this.linksOf([id]))[0];
    if (!last) throw new Error('Este catálogo ainda não foi publicado.');
    check(await getSupabase().from('catalog_links').update({ active: true, revoked_at: null, expires_at: expiresAt }).eq('slug', last.slug));
    check(await getSupabase().from('catalogs').update({ status: 'publicado' }).eq('id', id));
  }

  async getPublic(slug: string): Promise<PublicResult> {
    const r = check(await getSupabase().rpc('get_public_catalog', { p_slug: slug })) as { status: string; catalog?: PublicCatalog; expires_at?: string | null };
    if (r.status === 'ok' && r.catalog) return { status: 'ok', catalog: r.catalog, expiresAt: r.expires_at ?? null };
    return { status: r.status === 'expirado' ? 'expirado' : 'nao_encontrado' };
  }

  async publicImage(slug: string, ref: string): Promise<string | null> {
    if (!ref.startsWith(IMG_REF)) return ref;
    const r = await getSupabase().rpc('get_public_catalog_image', { p_slug: slug, p_id: ref.slice(IMG_REF.length) });
    return r.error ? null : ((r.data as string | null) ?? null);
  }

  async track(slug: string, kind: EventKind, itemId?: string): Promise<void> {
    await getSupabase().rpc('track_catalog_event', { p_slug: slug, p_kind: kind, p_item: itemId ?? null });
  }
}

/* ======================================================================= Local */
interface LocalLink extends CatalogLink { catalogId: string; snapshot: PublicCatalog }
interface LocalState { catalogs: Omit<CatalogRecord, 'links' | 'stats'>[]; links: LocalLink[]; events: { catalogId: string; slug: string; kind: EventKind; item?: string; at: string }[] }
const KEY = 'ideia-cubica:catalogos:v1';

class LocalCatalogRepository implements CatalogRepository {
  readonly kind = 'local' as const;
  private read(): LocalState {
    try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw) as LocalState; } catch { /* vazio */ }
    return { catalogs: [], links: [], events: [] };
  }
  private write(s: LocalState) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { throw new Error('Não foi possível salvar: o armazenamento do navegador está cheio.'); }
  }
  private full(s: LocalState, c: LocalState['catalogs'][number]): CatalogRecord {
    const ev = s.events.filter((e) => e.catalogId === c.id);
    const visits = ev.filter((e) => e.kind === 'visita');
    return {
      ...structuredClone(c),
      links: s.links.filter((l) => l.catalogId === c.id).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .map(({ slug, expiresAt, active, publishedAt, revokedAt }) => ({ slug, expiresAt, active, publishedAt, revokedAt })),
      stats: { visits: visits.length, productViews: ev.filter((e) => e.kind === 'produto').length, contacts: ev.filter((e) => e.kind === 'contato').length,
        shares: ev.filter((e) => e.kind === 'compartilhar').length, lastVisit: visits.length ? visits[visits.length - 1].at : null },
    };
  }
  async list() { const s = this.read(); return s.catalogs.map((c) => this.full(s, c)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async get(id: string) { const s = this.read(); const c = s.catalogs.find((x) => x.id === id); return c ? this.full(s, c) : null; }
  async save(rec: CatalogRecord) {
    const s = this.read();
    const { links: _l, stats: _s, ...plain } = rec;
    s.catalogs = [...s.catalogs.filter((x) => x.id !== rec.id), { ...structuredClone(plain), updatedAt: nowISO() }];
    this.write(s);
  }
  async remove(id: string) {
    const s = this.read();
    s.catalogs = s.catalogs.filter((x) => x.id !== id); s.links = s.links.filter((l) => l.catalogId !== id); s.events = s.events.filter((e) => e.catalogId !== id);
    this.write(s);
  }
  async publish(rec: CatalogRecord, opts: { expiresAt: string | null; newLink: boolean }) {
    await this.save(rec);
    const s = this.read();
    const snapshot = publicSnapshot(rec);
    const current = s.links.find((l) => l.catalogId === rec.id && l.active);
    let link: LocalLink;
    if (current && !opts.newLink) {
      Object.assign(current, { snapshot, expiresAt: opts.expiresAt, publishedAt: nowISO() });
      link = current;
    } else {
      if (current) Object.assign(current, { active: false, revokedAt: nowISO() });
      link = { slug: randomSlug(), catalogId: rec.id, snapshot, expiresAt: opts.expiresAt, active: true, publishedAt: nowISO(), revokedAt: null };
      s.links.push(link);
    }
    const c = s.catalogs.find((x) => x.id === rec.id); if (c) c.status = 'publicado';
    this.write(s);
    return { slug: link.slug, expiresAt: link.expiresAt, active: true, publishedAt: link.publishedAt, revokedAt: null };
  }
  async expire(id: string) {
    const s = this.read();
    for (const l of s.links) if (l.catalogId === id && l.active) Object.assign(l, { active: false, revokedAt: nowISO() });
    const c = s.catalogs.find((x) => x.id === id); if (c) c.status = 'expirado';
    this.write(s);
  }
  async reactivate(id: string, expiresAt: string | null) {
    const s = this.read();
    const last = s.links.filter((l) => l.catalogId === id).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    if (!last) throw new Error('Este catálogo ainda não foi publicado.');
    Object.assign(last, { active: true, revokedAt: null, expiresAt });
    const c = s.catalogs.find((x) => x.id === id); if (c) c.status = 'publicado';
    this.write(s);
  }
  async getPublic(slug: string): Promise<PublicResult> {
    const l = this.read().links.find((x) => x.slug === slug);
    if (!l) return { status: 'nao_encontrado' };
    if (!l.active || (l.expiresAt && new Date(l.expiresAt) <= new Date())) return { status: 'expirado' };
    return { status: 'ok', catalog: l.snapshot, expiresAt: l.expiresAt };
  }
  async publicImage(_slug: string, ref: string) { return ref; }
  async track(slug: string, kind: EventKind, item?: string) {
    const s = this.read();
    const l = s.links.find((x) => x.slug === slug && x.active);
    if (!l) return;
    s.events.push({ catalogId: l.catalogId, slug, kind, item, at: nowISO() });
    this.write(s);
  }
}

let repo: CatalogRepository | null = null;
export function catalogRepository(): CatalogRepository {
  repo ??= usesSupabase ? new SupabaseCatalogRepository() : new LocalCatalogRepository();
  return repo;
}

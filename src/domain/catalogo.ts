/**
 * Catálogo digital (vitrine para o cliente).
 *
 * Regra fundamental: cada produto do catálogo guarda uma CÓPIA dos dados comerciais
 * (nome, descrição, foto, preços). A origem (peça do orçamento ou peça pronta) fica só
 * como referência: editar o catálogo nunca altera o orçamento, e mudar/excluir o
 * orçamento não estraga o catálogo. Cada catálogo é independente dos outros.
 *
 * A publicação é uma FOTOGRAFIA pública (publicSnapshot) só com o que o cliente vê:
 * sem origem, custos, margens ou qualquer dado interno.
 */
import type { ID, ISODate, ISODateTime } from './types';
import type { DecStr } from './money';
import { D, cents } from './money';
import { BusinessError, assert, newId, nowISO, requireText } from './core';
import { CATALOG_THEMES, themeOf, type ThemeId } from './catalogThemes';

/* ---------------------------------------------------------------- tipos */
export const BADGES = ['MAIS VENDIDO', 'LANÇAMENTO', 'OFERTA ESPECIAL', 'EXCLUSIVO', 'ÚLTIMAS UNIDADES', 'COMBO PROMOCIONAL', 'PRESENTE IDEAL', 'DESTAQUE'] as const;
export const SECTION_PRESETS = ['Destaques', 'Ofertas especiais', 'Kits promocionais', 'Mais vendidos', 'Novidades', 'Produtos selecionados'] as const;

export type CatalogSource = { kind: 'orcamento'; quoteId: ID; itemId: ID; label: string } | { kind: 'estoque'; finishedGoodId: ID; label: string };

export interface CatalogProduct {
  id: ID;
  /** De onde veio (só referência interna; nunca vai para a página pública). */
  source?: CatalogSource;
  name: string;
  description: string;
  image: string | null;
  originalPrice: DecStr | null;
  promoPrice: DecStr | null;
  showPrice: boolean;
  badge: string | null;
}

export interface CatalogKit {
  id: ID;
  name: string;
  description: string;
  productIds: ID[];
  image: string | null;
  /** Preço de referência ("De"): por padrão, a soma dos produtos. */
  referencePrice: DecStr | null;
  promoPrice: DecStr | null;
  showPrice: boolean;
  badge: string | null;
}

export interface CatalogBanner { title: string; subtitle: string; image: string | null }

export type SectionEntry = { type: 'produto' | 'kit'; id: ID };
export interface CatalogSection {
  id: ID;
  title: string;
  /** Banner exibido antes da seção (opcional). */
  banner: CatalogBanner | null;
  entries: SectionEntry[];
}

export interface CatalogContact { whatsapp: string; phone: string; instagram: string; email: string; site: string }

export interface CatalogSettings {
  storeName: string;
  logo: string | null;
  cover: string | null;
  intro: string;
  /** Cores próprias (vazias = cores da temática). */
  primaryColor: string | null;
  accentColor: string | null;
  headerBanner: CatalogBanner | null;
  contact: CatalogContact;
  /** Validade da campanha (informativa, exibida ao cliente). */
  campaignUntil: ISODate | null;
}

export interface CatalogDoc {
  version: 1;
  settings: CatalogSettings;
  sections: CatalogSection[];
  products: CatalogProduct[];
  kits: CatalogKit[];
}

export type CatalogStatus = 'rascunho' | 'publicado' | 'expirado';

export interface CatalogLink {
  slug: string;
  expiresAt: ISODateTime | null;
  active: boolean;
  publishedAt: ISODateTime;
  revokedAt: ISODateTime | null;
}

export interface CatalogStats { visits: number; productViews: number; contacts: number; shares: number; lastVisit: ISODateTime | null }

export interface CatalogRecord {
  id: ID;
  name: string;
  theme: ThemeId;
  data: CatalogDoc;
  status: CatalogStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** Links (o ativo e os antigos), do mais novo para o mais antigo. */
  links: CatalogLink[];
  stats?: CatalogStats;
}

/* ---------------------------------------------------------------- criação */
export function emptyCatalogDoc(storeName: string): CatalogDoc {
  const section = (title: string): CatalogSection => ({ id: newId(), title, banner: null, entries: [] });
  return {
    version: 1,
    settings: {
      storeName, logo: null, cover: null, intro: '', primaryColor: null, accentColor: null, headerBanner: null,
      contact: { whatsapp: '', phone: '', instagram: '', email: '', site: '' }, campaignUntil: null,
    },
    sections: [section('Destaques'), section('Produtos selecionados')],
    products: [], kits: [],
  };
}

export function newCatalog(input: { name: string; theme: string; storeName: string }): CatalogRecord {
  const name = requireText(input.name, 'o nome do catálogo');
  assert(name.length <= 120, 'Nome do catálogo muito longo (máximo 120 caracteres).');
  assert(CATALOG_THEMES.some((t) => t.id === input.theme), 'Escolha uma temática.');
  const now = nowISO();
  return { id: newId(), name, theme: input.theme as ThemeId, data: emptyCatalogDoc(input.storeName), status: 'rascunho', createdAt: now, updatedAt: now, links: [] };
}

/** Duplica: copia produtos, kits, seções, banners e visual. Começa como rascunho, sem link. */
export function duplicateCatalog(rec: CatalogRecord, name?: string): CatalogRecord {
  const now = nowISO();
  return {
    id: newId(), name: (name?.trim() || `${rec.name} (cópia)`).slice(0, 120), theme: rec.theme, data: structuredClone(rec.data),
    status: 'rascunho', createdAt: now, updatedAt: now, links: [],
  };
}

/** Situação real: publicado com validade vencida conta como expirado. */
export function catalogStatus(rec: Pick<CatalogRecord, 'status' | 'links'>, now = new Date()): CatalogStatus {
  const link = activeLink(rec);
  if (link) return link.expiresAt && new Date(link.expiresAt) <= now ? 'expirado' : 'publicado';
  return rec.links.length ? 'expirado' : 'rascunho';
}
export const activeLink = (rec: Pick<CatalogRecord, 'links'>) => rec.links.find((l) => l.active) ?? null;

/* ---------------------------------------------------------------- produtos */
/* Peças candidatas (orçamentos e estoque): catalogoFontes.ts — separado para a página pública não carregar o orçamento. */
export function addProducts(doc: CatalogDoc, products: CatalogProduct[], sectionId?: ID) {
  assert(products.length > 0, 'Escolha ao menos um produto.');
  if (!doc.sections.length) doc.sections.push({ id: newId(), title: 'Produtos selecionados', banner: null, entries: [] });
  const section = doc.sections.find((s) => s.id === sectionId) ?? doc.sections[doc.sections.length - 1];
  for (const p of products) {
    doc.products.push(p);
    section.entries.push({ type: 'produto', id: p.id });
  }
}

const price = (v: DecStr | null | undefined, label: string): DecStr | null => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const d = cents(D(v));
  assert(!d.isNegative(), `${label} não pode ser negativo.`);
  return d.toString();
};

export function updateProduct(doc: CatalogDoc, id: ID, patch: Partial<Omit<CatalogProduct, 'id' | 'source'>>) {
  const p = doc.products.find((x) => x.id === id);
  if (!p) throw new BusinessError('Produto não encontrado no catálogo.');
  if (patch.name !== undefined) p.name = requireText(patch.name, 'o nome do produto');
  if (patch.description !== undefined) p.description = patch.description;
  if (patch.image !== undefined) p.image = patch.image;
  if (patch.showPrice !== undefined) p.showPrice = patch.showPrice;
  if (patch.badge !== undefined) p.badge = patch.badge?.trim() ? patch.badge.trim().slice(0, 40) : null;
  if (patch.originalPrice !== undefined) p.originalPrice = price(patch.originalPrice, 'Preço original');
  if (patch.promoPrice !== undefined) p.promoPrice = price(patch.promoPrice, 'Preço promocional');
  return p;
}

/** Remove o produto do catálogo (e dos kits em que aparece). */
export function removeProduct(doc: CatalogDoc, id: ID) {
  doc.products = doc.products.filter((p) => p.id !== id);
  for (const s of doc.sections) s.entries = s.entries.filter((e) => !(e.type === 'produto' && e.id === id));
  for (const k of doc.kits) k.productIds = k.productIds.filter((x) => x !== id);
}

/* ---------------------------------------------------------------- ordem e seções */
export function moveEntry(doc: CatalogDoc, sectionId: ID, index: number, delta: -1 | 1) {
  const s = doc.sections.find((x) => x.id === sectionId);
  if (!s) return;
  const j = index + delta;
  if (j < 0 || j >= s.entries.length) return;
  [s.entries[index], s.entries[j]] = [s.entries[j], s.entries[index]];
}

/** Leva um produto/kit para outra seção (no fim dela). */
export function moveEntryToSection(doc: CatalogDoc, entry: SectionEntry, toSectionId: ID) {
  const to = doc.sections.find((x) => x.id === toSectionId);
  if (!to) return;
  for (const s of doc.sections) s.entries = s.entries.filter((e) => !(e.type === entry.type && e.id === entry.id));
  to.entries.push(entry);
}

export function addSection(doc: CatalogDoc, title: string): CatalogSection {
  const s: CatalogSection = { id: newId(), title: requireText(title, 'o nome da seção').slice(0, 80), banner: null, entries: [] };
  doc.sections.push(s);
  return s;
}

export function moveSection(doc: CatalogDoc, index: number, delta: -1 | 1) {
  const j = index + delta;
  if (j < 0 || j >= doc.sections.length) return;
  [doc.sections[index], doc.sections[j]] = [doc.sections[j], doc.sections[index]];
}

/** Remove a seção; os produtos e kits dela passam para a primeira seção que sobrar. */
export function removeSection(doc: CatalogDoc, id: ID) {
  assert(doc.sections.length > 1, 'O catálogo precisa ter ao menos uma seção.');
  const s = doc.sections.find((x) => x.id === id);
  if (!s) return;
  doc.sections = doc.sections.filter((x) => x.id !== id);
  doc.sections[0].entries.push(...s.entries);
}

/* ---------------------------------------------------------------- kits */
export function kitReferencePrice(doc: CatalogDoc, productIds: ID[]): DecStr | null {
  const prices = productIds.map((id) => doc.products.find((p) => p.id === id)?.originalPrice);
  if (!prices.length || prices.some((p) => !p)) return null;
  return cents(prices.reduce((a, p) => a.plus(D(p!)), D(0))).toString();
}

export function saveKit(doc: CatalogDoc, input: Omit<CatalogKit, 'id'> & { id?: ID }, sectionId?: ID): CatalogKit {
  const name = requireText(input.name, 'o nome do kit');
  const ids = [...new Set(input.productIds)].filter((id) => doc.products.some((p) => p.id === id));
  assert(ids.length >= 2, 'Um kit precisa de ao menos dois produtos do catálogo.');
  const kit: CatalogKit = {
    id: input.id ?? newId(), name, description: input.description ?? '', productIds: ids, image: input.image ?? null,
    referencePrice: price(input.referencePrice, 'Preço de referência') ?? kitReferencePrice(doc, ids),
    promoPrice: price(input.promoPrice, 'Preço promocional'), showPrice: input.showPrice, badge: input.badge?.trim() || null,
  };
  const existing = doc.kits.findIndex((k) => k.id === kit.id);
  if (existing >= 0) { doc.kits[existing] = kit; return kit; }
  doc.kits.push(kit);
  const section = doc.sections.find((s) => s.id === sectionId) ?? doc.sections.find((s) => /kit/i.test(s.title)) ?? doc.sections[0];
  section.entries.push({ type: 'kit', id: kit.id });
  return kit;
}

export function removeKit(doc: CatalogDoc, id: ID) {
  doc.kits = doc.kits.filter((k) => k.id !== id);
  for (const s of doc.sections) s.entries = s.entries.filter((e) => !(e.type === 'kit' && e.id === id));
}

/** Desconto de um preço promocional em relação ao original (ex.: 0.2 = 20%). */
export function discountOf(original: DecStr | null, promo: DecStr | null): number | null {
  if (!original || !promo) return null;
  const o = D(original), p = D(promo);
  if (o.lte(0) || p.gte(o)) return null;
  return o.minus(p).div(o).toNumber();
}

/* ---------------------------------------------------------------- publicação */
/** O que o cliente vê. Nada de origem, custos ou dados internos; preço só quando "exibir preço". */
export interface PublicItem {
  type: 'produto' | 'kit';
  id: ID;
  name: string;
  description: string;
  image: string | null;
  price: DecStr | null;
  promoPrice: DecStr | null;
  badge: string | null;
  /** Kit: nomes dos produtos que compõem. */
  includes?: string[];
}
export interface PublicCatalog {
  name: string;
  theme: ThemeId;
  settings: Omit<CatalogSettings, 'primaryColor' | 'accentColor'> & { primaryColor: string | null; accentColor: string | null };
  sections: { id: ID; title: string; banner: CatalogBanner | null; items: PublicItem[] }[];
  publishedAt: ISODateTime;
}

export function publicSnapshot(rec: CatalogRecord): PublicCatalog {
  const d = rec.data;
  const items = (s: CatalogSection): PublicItem[] => s.entries.flatMap((e): PublicItem[] => {
    if (e.type === 'produto') {
      const p = d.products.find((x) => x.id === e.id);
      if (!p) return [];
      return [{ type: 'produto', id: p.id, name: p.name, description: p.description, image: p.image, price: p.showPrice ? p.originalPrice : null, promoPrice: p.showPrice ? p.promoPrice : null, badge: p.badge }];
    }
    const k = d.kits.find((x) => x.id === e.id);
    if (!k) return [];
    return [{
      type: 'kit', id: k.id, name: k.name, description: k.description, image: k.image ?? d.products.find((p) => p.id === k.productIds[0])?.image ?? null,
      price: k.showPrice ? k.referencePrice : null, promoPrice: k.showPrice ? k.promoPrice : null, badge: k.badge,
      includes: k.productIds.map((id) => d.products.find((p) => p.id === id)?.name).filter(Boolean) as string[],
    }];
  });
  return {
    name: rec.name, theme: rec.theme, settings: structuredClone(d.settings),
    sections: d.sections.map((s) => ({ id: s.id, title: s.title, banner: s.banner, items: items(s) })).filter((s) => s.items.length || s.banner),
    publishedAt: nowISO(),
  };
}

/** Problemas que impedem publicar (catálogo vazio, produto sem nome...). */
export function publishProblems(rec: CatalogRecord): string[] {
  const out: string[] = [];
  if (!rec.data.products.length && !rec.data.kits.length) out.push('Adicione ao menos um produto.');
  if (rec.data.products.some((p) => !p.name.trim())) out.push('Há produto sem nome.');
  const c = rec.data.settings.contact;
  if (!c.whatsapp && !c.phone && !c.instagram && !c.email && !c.site) out.push('Informe ao menos um contato (WhatsApp, telefone, Instagram, e-mail ou site) para o cliente falar com você.');
  return out;
}

/** Link aleatório e não sequencial (12 caracteres a-z0-9, ~62 bits). */
export function randomSlug(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Número de WhatsApp só com dígitos, com DDI do Brasil quando faltar. */
export function whatsappNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
}

export const themeName = (id: string) => themeOf(id).name;

/**
 * Desenho do catálogo para o cliente. O mesmo componente é usado na pré-visualização do
 * editor e na página pública, então o operador vê exatamente o que o cliente vai ver.
 * Usa só os dados da publicação (PublicCatalog): nada interno chega aqui.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { PublicCatalog, PublicItem } from '../../domain/catalogo';
import { discountOf, whatsappNumber } from '../../domain/catalogo';
import { themeFontsHref, themeOf } from '../../domain/catalogThemes';
import { D, fmtBRL } from '../../domain/money';
import './catalog.css';

export type ViewEvent = { kind: 'produto' | 'contato' | 'compartilhar'; itemId?: string };

/** Carrega as fontes da temática uma vez por página. */
function useThemeFonts(href: string) {
  useEffect(() => {
    if (document.querySelector(`link[data-cv-font="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.dataset.cvFont = href;
    document.head.appendChild(l);
  }, [href]);
}

/** Foto: data URL direto; referência (img:…) é buscada pela função de carregar fotos. */
function Img({ src, alt, load, className }: { src: string | null; alt: string; load?: (ref: string) => Promise<string | null>; className?: string }) {
  const [url, setUrl] = useState<string | null>(src && !src.startsWith('img:') ? src : null);
  useEffect(() => {
    let alive = true;
    if (!src) { setUrl(null); return; }
    if (!src.startsWith('img:')) { setUrl(src); return; }
    load?.(src).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [src, load]);
  return url ? <img src={url} alt={alt} className={className} loading="lazy" /> : <div className={`cv-img-ph ${className ?? ''}`} aria-hidden="true" />;
}

function Badge({ text, shape }: { text: string; shape: string }) {
  return <span className={`cv-badge cv-badge-${shape}`}>{text}</span>;
}

function Price({ price, promo }: { price: string | null; promo: string | null }) {
  if (!price && !promo) return <div className="cv-price"><span className="cv-ask">Consulte o valor</span></div>;
  const off = discountOf(price, promo);
  if (promo && price && off) {
    return (
      <div className="cv-price">
        <span className="cv-from">De {fmtBRL(price)}</span>
        <span className="cv-now">por <b>{fmtBRL(promo)}</b></span>
        <span className="cv-off">−{Math.round(off * 100)}%</span>
      </div>
    );
  }
  return <div className="cv-price"><span className="cv-now"><b>{fmtBRL(promo ?? price)}</b></span></div>;
}

export function CatalogView({ catalog, load, onEvent, shareUrl, frame }: {
  catalog: PublicCatalog;
  /** Busca foto por referência (página pública). */
  load?: (ref: string) => Promise<string | null>;
  onEvent?: (e: ViewEvent) => void;
  /** Endereço do catálogo publicado (para compartilhar produtos). */
  shareUrl?: string;
  /** Dentro do editor: botões não abrem links. */
  frame?: boolean;
}) {
  const t = themeOf(catalog.theme);
  const s = catalog.settings;
  useThemeFonts(themeFontsHref(t));
  const [open, setOpen] = useState<PublicItem | null>(null);
  const style = {
    '--cv-bg': t.colors.bg, '--cv-surface': t.colors.surface, '--cv-text': t.colors.text, '--cv-muted': t.colors.muted, '--cv-border': t.colors.border,
    '--cv-primary': s.primaryColor || t.colors.primary, '--cv-on-primary': t.colors.onPrimary, '--cv-accent': s.accentColor || t.colors.accent,
    '--cv-on-accent': t.colors.onAccent, '--cv-price': s.primaryColor || t.colors.price, '--cv-hero': t.hero,
    '--cv-font-heading': `'${t.fonts.heading}', '${t.fonts.body}', system-ui, sans-serif`, '--cv-font-body': `'${t.fonts.body}', system-ui, sans-serif`,
  } as CSSProperties;
  const wa = whatsappNumber(s.contact.whatsapp);
  const contactHref = (item?: PublicItem) => {
    const msg = item ? `Olá! Vi no catálogo "${catalog.name}" e tenho interesse em: ${item.name}.` : `Olá! Vi o catálogo "${catalog.name}" e gostaria de mais informações.`;
    if (wa) return `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`;
    if (s.contact.phone) return `tel:${s.contact.phone.replace(/[^\d+]/g, '')}`;
    if (s.contact.instagram) return `https://instagram.com/${s.contact.instagram.replace(/^@/, '')}`;
    if (s.contact.email) return `mailto:${s.contact.email}?subject=${encodeURIComponent(catalog.name)}&body=${encodeURIComponent(msg)}`;
    if (s.contact.site) return /^https?:\/\//.test(s.contact.site) ? s.contact.site : `https://${s.contact.site}`;
    return null;
  };
  const contact = (item?: PublicItem) => {
    const href = contactHref(item);
    onEvent?.({ kind: 'contato', itemId: item?.id });
    if (href && !frame) window.open(href, '_blank', 'noopener');
  };
  const share = async (item?: PublicItem) => {
    onEvent?.({ kind: 'compartilhar', itemId: item?.id });
    if (frame || !shareUrl) return;
    const url = item ? `${shareUrl}#p-${item.id}` : shareUrl;
    const text = item ? `${item.name} — ${catalog.name}` : catalog.name;
    try {
      if (navigator.share) await navigator.share({ title: text, url });
      else { await navigator.clipboard.writeText(url); alert('Link copiado!'); }
    } catch { /* cancelado */ }
  };
  const openItem = (item: PublicItem) => { setOpen(item); onEvent?.({ kind: 'produto', itemId: item.id }); };
  // Link de produto compartilhado (#p-<id>): abre direto o produto.
  useEffect(() => {
    if (frame) return;
    const id = window.location.hash.startsWith('#p-') ? window.location.hash.slice(3) : null;
    const item = id ? catalog.sections.flatMap((x) => x.items).find((x) => x.id === id) : undefined;
    if (item) openItem(item);
  }, []);
  const orn = t.ornaments;
  const anyContact = !!contactHref();

  const card = (item: PublicItem): ReactNode => (
    <article key={item.id} id={`p-${item.id}`} className={`cv-card${item.type === 'kit' ? ' cv-kit' : ''}`}>
      <button type="button" className="cv-card-open" onClick={() => openItem(item)} aria-label={`Ver ${item.name}`}>
        <div className="cv-media">
          <Img src={item.image} alt={item.name} load={load} />
          {item.badge && <Badge text={item.badge} shape={t.badgeShape} />}
          {item.type === 'kit' && <span className="cv-kit-tag">KIT</span>}
        </div>
        <div className="cv-info">
          <h3>{item.name}</h3>
          {item.type === 'kit' && item.includes?.length ? <p className="cv-includes">{item.includes.join(' + ')}</p> : null}
          {item.description && <p className="cv-desc">{item.description}</p>}
          <Price price={item.price} promo={item.promoPrice} />
          {item.type === 'kit' && item.price && item.promoPrice && D(item.promoPrice).lt(item.price) && <p className="cv-save">Economize {fmtBRL(D(item.price).minus(item.promoPrice))}</p>}
        </div>
      </button>
      <div className="cv-actions">
        {anyContact && <button type="button" className="cv-btn" onClick={() => contact(item)}>{wa ? 'Quero este' : 'Tenho interesse'}</button>}
        <button type="button" className="cv-btn cv-btn-ghost" onClick={() => share(item)} aria-label={`Compartilhar ${item.name}`}>Compartilhar</button>
      </div>
    </article>
  );

  return (
    <div className={`cv-root${frame ? ' cv-frame' : ''}`}><div className="cv" style={style}>
      <header className="cv-hero">
        {s.cover ? <Img src={s.cover} alt="" load={load} className="cv-cover" /> : null}
        <div className="cv-hero-shade" />
        {orn.length > 0 && <div className="cv-orn" aria-hidden="true">{orn.map((o, i) => <span key={i} className={`cv-orn-${i}`}>{o}</span>)}</div>}
        <div className="cv-hero-in">
          {s.logo ? <Img src={s.logo} alt={s.storeName} load={load} className="cv-logo" /> : null}
          {s.storeName && <p className="cv-store">{s.storeName}</p>}
          <h1>{catalog.name}</h1>
          {s.intro && <p className="cv-intro">{s.intro}</p>}
          {s.campaignUntil && <p className="cv-until">Ofertas válidas até {new Date(s.campaignUntil + 'T12:00:00').toLocaleDateString('pt-BR')}</p>}
        </div>
      </header>

      {s.headerBanner && (s.headerBanner.title || s.headerBanner.image) && <Banner banner={s.headerBanner} load={load} ornament={orn[0]} big />}

      <main className="cv-main">
        {catalog.sections.map((sec) => (
          <section key={sec.id} className="cv-section">
            {sec.banner && (sec.banner.title || sec.banner.image) && <Banner banner={sec.banner} load={load} ornament={orn[1] ?? orn[0]} />}
            {sec.items.length > 0 && <>
              <h2 className="cv-sec-title">{orn[2] ? <span aria-hidden="true">{orn[2]} </span> : null}{sec.title}</h2>
              <div className="cv-grid">{sec.items.map(card)}</div>
            </>}
          </section>
        ))}
        {!catalog.sections.length && <p className="cv-empty">Nenhum produto neste catálogo ainda.</p>}
      </main>

      <footer className="cv-foot">
        {s.storeName && <b>{s.storeName}</b>}
        <div className="cv-contacts">
          {s.contact.whatsapp && <span>WhatsApp {s.contact.whatsapp}</span>}
          {s.contact.phone && <span>Tel. {s.contact.phone}</span>}
          {s.contact.instagram && <span>Instagram {s.contact.instagram.startsWith('@') ? s.contact.instagram : `@${s.contact.instagram}`}</span>}
          {s.contact.email && <span>{s.contact.email}</span>}
          {s.contact.site && <span>{s.contact.site}</span>}
        </div>
        {shareUrl && <button type="button" className="cv-btn cv-btn-ghost" onClick={() => share()}>Compartilhar catálogo</button>}
      </footer>

      {anyContact && <button type="button" className={`cv-fab${wa ? ' cv-fab-wa' : ''}`} onClick={() => contact()} aria-label={wa ? 'Falar no WhatsApp' : 'Falar com a loja'}>
        {wa ? <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 2.9 2.9 0 00-.9 2.2 5 5 0 001 2.7 11.5 11.5 0 004.4 3.9c1.6.7 2.3.8 3.1.6a2.7 2.7 0 001.8-1.2 2.2 2.2 0 00.2-1.2c-.1-.1-.3-.2-.6-.3z" /></svg> : 'Contato'}
      </button>}

      {open && (
        <div className="cv-modal" role="dialog" aria-modal="true" aria-label={open.name} onClick={() => setOpen(null)}>
          <div className="cv-modal-box" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="cv-close" onClick={() => setOpen(null)} aria-label="Fechar">×</button>
            <div className="cv-media cv-media-lg"><Img src={open.image} alt={open.name} load={load} />{open.badge && <Badge text={open.badge} shape={t.badgeShape} />}</div>
            <div className="cv-info">
              <h3>{open.name}</h3>
              {open.type === 'kit' && open.includes?.length ? <p className="cv-includes">Inclui: {open.includes.join(' + ')}</p> : null}
              {open.description && <p className="cv-desc cv-desc-full">{open.description}</p>}
              <Price price={open.price} promo={open.promoPrice} />
              <div className="cv-actions">
                {anyContact && <button type="button" className="cv-btn" onClick={() => contact(open)}>{wa ? 'Pedir pelo WhatsApp' : 'Tenho interesse'}</button>}
                <button type="button" className="cv-btn cv-btn-ghost" onClick={() => share(open)}>Compartilhar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div></div>
  );
}

function Banner({ banner, load, ornament, big }: { banner: NonNullable<PublicCatalog['settings']['headerBanner']>; load?: (ref: string) => Promise<string | null>; ornament?: string; big?: boolean }) {
  return (
    <div className={`cv-banner${big ? ' cv-banner-big' : ''}${banner.image ? ' cv-banner-img' : ''}`}>
      {banner.image && <Img src={banner.image} alt="" load={load} className="cv-banner-bg" />}
      <div className="cv-banner-in">
        {ornament && <span className="cv-banner-orn" aria-hidden="true">{ornament}</span>}
        {banner.title && <strong>{banner.title}</strong>}
        {banner.subtitle && <span>{banner.subtitle}</span>}
      </div>
    </div>
  );
}

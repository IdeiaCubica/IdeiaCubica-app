/**
 * Desenho do catálogo para o cliente. O mesmo componente é usado na pré-visualização do
 * editor e na página pública, então o operador vê exatamente o que o cliente vai ver.
 * Usa só os dados da publicação (PublicCatalog): nada interno chega aqui.
 *
 * Carrinho: o cliente escolhe produtos e kits, vê o total previsto (com o desconto por valor
 * mínimo) e envia a lista pelo WhatsApp. O carrinho fica só no navegador do cliente.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { CartLine, PublicCatalog, PublicItem } from '../../domain/catalogo';
import { cartMessage, cartTotals, discountOf, itemUnitPrice, whatsappNumber, withDefaults } from '../../domain/catalogo';
import { resolveTheme, themeFontsHref } from '../../domain/catalogThemes';
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

const WaIcon = ({ size = 26 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 2.9 2.9 0 00-.9 2.2 5 5 0 001 2.7 11.5 11.5 0 004.4 3.9c1.6.7 2.3.8 3.1.6a2.7 2.7 0 001.8-1.2 2.2 2.2 0 00.2-1.2c-.1-.1-.3-.2-.6-.3z" /></svg>
);

/** Carrinho guardado só neste navegador (conveniência do cliente; nada vai para o servidor). */
function useCart(key: string | null) {
  const [cart, setCart] = useState<Record<string, number>>(() => {
    if (!key) return {};
    try { return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>; } catch { return {}; }
  });
  useEffect(() => { if (key) try { localStorage.setItem(key, JSON.stringify(cart)); } catch { /* sem armazenamento */ } }, [key, cart]);
  const set = (id: string, qty: number) => setCart((c) => { const n = { ...c }; if (qty > 0) n[id] = Math.min(999, qty); else delete n[id]; return n; });
  return { cart, set, clear: () => setCart({}) };
}

export function CatalogView({ catalog, load, onEvent, shareUrl, frame }: {
  catalog: PublicCatalog;
  /** Busca foto por referência (página pública). */
  load?: (ref: string) => Promise<string | null>;
  onEvent?: (e: ViewEvent) => void;
  /** Endereço do catálogo publicado (para compartilhar produtos). */
  shareUrl?: string;
  /** Dentro do editor: botões não abrem links e o carrinho não é guardado. */
  frame?: boolean;
}) {
  const s = useMemo(() => withDefaults({ settings: { ...catalog.settings } }).settings, [catalog.settings]);
  const t = resolveTheme(catalog.theme, s.custom);
  useThemeFonts(themeFontsHref(t));
  const [open, setOpen] = useState<PublicItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [note, setNote] = useState('');
  const { cart, set: setQty, clear } = useCart(frame || !shareUrl ? null : `cv-carrinho:${shareUrl}`);
  const allItems = useMemo(() => catalog.sections.flatMap((x) => x.items), [catalog.sections]);
  const lines: CartLine[] = allItems.filter((i) => cart[i.id]).map((i) => ({ id: i.id, name: i.name, type: i.type, qty: cart[i.id], unitPrice: itemUnitPrice(i) }));
  const totals = cartTotals(lines, s.cart);
  const cartOn = s.cart.enabled;
  const discountText = s.cart.discountAbove && s.cart.discountPct && D(s.cart.discountPct).gt(0)
    ? `Pedidos acima de ${fmtBRL(s.cart.discountAbove)} ganham ${D(s.cart.discountPct).toString().replace('.', ',')}% de desconto` : null;

  const style = {
    '--cv-bg': t.colors.bg, '--cv-surface': t.colors.surface, '--cv-text': t.colors.text, '--cv-muted': t.colors.muted, '--cv-border': t.colors.border,
    '--cv-primary': s.primaryColor || t.colors.primary, '--cv-on-primary': t.colors.onPrimary, '--cv-accent': s.accentColor || t.colors.accent,
    '--cv-on-accent': t.colors.onAccent, '--cv-price': s.primaryColor || t.colors.price, '--cv-hero': t.hero,
    '--cv-font-heading': `'${t.fonts.heading}', '${t.fonts.body}', system-ui, sans-serif`, '--cv-font-body': `'${t.fonts.body}', system-ui, sans-serif`,
  } as CSSProperties;
  const wa = whatsappNumber(s.contact.whatsapp);
  const contactHref = (msg: string) => {
    if (wa) return `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`;
    if (s.contact.phone) return `tel:${s.contact.phone.replace(/[^\d+]/g, '')}`;
    if (s.contact.instagram) return `https://instagram.com/${s.contact.instagram.replace(/^@/, '')}`;
    if (s.contact.email) return `mailto:${s.contact.email}?subject=${encodeURIComponent(catalog.name)}&body=${encodeURIComponent(msg)}`;
    if (s.contact.site) return /^https?:\/\//.test(s.contact.site) ? s.contact.site : `https://${s.contact.site}`;
    return null;
  };
  const anyContact = !!contactHref('');
  const go = (msg: string, itemId?: string) => {
    onEvent?.({ kind: 'contato', itemId });
    const href = contactHref(msg);
    if (!href || frame) return;
    // Sem WhatsApp, a mensagem vai para a área de transferência para o cliente colar no contato.
    if (!wa) navigator.clipboard?.writeText(msg).catch(() => undefined);
    window.open(href, '_blank', 'noopener');
  };
  const contactItem = (item?: PublicItem) => go(item ? `Olá! Vi no catálogo "${catalog.name}" e tenho interesse em: ${item.name}.` : `Olá! Vi o catálogo "${catalog.name}" e gostaria de mais informações.`, item?.id);
  const sendCart = () => go(cartMessage(catalog.name, lines, s.cart, note), 'carrinho');
  const askCustom = () => go(`Olá! Vi o catálogo "${catalog.name}" e gostaria de um produto PERSONALIZADO. Minha ideia é: `, 'personalizado');
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
    const item = id ? allItems.find((x) => x.id === id) : undefined;
    if (item) openItem(item);
  }, []);
  const orn = t.ornaments;

  /** Botão do carrinho: "Adicionar" ou o seletor de quantidade. */
  const CartButton = ({ item, big }: { item: PublicItem; big?: boolean }) => {
    const q = cart[item.id] ?? 0;
    if (!q) return <button type="button" className={`cv-btn${big ? ' cv-btn-big' : ''}`} onClick={() => setQty(item.id, 1)}>Adicionar ao pedido</button>;
    return (
      <div className="cv-stepper" role="group" aria-label={`Quantidade de ${item.name}`}>
        <button type="button" onClick={() => setQty(item.id, q - 1)} aria-label="Menos um">−</button>
        <span aria-live="polite">{q} no pedido</span>
        <button type="button" onClick={() => setQty(item.id, q + 1)} aria-label="Mais um">+</button>
      </div>
    );
  };

  const card = (item: PublicItem): ReactNode => (
    <article key={item.id} id={`p-${item.id}`} className={`cv-card${item.type === 'kit' ? ' cv-kit' : ''}${cart[item.id] ? ' cv-in-cart' : ''}`}>
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
        {cartOn ? <CartButton item={item} /> : anyContact && <button type="button" className="cv-btn" onClick={() => contactItem(item)}>{wa ? 'Quero este' : 'Tenho interesse'}</button>}
        <button type="button" className="cv-btn cv-btn-ghost cv-btn-icon" onClick={() => share(item)} aria-label={`Compartilhar ${item.name}`} title="Compartilhar">↗</button>
      </div>
    </article>
  );

  const showBar = cartOn && totals.pieces > 0;
  return (
    <div className={`cv-root${frame ? ' cv-frame' : ''}`}><div className={`cv${showBar ? ' cv-has-bar' : ''}`} style={style}>
      {t.backgroundImage && <Img src={t.backgroundImage} alt="" load={load} className="cv-bgimg" />}
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
          {cartOn && discountText && <p className="cv-until cv-promo">🎁 {discountText}</p>}
        </div>
      </header>

      {s.headerBanner && (s.headerBanner.title || s.headerBanner.image) && <Banner banner={s.headerBanner} load={load} ornament={orn[0]} big />}

      {s.customRequest.enabled && anyContact && (
        <div className="cv-custom">
          <p>{s.customRequest.text || 'Quer uma peça do seu jeito?'}</p>
          <button type="button" className="cv-btn cv-btn-custom" onClick={askCustom}>{wa && <WaIcon size={18} />} PERSONALIZADO</button>
        </div>
      )}

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

      {showBar && (
        <button type="button" className="cv-cartbar" onClick={() => setCartOpen(true)}>
          <span className="cv-cartbar-n">🛒 {totals.pieces} {totals.pieces === 1 ? 'item' : 'itens'}</span>
          <span className="cv-cartbar-total"><b>{fmtBRL(totals.total)}</b>{totals.eligible && <small> com desconto</small>}{totals.toQuote ? <small> + a combinar</small> : null}</span>
          <span className="cv-cartbar-go">Ver pedido</span>
        </button>
      )}

      {anyContact && <button type="button" className={`cv-fab${wa ? ' cv-fab-wa' : ''}`} onClick={() => contactItem()} aria-label={wa ? 'Falar no WhatsApp' : 'Falar com a loja'}>
        {wa ? <WaIcon /> : 'Contato'}
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
                {cartOn ? <CartButton item={open} big /> : anyContact && <button type="button" className="cv-btn" onClick={() => contactItem(open)}>{wa ? 'Pedir pelo WhatsApp' : 'Tenho interesse'}</button>}
                <button type="button" className="cv-btn cv-btn-ghost" onClick={() => share(open)}>Compartilhar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {cartOpen && (
        <div className="cv-modal" role="dialog" aria-modal="true" aria-label="Meu pedido" onClick={() => setCartOpen(false)}>
          <div className="cv-modal-box cv-cart" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="cv-close" onClick={() => setCartOpen(false)} aria-label="Fechar">×</button>
            <h3>Meu pedido</h3>
            {lines.length === 0 ? <p className="cv-desc">Seu pedido está vazio. Toque em “Adicionar ao pedido” nos produtos.</p> : <>
              <ul className="cv-cart-lines">
                {lines.map((l) => (
                  <li key={l.id}>
                    <div className="cv-cart-name"><b>{l.name}</b>{l.type === 'kit' && <span className="cv-kit-mini">KIT</span>}
                      <small>{l.unitPrice ? `${fmtBRL(l.unitPrice)} cada` : 'valor a combinar'}</small></div>
                    <div className="cv-stepper cv-stepper-sm">
                      <button type="button" onClick={() => setQty(l.id, l.qty - 1)} aria-label={`Menos um ${l.name}`}>−</button>
                      <span>{l.qty}</span>
                      <button type="button" onClick={() => setQty(l.id, l.qty + 1)} aria-label={`Mais um ${l.name}`}>+</button>
                    </div>
                    <b className="cv-cart-sub">{l.unitPrice ? fmtBRL(D(l.unitPrice).times(l.qty)) : '—'}</b>
                  </li>
                ))}
              </ul>
              <dl className="cv-cart-sum">
                <dt>Subtotal</dt><dd>{fmtBRL(totals.subtotal)}</dd>
                {totals.eligible && <><dt>Desconto ({D(s.cart.discountPct!).toString().replace('.', ',')}%)</dt><dd className="cv-cart-disc">− {fmtBRL(totals.discount)}</dd></>}
                <dt className="cv-cart-total">Total previsto</dt><dd className="cv-cart-total">{fmtBRL(totals.total)}</dd>
              </dl>
              {totals.toQuote > 0 && <p className="cv-desc">+ {totals.toQuote} item(ns) com valor a combinar com a loja.</p>}
              {discountText && (totals.eligible
                ? <p className="cv-cart-ok">🎉 Você ganhou {D(s.cart.discountPct!).toString().replace('.', ',')}% de desconto!</p>
                : totals.missing && <p className="cv-cart-hint">Faltam <b>{fmtBRL(totals.missing.plus('0.01'))}</b> para ganhar {D(s.cart.discountPct!).toString().replace('.', ',')}% de desconto.</p>)}
              <label className="cv-note">Observação (cores, nomes, prazo…)<textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={2} /></label>
              <div className="cv-actions">
                {anyContact && <button type="button" className="cv-btn cv-btn-big cv-btn-wa" onClick={sendCart}>{wa ? <><WaIcon size={18} /> Enviar pedido pelo WhatsApp</> : 'Enviar pedido'}</button>}
                <button type="button" className="cv-btn cv-btn-ghost" onClick={clear}>Esvaziar</button>
              </div>
              <p className="cv-desc">O valor é uma previsão: a loja confirma disponibilidade, prazo e pagamento na conversa.</p>
            </>}
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

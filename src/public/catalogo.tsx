/**
 * Página pública do catálogo (/c/<link>). Independente da área administrativa: sem login,
 * sem menus, sem dados internos. O banco confere o link e a validade a cada acesso.
 */
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { catalogRepository, type PublicResult } from '../data/catalogRepo';
import { CatalogView, type ViewEvent } from '../ui/catalogo/CatalogView';

/** /c/<slug> (produção) ou /catalogo.html?c=<slug> (desenvolvimento). */
function slugFromUrl(): string {
  const m = window.location.pathname.match(/\/c\/([a-z0-9]{10,32})\/?$/);
  return m?.[1] ?? new URLSearchParams(window.location.search).get('c') ?? '';
}

/** Endereço de catálogos aberto sem link (ex.: catalogo.ideiacubica.com.br): página da marca, sem login. */
function Home() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#1c1c1c', textAlign: 'center', background: '#f7f7f5' }}>
      <div style={{ maxWidth: 440 }}>
        <img src="/brand/10_icone_simbolo_transparente.svg" alt="" width={96} height={96} />
        <h1 style={{ fontSize: 28, margin: '12px 0 8px' }}>Ideia Cúbica</h1>
        <p style={{ color: '#6b6b6b', lineHeight: 1.5, margin: 0 }}>Peças impressas em 3D, personalizadas para você.</p>
        <p style={{ color: '#6b6b6b', lineHeight: 1.5 }}>Nossos catálogos são enviados por link. Peça o seu para a nossa equipe.</p>
      </div>
    </div>
  );
}

function Unavailable({ expired }: { expired: boolean }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#1c1c1c', textAlign: 'center' }}>
      <div style={{ maxWidth: 420 }}>
        <div style={{ fontSize: 56 }} aria-hidden="true">{expired ? '⏳' : '🔎'}</div>
        <h1 style={{ fontSize: 24, margin: '12px 0 8px' }}>{expired ? 'Este catálogo não está mais disponível' : 'Catálogo não encontrado'}</h1>
        <p style={{ color: '#6b6b6b', lineHeight: 1.5 }}>
          {expired ? 'A campanha terminou ou o link foi encerrado pela loja. Fale com quem enviou o link para receber o catálogo atualizado.'
            : 'Confira se o link foi copiado inteiro. Se o problema continuar, peça um novo link para a loja.'}
        </p>
      </div>
    </div>
  );
}

function PublicCatalogPage() {
  const slug = slugFromUrl();
  const repo = catalogRepository();
  const [state, setState] = useState<PublicResult | 'carregando' | 'erro' | 'inicio'>('carregando');
  useEffect(() => {
    if (!slug) { setState('inicio'); return; }
    repo.getPublic(slug).then((r) => {
      setState(r);
      if (r.status === 'ok') {
        document.title = r.catalog.settings.storeName ? `${r.catalog.name} · ${r.catalog.settings.storeName}` : r.catalog.name;
        // Uma visita por sessão do navegador (sem guardar nada do visitante).
        const key = `cv-visita:${slug}`;
        try { if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, '1'); repo.track(slug, 'visita').catch(() => undefined); } } catch { repo.track(slug, 'visita').catch(() => undefined); }
      }
    }).catch(() => setState('erro'));
  }, [slug]);
  const load = useCallback((ref: string) => repo.publicImage(slug, ref), [slug]);
  const onEvent = useCallback((e: ViewEvent) => { repo.track(slug, e.kind, e.itemId).catch(() => undefined); }, [slug]);

  if (state === 'inicio') return <Home />;
  if (state === 'carregando') return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui, sans-serif', color: '#6b6b6b' }}>Carregando catálogo…</div>;
  if (state === 'erro') return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui, sans-serif', padding: 24, textAlign: 'center' }}>Não foi possível abrir o catálogo agora. Verifique a internet e tente de novo.</div>;
  if (state.status !== 'ok') return <Unavailable expired={state.status === 'expirado'} />;
  const shareUrl = window.location.href.split('#')[0];
  return <CatalogView catalog={state.catalog} load={load} onEvent={onEvent} shareUrl={shareUrl} />;
}

createRoot(document.getElementById('catalogo')!).render(<StrictMode><PublicCatalogPage /></StrictMode>);

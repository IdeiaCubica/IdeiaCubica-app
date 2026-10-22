import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from './store';
import { useAuth } from './Auth';
import { Painel } from './pages/Painel';
import { Orcamentos } from './pages/Orcamentos';
import { Compras } from './pages/Compras';
import { Cadastros } from './pages/Cadastros';
import { Estoque } from './pages/Estoque';
import { Producao } from './pages/Producao';
import { Financeiro } from './pages/Financeiro';
import { Parametros } from './pages/Parametros';
import { Configuracoes } from './pages/Configuracoes';
import { purchaseAlerts } from '../domain/inventory';

/** Roteamento por hash (#/pagina/parametro): sem dependências, recarregar mantém a tela. */
export function navigate(path: string) { window.location.hash = '#/' + path; }

function useRoute() {
  const parse = () => window.location.hash.replace(/^#\/?/, '').split('/');
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const h = () => { setRoute(parse()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return route;
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

const NAV: { id: string; label: string; icon: string }[] = [
  { id: 'painel', label: 'Painel', icon: 'M3 13h8V3H3zM13 21h8v-8h-8zM13 3v6h8V3zM3 21h8v-4H3z' },
  { id: 'orcamentos', label: 'Orçamentos', icon: 'M9 7h6M9 11h6M9 15h3M5 3h14v18H5z' },
  { id: 'producao', label: 'Produção', icon: 'M12 2l9 5v10l-9 5-9-5V7zM12 22V12M21 7l-9 5-9-5' },
  { id: 'estoque', label: 'Estoque', icon: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10' },
  { id: 'compras', label: 'Compras', icon: 'M6 6h15l-2 9H8zM6 6L5 3H2M9 20a1 1 0 100-2 1 1 0 000 2zM18 20a1 1 0 100-2 1 1 0 000 2z' },
  { id: 'financeiro', label: 'Financeiro', icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6' },
  { id: 'cadastros', label: 'Cadastros', icon: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM19 8v6M22 11h-6' },
];

/** Rotas da v0.1 mantidas para links e favoritos antigos. */
const LEGACY: Record<string, string> = {
  'insumos/materiais': 'cadastros/materiais', 'insumos/cadastros': 'cadastros/fornecedores', 'insumos/compras': 'compras', insumos: 'compras',
  'config/parametros': 'parametros/gerais', 'config/canais': 'parametros/canais', 'config/indiretas': 'parametros/indiretas', 'producao/impressoras': 'parametros/impressoras',
};

export function App() {
  const { db, repo, persistent } = useStore();
  const { email, signOut } = useAuth();
  const [page = 'painel', param] = useRoute();
  const legacy = LEGACY[param ? `${page}/${param}` : page] ?? LEGACY[page];
  useEffect(() => { if (legacy) navigate(legacy); }, [legacy]);
  let content: ReactNode;
  switch (page) {
    case 'orcamentos': content = <Orcamentos param={param} />; break;
    case 'compras': content = <Compras />; break;
    case 'cadastros': content = <Cadastros param={param} />; break;
    case 'parametros': content = <Parametros param={param} />; break;
    case 'estoque': content = <Estoque param={param} />; break;
    case 'producao': content = <Producao param={param} />; break;
    case 'financeiro': content = <Financeiro param={param} />; break;
    case 'config': content = <Configuracoes param={param} />; break;    default: content = <Painel />;
  }
  const alerts = purchaseAlerts(db);
  const shortage = alerts.some((a) => a.status === 'falta');
  const badges: Record<string, ReactNode> = {
    estoque: alerts.length > 0 && (
      <span className={`nav-badge${shortage ? ' err' : ''}`} title={`${alerts.length} material(is) para comprar`}>{alerts.length}</span>
    ),
  };
  const navBtn = (id: string, label: string, icon: string) => (
    <button key={id} className={page === id || (page === '' && id === 'painel') ? 'on' : ''} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}>
      <Icon d={icon} />{label}{badges[id]}
    </button>
  );
  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/painel">
          <img src="/brand/simbolo_recortado_fundo_escuro.svg" alt="" />
          <div><b>ideia cúbica</b><span>GESTÃO 3D</span></div>
        </a>
        <div className="storage" title={repo.description}>
          <i className={repo.kind === 'supabase' ? 'cloud' : ''} />
          <span>{repo.kind === 'supabase'
            ? 'Dados na nuvem (Supabase)'
            : `Armazenamento local (navegador)${persistent === false ? ' — sem proteção contra limpeza automática' : ''}. Faça backups.`}</span>
          {email && <><span className="user">{email}</span><button className="btn inverse sm" onClick={signOut}>Sair</button></>}
        </div>
      </header>
      <div className="layout">
        <aside className="sidenav">
          <nav aria-label="Módulos">
            {NAV.map((n) => navBtn(n.id, n.label, n.icon))}
            <div className="sep" />
            {navBtn('parametros', 'Parâmetros de Custos', 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6')}
            {navBtn('config', 'Configurações', 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z')}
          </nav>
        </aside>
        <main>{content}</main>
      </div>
    </>
  );
}

/**
 * Autenticação (Supabase Auth, e-mail e senha).
 *
 * - Sem sessão → tela de login.
 * - Com sessão, mas sem cadastro em `app_members` → acesso negado (o banco
 *   também bloqueia via RLS; esta tela só explica ao usuário).
 * - Recuperação de senha por e-mail.
 * No modo local (VITE_STORAGE_DRIVER=local) não há login.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { forceLocalSignOut, getSupabase, missingSupabaseConfig, usesSupabase, withTimeout } from '../data/supabase';
import { Alert, TextField } from './components/ui';

/** Mensagem clara para falhas de comunicação (o "Failed to fetch" do navegador não diz nada ao usuário). */
function authMessage(msg: string): string {
  if (/invalid login|invalid credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/failed to fetch|networkerror|load failed|fetch failed|timeout|522|gateway/i.test(msg)) {
    return 'O servidor do banco de dados (Supabase) não respondeu. Se a internet estiver funcionando, o projeto no Supabase pode estar pausado ou sobrecarregado: abra o painel do Supabase e reinicie o projeto (veja docs/DEPLOY.md → Problemas comuns). Seus dados não foram afetados.';
  }
  return msg;
}

interface AuthCtx { email: string | null; signOut: () => Promise<void> }
const Ctx = createContext<AuthCtx>({ email: null, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-brand">
          <img src="/brand/simbolo_recortado_fundo_escuro.svg" alt="" />
          <div><b>ideia cúbica</b><span>GESTÃO 3D</span></div>
        </div>
        <div className="card-body stack">{children}</div>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  if (!usesSupabase) return <>{children}</>;
  const missing = missingSupabaseConfig();
  if (missing.length) {
    return (
      <Shell>
        <h2>Configuração incompleta</h2>
        <Alert tone="error" title="Faltam variáveis de ambiente">
          Defina {missing.join(' e ')} no arquivo <code>.env.local</code> (computador) ou em Settings → Environment Variables (Vercel) e reinicie/redeploy.
          Veja docs/DEPLOY.md.
        </Alert>
      </Shell>
    );
  }
  return <SupabaseGate>{children}</SupabaseGate>;
}

function SupabaseGate({ children }: { children: ReactNode }) {
  const sb = getSupabase();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [member, setMember] = useState<boolean | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    withTimeout(sb.auth.getSession(), 15000, 'Sem resposta ao recuperar a sessão.')
      .then(({ data }) => setSession(data.session))
      .catch(() => setSession(null));   // sem sessão confiável → tela de login
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [sb]);

  // Verifica a liberação uma vez por usuário (não a cada renovação do login), com limite de tempo.
  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) { setMember(null); setCheckError(null); return; }
    let alive = true;
    setMember(null); setCheckError(null);
    withTimeout(sb.from('app_members').select('user_id').eq('user_id', userId).maybeSingle(), 15000,
      'O servidor demorou para responder ao verificar suas permissões.')
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) setCheckError(`Não foi possível verificar suas permissões: ${authMessage(error.message)}`);
        else setMember(!!data);
      })
      .catch((e: unknown) => { if (alive) setCheckError(e instanceof Error ? e.message : 'Falha ao verificar permissões.'); });
    return () => { alive = false; };
  }, [userId, sb, attempt]);

  const signOut = async () => { await forceLocalSignOut(); setSession(null); };

  if (session === undefined) return <Shell><p className="muted">Verificando acesso…</p></Shell>;
  if (recovery && session) return <NewPassword onDone={() => setRecovery(false)} />;
  if (!session) return <Login />;
  if (checkError) {
    return (
      <Shell>
        <h2>Não conseguimos confirmar o acesso</h2>
        <Alert tone="warning">{checkError} Verifique a internet e tente de novo. Se continuar, saia e entre novamente.</Alert>
        <div className="row">
          <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>Tentar novamente</button>
          <button className="btn secondary" onClick={signOut}>Sair e entrar novamente</button>
        </div>
      </Shell>
    );
  }
  if (member === null) return <Shell><p className="muted">Verificando permissões…</p><SlowHint onSignOut={signOut} /></Shell>;
  if (!member) {
    return (
      <Shell>
        <h2>Acesso não liberado</h2>
        <Alert tone="warning">O usuário <b>{session.user.email}</b> entrou, mas não está liberado no sistema. O administrador precisa cadastrá-lo em <code>app_members</code> (docs/DEPLOY.md, passo 4).</Alert>
        <button className="btn secondary" onClick={signOut}>Sair</button>
      </Shell>
    );
  }
  return <Ctx.Provider value={{ email: session.user.email ?? null, signOut }}>{children}</Ctx.Provider>;
}

/** Depois de alguns segundos esperando, oferece uma saída em vez de deixar a tela parada. */
function SlowHint({ onSignOut }: { onSignOut: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 6000); return () => clearTimeout(t); }, []);
  if (!slow) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="small muted">Está demorando mais que o normal.</p>
      <div className="row">
        <button className="btn secondary sm" onClick={() => window.location.reload()}>Recarregar</button>
        <button className="btn ghost sm" onClick={onSignOut}>Sair e entrar novamente</button>
      </div>
    </div>
  );
}

function Login() {
  const sb = getSupabase();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(/invalid/i.test(error.message) && !/fetch/i.test(error.message) ? 'E-mail ou senha incorretos.' : authMessage(error.message));
  };
  const forgot = async () => {
    if (!email.trim()) { setError('Digite seu e-mail para receber o link de redefinição.'); return; }
    setBusy(true); setError(null);
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    setBusy(false);
    if (error) setError(authMessage(error.message)); else setInfo('Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.');
  };

  return (
    <Shell>
      <div><h2>Entrar</h2><p className="muted">Acesso restrito à equipe da Ideia Cúbica.</p></div>
      <form className="stack" onSubmit={submit}>
        <TextField label="E-mail" type="email" value={email} onChange={setEmail} autoFocus required />
        <TextField label="Senha" type="password" value={password} onChange={setPassword} required />
        {error && <Alert tone="error">{error}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}
        <button className="btn primary" type="submit" disabled={busy || !email || !password}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <button className="btn ghost" type="button" onClick={forgot} disabled={busy}>Esqueci minha senha</button>
      </form>
    </Shell>
  );
}

function NewPassword({ onDone }: { onDone: () => void }) {
  const sb = getSupabase();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (p1.length < 8) { setError('A senha deve ter pelo menos 8 caracteres.'); return; }
    if (p1 !== p2) { setError('As senhas não conferem.'); return; }
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) setError(error.message); else onDone();
  };
  return (
    <Shell>
      <h2>Criar nova senha</h2>
      <form className="stack" onSubmit={save}>
        <TextField label="Nova senha" type="password" value={p1} onChange={setP1} required autoFocus />
        <TextField label="Repita a nova senha" type="password" value={p2} onChange={setP2} required />
        {error && <Alert tone="error">{error}</Alert>}
        <button className="btn primary" type="submit">Salvar senha</button>
      </form>
    </Shell>
  );
}

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
import { getSupabase, missingSupabaseConfig, usesSupabase } from '../data/supabase';
import { Alert, TextField } from './components/ui';

interface AuthCtx { email: string | null; signOut: () => Promise<void> }
const Ctx = createContext<AuthCtx>({ email: null, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-brand">
          <img src="/brand/09_icone_simbolo_fundo_escuro.svg" alt="" />
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
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [sb]);

  useEffect(() => {
    if (!session) { setMember(null); return; }
    sb.from('app_members').select('user_id').eq('user_id', session.user.id).maybeSingle()
      .then(({ data, error }) => setMember(!error && !!data));
  }, [session, sb]);

  const signOut = async () => { await sb.auth.signOut(); };

  if (session === undefined) return <Shell><p className="muted">Verificando acesso…</p></Shell>;
  if (recovery && session) return <NewPassword onDone={() => setRecovery(false)} />;
  if (!session) return <Login />;
  if (member === null) return <Shell><p className="muted">Verificando permissões…</p></Shell>;
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
    if (error) setError(/invalid/i.test(error.message) ? 'E-mail ou senha incorretos.' : error.message);
  };
  const forgot = async () => {
    if (!email.trim()) { setError('Digite seu e-mail para receber o link de redefinição.'); return; }
    setBusy(true); setError(null);
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    setBusy(false);
    if (error) setError(error.message); else setInfo('Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.');
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

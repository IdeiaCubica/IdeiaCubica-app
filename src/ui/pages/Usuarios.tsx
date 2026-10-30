/**
 * Administração de usuários (Configurações → Usuários).
 * Dono do sistema: cria logins, define senhas e remove acessos (via /api/usuarios, no servidor).
 * Qualquer usuário: troca a própria senha (direto no Supabase Auth, sem chave de administração).
 */
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { getSupabase, usesSupabase } from '../../data/supabase';
import { callApi } from '../../io/api';
import { fmtDateTime } from '../../domain/core';
import { Alert, Badge, DataTable, Empty, Modal, TextField, useConfirm } from '../components/ui';

interface Member { user_id: string; email: string; name: string | null; role: 'owner' | 'member'; created_at: string; last_sign_in_at: string | null }

const MIN = 8;
const passwordProblem = (p: string, c: string) => (p.length < MIN ? `A senha precisa ter pelo menos ${MIN} caracteres.` : p !== c ? 'As duas senhas não são iguais.' : null);

export function Usuarios() {
  const { toast } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [owner, setOwner] = useState<boolean | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pwdFor, setPwdFor] = useState<Member | 'eu' | null>(null);

  const load = async () => {
    if (!usesSupabase) return;
    setError(null);
    const sb = getSupabase();
    const { data: u } = await sb.auth.getUser();
    setMe(u.user?.id ?? null);
    const o = await sb.rpc('is_owner');
    if (o.error) { setOwner(false); setError(/does not exist|schema cache/i.test(o.error.message) ? 'O banco ainda não tem a atualização de usuários: rode supabase/migrations/20261029000000_v1_10_usuarios.sql no SQL Editor do Supabase.' : o.error.message); return; }
    setOwner(o.data === true);
    if (o.data === true) {
      const l = await sb.rpc('admin_list_members');
      if (l.error) setError(l.error.message); else setMembers((l.data ?? []) as Member[]);
    }
  };
  useEffect(() => { load(); }, []);

  if (!usesSupabase) {
    return <div className="card"><Empty title="Usuários só na versão publicada" text="Esta cópia guarda os dados só no navegador e não tem login. A administração de usuários funciona na versão publicada (Supabase)." /></div>;
  }

  const remove = async (m: Member) => {
    const ok = await confirm({ title: `Remover o acesso de ${m.name || m.email}?`, danger: true, confirmLabel: 'Remover acesso',
      text: 'A pessoa não consegue mais entrar no sistema. Os dados que ela lançou continuam no sistema.' });
    if (ok === null) return;
    try { await callApi('usuarios', { action: 'remove', userId: m.user_id }); toast('success', 'Acesso removido.'); load(); }
    catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="stack">
      {error && <Alert tone="error" title="Não foi possível carregar os usuários">{error}</Alert>}
      <div className="card">
        <div className="card-head">
          <div><h2>Usuários do sistema</h2><p className="muted small">Todos os usuários veem e alteram os mesmos dados. Só o <b>dono</b> cria usuários, define senhas e remove acessos.</p></div>
          <div className="row">
            <button className="btn secondary" onClick={() => setPwdFor('eu')}>Trocar minha senha</button>
            {owner && <button className="btn primary" onClick={() => setCreating(true)}>Novo usuário</button>}
          </div>
        </div>
        {owner === false && !error && <div className="card-body"><p className="muted" style={{ margin: 0 }}>Você é um usuário do sistema. Para criar ou remover usuários, fale com o dono do sistema.</p></div>}
        {owner && members && <DataTable rows={members} rowKey={(m) => m.user_id}
          empty={<Empty title="Nenhum usuário" />}
          columns={[
            { key: 'n', header: 'Usuário', render: (m) => <><b>{m.name || m.email}</b><div className="muted small">{m.email}{m.user_id === me ? ' · você' : ''}</div></> },
            { key: 'r', header: 'Papel', render: (m) => m.role === 'owner' ? <Badge tone="primary">dono</Badge> : <Badge>usuário</Badge> },
            { key: 'c', header: 'Liberado em', render: (m) => fmtDateTime(m.created_at) },
            { key: 'l', header: 'Último acesso', render: (m) => (m.last_sign_in_at ? fmtDateTime(m.last_sign_in_at) : <span className="muted">ainda não entrou</span>) },
            { key: 'a', header: '', render: (m) => <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              {m.user_id !== me && <button className="btn ghost sm" onClick={() => setPwdFor(m)}>Definir senha</button>}
              {m.role === 'member' && <button className="btn ghost sm danger-text" onClick={() => remove(m)}>Remover acesso</button>}
            </div> },
          ]} />}
      </div>
      <Alert tone="info" title="Uso por mais de uma pessoa ao mesmo tempo">
        Se duas pessoas salvarem alterações quase ao mesmo tempo, a segunda recebe o aviso “os dados foram alterados em outro dispositivo” e precisa recarregar a página (F5) e refazer a última alteração. Nada é perdido nem sobrescrito.
      </Alert>
      {creating && <NewUserForm onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {pwdFor && <PasswordForm target={pwdFor} onClose={() => setPwdFor(null)} />}
      {confirmEl}
    </div>
  );
}

function NewUserForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = !name.trim() ? 'Informe o nome.' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Informe um e-mail válido.' : passwordProblem(password, again);
  const submit = async () => {
    if (problem) return toast('warning', problem);
    setBusy(true);
    try {
      await callApi('usuarios', { action: 'create', name: name.trim(), email: email.trim(), password });
      toast('success', `Usuário ${email.trim()} criado. Passe o e-mail e a senha para a pessoa entrar.`);
      onDone();
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Novo usuário" subtitle="A pessoa entra com este e-mail e esta senha. Ela terá acesso a todos os dados do sistema (sem administrar usuários)." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Criando…' : 'Criar usuário'}</button></>}>
      <div className="stack">
        <TextField label="Nome" required value={name} onChange={setName} placeholder="Ex.: Maria Souza" />
        <TextField label="E-mail (login)" required value={email} onChange={setEmail} placeholder="maria@exemplo.com" />
        <PasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} />
      </div>
    </Modal>
  );
}

function PasswordForm({ target, onClose }: { target: Member | 'eu'; onClose: () => void }) {
  const { toast } = useStore();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const self = target === 'eu';
  const submit = async () => {
    const problem = passwordProblem(password, again);
    if (problem) return toast('warning', problem);
    setBusy(true);
    try {
      if (self) {
        const { error } = await getSupabase().auth.updateUser({ password });
        if (error) throw new Error(/same|different/i.test(error.message) ? 'A nova senha precisa ser diferente da atual.' : error.message);
        toast('success', 'Sua senha foi trocada.');
      } else {
        await callApi('usuarios', { action: 'password', userId: target.user_id, password });
        toast('success', `Senha de ${target.name || target.email} definida. Passe a nova senha para a pessoa.`);
      }
      onClose();
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={self ? 'Trocar minha senha' : `Definir senha de ${target.name || target.email}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={busy}>{busy ? 'Salvando…' : 'Salvar senha'}</button></>}>
      <div className="stack"><PasswordFields password={password} setPassword={setPassword} again={again} setAgain={setAgain} /></div>
    </Modal>
  );
}

function PasswordFields({ password, setPassword, again, setAgain }: { password: string; setPassword: (v: string) => void; again: string; setAgain: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <div className="field">
        <label htmlFor="nova-senha">Senha</label>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
          <input id="nova-senha" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="btn ghost sm" onClick={() => setShow((s) => !s)}>{show ? 'Ocultar' : 'Mostrar'}</button>
        </div>
        <small className="muted">Mínimo de {MIN} caracteres. Use letras e números.</small>
      </div>
      <div className="field">
        <label htmlFor="nova-senha-2">Repita a senha</label>
        <input id="nova-senha-2" type={show ? 'text' : 'password'} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
    </>
  );
}

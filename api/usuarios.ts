/**
 * POST /api/usuarios — administração de usuários (somente o DONO do sistema).
 *
 * Criar login e trocar senha de outra pessoa exige a API administrativa do Supabase,
 * que só aceita a chave "service_role". Essa chave fica APENAS aqui no servidor:
 *   Vercel → Settings → Environment Variables → SUPABASE_SERVICE_ROLE_KEY
 * (nunca com prefixo VITE_, nunca no código, nunca no navegador). Aceita a chave secreta
 * nova do Supabase (sb_secret_…) ou a antiga "service_role".
 *
 * Corpo: { action: 'create', name, email, password }
 *        { action: 'password', userId, password }
 *        { action: 'remove', userId }
 */
import { HttpError, env, handle, json, requireOwner } from './_lib/http.js';

interface Body { action?: string; name?: string; email?: string; password?: string; userId?: string }

const MIN_PASSWORD = 8;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkPassword(p: unknown): string {
  const s = String(p ?? '');
  if (s.length < MIN_PASSWORD) throw new HttpError(400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  if (s.length > 72) throw new HttpError(400, 'A senha pode ter no máximo 72 caracteres.');
  return s;
}

function admin() {
  const url = env('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url) throw new HttpError(500, 'Servidor sem configuração do Supabase (VITE_SUPABASE_URL).');
  if (!key) throw new HttpError(503, 'Administração de usuários não configurada: cadastre SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente da Vercel (veja docs/DEPLOY.md).');
  // Chave nova (sb_secret_…): só no cabeçalho apikey (o Supabase gera o acesso administrativo).
  // Chave antiga (JWT service_role): apikey + Authorization.
  const headers: Record<string, string> = key.startsWith('sb_secret_')
    ? { apikey: key, 'content-type': 'application/json' }
    : { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  return {
    async call(path: string, init: { method: string; body?: unknown; prefer?: string }) {
      const res = await fetch(`${url}${path}`, {
        method: init.method,
        headers: init.prefer ? { ...headers, prefer: init.prefer } : headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { ok: res.ok, status: res.status, data: data as Record<string, unknown> | null };
    },
  };
}

const authMessage = (data: Record<string, unknown> | null) => String(data?.msg ?? data?.message ?? data?.error_description ?? data?.error ?? '');

export const POST = handle(async (request) => {
  const me = await requireOwner(request);
  const body = (await request.json().catch(() => ({}))) as Body;
  const api = admin();

  if (body.action === 'create') {
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!name) throw new HttpError(400, 'Informe o nome do usuário.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
    const password = checkPassword(body.password);

    const created = await api.call('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true, user_metadata: { name } } });
    if (!created.ok) {
      const msg = authMessage(created.data);
      if (/already|registered|exists/i.test(msg)) throw new HttpError(409, 'Já existe um login com este e-mail. Se a pessoa já tem conta, use “Definir senha” na lista ou fale com o suporte.');
      if (created.status === 401 || created.status === 403) throw new HttpError(502, 'O Supabase recusou a chave de administração. Confira SUPABASE_SERVICE_ROLE_KEY na Vercel.');
      throw new HttpError(502, `O Supabase não criou o usuário (${created.status}). ${msg}`.trim());
    }
    const userId = String(created.data?.id ?? '');
    const member = await api.call('/rest/v1/app_members', { method: 'POST', body: { user_id: userId, role: 'member', name }, prefer: 'return=minimal' });
    if (!member.ok) {
      // Não deixa login "solto" sem acesso: desfaz a criação.
      await api.call(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
      throw new HttpError(502, `O login foi criado, mas a liberação no sistema falhou e foi desfeita. ${authMessage(member.data)}`.trim());
    }
    console.info(`[usuarios] ${me.email} criou ${email}`);
    return json({ ok: true, userId });
  }

  if (body.action === 'password') {
    const userId = String(body.userId ?? '');
    if (!uuid.test(userId)) throw new HttpError(400, 'Usuário inválido.');
    const password = checkPassword(body.password);
    const res = await api.call(`/auth/v1/admin/users/${userId}`, { method: 'PUT', body: { password } });
    if (!res.ok) throw new HttpError(502, `Não foi possível definir a senha (${res.status}). ${authMessage(res.data)}`.trim());
    console.info(`[usuarios] ${me.email} definiu a senha de ${userId}`);
    return json({ ok: true });
  }

  if (body.action === 'remove') {
    const userId = String(body.userId ?? '');
    if (!uuid.test(userId)) throw new HttpError(400, 'Usuário inválido.');
    if (userId === me.userId) throw new HttpError(400, 'Você não pode remover o seu próprio acesso.');
    const res = await api.call(`/rest/v1/app_members?user_id=eq.${userId}&role=eq.member`, { method: 'DELETE', prefer: 'return=representation' });
    if (!res.ok) throw new HttpError(502, `Não foi possível remover o acesso (${res.status}).`);
    if (!Array.isArray(res.data) || res.data.length === 0) throw new HttpError(400, 'Este usuário não pode ser removido por aqui (é o dono do sistema ou já não tem acesso).');
    // Bloqueia também o login, para encerrar sessões abertas na próxima renovação.
    await api.call(`/auth/v1/admin/users/${userId}`, { method: 'PUT', body: { ban_duration: '876000h' } });
    console.info(`[usuarios] ${me.email} removeu o acesso de ${userId}`);
    return json({ ok: true });
  }

  throw new HttpError(400, 'Ação desconhecida.');
});

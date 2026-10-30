/**
 * Utilidades das funções serverless (Vercel, runtime Node).
 *
 * Toda função exige o token de sessão do Supabase do usuário logado e confere
 * se ele está liberado em `app_members` (RPC is_member, protegida por RLS).
 * Assim o token da SuperFrete fica só no servidor e só usuários do sistema
 * conseguem usar a cota dele.
 */

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function env(name: string, ...fallbacks: string[]): string | undefined {
  for (const n of [name, ...fallbacks]) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Valida a sessão e a liberação do usuário. Retorna o e-mail para registro. */
export async function requireMember(request: Request): Promise<{ userId: string; email: string | null }> {
  const url = env('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const anon = env('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY');
  if (!url || !anon) throw new HttpError(500, 'Servidor sem configuração do Supabase (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Faça login para usar este recurso.');

  const userRes = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
  if (!userRes.ok) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  const user = (await userRes.json()) as { id?: string; email?: string };
  if (!user.id) throw new HttpError(401, 'Sessão inválida.');

  const memberRes = await fetch(`${url}/rest/v1/rpc/is_member`, {
    method: 'POST',
    headers: { apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!memberRes.ok || (await memberRes.json()) !== true) throw new HttpError(403, 'Usuário não liberado para usar o sistema.');
  return { userId: user.id, email: user.email ?? null };
}

/** Exige que o usuário logado seja o DONO do sistema (papel owner em app_members). */
export async function requireOwner(request: Request): Promise<{ userId: string; email: string | null }> {
  const who = await requireMember(request);
  const url = env('SUPABASE_URL', 'VITE_SUPABASE_URL')!;
  const anon = env('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')!;
  const token = (request.headers.get('authorization') ?? '').slice(7).trim();
  const res = await fetch(`${url}/rest/v1/rpc/is_owner`, {
    method: 'POST',
    headers: { apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (res.status === 404) throw new HttpError(503, 'O banco ainda não tem a atualização de usuários. Rode supabase/migrations/20261029000000_v1_10_usuarios.sql no SQL Editor do Supabase.');
  if (!res.ok || (await res.json()) !== true) throw new HttpError(403, 'Somente o dono do sistema pode administrar usuários.');
  return who;
}

/** Envolve o handler: converte erros em respostas JSON com mensagem amigável. */
export function handle(fn: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      return await fn(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Erro inesperado no servidor. Tente novamente em instantes.' }, 500);
    }
  };
}

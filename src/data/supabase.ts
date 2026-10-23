/**
 * Cliente Supabase (navegador).
 *
 * Usa SOMENTE a chave pública "anon" — ela foi feita para ficar no frontend.
 * A proteção real dos dados é feita no banco por RLS (Row Level Security):
 * apenas usuários cadastrados em `app_members` leem e gravam.
 * Nunca coloque a service_role key ou a senha do banco em variáveis VITE_*.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
export const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

export const storageDriver = ((import.meta.env.VITE_STORAGE_DRIVER as string | undefined) ?? 'local').trim();
export const usesSupabase = storageDriver === 'supabase';

/** O que falta para conectar (lista vazia = configuração completa). */
export function missingSupabaseConfig(): string[] {
  const miss: string[] = [];
  if (!supabaseUrl) miss.push('VITE_SUPABASE_URL');
  if (!supabaseAnonKey) miss.push('VITE_SUPABASE_ANON_KEY');
  return miss;
}

let client: SupabaseClient | null = null;

/**
 * Trava de sessão só dentro desta aba. A trava padrão (navigator.locks, entre abas)
 * pode ficar presa ao renovar um login vencido — o app parava em "Verificando permissões…".
 */
let chain: Promise<unknown> = Promise.resolve();
async function tabLock<R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export function getSupabase(): SupabaseClient {
  if (missingSupabaseConfig().length) throw new Error('Supabase não configurado: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.');
  client ??= createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, lock: tabLock },
  });
  return client;
}

/** Rejeita se a promessa não terminar no tempo dado (evita telas de espera infinitas). */
export function withTimeout<T>(p: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Remove a sessão salva neste navegador mesmo sem resposta do servidor. */
export async function forceLocalSignOut() {
  try { await withTimeout(getSupabase().auth.signOut({ scope: 'local' }), 4000, 'timeout'); } catch { /* segue limpando */ }
  try {
    for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token/.test(k)) localStorage.removeItem(k);
  } catch { /* armazenamento indisponível */ }
}

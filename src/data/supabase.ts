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

export function getSupabase(): SupabaseClient {
  if (missingSupabaseConfig().length) throw new Error('Supabase não configurado: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.');
  client ??= createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

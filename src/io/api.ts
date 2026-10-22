/**
 * Chamadas às funções do servidor (/api/*, Vercel). Enviam o token da sessão do
 * Supabase; o token da SuperFrete fica só no servidor.
 */
import { getSupabase, usesSupabase } from '../data/supabase';
export class ApiError extends Error {}

export async function callApi<T>(path: string, body: unknown): Promise<T> {
  if (!usesSupabase) throw new ApiError('Este recurso usa o servidor e só funciona na versão publicada (com login no Supabase).');
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('Sessão expirada. Entre novamente.');
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique a internet.');
  }
  const payload = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !payload) {
    if (res.status === 404) throw new ApiError('Função do servidor não encontrada (disponível apenas na versão publicada na Vercel).');
    throw new ApiError(payload?.error ?? `Erro do servidor (${res.status}).`);
  }
  return payload;
}

export interface FreightOption {
  id: number;
  name: string;
  company: string;
  price: string | null;
  discount: string | null;
  deliveryMin: number | null;
  deliveryMax: number | null;
  error?: string;
}

export function quoteFreight(input: {
  from: string; to: string; package: { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }; insuranceValue?: number;
}) {
  return callApi<{ options: FreightOption[] }>('frete', input);
}

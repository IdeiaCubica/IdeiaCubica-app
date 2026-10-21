/**
 * Camada de persistência substituível.
 *
 * As regras de negócio operam sobre um objeto DB em memória e cada operação é
 * confirmada inteira (commit único) — se qualquer validação falhar, nada é
 * gravado. Há duas implementações do mesmo contrato:
 *
 *  - LocalStorageRepository: navegador (desenvolvimento / uso offline).
 *  - SupabaseRepository: banco PostgreSQL no Supabase (produção). O estado é
 *    gravado por uma função transacional no banco (`save_app_state`) com
 *    controle de versão otimista e cópia automática no histórico.
 *
 * Etapa seguinte prevista (docs/ARQUITETURA.md): tabelas normalizadas por
 * entidade (supabase/planned/normalized_schema.sql), sem mudar o domínio.
 */
import type { DB } from '../domain/types';
import { createEmptyDB, migrate } from '../domain/schema';
import { getSupabase, usesSupabase } from './supabase';

export interface Snapshot { id: number; version: number; savedAt: string; bytes: number }

export interface Repository {
  readonly kind: 'local' | 'supabase';
  /** Descrição honesta de onde os dados ficam. */
  readonly description: string;
  load(): Promise<DB>;
  save(db: DB): Promise<void>;
  /** Histórico de versões dos dados (somente no Supabase). */
  listSnapshots?(): Promise<Snapshot[]>;
  loadSnapshot?(id: number): Promise<DB>;
}

const KEY = 'ideia-cubica:db:v1';
const PREV_KEY = 'ideia-cubica:db:v1:anterior';

export class LocalStorageRepository implements Repository {
  readonly kind = 'local' as const;
  readonly description = 'Dados salvos apenas neste navegador, neste computador. Faça backups regulares (Configurações → Backup).';

  async load(): Promise<DB> {
    const raw = localStorage.getItem(KEY);
    if (!raw) return createEmptyDB();
    try {
      return migrate(JSON.parse(raw));
    } catch (e) {
      const prev = localStorage.getItem(PREV_KEY);
      if (prev) return migrate(JSON.parse(prev));
      throw e;
    }
  }

  async save(db: DB): Promise<void> {
    const json = JSON.stringify(db);
    try {
      const current = localStorage.getItem(KEY);
      if (current) localStorage.setItem(PREV_KEY, current); // cópia de segurança da versão anterior
      localStorage.setItem(KEY, json);
    } catch {
      throw new Error('Não foi possível salvar: o armazenamento do navegador está cheio ou bloqueado. Exporte um backup e libere espaço.');
    }
  }
}

/** Dados que ficaram no navegador antes da migração para a nuvem (para importação). */
export function readLocalBrowserData(): DB | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export class SupabaseRepository implements Repository {
  readonly kind = 'supabase' as const;
  readonly description = 'Dados salvos no banco Supabase (nuvem), acessíveis de qualquer dispositivo após o login. Cada gravação gera uma cópia no histórico.';
  /** Versão do estado carregado; a gravação só é aceita se o banco ainda estiver nesta versão. */
  private version = 0;

  async load(): Promise<DB> {
    const { data, error } = await getSupabase().from('app_state').select('data, version').eq('id', 1).maybeSingle();
    if (error) throw new Error(friendly(error.message));
    if (!data) { this.version = 0; return createEmptyDB(); }
    this.version = data.version;
    return migrate(data.data);
  }

  async save(db: DB): Promise<void> {
    const { data, error } = await getSupabase().rpc('save_app_state', { p_data: db, p_expected_version: this.version });
    if (error) {
      if (error.code === '40001' || /conflito/i.test(error.message)) {
        throw new Error('Os dados foram alterados em outra aba ou dispositivo. Recarregue a página (F5) para ver a versão mais recente — nada foi gravado.');
      }
      throw new Error(friendly(error.message));
    }
    this.version = data as number;
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const { data, error } = await getSupabase().from('app_state_history').select('id, version, saved_at, bytes').order('id', { ascending: false }).limit(100);
    if (error) throw new Error(friendly(error.message));
    return (data ?? []).map((r) => ({ id: r.id, version: r.version, savedAt: r.saved_at, bytes: r.bytes }));
  }

  async loadSnapshot(id: number): Promise<DB> {
    const { data, error } = await getSupabase().from('app_state_history').select('data').eq('id', id).single();
    if (error) throw new Error(friendly(error.message));
    return migrate(data.data);
  }
}

function friendly(msg: string): string {
  if (/failed to fetch|network/i.test(msg)) return 'Sem conexão com o servidor. Verifique a internet e tente novamente — nada foi gravado.';
  if (/permission|denied|42501|row-level security/i.test(msg)) return 'Seu usuário não tem permissão para acessar os dados. Verifique o cadastro em app_members (docs/DEPLOY.md).';
  if (/relation .* does not exist|function .* does not exist|schema cache/i.test(msg)) return 'O banco ainda não foi preparado. Execute a migration do Supabase (docs/DEPLOY.md, passo 2).';
  return msg;
}

export function createRepository(): Repository {
  return usesSupabase ? new SupabaseRepository() : new LocalStorageRepository();
}

/** Pede ao navegador para não apagar os dados automaticamente quando faltar espaço. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* indisponível */ }
  return null;
}

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
import { collectImageRefs, collectInlineImages, hydrateImages, sha256Hex, withImageRefs } from './images';

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
  readonly description = 'Dados salvos no banco Supabase (nuvem), acessíveis de qualquer dispositivo após o login. O histórico guarda cópias de segurança periódicas.';
  /** Versão do estado carregado; a gravação só é aceita se o banco ainda estiver nesta versão. */
  private version = 0;
  /** Fotos separadas (tabela app_images): null = ainda não sabemos se a tabela existe; false = não existe (modo antigo). */
  private imagesTable: boolean | null = null;
  /** Foto (data URL) → id (SHA-256), para não recalcular a cada gravação. */
  private idOf = new Map<string, string>();
  /** Ids de fotos que já estão no banco. */
  private stored = new Set<string>();

  /** Troca as referências img:… pelas fotos guardadas na tabela app_images. */
  private async hydrate(raw: unknown): Promise<void> {
    const ids = [...collectImageRefs(raw)];
    if (!ids.length) return;
    const images = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 40) {
      const { data, error } = await getSupabase().from('app_images').select('id, data').in('id', ids.slice(i, i + 40));
      if (error) throw new Error(friendly(error.message));
      for (const r of data ?? []) images.set(r.id as string, r.data as string);
    }
    hydrateImages(raw, images);
    for (const [id, data] of images) { this.idOf.set(data, id); this.stored.add(id); }
    this.imagesTable = true;
  }

  /** Envia as fotos que ainda não estão no banco. Retorna false se a tabela não existe (banco sem a v1.11). */
  private async uploadImages(rows: { id: string; data: string }[]): Promise<boolean> {
    let batch: typeof rows = [], size = 0;
    const flush = async () => {
      if (!batch.length) return true;
      const { error } = await getSupabase().from('app_images')
        .upsert(batch.map((r) => ({ id: r.id, data: r.data, bytes: r.data.length })), { onConflict: 'id', ignoreDuplicates: true });
      if (error) {
        if (/does not exist|schema cache|PGRST205|42P01/i.test(`${error.code} ${error.message}`)) return false;
        throw new Error(friendly(error.message));
      }
      batch.forEach((r) => this.stored.add(r.id));
      batch = []; size = 0;
      return true;
    };
    for (const r of rows) {
      if (size + r.data.length > 2_000_000 && !(await flush())) return false;
      batch.push(r); size += r.data.length;
    }
    return flush();
  }

  /** Documento a gravar: fotos trocadas por referências (se o banco já tem a tabela de fotos). */
  private async payload(db: DB): Promise<unknown> {
    if (this.imagesTable === false) return db;
    const inline = collectInlineImages(db);
    if (!inline.size) return db;
    for (const s of inline) if (!this.idOf.has(s)) this.idOf.set(s, await sha256Hex(s));
    const missing = [...inline].map((s) => ({ id: this.idOf.get(s)!, data: s })).filter((r) => !this.stored.has(r.id));
    if (missing.length && !(await this.uploadImages(missing))) { this.imagesTable = false; return db; }
    this.imagesTable = true;
    return withImageRefs(db, this.idOf);
  }

  async load(): Promise<DB> {
    const { data, error } = await getSupabase().from('app_state').select('data, version').eq('id', 1).maybeSingle();
    if (error) throw new Error(friendly(error.message));
    if (!data) { this.version = 0; return createEmptyDB(); }
    this.version = data.version;
    await this.hydrate(data.data);
    return migrate(data.data);
  }

  async save(db: DB): Promise<void> {
    const p_data = await this.payload(db);
    const { data, error } = await getSupabase().rpc('save_app_state', { p_data, p_expected_version: this.version });
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
    await this.hydrate(data.data);
    return migrate(data.data);
  }
}

function friendly(msg: string): string {
  if (/statement timeout|canceling statement/i.test(msg)) {
    return 'O banco demorou demais para gravar e cancelou a operação — nada foi gravado. Tente de novo; se continuar, aplique a atualização do banco supabase/migrations/20261028000000_v1_9_gravacao_rapida.sql (docs/DEPLOY.md).';
  }
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

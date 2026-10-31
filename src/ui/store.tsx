/**
 * Estado global da interface.
 *
 * `run()` executa uma operação de negócio como TRANSAÇÃO: clona o banco,
 * aplica a operação, persiste e só então atualiza a tela. Se a regra de
 * negócio lançar erro ou a gravação falhar, nada muda.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DB } from '../domain/types';
import { createRepository, requestPersistentStorage, type Repository } from '../data/repository';
import { withTimeout } from '../data/supabase';

type ToastKind = 'success' | 'error' | 'info' | 'warning';
interface Toast { id: number; kind: ToastKind; text: string }

interface StoreCtx {
  db: DB;
  repo: Repository;
  persistent: boolean | null;
  run: <T>(fn: (draft: DB) => T, success?: string) => Promise<{ ok: true; value: T } | { ok: false; error: string }>;
  replaceAll: (db: DB) => Promise<void>;
  toast: (kind: ToastKind, text: string) => void;
}

const Ctx = createContext<StoreCtx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const repoRef = useRef<Repository>(createRepository());
  const [db, setDb] = useState<DB | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dbRef = useRef<DB | null>(null);

  useEffect(() => {
    withTimeout(repoRef.current.load(), 30000, 'O servidor demorou demais para enviar os dados. Verifique a internet e tente novamente.')
      .then((d) => {
        dbRef.current = d; setDb(d);
        // Dados antigos com fotos dentro: separa as fotos em segundo plano (gravações seguintes ficam leves).
        setTimeout(() => { if (dbRef.current === d) repoRef.current.compactIfNeeded?.(d); }, 3000);
      }).catch((e) => setLoadError(String(e?.message ?? e)));
    if (repoRef.current.kind === 'local') requestPersistentStorage().then(setPersistent);
  }, []);

  const toast = useCallback((kind: ToastKind, text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  // "Salvando…" aparece só se a gravação passar de meio segundo (gravações rápidas não piscam a tela).
  const [saving, setSaving] = useState(false);
  const savingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useCallback<StoreCtx['run']>(async (fn, success) => {
    const current = dbRef.current;
    if (!current) return { ok: false, error: 'Dados ainda não carregados.' };
    const draft = structuredClone(current);
    savingTimer.current = setTimeout(() => setSaving(true), 500);
    const done = () => { if (savingTimer.current) clearTimeout(savingTimer.current); setSaving(false); };
    try {
      const value = fn(draft);
      await repoRef.current.save(draft).finally(done);
      dbRef.current = draft;
      setDb(draft);
      if (success) toast('success', success);
      return { ok: true, value };
    } catch (e) {
      done();
      const msg = e instanceof Error ? e.message : String(e);
      toast('error', msg);
      return { ok: false, error: msg };
    }
  }, [toast]);

  const replaceAll = useCallback(async (next: DB) => {
    await repoRef.current.save(next);
    dbRef.current = next;
    setDb(next);
  }, []);

  if (loadError) {
    return (
      <div style={{ padding: 32 }}>
        <div className="alert a-error"><b>Não foi possível carregar os dados</b>{loadError}</div>
        <button className="btn secondary" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>Tentar novamente</button>
      </div>
    );
  }
  if (!db) return <div style={{ padding: 32 }} className="muted">Carregando…</div>;

  return (
    <Ctx.Provider value={{ db, repo: repoRef.current, persistent, run, replaceAll, toast }}>
      {children}
      <div className="toast-zone" role="status" aria-live="polite">
        {saving && <div className="alert toast a-info">Salvando…</div>}
        {toasts.map((t) => (
          <div key={t.id} className={`alert toast a-${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useStore(): StoreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStore fora do StoreProvider');
  return c;
}

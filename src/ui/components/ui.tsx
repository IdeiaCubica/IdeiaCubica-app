/** Componentes de interface compartilhados (padrão visual único para todo o sistema). */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseBR } from '../../domain/money';
import { TextField } from './fields';

export * from './fields';
export { Combobox, type ComboOption } from './combobox';

/* ---------------- Conversão de campos ---------------- */
/** Texto BR → number | null (quantidades). */
export const num = (s: string): number | null => { const d = parseBR(s); return d ? d.toNumber() : null; };
/** Texto BR → string decimal | null (valores monetários). */
export const dec = (s: string): string | null => { const d = parseBR(s); return d ? d.toString() : null; };

export function useForm<T extends object>(initial: T | (() => T)) {
  const [v, setV] = useState<T>(initial);
  const set = <K extends keyof T>(k: K) => (value: T[K]) => setV((s) => ({ ...s, [k]: value }));
  return [v, set, setV] as const;
}

/* ---------------- Feedback ---------------- */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info';
export const Badge = ({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) =>
  <span className={`badge b-${tone}`} title={title}>{children}</span>;

export function Alert({ tone, title, children }: { tone: 'success' | 'warning' | 'error' | 'info'; title?: string; children?: ReactNode }) {
  return <div className={`alert a-${tone}`}>{title && <b>{title}</b>}{children}</div>;
}

export function Empty({ title, text, action }: { title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <img src="/brand/10_icone_simbolo_transparente.svg" alt="" />
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Kpi({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className={`card kpi ${accent ? 'accent' : ''}`}>
      <p className="l">{label}</p>
      <p className="v">{value}</p>
      {hint && <p className="h">{hint}</p>}
    </div>
  );
}

export function PageHead({ eyebrow, title, text, actions }: { eyebrow: string; title: string; text?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{text && <p>{text}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Modal e confirmação ---------------- */
export function Modal({ title, subtitle, onClose, footer, wide, children }: { title: string; subtitle?: string; onClose: () => void; footer?: ReactNode; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="m-head">
          <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button className="btn ghost sm" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="m-body">{children}</div>
        {footer && <div className="m-foot">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmOpts { title: string; text: ReactNode; confirmLabel?: string; danger?: boolean; reasonLabel?: string }
/** Confirmação para operações críticas. Retorna o motivo digitado ('' se não exigido) ou null se cancelado. */
export function useConfirm() {
  const [state, setState] = useState<{ opts: ConfirmOpts; resolve: (v: string | null) => void } | null>(null);
  const [reason, setReason] = useState('');
  const confirm = (opts: ConfirmOpts) => new Promise<string | null>((resolve) => { setReason(''); setState({ opts, resolve }); });
  const close = (v: string | null) => { state?.resolve(v); setState(null); };
  const element = state ? (
    <Modal title={state.opts.title} onClose={() => close(null)} footer={<>
      <button className="btn ghost" onClick={() => close(null)}>Voltar</button>
      <button className={`btn ${state.opts.danger ? 'danger' : 'primary'}`} disabled={!!state.opts.reasonLabel && !reason.trim()} onClick={() => close(reason.trim())}>
        {state.opts.confirmLabel ?? 'Confirmar'}
      </button>
    </>}>
      <div className="stack">
        <div>{state.opts.text}</div>
        {state.opts.reasonLabel && <TextField label={state.opts.reasonLabel} value={reason} onChange={setReason} required autoFocus />}
      </div>
    </Modal>
  ) : null;
  return [confirm, element] as const;
}

/* ---------------- Tabela ---------------- */
export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  num?: boolean;
}

export function DataTable<T>({ rows, columns, search, toolbar, onRowClick, empty, rowKey, footer, initialSort }: {
  rows: T[]; columns: Column<T>[]; search?: (row: T) => string; toolbar?: ReactNode; onRowClick?: (row: T) => void;
  empty: ReactNode; rowKey: (row: T) => string; footer?: ReactNode; initialSort?: { key: string; dir: 1 | -1 };
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null);
  const shown = useMemo(() => {
    let r = rows;
    if (search && q.trim()) {
      const n = q.trim().toLowerCase();
      r = r.filter((x) => search(x).toLowerCase().includes(n));
    }
    const col = columns.find((c) => c.key === sort?.key);
    if (col?.sort && sort) {
      const s = col.sort;
      r = [...r].sort((a, b) => { const va = s(a), vb = s(b); return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir; });
    }
    return r;
  }, [rows, q, sort, columns, search]);

  return (
    <div>
      {(search || toolbar) && (
        <div className="toolbar">
          {search && <input type="search" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />}
          {toolbar}
          <span className="muted small" style={{ marginLeft: 'auto' }}>{shown.length} de {rows.length}</span>
        </div>
      )}
      {rows.length === 0 ? empty : shown.length === 0 ? <div className="empty"><p>Nenhum resultado para a busca.</p></div> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={`${c.num ? 'num' : ''} ${c.sort ? 'sortable' : ''}`}
                    onClick={() => c.sort && setSort((s) => ({ key: c.key, dir: s?.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
                    {c.header}{sort?.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={rowKey(r)} className={onRowClick ? 'clickable' : ''} onClick={() => onRowClick?.(r)}>
                  {columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render(r)}</td>)}
                </tr>
              ))}
            </tbody>
            {footer && <tfoot>{footer}</tfoot>}
          </table>
        </div>
      )}
    </div>
  );
}

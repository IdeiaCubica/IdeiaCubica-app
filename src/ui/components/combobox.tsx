/**
 * Lista suspensa pesquisável — usada em TODAS as listas do sistema.
 *
 * - Clique ou foco abre a lista; digitar filtra (sem diferenciar maiúsculas
 *   e acentos, em qualquer parte do texto).
 * - ↑/↓ navegam, Enter escolhe, Esc fecha, Tab sai.
 * - Acessível: padrão ARIA combobox + listbox.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ComboOption { value: string; label: string }

export interface ComboboxProps {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  /** Texto da opção vazia (ex.: "— nenhum —"). Sem ele, não há opção vazia. */
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  /** Versão menor, para barras de filtro. */
  compact?: boolean;
  className?: string;
}

export const normalizeText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function Combobox(p: ComboboxProps) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = usuário não está digitando
  const [active, setActive] = useState(0);

  const all = useMemo(() => (p.placeholder !== undefined ? [{ value: '', label: p.placeholder }, ...p.options] : p.options), [p.options, p.placeholder]);
  const selected = all.find((o) => o.value === p.value);
  const filtered = useMemo(() => {
    if (!query) return all;
    const q = normalizeText(query.trim());
    return all.filter((o) => o.value !== '' && normalizeText(o.label).includes(q));
  }, [all, query]);

  const close = () => { setOpen(false); setQuery(null); };
  const openList = () => {
    if (p.disabled) return;
    setOpen(true);
    setActive(Math.max(0, all.findIndex((o) => o.value === p.value)));
  };
  const choose = (o: ComboOption) => { p.onChange(o.value); close(); };

  // Fecha ao clicar fora.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  // Mantém a opção destacada visível.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openList(); else setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (open && filtered[active]) { e.preventDefault(); choose(filtered[active]); } }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); close(); } }
    else if (e.key === 'Tab') close();
  };

  const shown = query ?? (selected && selected.value !== '' ? selected.label : '');
  const ph = selected?.value === '' || !selected ? (p.placeholder ?? 'Digite para buscar…') : undefined;

  return (
    <div ref={wrapRef} className={`combo ${p.compact ? 'compact' : ''} ${open ? 'open' : ''} ${p.className ?? ''}`}>
      <input
        id={p.id} role="combobox" aria-label={p.ariaLabel} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined} aria-required={p.required}
        autoComplete="off" spellCheck={false} disabled={p.disabled} value={shown} placeholder={ph}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onFocus={(e) => { e.target.select(); }}
        onClick={() => (open ? undefined : openList())}
        onKeyDown={onKeyDown}
      />
      <span className="combo-caret" aria-hidden="true" onMouseDown={(e) => { e.preventDefault(); if (open) close(); else { openList(); (wrapRef.current?.querySelector('input') as HTMLInputElement | null)?.focus(); } }}>▾</span>
      {open && (
        <ul id={listId} role="listbox" className="combo-list">
          {filtered.length === 0 ? <li className="combo-empty">Nenhum resultado para “{query}”</li> : filtered.map((o, i) => (
            <li key={o.value || '__vazio'} id={`${listId}-${i}`} role="option" aria-selected={o.value === p.value}
              className={`${i === active ? 'active' : ''} ${o.value === p.value ? 'selected' : ''} ${o.value === '' ? 'empty-opt' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); choose(o); }} onMouseEnter={() => setActive(i)}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

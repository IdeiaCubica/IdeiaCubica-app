/** Campos de formulário com rótulo associado (acessível) e entrada numérica no padrão brasileiro. */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { parseBR } from '../../domain/money';
import { Combobox } from './combobox';

export const isInvalidNum = (s: string) => s.trim() !== '' && parseBR(s) === null;

interface FieldProps { label: string; required?: boolean; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }
export function Field({ label, required, hint, error, children, className, htmlFor }: FieldProps) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label htmlFor={htmlFor}>{label}{required && <span className="req"> *</span>}</label>
      {children}
      {error ? <small className="err">{error}</small> : hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function TextField(p: { label: string; value: string; onChange: (v: string) => void; required?: boolean; hint?: ReactNode; placeholder?: string; type?: string; disabled?: boolean; autoFocus?: boolean }) {
  const id = useId();
  return (
    <Field label={p.label} required={p.required} hint={p.hint} htmlFor={id}>
      <input id={id} type={p.type ?? 'text'} value={p.value} placeholder={p.placeholder} disabled={p.disabled} autoFocus={p.autoFocus} aria-required={p.required} onChange={(e) => p.onChange(e.target.value)} />
    </Field>
  );
}

export function NumField(p: { label: string; value: string; onChange: (v: string) => void; suffix?: string; required?: boolean; hint?: ReactNode; placeholder?: string; disabled?: boolean }) {
  const id = useId();
  const invalid = isInvalidNum(p.value);
  return (
    <Field label={p.label} required={p.required} hint={p.hint} htmlFor={id} error={invalid ? 'Número inválido. Use vírgula para decimais (ex.: 12,50).' : null}>
      <div className={p.suffix ? 'suffix' : undefined}>
        <input id={id} inputMode="decimal" className={invalid ? 'invalid' : undefined} aria-invalid={invalid} aria-required={p.required} value={p.value} placeholder={p.placeholder} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value)} />
        {p.suffix && <span aria-hidden="true">{p.suffix}</span>}
      </div>
    </Field>
  );
}

/**
 * Campo decimal ligado diretamente a um valor canônico (string decimal | null).
 * Mantém o texto digitado ("12," durante a digitação) e só propaga valores válidos.
 */
export function DecField(p: { label: string; value: string | number | null | undefined; onChange: (v: string | null) => void; suffix?: string; required?: boolean; hint?: ReactNode; placeholder?: string; disabled?: boolean }) {
  const [text, onText] = useDecimalText(p.value, p.onChange);
  return <NumField label={p.label} value={text} onChange={onText} suffix={p.suffix} required={p.required} hint={p.hint} placeholder={p.placeholder} disabled={p.disabled} />;
}

/** Texto digitado ↔ valor canônico: mantém "12," durante a digitação e só propaga valores válidos. */
function useDecimalText(value: string | number | null | undefined, onChange: (v: string | null) => void, decimals?: number) {
  const canonical = value === null || value === undefined || value === '' ? null : String(value);
  const show = (c: string | null) => (c === null ? '' : (decimals !== undefined ? parseBR(c)!.toFixed(decimals) : c).replace('.', ','));
  const [text, setText] = useState(() => show(canonical));
  useEffect(() => {
    const parsed = parseBR(text);
    const same = parsed === null ? canonical === null : canonical !== null && parsed.eq(canonical);
    if (!same) setText(show(canonical));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical]);
  const onText = (t: string) => { setText(t); const d = parseBR(t); if (t.trim() === '') onChange(null); else if (d) onChange(d.toString()); };
  return [text, onText] as const;
}

/** Campo decimal compacto (sem rótulo visível), para tabelas editáveis. */
export function InlineDec(p: { value: string | number | null | undefined; onChange: (v: string | null) => void; ariaLabel: string; placeholder?: string; prefix?: string; disabled?: boolean; decimals?: number }) {
  const [text, onText] = useDecimalText(p.value, p.onChange, p.decimals ?? 2);
  const invalid = isInvalidNum(text);
  return (
    <span className="inline-dec">
      {p.prefix && <span aria-hidden="true">{p.prefix}</span>}
      <input inputMode="decimal" aria-label={p.ariaLabel} aria-invalid={invalid} className={invalid ? 'invalid' : undefined} value={text} placeholder={p.placeholder} disabled={p.disabled} onChange={(e) => onText(e.target.value)} />
    </span>
  );
}

export function DateField(p: { label: string; value: string; onChange: (v: string) => void; required?: boolean; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={p.label} required={p.required} hint={p.hint} htmlFor={id}>
      <input id={id} type="date" value={p.value} aria-required={p.required} onChange={(e) => p.onChange(e.target.value)} />
    </Field>
  );
}

export interface Option { value: string; label: string }
/** Campo de lista com rótulo — sempre pesquisável (digitar filtra as opções). */
export function SelectField(p: { label: string; value: string; onChange: (v: string) => void; options: Option[]; placeholder?: string; required?: boolean; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <Field label={p.label} required={p.required} hint={p.hint} htmlFor={id}>
      <Combobox id={id} value={p.value} onChange={p.onChange} options={p.options} placeholder={p.placeholder} disabled={p.disabled} required={p.required} />
    </Field>
  );
}

export function TextArea(p: { label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; placeholder?: string }) {
  const id = useId();
  return (
    <Field label={p.label} hint={p.hint} htmlFor={id}>
      <textarea id={id} value={p.value} placeholder={p.placeholder} onChange={(e) => p.onChange(e.target.value)} />
    </Field>
  );
}

export function Check(p: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check"><input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} />{p.label}</label>
  );
}

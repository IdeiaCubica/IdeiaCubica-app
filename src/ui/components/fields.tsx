/** Campos de formulário com rótulo associado (acessível) e entrada numérica no padrão brasileiro. */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { fmtNum, parseBR } from '../../domain/money';
import { fmtDuration, hmToHours, hoursToHM } from '../../domain/conversions';
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
    // "Vazio" e "zero" são equivalentes aqui: telas que guardam 0 como vazio (ou o contrário)
    // não podem apagar o "0" que o usuário começou a digitar (ex.: "0,5").
    const isZero = (c: string | null) => c === null || parseBR(c)?.isZero() === true;
    const same = parsed === null
      ? isZero(canonical)
      : canonical === null ? parsed.isZero() : parsed.eq(canonical);
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

/**
 * Duração em HORAS INTEIRAS + MINUTOS (0–59). O texto digitado nunca é
 * reescrito durante a digitação; o total aparece por extenso para conferência.
 * Decimais em "horas" são recusados com explicação (1,20 é ambíguo).
 */
export function TimeField(p: { label: string; value: number | null | undefined; onChange: (hours: number | null) => void; hint?: ReactNode; required?: boolean }) {
  const id = useId();
  const init = hoursToHM(p.value ?? null);
  const [hText, setH] = useState(init ? String(init.h) : '');
  const [mText, setM] = useState(init ? String(init.m) : '');
  const parseInt0 = (s: string) => (s.trim() === '' ? 0 : /^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const h = parseInt0(hText), m = parseInt0(mText);
  const hErr = Number.isNaN(h) ? (/[.,]/.test(hText) ? 'Use horas inteiras e coloque o restante em minutos (ex.: 1 h e 20 min).' : 'Número inválido.') : null;
  const mErr = Number.isNaN(m) ? 'Número inválido.' : m > 59 ? 'Minutos vão de 0 a 59.' : null;
  const empty = hText.trim() === '' && mText.trim() === '';
  const local = empty || hErr || mErr ? null : hmToHours(h, m);

  // Sincroniza apenas quando o valor muda por fora (ex.: leitura de arquivo 3MF).
  useEffect(() => {
    const ext = p.value ?? null;
    const same = ext === null ? empty : local !== null && Math.abs(local - ext) < 1 / 120;
    if (!same) { const hm = hoursToHM(ext); setH(hm ? String(hm.h) : ''); setM(hm ? String(hm.m) : ''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.value]);

  const emit = (nh: string, nm: string) => {
    const a = parseInt0(nh), b = parseInt0(nm);
    if (nh.trim() === '' && nm.trim() === '') p.onChange(null);
    else if (!Number.isNaN(a) && !Number.isNaN(b) && b <= 59) p.onChange(hmToHours(a, b));
  };
  const err = hErr ?? mErr;
  return (
    <Field label={p.label} required={p.required} htmlFor={id} error={err}
      hint={local !== null ? <>Total: <b>{fmtDuration(local)}</b> ({fmtNum(local, 4)} h){p.hint ? <> · {p.hint}</> : null}</> : p.hint}>
      <div className="time-field">
        <div className="suffix"><input id={id} inputMode="numeric" aria-label={`${p.label} — horas`} aria-invalid={!!hErr} className={hErr ? 'invalid' : undefined}
          value={hText} placeholder="0" onChange={(e) => { setH(e.target.value); emit(e.target.value, mText); }} /><span aria-hidden="true">h</span></div>
        <div className="suffix"><input inputMode="numeric" aria-label={`${p.label} — minutos`} aria-invalid={!!mErr} className={mErr ? 'invalid' : undefined}
          value={mText} placeholder="0" onChange={(e) => { setM(e.target.value); emit(hText, e.target.value); }} /><span aria-hidden="true">min</span></div>
      </div>
    </Field>
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

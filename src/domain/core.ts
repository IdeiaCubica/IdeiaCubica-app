/** Utilidades compartilhadas pelas regras de negócio. */
import type { DB, ID, ISODate, Unit } from './types';

/** Erro de regra de negócio: mensagem pensada para o usuário final. */
export class BusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessError';
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new BusinessError(message);
}

export const newId = (): ID =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

export const nowISO = () => new Date().toISOString();

/** Data local (AAAA-MM-DD) de um instante; instantes são gravados em UTC. */
export function localDateOf(d: Date): ISODate {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const todayISO = (): ISODate => localDateOf(new Date());

/** Converte "AAAA-MM-DD" ou instante ISO completo para a data local. */
export const toLocalDate = (iso: string): ISODate => (iso.length > 10 ? localDateOf(new Date(iso)) : iso);

export function addDays(date: ISODate, days: number): ISODate {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export const isISODate = (s: unknown): s is ISODate => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = toLocalDate(iso).split('-');
  return `${d}/${m}/${y}`;
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  return dt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Gera códigos sequenciais legíveis (ex.: CMP-0001). */
export function nextCode(db: DB, counter: string, prefix: string): string {
  const n = (db.counters[counter] ?? 0) + 1;
  db.counters[counter] = n;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

export function audit(db: DB, action: string, detail?: string) {
  db.audit.push({ at: nowISO(), action, detail });
  if (db.audit.length > 3000) db.audit.splice(0, db.audit.length - 3000);
}

export function byId<T extends { id: ID }>(list: T[], id: ID | undefined, what: string): T {
  const item = id ? list.find((x) => x.id === id) : undefined;
  if (!item) throw new BusinessError(`${what} não encontrado(a).`);
  return item;
}

export function requireText(v: string | undefined | null, field: string): string {
  const s = (v ?? '').trim();
  if (!s) throw new BusinessError(`Informe ${field}.`);
  return s;
}

export function requirePositive(v: number | null | undefined, field: string): number {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) throw new BusinessError(`${field} deve ser maior que zero.`);
  return v;
}

export function requireNonNegative(v: number | null | undefined, field: string): number {
  if (v === null || v === undefined || !Number.isFinite(v) || v < 0) throw new BusinessError(`${field} não pode ser negativo.`);
  return v;
}

/* ------------------------------------------------------------------ */
/* Documentos e telefone                                               */
/* ------------------------------------------------------------------ */
export const onlyDigits = (s: string | undefined | null) => (s ?? '').replace(/\D/g, '');

/** CPF válido pelos dígitos verificadores (rejeita sequências repetidas). */
export function isValidCpf(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

/** CNPJ válido pelos dígitos verificadores (rejeita sequências repetidas). */
export function isValidCnpj(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = w.reduce((acc, wi, i) => acc + Number(d[i]) * wi, 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** Formata CPF/CNPJ para exibição (mantém o texto original se não tiver 11/14 dígitos). */
export function fmtDocument(value?: string | null): string {
  const d = onlyDigits(value);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return value ?? '';
}

export function fmtPhone(value?: string | null): string {
  const d = onlyDigits(value);
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return value ?? '';
}

/* ------------------------------------------------------------------ */
/* Unidades                                                            */
/* ------------------------------------------------------------------ */
export const UNIT_LABEL: Record<Unit, string> = {
  g: 'grama (g)', kg: 'quilograma (kg)', un: 'unidade (un)', m: 'metro (m)', cm: 'centímetro (cm)',
  ml: 'mililitro (ml)', l: 'litro (l)', pacote: 'pacote', rolo: 'rolo',
};

const UNIT_GROUP: Record<Unit, { group: string; factor: number }> = {
  g: { group: 'massa', factor: 1 }, kg: { group: 'massa', factor: 1000 },
  m: { group: 'comprimento', factor: 100 }, cm: { group: 'comprimento', factor: 1 },
  ml: { group: 'volume', factor: 1 }, l: { group: 'volume', factor: 1000 },
  un: { group: 'un', factor: 1 }, pacote: { group: 'pacote', factor: 1 }, rolo: { group: 'rolo', factor: 1 },
};

export const compatibleUnits = (u: Unit): Unit[] =>
  (Object.keys(UNIT_GROUP) as Unit[]).filter((k) => UNIT_GROUP[k].group === UNIT_GROUP[u].group);

/** Converte quantidade entre unidades; lança erro se não houver conversão válida. */
export function convertQty(qty: number, from: Unit, to: Unit): number {
  if (from === to) return qty;
  const a = UNIT_GROUP[from], b = UNIT_GROUP[to];
  if (a.group !== b.group) throw new BusinessError(`Não existe conversão válida de ${from} para ${to}.`);
  return (qty * a.factor) / b.factor;
}

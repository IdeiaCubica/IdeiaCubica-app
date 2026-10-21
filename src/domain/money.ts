/**
 * Aritmética decimal e formatação brasileira.
 *
 * Todo cálculo financeiro passa por Decimal (decimal.js) para evitar erros de
 * ponto flutuante. Valores monetários e custos unitários são persistidos como
 * string decimal (`DecStr`), nunca como number.
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type DecStr = string;
export type DecInput = Decimal.Value | null | undefined;

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);

/** Converte para Decimal. `null`/`undefined`/'' viram zero — use apenas quando zero for semanticamente correto. */
export function D(v: DecInput): Decimal {
  if (v === null || v === undefined || v === '') return ZERO;
  return new Decimal(v);
}

/** Retorna Decimal ou null quando o valor não foi informado. */
export function Dn(v: DecInput): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  return new Decimal(v);
}

export const sum = (vals: DecInput[]): Decimal => vals.reduce<Decimal>((acc, v) => acc.plus(D(v)), ZERO);

/** Arredonda para centavos (meio para cima). */
export const cents = (d: Decimal): Decimal => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Percentual armazenado como "12,5" → fração 0.125 */
export const pct = (v: DecInput): Decimal => D(v).div(100);

/**
 * Divide um total em N parcelas com centavos exatos: a diferença de
 * arredondamento fica na última parcela, garantindo que a soma = total.
 */
export function splitInstallments(total: Decimal, n: number): Decimal[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('Número de parcelas inválido.');
  const base = total.div(n).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] = cents(total.minus(base.times(n - 1)));
  return parts;
}

/**
 * Converte texto digitado no padrão brasileiro ("1.234,56") ou internacional
 * ("1234.56") em Decimal. Retorna null se vazio ou inválido.
 */
export function parseBR(input: string | number | null | undefined): Decimal | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? new Decimal(input) : null;
  let s = input.trim().replace(/\s|R\$|%/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return new Decimal(s);
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function fmtBRL(v: DecInput, decimals = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = D(v);
  if (decimals === 2) return brl.format(cents(d).toNumber());
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(d.toDecimalPlaces(decimals).toNumber());
}

export function fmtNum(v: DecInput, decimals = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: decimals })
    .format(D(v).toDecimalPlaces(decimals).toNumber());
}

/** Formata uma FRAÇÃO (0.25) como "25,0%". */
export function fmtPct(fraction: DecInput, decimals = 1): string {
  if (fraction === null || fraction === undefined || fraction === '') return '—';
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .format(D(fraction).times(100).toDecimalPlaces(decimals).toNumber()) + '%';
}

/** Valor para preencher um campo de texto no padrão BR (sem símbolo). */
export function toInputBR(v: DecInput, decimals = 6): string {
  if (v === null || v === undefined || v === '') return '';
  return D(v).toDecimalPlaces(decimals).toString().replace('.', ',');
}

/**
 * Conversões usadas pela interface — centralizadas aqui para serem testadas
 * (um erro de conversão vira prejuízo direto no preço).
 */
import { D, Decimal } from './money';

/* ---------------- Tempo ---------------- */

/** Horas decimais → horas inteiras + minutos inteiros (arredonda ao minuto, com "vai um" em 60). */
export function hoursToHM(hours: number | null | undefined): { h: number; m: number } | null {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return null;
  const totalMin = Math.round(hours * 60);
  return { h: Math.floor(totalMin / 60), m: totalMin % 60 };
}

/** Horas inteiras + minutos → horas decimais (ex.: 1 h 20 min = 1,3333 h). */
export function hmToHours(h: number, m: number): number {
  return h + m / 60;
}

/** "1 h 20 min" */
export function fmtDuration(hours: number | null | undefined): string {
  const hm = hoursToHM(hours);
  if (!hm) return '—';
  if (hm.h === 0) return `${hm.m} min`;
  return hm.m === 0 ? `${hm.h} h` : `${hm.h} h ${hm.m} min`;
}

/**
 * Lê uma duração digitada de forma livre, sem ambiguidade:
 *   "1:20", "1h20", "1h 20min", "80min", "2h", "45m".
 * Número puro sem unidade ("1,20") é REJEITADO — não dá para saber se é 1 h 20 min ou 1,2 h.
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return hmToHours(Number(m[1]), Number(m[2]));
  m = s.match(/^(\d+)h(?:([0-5]?\d)(?:min|m)?)?$/); // 2h · 1h20 · 1h20min
  if (m) return hmToHours(Number(m[1]), Number(m[2] ?? 0));
  m = s.match(/^(\d+)(?:min|m)$/); // 80min · 45m
  if (m) return hmToHours(0, Number(m[1]));
  return null;
}

/* ---------------- Preço de material ---------------- */

/** R$/kg (como o usuário digita) → R$/g (como o sistema calcula). */
export const perKgToPerGram = (perKg: Decimal.Value): Decimal => D(perKg).div(1000);
/** R$/g → R$/kg (para exibir). */
export const perGramToPerKg = (perGram: Decimal.Value): Decimal => D(perGram).times(1000);

/* ---------------- Energia ---------------- */

/** Potência média em watts → consumo em kWh por hora de impressão. */
export const wattsToKwhPerHour = (watts: Decimal.Value): Decimal => D(watts).div(1000);

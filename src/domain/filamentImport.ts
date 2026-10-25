/**
 * Importação de filamentos por planilha (CSV do Excel/Google Planilhas ou colar as células).
 *
 * Colunas (cabeçalho na 1ª linha; ordem livre, acentos e maiúsculas não importam):
 *   nome* · tipo* · cor* · cor_hex · marca · fabricante · peso_liquido_g · carretel_vazio_g ·
 *   preco_kg · estoque_minimo_g · observacoes
 * Quantidades sempre em GRAMAS; o preço é por kg (R$/kg), como no cadastro.
 */
import type { DB, Material } from './types';
import { D, Decimal } from './money';
import { assert, audit } from './core';
import { saveMaterial, saveNamed } from './catalog';

export const FILAMENT_COLUMNS = ['nome', 'tipo', 'cor', 'cor_hex', 'marca', 'fabricante', 'peso_liquido_g', 'carretel_vazio_g', 'preco_kg', 'estoque_minimo_g', 'observacoes'] as const;
type Col = (typeof FILAMENT_COLUMNS)[number];

/** Modelo para download: separador ";" (abre direto no Excel em português) e BOM para os acentos. */
export function filamentTemplateCsv(): string {
  const rows = [
    FILAMENT_COLUMNS.join(';'),
    'PLA Basic Preto;PLA;Preto;#111111;Bambu Lab;Bambu Lab;1000;250;89,90;500;',
    'PETG HF Azul;PETG;Azul;#1f5fbf;Bambu Lab;Bambu Lab;1000;250;94,90;;carretel com refil',
    'PLA Silk Dourado;PLA Silk;Dourado;#d4a017;Voolt3D;Voolt3D;1000;;119,00;;',
  ];
  return '﻿' + rows.join('\r\n') + '\r\n';
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ALIASES: Record<string, Col> = {
  nome: 'nome', descricao: 'nome', name: 'nome',
  tipo: 'tipo', material: 'tipo', tipo_de_material: 'tipo',
  cor: 'cor', color: 'cor',
  cor_hex: 'cor_hex', hex: 'cor_hex', amostra: 'cor_hex', codigo_da_cor: 'cor_hex',
  marca: 'marca', brand: 'marca',
  fabricante: 'fabricante',
  peso_liquido_g: 'peso_liquido_g', peso_liquido: 'peso_liquido_g', peso: 'peso_liquido_g', peso_g: 'peso_liquido_g', peso_do_carretel: 'peso_liquido_g',
  carretel_vazio_g: 'carretel_vazio_g', carretel_vazio: 'carretel_vazio_g', tara: 'carretel_vazio_g',
  preco_kg: 'preco_kg', preco: 'preco_kg', preco_por_kg: 'preco_kg', 'preco_r$/kg': 'preco_kg', valor_kg: 'preco_kg',
  estoque_minimo_g: 'estoque_minimo_g', estoque_minimo: 'estoque_minimo_g', minimo: 'estoque_minimo_g',
  observacoes: 'observacoes', observacao: 'observacoes', obs: 'observacoes',
};

/** Lê CSV (";", "," ou tabulação, com aspas) ou células coladas do Excel. */
export function parseTable(text: string): string[][] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n').find((l) => l.trim()) ?? '';
  const delim = firstLine.includes('\t') ? '\t' : (firstLine.split(';').length >= firstLine.split(',').length ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Número em pt-BR ("89,90", "1.000", "1000", "R$ 94,90"). */
export function parseNumBR(s: string | undefined): Decimal | null {
  let v = (s ?? '').replace(/\s|R\$|g$/gi, '');
  if (!v) return null;
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(v)) v = v.replace(/\./g, '');
  return /^-?\d+(\.\d+)?$/.test(v) ? D(v) : null;
}

export interface FilamentRow {
  line: number;
  name: string; materialType: string; color: string; colorHex?: string; brand?: string; manufacturer?: string;
  netWeightG: number | null; spoolWeightG: number | null; pricePerKg: Decimal | null; minStockG: number | null; notes?: string;
  /** novo · atualizar (já existe) · erro */
  status: 'novo' | 'existe' | 'erro';
  message?: string;
  existingId?: string;
}

/** Interpreta a planilha e confere cada linha (sem gravar nada). */
export function previewFilamentImport(db: DB, text: string): { rows: FilamentRow[]; missingColumns: string[] } {
  const table = parseTable(text);
  if (!table.length) return { rows: [], missingColumns: ['nome', 'tipo', 'cor'] };
  const header = table[0].map((h) => ALIASES[plain(h).replace(/\s+/g, '_')]);
  const missingColumns = (['nome', 'tipo', 'cor'] as Col[]).filter((c) => !header.includes(c));
  if (missingColumns.length) return { rows: [], missingColumns };
  const seen = new Set<string>();
  const rows = table.slice(1).map((cells, k): FilamentRow => {
    const get = (c: Col) => { const i = header.indexOf(c); return i >= 0 ? (cells[i] ?? '').trim() : ''; };
    const num = (c: Col) => { const d = parseNumBR(get(c)); return d ? d.toNumber() : null; };
    const errs: string[] = [];
    const name = get('nome'), materialType = get('tipo'), color = get('cor');
    if (!name) errs.push('falta o nome');
    if (!materialType) errs.push('falta o tipo (PLA, PETG…)');
    if (!color) errs.push('falta a cor');
    const hexRaw = get('cor_hex');
    const colorHex = hexRaw ? (hexRaw.startsWith('#') ? hexRaw : `#${hexRaw}`) : undefined;
    if (colorHex && !/^#[0-9a-f]{6}$/i.test(colorHex)) errs.push(`cor_hex inválida (${hexRaw}); use #RRGGBB`);
    for (const c of ['peso_liquido_g', 'carretel_vazio_g', 'preco_kg', 'estoque_minimo_g'] as Col[]) {
      if (get(c) && parseNumBR(get(c)) === null) errs.push(`${c} não é número (${get(c)})`);
    }
    const net = num('peso_liquido_g');
    if (net !== null && (net < 50 || net > 20000)) errs.push(`peso_liquido_g = ${net}: informe em gramas (ex.: 1000 para 1 kg)`);
    const price = parseNumBR(get('preco_kg'));
    if (price && (price.lt(20) || price.gt(800))) errs.push(`preço R$ ${get('preco_kg')}/kg fora do normal (R$ 20 a 800/kg); a coluna é o preço por kg`);
    const key = plain(name);
    if (key && seen.has(key)) errs.push('nome repetido na planilha');
    seen.add(key);
    const existing = db.materials.find((m) => plain(m.name) === key);
    return {
      line: k + 2, name, materialType, color, colorHex, brand: get('marca') || undefined, manufacturer: get('fabricante') || undefined,
      netWeightG: net, spoolWeightG: num('carretel_vazio_g'), pricePerKg: price, minStockG: num('estoque_minimo_g'), notes: get('observacoes') || undefined,
      status: errs.length ? 'erro' : existing ? 'existe' : 'novo', message: errs.join('; ') || (existing ? `já cadastrado (${existing.code})` : undefined), existingId: existing?.id,
    };
  });
  return { rows, missingColumns };
}

/** Grava as linhas válidas. Já cadastrados: pulados, ou atualizados se `updateExisting`. */
export function importFilaments(db: DB, rows: FilamentRow[], opts: { updateExisting: boolean }) {
  const cat = db.categories.find((c) => c.isFilament);
  assert(cat, 'Não há categoria de filamento. Crie/ative a categoria Filamentos em Cadastros → Materiais → Categorias.');
  const named = (list: 'brands' | 'manufacturers', name?: string) => {
    if (!name) return undefined;
    return (db[list].find((x) => plain(x.name) === plain(name)) ?? saveNamed(db, list, { name, active: true })).id;
  };
  let created = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    if (r.status === 'erro') { skipped++; continue; }
    const existing: Material | undefined = r.existingId ? db.materials.find((m) => m.id === r.existingId) : undefined;
    if (existing && !opts.updateExisting) { skipped++; continue; }
    const input = {
      name: r.name, categoryId: existing?.categoryId ?? cat.id, unit: 'g' as const, active: existing?.active ?? true,
      brandId: named('brands', r.brand) ?? existing?.brandId, manufacturerId: named('manufacturers', r.manufacturer) ?? existing?.manufacturerId,
      filament: { ...(existing?.filament ?? {}), materialType: r.materialType, color: r.color, colorHex: r.colorHex ?? existing?.filament?.colorHex,
        netWeightG: r.netWeightG ?? existing?.filament?.netWeightG ?? null, spoolWeightG: r.spoolWeightG ?? existing?.filament?.spoolWeightG ?? null },
      referenceCost: r.pricePerKg ? r.pricePerKg.div(1000).toString() : existing?.referenceCost ?? null,
      costSource: existing?.costSource,
      minStock: r.minStockG ?? existing?.minStock ?? null, safetyStock: existing?.safetyStock ?? null, leadTimeDays: existing?.leadTimeDays ?? null,
      location: existing?.location, notes: r.notes ?? existing?.notes, code: existing?.code,
    };
    saveMaterial(db, input, existing?.id);
    if (existing) updated++; else created++;
  }
  audit(db, 'Importação de filamentos', `${created} novo(s), ${updated} atualizado(s), ${skipped} ignorado(s)`);
  return { created, updated, skipped };
}

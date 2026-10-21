/**
 * Leitura de projetos 3MF (Bambu Studio / OrcaSlicer) sem dependências.
 *
 * 3MF é um ZIP. Lemos o diretório central e descompactamos entradas com
 * DecompressionStream('deflate-raw'), nativo dos navegadores modernos.
 *
 * Separação de origem dos dados:
 *   - "fatiador": somente quando o arquivo contém resultado de fatiamento
 *     (slice_info.config com placas, tempo e peso) — exportado com placa fatiada;
 *   - "usuario"/"estimativa" nunca são inventados aqui;
 *   - configurações de perfil (impressora, camada, preenchimento) são
 *     informativas e não substituem um fatiamento.
 */
import type { DataOrigin } from '../domain/types';

interface ZipEntry { name: string; method: number; compSize: number; offset: number }

function readEntries(buf: ArrayBuffer): ZipEntry[] {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Arquivo não é um 3MF/ZIP válido.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Diretório do 3MF corrompido.');
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.push({ name, method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readText(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const v = new DataView(buf);
  const nameLen = v.getUint16(e.offset + 26, true), extraLen = v.getUint16(e.offset + 28, true);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error(`Compressão ${e.method} não suportada.`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

export interface ThreeMFPlate { index: number; predictionSec: number | null; weightG: number | null; filaments: { type: string; color: string; usedG: number | null; usedM: number | null }[] }

export interface ThreeMFInfo {
  application: string | null;
  sliced: boolean;
  plates: ThreeMFPlate[];
  facts: { label: string; value: string; origin: DataOrigin }[];
  totals: { weightG: number | null; hours: number | null };
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

export async function parse3MF(buf: ArrayBuffer): Promise<ThreeMFInfo> {
  const entries = readEntries(buf);
  const get = async (n: string) => { const e = entries.find((x) => x.name === n); return e ? readText(buf, e) : null; };
  const facts: ThreeMFInfo['facts'] = [];

  const model = await get('3D/3dmodel.model');
  const meta = (key: string) => model?.match(new RegExp(`<metadata name="${key}">([^<]*)</metadata>`))?.[1]?.trim() || null;
  const application = meta('Application');
  if (application) facts.push({ label: 'Aplicativo de origem', value: application, origin: 'fatiador' });
  for (const [k, l] of [['Title', 'Título'], ['Designer', 'Criador'], ['License', 'Licença'], ['Origin', 'Origem']] as const) {
    const val = meta(k);
    if (val) facts.push({ label: l, value: val, origin: 'fatiador' });
  }

  const settings = await get('Metadata/project_settings.config');
  if (settings) {
    try {
      const s = JSON.parse(settings) as Record<string, unknown>;
      const one = (k: string) => (Array.isArray(s[k]) ? (s[k] as string[]).join(', ') : typeof s[k] === 'string' ? (s[k] as string) : null);
      const pairs: [string, string][] = [
        ['printer_model', 'Impressora do perfil'], ['print_settings_id', 'Perfil de impressão'], ['layer_height', 'Altura de camada (mm)'],
        ['sparse_infill_density', 'Preenchimento'], ['enable_support', 'Suportes habilitados (1 = sim)'], ['nozzle_diameter', 'Bico (mm)'],
      ];
      for (const [k, l] of pairs) { const val = one(k); if (val) facts.push({ label: l, value: val, origin: 'fatiador' }); }
      const types = Array.isArray(s.filament_type) ? (s.filament_type as string[]) : [];
      if (types.length) facts.push({ label: 'Filamentos configurados no projeto', value: [...new Set(types)].join(', '), origin: 'fatiador' });
    } catch { /* configuração ilegível: ignorada */ }
  }

  const plates: ThreeMFPlate[] = [];
  const slice = await get('Metadata/slice_info.config');
  if (slice) {
    for (const block of slice.match(/<plate>[\s\S]*?<\/plate>/g) ?? []) {
      const m = (k: string) => block.match(new RegExp(`<metadata key="${k}" value="([^"]*)"`))?.[1] ?? null;
      const filaments = (block.match(/<filament [^>]*\/>/g) ?? []).map((f) => ({
        type: attr(f, 'type') ?? '?', color: attr(f, 'color') ?? '',
        usedG: attr(f, 'used_g') ? Number(attr(f, 'used_g')) : null, usedM: attr(f, 'used_m') ? Number(attr(f, 'used_m')) : null,
      }));
      plates.push({ index: Number(m('index') ?? plates.length + 1), predictionSec: m('prediction') ? Number(m('prediction')) : null, weightG: m('weight') ? Number(m('weight')) : null, filaments });
    }
  }
  const sliced = plates.some((p) => p.predictionSec !== null || p.weightG !== null);
  const weightG = sliced ? plates.reduce((s, p) => s + (p.weightG ?? 0), 0) : null;
  const hours = sliced ? plates.reduce((s, p) => s + (p.predictionSec ?? 0), 0) / 3600 : null;
  if (sliced) {
    facts.push({ label: 'Placas fatiadas', value: String(plates.length), origin: 'fatiador' });
    facts.push({ label: 'Peso total do fatiador (g)', value: weightG!.toFixed(2), origin: 'fatiador' });
    facts.push({ label: 'Tempo total do fatiador (h)', value: hours!.toFixed(2), origin: 'fatiador' });
  } else {
    facts.push({ label: 'Peso e tempo de impressão', value: 'Não disponíveis: o 3MF não contém resultado de fatiamento. Fatie no Bambu Studio/Orca e informe os valores, ou exporte "placa fatiada".', origin: 'pendente' });
  }
  return { application, sliced, plates, facts, totals: { weightG, hours } };
}

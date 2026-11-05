/**
 * Gravação por registro (v1.21).
 *
 * Antes, cada operação gravava o sistema INTEIRO (um documento de vários MB) no banco:
 * o banco precisava ler, comprimir e gravar tudo a cada clique, e o custo crescia junto com
 * os dados (mais orçamentos, movimentos, títulos…). Isso esgotava a CPU do banco.
 *
 * Agora o documento é guardado em linhas (tabela app_records), uma por registro:
 *   - coleções de entidades (arrays de objetos com `id`): uma linha por entidade  → coll "e:<chave>"
 *   - listas sem id (ex.: auditoria): blocos de CHUNK itens                          → coll "c:<chave>"
 *   - o resto (configurações, contadores…): uma linha por chave                      → coll "d"
 * Cada gravação envia só as linhas que mudaram. Na memória do app nada muda: o objeto DB é o mesmo.
 *
 * A mesma divisão é feita no banco (split_app_state, na migração) — as regras precisam ser idênticas.
 */

export const CHUNK = 250;
/** Espaço entre as posições de entidades novas (permite inserir no meio sem renumerar tudo). */
const GAP = 1024;

export interface RecordRow { c: string; i: string; o: number; d: unknown }
export const rowKey = (r: Pick<RecordRow, 'c' | 'i'>) => `${r.c}\u0000${r.i}`;

/** Array de entidades: não vazio, só objetos com id texto, sem ids repetidos. */
function isEntityArray(v: unknown[]): v is { id: string }[] {
  if (!v.length) return false;
  const ids = new Set<string>();
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x) || typeof (x as { id?: unknown }).id !== 'string') return false;
    const id = (x as { id: string }).id;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

/**
 * Divide o documento em linhas. `prevOrd` (posição de cada entidade na última gravação) mantém as
 * posições estáveis: acrescentar ou apagar um registro não renumera os outros.
 */
export function toRows(doc: Record<string, unknown>, prevOrd: Map<string, number> = new Map()): RecordRow[] {
  const rows: RecordRow[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue; // vazio = sem linhas (a coleção volta vazia ao carregar)
      if (isEntityArray(value)) {
        const c = `e:${key}`;
        let prev = -Infinity;
        value.forEach((item, idx) => {
          const known = prevOrd.get(rowKey({ c, i: item.id }));
          let o: number;
          if (known !== undefined && known > prev) o = known;
          else {
            // Próxima posição conhecida à frente (para inserir no meio sem empurrar as seguintes).
            let next: number | undefined;
            for (let j = idx + 1; j < value.length; j++) {
              const k = prevOrd.get(rowKey({ c, i: value[j].id }));
              if (k !== undefined && k > prev) { next = k; break; }
            }
            o = prev === -Infinity ? (next !== undefined ? next - GAP : 0) : next !== undefined && next - prev > 1e-6 ? (prev + next) / 2 : prev + GAP;
          }
          prev = o;
          rows.push({ c, i: item.id, o, d: item });
        });
      } else {
        const c = `c:${key}`;
        for (let n = 0; n * CHUNK < value.length; n++) rows.push({ c, i: `k${n}`, o: n, d: value.slice(n * CHUNK, (n + 1) * CHUNK) });
      }
    } else {
      rows.push({ c: 'd', i: key, o: 0, d: value });
    }
  }
  return rows;
}

/** Remonta o documento a partir das linhas (ordem: posição, depois id). */
export function fromRows(rows: RecordRow[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  const groups = new Map<string, RecordRow[]>();
  for (const r of rows) {
    if (r.c === 'd') { doc[r.i] = r.d; continue; }
    const g = groups.get(r.c) ?? [];
    g.push(r);
    groups.set(r.c, g);
  }
  for (const [c, g] of groups) {
    g.sort((a, b) => a.o - b.o || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));
    const key = c.slice(2);
    doc[key] = c.startsWith('e:') ? g.map((r) => r.d) : g.flatMap((r) => r.d as unknown[]);
  }
  return doc;
}

/** Estado da última gravação: conteúdo (JSON) e posição de cada linha. */
export interface SavedState { json: Map<string, string>; ord: Map<string, number> }
export const emptySaved = (): SavedState => ({ json: new Map(), ord: new Map() });

export function savedFrom(rows: RecordRow[]): SavedState {
  const s = emptySaved();
  for (const r of rows) { const k = rowKey(r); s.json.set(k, JSON.stringify(r.d)); s.ord.set(k, r.o); }
  return s;
}

/** O que mudou desde a última gravação: linhas novas/alteradas e linhas apagadas. */
export function diffRows(rows: RecordRow[], saved: SavedState) {
  const upserts: RecordRow[] = [];
  const next = emptySaved();
  for (const r of rows) {
    const k = rowKey(r);
    const j = JSON.stringify(r.d);
    next.json.set(k, j); next.ord.set(k, r.o);
    if (saved.json.get(k) !== j || saved.ord.get(k) !== r.o) upserts.push(r);
  }
  const deletes = [...saved.json.keys()].filter((k) => !next.json.has(k)).map((k) => { const [c, i] = k.split('\u0000'); return { c, i }; });
  return { upserts, deletes, next };
}

/**
 * Fotos fora do documento principal.
 *
 * No banco, cada foto (data URL) é guardada uma vez na tabela `app_images`, com o id =
 * SHA-256 do conteúdo; no documento do sistema fica só a referência `img:<id>`.
 * Na memória do app nada muda: ao carregar, as referências viram fotos de novo.
 */

export const IMG_REF = 'img:';
const REF_RE = /^img:[0-9a-f]{64}$/;
/** Só fotos de verdade (data URL de imagem) e de tamanho relevante saem do documento. */
export const isInlineImage = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:image/') && v.length > 512;
export const isImageRef = (v: unknown): v is string => typeof v === 'string' && REF_RE.test(v);

function walk(node: unknown, visit: (s: string) => void) {
  if (typeof node === 'string') { visit(node); return; }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walk(x, visit); return; }
  for (const k of Object.keys(node as Record<string, unknown>)) walk((node as Record<string, unknown>)[k], visit);
}

export function collectInlineImages(root: unknown): Set<string> {
  const out = new Set<string>();
  walk(root, (s) => { if (isInlineImage(s)) out.add(s); });
  return out;
}

export function collectImageRefs(root: unknown): Set<string> {
  const out = new Set<string>();
  walk(root, (s) => { if (isImageRef(s)) out.add(s.slice(IMG_REF.length)); });
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cópia do documento com as fotos trocadas pelas referências (o original não é alterado). */
export function withImageRefs<T>(root: T, idOf: Map<string, string>): T {
  return JSON.parse(JSON.stringify(root, (_k, v) => (isInlineImage(v) && idOf.has(v) ? IMG_REF + idOf.get(v) : v))) as T;
}

/** Troca, no próprio objeto, as referências pelas fotos. Referências sem foto viram null. */
export function hydrateImages(root: unknown, images: Map<string, string>): void {
  const fix = (node: unknown): unknown => {
    if (isImageRef(node)) return images.get(node.slice(IMG_REF.length)) ?? null;
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = fix(node[i]); return node; }
    const o = node as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = fix(o[k]);
    return node;
  };
  fix(root);
}

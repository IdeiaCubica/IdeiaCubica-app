/** Fotos fora do documento: ida (referências) e volta (fotos) sem perder nada. */
import { describe, expect, it } from 'vitest';
import { collectImageRefs, collectInlineImages, hydrateImages, sha256Hex, withImageRefs } from './images';

const photo = (c: string) => 'data:image/jpeg;base64,' + c.repeat(2000);

describe('Fotos separadas do documento', () => {
  it('troca cada foto por uma referência curta e volta ao original', async () => {
    const a = photo('A'), b = photo('B');
    const db = { quotes: [{ versions: [{ items: [{ image: a, name: 'X' }, { image: b }, { image: a }] }] }], finishedGoods: [{ image: null }], note: 'data:image/png;base64,curta' };
    const inline = collectInlineImages(db);
    expect(inline.size).toBe(2); // a foto repetida conta uma vez; a "curta" fica no documento
    const idOf = new Map<string, string>();
    for (const s of inline) idOf.set(s, await sha256Hex(s));
    const stored = withImageRefs(db, idOf);
    const json = JSON.stringify(stored);
    expect(json.length).toBeLessThan(600); // ~12 KB de fotos viram ~200 caracteres de referência
    expect(db.quotes[0].versions[0].items[0].image).toBe(a); // o original não muda
    expect(collectImageRefs(stored)).toEqual(new Set([idOf.get(a), idOf.get(b)]));
    const images = new Map([...idOf].map(([data, id]) => [id, data]));
    hydrateImages(stored, images);
    expect(stored).toEqual(db);
  });

  it('id é o SHA-256 do conteúdo (mesma foto = mesmo id)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('referência sem foto no banco vira vazio, sem quebrar', () => {
    const doc = { image: 'img:' + '0'.repeat(64) };
    hydrateImages(doc, new Map());
    expect(doc.image).toBeNull();
  });
});

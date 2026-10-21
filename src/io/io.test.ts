/** Testes dos leitores de arquivo com os modelos reais da pasta "Modelos STL" (pulados se ausentes). */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStl } from './stl';
import { parse3MF } from './threeMF';

const dir = resolve(__dirname, '../../../Modelos STL/Kartodromo Granja Viana/slt melhorada');
const file = (n: string) => resolve(dir, n);
const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('STL', () => {
  it('cubo ASCII de 10 mm → 1 cm³', () => {
    const v = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
    const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
    const txt = 'solid c\n' + f.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i].join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n') + '\nendsolid c';
    const info = parseStl(new TextEncoder().encode(txt).buffer as ArrayBuffer);
    expect(info.triangles).toBe(12);
    expect(info.volumeCm3).toBeCloseTo(1, 6);
    expect(info.sizeMm).toEqual({ x: 10, y: 10, z: 10 });
  });

  it.skipIf(!existsSync(file('pista_kgv_102_leve.stl')))('lê o STL real da pista', () => {
    const info = parseStl(toAB(readFileSync(file('pista_kgv_102_leve.stl'))));
    expect(info.triangles).toBeGreaterThan(0);
    expect(info.volumeCm3).toBeGreaterThan(0);
  });
});

describe('3MF', () => {
  it.skipIf(!existsSync(file('pista_kgv_102_leve.3mf')))('3MF sem fatiamento não inventa peso/tempo', async () => {
    const info = await parse3MF(toAB(readFileSync(file('pista_kgv_102_leve.3mf'))));
    expect(info.sliced).toBe(false);
    expect(info.totals.weightG).toBeNull();
    expect(info.facts.some((f) => f.label === 'Impressora do perfil' && f.value.includes('A1'))).toBe(true);
    expect(info.facts.some((f) => f.origin === 'pendente')).toBe(true);
  });
});

/** v1.21: gravação por registro — divisão sem perda e só o que mudou vai para o banco. */
import { describe, expect, it } from 'vitest';
import { CHUNK, diffRows, emptySaved, fromRows, savedFrom, toRows } from './records';
import { createEmptyDB, migrate } from '../domain/schema';
import { saveParty } from '../domain/catalog';
import { audit } from '../domain/core';
import { emptyQuoteInput, saveQuote } from '../domain/quotes';

function sample() {
  const db = createEmptyDB();
  for (let i = 0; i < 5; i++) saveParty(db, { kind: 'cliente', name: `Cliente ${i}` });
  for (let i = 0; i < CHUNK + 40; i++) audit(db, 'teste', `linha ${i}`);
  saveQuote(db, { name: 'Vaso' }, [{ name: 'Vaso', input: { ...emptyQuoteInput(db.settings), quantity: 2 } }]);
  return db;
}
const roundTrip = (rows: ReturnType<typeof toRows>) => JSON.parse(JSON.stringify(rows)) as ReturnType<typeof toRows>;

describe('Gravação por registro', () => {
  it('dividir e remontar devolve exatamente o mesmo sistema', () => {
    const db = sample();
    const rows = roundTrip(toRows(db as unknown as Record<string, unknown>));
    const back = migrate(fromRows(rows));
    expect(JSON.stringify(back)).toBe(JSON.stringify(migrate(JSON.parse(JSON.stringify(db)))));
    expect(rows.filter((r) => r.c === 'e:parties')).toHaveLength(5);
    expect(rows.filter((r) => r.c === 'c:audit')).toHaveLength(2); // auditoria em blocos
    expect(rows.find((r) => r.c === 'd' && r.i === 'settings')).toBeTruthy();
  });

  it('nada mudou → nada é enviado; uma alteração → só aquela linha', () => {
    const db = sample();
    const saved = savedFrom(roundTrip(toRows(db as unknown as Record<string, unknown>)));
    let d = diffRows(toRows(db as unknown as Record<string, unknown>, saved.ord), saved);
    expect([d.upserts.length, d.deletes.length]).toEqual([0, 0]);
    db.parties[2].name = 'Ana alterada';
    d = diffRows(toRows(db as unknown as Record<string, unknown>, saved.ord), saved);
    expect(d.upserts.map((r) => `${r.c}/${r.i}`)).toEqual([`e:parties/${db.parties[2].id}`]);
  });

  it('acrescentar e apagar não renumeram os outros registros', () => {
    const db = sample();
    let saved = savedFrom(toRows(db as unknown as Record<string, unknown>));
    saveParty(db, { kind: 'cliente', name: 'Nova' });
    let d = diffRows(toRows(db as unknown as Record<string, unknown>, saved.ord), saved);
    expect(d.upserts.filter((r) => r.c === 'e:parties')).toHaveLength(1); // só a nova
    saved = d.next;
    const removed = db.parties[0].id;
    db.parties = db.parties.filter((p) => p.id !== removed);
    d = diffRows(toRows(db as unknown as Record<string, unknown>, saved.ord), saved);
    expect(d.upserts.filter((r) => r.c === 'e:parties')).toHaveLength(0);
    expect(d.deletes).toEqual([{ c: 'e:parties', i: removed }]);
    // A ordem continua a mesma ao remontar
    const back = fromRows(toRows(db as unknown as Record<string, unknown>, d.next.ord)) as { parties: { id: string }[] };
    expect(back.parties.map((p) => p.id)).toEqual(db.parties.map((p) => p.id));
  });

  it('inserir no meio mantém a ordem sem regravar as seguintes', () => {
    const db = sample();
    const saved = savedFrom(toRows(db as unknown as Record<string, unknown>));
    const novo = { ...db.parties[0], id: 'novo-meio', name: 'Meio' };
    db.parties.splice(2, 0, novo);
    const rows = toRows(db as unknown as Record<string, unknown>, saved.ord);
    const d = diffRows(rows, saved);
    expect(d.upserts.filter((r) => r.c === 'e:parties').map((r) => r.i)).toEqual(['novo-meio']);
    expect((fromRows(rows) as { parties: { id: string }[] }).parties.map((p) => p.id)).toEqual(db.parties.map((p) => p.id));
  });

  it('nova auditoria mexe só no último bloco; coleção esvaziada apaga as linhas', () => {
    const db = sample();
    const saved = savedFrom(toRows(db as unknown as Record<string, unknown>));
    audit(db, 'mais uma');
    let d = diffRows(toRows(db as unknown as Record<string, unknown>, saved.ord), saved);
    expect(d.upserts.map((r) => `${r.c}/${r.i}`)).toEqual(['c:audit/k1']);
    db.parties = [];
    d = diffRows(toRows(db as unknown as Record<string, unknown>, saved.ord), saved);
    expect(d.deletes.filter((x) => x.c === 'e:parties')).toHaveLength(5);
    expect((migrate(fromRows(toRows(db as unknown as Record<string, unknown>))) as { parties: unknown[] }).parties).toEqual([]);
    expect(emptySaved().json.size).toBe(0);
  });
});

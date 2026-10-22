/** Testes de cadastros: clientes completos, CPF/CNPJ, listas de marcas/fabricantes/fontes e migração. */
import { describe, expect, it } from 'vitest';
import { createEmptyDB, migrate } from './schema';
import { deleteNamed, saveMaterial, saveNamed, saveParty } from './catalog';
import { fmtDocument, isValidCnpj, isValidCpf } from './core';
import { fromViaCep } from './address';

describe('CPF e CNPJ', () => {
  it('valida dígitos verificadores', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });
  it('formata para exibição', () => {
    expect(fmtDocument('52998224725')).toBe('529.982.247-25');
    expect(fmtDocument('11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('Clientes', () => {
  const full = (db: ReturnType<typeof createEmptyDB>) => ({
    kind: 'cliente' as const, name: 'Maria da Silva', address: 'Rua A, 10 — São Paulo/SP', phone: '(11) 98765-4321',
    document: '529.982.247-25', sourceId: db.leadSources[0].id, notes: '',
  });

  it('só o nome é obrigatório (cliente sem CPF, endereço ou telefone é aceito)', () => {
    const db = createEmptyDB();
    expect(() => saveParty(db, { kind: 'cliente', name: '' })).toThrow(/nome/);
    expect(saveParty(db, { kind: 'cliente', name: 'Cliente sem documento' }).document).toBeFalsy();
    const p = saveParty(db, full(db));
    expect(p.document).toBe('52998224725');
    expect(p.phone).toBe('11987654321');
  });
  it('endereço por partes gera a linha formatada e valida o CEP', () => {
    const db = createEmptyDB();
    const p = saveParty(db, { kind: 'cliente', name: 'Ana', addressParts: { cep: '01001-000', street: 'Praça da Sé', number: '100', district: 'Sé', city: 'São Paulo', state: 'sp' } });
    expect(p.address).toBe('Praça da Sé, 100 — Sé — São Paulo/SP — CEP 01001-000');
    expect(p.addressParts!.cep).toBe('01001000');
    expect(() => saveParty(db, { kind: 'cliente', name: 'Bia', addressParts: { cep: '123' } })).toThrow(/CEP/);
  });
  it('converte a resposta do ViaCEP e reconhece CEP inexistente', () => {
    expect(fromViaCep({ cep: '01001-000', logradouro: 'Praça da Sé', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' }))
      .toEqual({ cep: '01001000', street: 'Praça da Sé', district: 'Sé', city: 'São Paulo', state: 'SP' });
    expect(fromViaCep({ erro: true })).toBeNull();
    expect(fromViaCep({ erro: 'true' })).toBeNull();
  });
  it('rejeita CPF inválido, telefone curto e CPF duplicado', () => {
    const db = createEmptyDB();
    expect(() => saveParty(db, { ...full(db), document: '123.456.789-00' })).toThrow(/CPF\/CNPJ inválido/);
    expect(() => saveParty(db, { ...full(db), phone: '98765' })).toThrow(/Telefone/);
    saveParty(db, full(db));
    expect(() => saveParty(db, { ...full(db), name: 'Outra' })).toThrow(/Já existe/);
  });
  it('fornecedor exige apenas o nome', () => {
    const db = createEmptyDB();
    expect(saveParty(db, { kind: 'fornecedor', name: 'Loja de filamentos' }).name).toBe('Loja de filamentos');
  });
  it('fontes de captação iniciais incluem as citadas pela empresa', () => {
    expect(createEmptyDB().leadSources.map((s) => s.name)).toEqual(['Instagram', 'Venda direta', 'Mercado Livre', 'Shopee']);
  });
});

describe('Marcas, fabricantes e fontes', () => {
  it('cria, impede duplicado e só exclui quando não está em uso', () => {
    const db = createEmptyDB();
    const b = saveNamed(db, 'brands', { name: 'Voolt', active: true });
    expect(() => saveNamed(db, 'brands', { name: 'voolt', active: true })).toThrow(/Já existe/);
    const cat = db.categories.find((c) => c.isFilament)!;
    saveMaterial(db, { name: 'PLA', categoryId: cat.id, unit: 'g', active: true, brandId: b.id, filament: { materialType: 'PLA', color: 'Preto' } });
    expect(() => deleteNamed(db, 'brands', b.id)).toThrow(/em uso/);
    const other = saveNamed(db, 'manufacturers', { name: 'Fábrica X', active: true });
    deleteNamed(db, 'manufacturers', other.id);
    expect(db.manufacturers).toHaveLength(0);
  });
  it('material não aceita marca inexistente', () => {
    const db = createEmptyDB();
    const cat = db.categories.find((c) => c.isFilament)!;
    expect(() => saveMaterial(db, { name: 'PLA', categoryId: cat.id, unit: 'g', active: true, brandId: 'x', filament: { materialType: 'PLA', color: 'Preto' } })).toThrow(/Marca/);
  });
  it('migra marca/fabricante em texto (v0.1) para as listas', () => {
    const old = createEmptyDB() as unknown as Record<string, unknown>;
    delete old.brands; delete old.manufacturers; delete old.leadSources;
    const cat = (old.categories as { id: string; isFilament: boolean }[]).find((c) => c.isFilament)!;
    old.materials = [{ id: 'm1', code: 'MAT-1', name: 'PLA', categoryId: cat.id, unit: 'g', active: true, createdAt: '', filament: { materialType: 'PLA', color: 'Preto', brand: 'Voolt', manufacturer: 'Voolt Ind.' } }];
    const db = migrate(old);
    expect(db.brands.map((b) => b.name)).toEqual(['Voolt']);
    expect(db.manufacturers.map((b) => b.name)).toEqual(['Voolt Ind.']);
    expect(db.materials[0].brandId).toBe(db.brands[0].id);
    expect(db.leadSources.length).toBe(4);
  });
});

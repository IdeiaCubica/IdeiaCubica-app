/** Cadastros: materiais, categorias, fornecedores/clientes, impressoras, canais, despesas indiretas, contas. */
import type { Account, Category, DB, ID, Material, NamedItem, Overhead, Party, Printer, SalesChannel } from './types';
import { D, Decimal, Dn } from './money';
import { BusinessError, assert, audit, byId, isValidCnpj, isValidCpf, newId, nowISO, onlyDigits, requireText } from './core';
import { formatAddress, isValidCep } from './address';

/* ---------------- Materiais ---------------- */
export type MaterialInput = Omit<Material, 'id' | 'code' | 'createdAt'> & { code?: string };

export function saveMaterial(db: DB, input: MaterialInput, id?: ID): Material {
  const name = requireText(input.name, 'o nome do material');
  const category = byId(db.categories, input.categoryId, 'Categoria');
  if (category.isFilament) {
    assert(input.filament, 'Informe os dados técnicos do filamento.');
    requireText(input.filament.materialType, 'o tipo de material (PLA, PETG...)');
    requireText(input.filament.color, 'a cor');
    assert(input.unit === 'g', 'Filamentos são controlados em gramas (g).');
  }
  for (const [v, label] of [[input.minStock, 'Estoque mínimo'], [input.safetyStock, 'Estoque de segurança'], [input.leadTimeDays, 'Prazo de reposição']] as const) {
    if (v !== null && v !== undefined) assert(v >= 0, `${label} não pode ser negativo.`);
  }
  if (input.referenceCost !== null && input.referenceCost !== undefined) assert(D(input.referenceCost).gte(0), 'O preço de referência não pode ser negativo.');
  if (input.brandId) byId(db.brands, input.brandId, 'Marca');
  if (input.manufacturerId) byId(db.manufacturers, input.manufacturerId, 'Fabricante');
  const code = (input.code ?? '').trim();
  if (code && db.materials.some((m) => m.code.toLowerCase() === code.toLowerCase() && m.id !== id)) {
    throw new BusinessError(`Já existe um material com o código ${code}.`);
  }
  if (id) {
    const mat = byId(db.materials, id, 'Material');
    if (mat.unit !== input.unit && db.lots.some((l) => l.materialId === id)) {
      throw new BusinessError('A unidade não pode ser alterada após existirem lotes deste material (os saldos ficariam inconsistentes).');
    }
    Object.assign(mat, { ...input, name, code: code || mat.code, filament: category.isFilament ? input.filament : undefined });
    audit(db, 'Material alterado', `${mat.code} ${mat.name}`);
    return mat;
  }
  const mat: Material = {
    ...input, id: newId(), name, code: code || nextMaterialCode(db, category),
    filament: category.isFilament ? input.filament : undefined, createdAt: nowISO(),
  };
  db.materials.push(mat);
  audit(db, 'Material cadastrado', `${mat.code} ${mat.name}`);
  return mat;
}

const DEFAULT_SIGLAS: Record<string, string> = {
  filamentos: 'FL', 'sacos plasticos': 'SP', 'caixas e embalagens': 'CX', etiquetas: 'ET', 'fitas adesivas': 'FT',
  'cola e adesivos': 'CL', pinceis: 'PN', lixas: 'LX', 'ferramentas e acessorios': 'FR', 'pecas de reposicao': 'PR', 'outros consumiveis': 'OC',
};
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Sigla sugerida para uma categoria: conhecida, ou as iniciais (sem repetir outra categoria). */
/** Nome do insumo para listas de seleção, com tipo e cor do filamento (quando o nome ainda não os tem). */
export function materialLabel(m: Pick<Material, 'name' | 'filament'>) {
  const f = m.filament;
  if (!f) return m.name;
  const name = m.name.toLowerCase();
  const extra = [f.materialType, f.color].filter((x) => x && !name.includes(x.toLowerCase()));
  return extra.length ? `${m.name} · ${extra.join(' ')}` : m.name;
}

export function suggestSigla(db: DB, name: string, exceptId?: ID): string {
  const known = DEFAULT_SIGLAS[plain(name)];
  const used = new Set(db.categories.filter((c) => c.id !== exceptId && c.code).map((c) => c.code!));
  if (known && !used.has(known)) return known;
  const words = plain(name).replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 2 || /\d/.test(w));
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? 'IN').slice(0, 2)).toUpperCase();
  if (!used.has(letters)) return letters;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(letters[0] + ch)) return letters[0] + ch;
  return letters + used.size;
}

export function normalizeSigla(s: string) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); }

/**
 * Próximo código do insumo pela sigla da categoria: SIGLA + 5 dígitos, seguindo o
 * maior número já usado com essa sigla (inclusive códigos digitados à mão).
 * Ex.: existe FL00002 → próximo FL00003.
 */
export function nextMaterialCode(db: DB, category: Category): string {
  const sigla = category.code || suggestSigla(db, category.name, category.id);
  const re = new RegExp(`^${sigla}-?(\\d+)$`, 'i');
  const max = db.materials.reduce((m, x) => { const g = x.code.match(re); return g ? Math.max(m, Number(g[1])) : m; }, 0);
  let n = max + 1;
  let code = `${sigla}${String(n).padStart(5, '0')}`;
  while (db.materials.some((x) => x.code.toLowerCase() === code.toLowerCase())) code = `${sigla}${String(++n).padStart(5, '0')}`;
  return code;
}

/** Garante sigla em todas as categorias (dados anteriores à v1.5). */
export function ensureCategorySiglas(db: DB) {
  for (const c of db.categories) if (!c.code) c.code = suggestSigla(db, c.name, c.id);
}

/** Histórico de custos de aquisição de um material (por lote, em ordem cronológica). */
export function priceHistory(db: DB, materialId: ID) {
  return db.lots
    .filter((l) => l.materialId === materialId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((l) => ({ lot: l, unitCost: D(l.unitCost), supplier: db.parties.find((p) => p.id === l.supplierId)?.name }));
}

/* ---------------- Listas simples: marcas, fabricantes, fontes de captação ---------------- */
export type NamedList = 'brands' | 'manufacturers' | 'leadSources';
const NAMED_LABEL: Record<NamedList, string> = { brands: 'marca', manufacturers: 'fabricante', leadSources: 'fonte de captação' };

export function saveNamed(db: DB, list: NamedList, input: { name: string; active: boolean }, id?: ID): NamedItem {
  const label = NAMED_LABEL[list];
  const name = requireText(input.name, `o nome da ${label}`);
  assert(!db[list].some((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== id), `Já existe ${label === 'fabricante' ? 'um fabricante' : 'uma ' + label} com esse nome.`);
  if (id) {
    const item = byId(db[list], id, label);
    Object.assign(item, { name, active: input.active });
    audit(db, `Cadastro alterado (${label})`, name);
    return item;
  }
  const item = { id: newId(), name, active: input.active };
  db[list].push(item);
  audit(db, `Cadastro criado (${label})`, name);
  return item;
}

/** Quantos registros usam o item (impede exclusão; permite apenas desativar). */
export function namedUsage(db: DB, list: NamedList, id: ID): number {
  if (list === 'brands') return db.materials.filter((m) => m.brandId === id).length;
  if (list === 'manufacturers') return db.materials.filter((m) => m.manufacturerId === id).length;
  return db.parties.filter((p) => p.sourceId === id).length;
}

export function deleteNamed(db: DB, list: NamedList, id: ID) {
  const item = byId(db[list], id, NAMED_LABEL[list]);
  const used = namedUsage(db, list, id);
  if (used > 0) throw new BusinessError(`"${item.name}" está em uso em ${used} cadastro(s). Desative em vez de excluir.`);
  db[list] = db[list].filter((x) => x.id !== id);
  audit(db, `Cadastro excluído (${NAMED_LABEL[list]})`, item.name);
}

/* ---------------- Categorias ---------------- */
export function saveCategory(db: DB, input: Omit<Category, 'id'>, id?: ID) {
  const name = requireText(input.name, 'o nome da categoria');
  if (db.categories.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== id)) throw new BusinessError('Já existe uma categoria com esse nome.');
  const code = normalizeSigla(input.code ?? '') || suggestSigla(db, name, id);
  assert(code.length >= 2, 'A sigla deve ter de 2 a 4 letras ou números.');
  if (db.categories.some((c) => c.code === code && c.id !== id)) throw new BusinessError(`A sigla ${code} já é usada por outra categoria.`);
  if (id) {
    const c = byId(db.categories, id, 'Categoria');
    if (c.isFilament !== input.isFilament && db.materials.some((m) => m.categoryId === id)) {
      throw new BusinessError('Não é possível mudar o tipo (filamento) de uma categoria que já possui materiais.');
    }
    Object.assign(c, { ...input, name, code });
    return c;
  }
  const c = { ...input, name, code, id: newId() };
  db.categories.push(c);
  return c;
}

/* ---------------- Fornecedores e clientes ---------------- */
/**
 * Clientes e fornecedores: apenas o NOME é obrigatório (nem todo cliente informa
 * CPF ou endereço). O que for preenchido é validado: CPF/CNPJ pelos dígitos
 * verificadores e sem duplicidade, telefone com DDD, CEP com 8 dígitos.
 */
export function saveParty(db: DB, input: Omit<Party, 'id'>, id?: ID): Party {
  const name = requireText(input.name, input.kind === 'cliente' ? 'o nome do cliente' : 'o nome');
  const parts = input.addressParts ? { ...input.addressParts, cep: onlyDigits(input.addressParts.cep) || undefined } : undefined;
  if (parts?.cep) assert(isValidCep(parts.cep), 'CEP deve ter 8 dígitos.');
  const hasParts = parts && Object.values(parts).some((v) => (v ?? '').toString().trim());
  const data: Omit<Party, 'id'> = {
    ...input, name, addressParts: hasParts ? parts : undefined,
    address: hasParts ? formatAddress(parts) : input.address?.trim(),
    phone: input.phone?.trim(), document: input.document?.trim(), notes: input.notes?.trim(),
  };
  if (data.document) {
    const d = onlyDigits(data.document);
    const ok = d.length === 11 ? isValidCpf(d) : d.length === 14 ? isValidCnpj(d) : false;
    assert(ok, 'CPF/CNPJ inválido. Confira os números (CPF tem 11 dígitos, CNPJ tem 14).');
    data.document = d;
    const dup = db.parties.find((p) => p.kind === input.kind && p.id !== id && onlyDigits(p.document) === d);
    assert(!dup, `Já existe um ${input.kind} com este CPF/CNPJ: ${dup?.name}.`);
  }
  if (data.phone) {
    assert(onlyDigits(data.phone).length >= 10, 'Telefone inválido: informe DDD + número.');
    data.phone = onlyDigits(data.phone);
  }
  if (data.sourceId) byId(db.leadSources, data.sourceId, 'Fonte de captação');
  if (id) {
    const p = byId(db.parties, id, 'Cadastro');
    Object.assign(p, data);
    audit(db, input.kind === 'cliente' ? 'Cliente alterado' : 'Fornecedor alterado', name);
    return p;
  }
  const p = { ...data, id: newId() };
  db.parties.push(p);
  audit(db, input.kind === 'cliente' ? 'Cliente cadastrado' : 'Fornecedor cadastrado', name);
  return p;
}

/* ---------------- Impressoras ---------------- */
export type PrinterInput = Omit<Printer, 'id' | 'maintenance'>;

export function savePrinter(db: DB, input: PrinterInput, id?: ID): Printer {
  const name = requireText(input.name, 'o nome/apelido da impressora');
  const acq = Dn(input.acquisitionValue), res = Dn(input.residualValue);
  if (acq) assert(!acq.isNegative(), 'Valor de aquisição inválido.');
  if (res) assert(!res.isNegative(), 'Valor residual inválido.');
  if (acq && res) assert(res.lte(acq), 'O valor residual não pode ser maior que o valor de aquisição.');
  if (input.usefulLifeHours !== null) assert(input.usefulLifeHours > 0, 'A vida útil deve ser maior que zero.');
  if (input.kwhPerHour !== null) assert(D(input.kwhPerHour).gte(0), 'Consumo de energia inválido.');
  if (id) {
    const p = byId(db.printers, id, 'Impressora');
    Object.assign(p, { ...input, name });
    audit(db, 'Impressora alterada', name);
    return p;
  }
  const p: Printer = { ...input, name, id: newId(), maintenance: [] };
  db.printers.push(p);
  audit(db, 'Impressora cadastrada', name);
  return p;
}

/**
 * Depreciação por hora = (aquisição − residual) / vida útil em horas produtivas.
 * Retorna null quando falta algum parâmetro (nunca assume zero).
 */
export function depreciationPerHour(p: Pick<Printer, 'acquisitionValue' | 'residualValue' | 'usefulLifeHours'>): Decimal | null {
  if (p.acquisitionValue === null || p.usefulLifeHours === null || p.usefulLifeHours <= 0) return null;
  return D(p.acquisitionValue).minus(D(p.residualValue ?? '0')).div(p.usefulLifeHours);
}

export function addMaintenance(db: DB, printerId: ID, rec: Omit<Printer['maintenance'][number], 'id'>) {
  const p = byId(db.printers, printerId, 'Impressora');
  requireText(rec.description, 'a descrição');
  assert(D(rec.cost).gte(0), 'Custo inválido.');
  p.maintenance.push({ ...rec, id: newId() });
  audit(db, 'Manutenção registrada', `${p.name}: ${rec.description}`);
}

/* ---------------- Canais de venda ---------------- */
export function saveChannel(db: DB, input: Omit<SalesChannel, 'id'>, id?: ID): SalesChannel {
  const name = requireText(input.name, 'o nome do canal');
  const rates = [input.taxPct, input.commissionPct, input.paymentFeePct, input.otherPct].map((v) => D(v));
  assert(rates.every((r) => r.gte(0) && r.lt(100)), 'Percentuais devem estar entre 0 e 100.');
  assert(rates.reduce((a, b) => a.plus(b)).lt(100), 'A soma dos encargos percentuais deve ser menor que 100%.');
  assert(D(input.fixedFeePerOrder).gte(0), 'Taxa fixa inválida.');
  if (id) {
    const c = byId(db.channels, id, 'Canal');
    Object.assign(c, { ...input, name });
    audit(db, 'Canal alterado', name);
    return c;
  }
  const c = { ...input, name, id: newId() };
  db.channels.push(c);
  audit(db, 'Canal cadastrado', name);
  return c;
}

/* ---------------- Despesas indiretas ---------------- */
export function saveOverhead(db: DB, input: Omit<Overhead, 'id'>, id?: ID) {
  const name = requireText(input.name, 'o nome da despesa');
  assert(D(input.monthlyAmount).gte(0), 'Valor mensal inválido.');
  if (id) { Object.assign(byId(db.overheads, id, 'Despesa'), { ...input, name }); return; }
  db.overheads.push({ ...input, name, id: newId() });
  audit(db, 'Despesa indireta cadastrada', name);
}

/**
 * Taxa de rateio de despesas indiretas por hora de máquina:
 *   Σ despesas mensais marcadas para o custo / horas produtivas por mês.
 * null quando as horas produtivas não estão configuradas.
 */
export function overheadRate(db: DB): { rate: Decimal | null; monthly: Decimal; basis: string } {
  const monthly = db.overheads.filter((o) => o.includeInCost).reduce((a, o) => a.plus(D(o.monthlyAmount)), D(0));
  const h = db.settings.productiveHoursPerMonth;
  if (!h || h <= 0) return { rate: null, monthly, basis: 'Horas produtivas por mês não configuradas.' };
  return { rate: monthly.div(h), monthly, basis: `R$ ${monthly.toFixed(2)}/mês ÷ ${h} h produtivas/mês` };
}

/* ---------------- Contas financeiras ---------------- */
export function saveAccount(db: DB, input: Omit<Account, 'id'>, id?: ID) {
  const name = requireText(input.name, 'o nome da conta');
  if (id) {
    const a = byId(db.accounts, id, 'Conta');
    const hasMoves = db.titles.some((t) => t.settlements.some((s) => s.accountId === id));
    if (hasMoves && (a.openingBalance !== input.openingBalance || a.openingDate !== input.openingDate)) {
      audit(db, 'Saldo inicial alterado', `${name}: ${a.openingBalance} → ${input.openingBalance}`);
    }
    Object.assign(a, { ...input, name });
    return;
  }
  db.accounts.push({ ...input, name, id: newId() });
  audit(db, 'Conta financeira criada', name);
}

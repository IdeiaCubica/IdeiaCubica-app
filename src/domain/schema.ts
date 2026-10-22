/**
 * Estado inicial e migração de versões do banco local.
 *
 * O estado inicial contém apenas ESTRUTURA (categorias configuráveis), nunca
 * dados operacionais fictícios: parâmetros de custo começam como "não
 * informado" (null) e o sistema avisa o impacto de cada ausência.
 */
import type { Category, DB, FinCategory } from './types';
import { BusinessError, newId } from './core';

const cat = (name: string, isFilament = false): Category => ({ id: newId(), name, isFilament, active: true });
const fin = (name: string, direction: 'in' | 'out', nature: FinCategory['nature'], system = false): FinCategory =>
  ({ id: newId(), name, direction, nature, system });

/** Nomes das categorias financeiras usadas pelas integrações automáticas. */
export const SYS_FIN = {
  compraInsumos: 'Compra de insumos',
  vendaProdutos: 'Venda de produtos',
  taxasVenda: 'Taxas e comissões de venda',
  freteVenda: 'Frete de vendas',
} as const;

export function createEmptyDB(): DB {
  return {
    schemaVersion: 1,
    counters: {},
    settings: {
      companyName: 'Ideia Cúbica',
      energyTariff: null,
      laborHourCost: null,
      productiveHoursPerMonth: null,
      defaultMarkupPct: null,
      defaultRounding: 'nenhum',
    },
    brands: [],
    manufacturers: [],
    // Fontes de captação citadas pela empresa; a lista é editável em Parâmetros de Custos.
    leadSources: ['Instagram', 'Venda direta', 'Mercado Livre', 'Shopee'].map((name) => ({ id: newId(), name, active: true })),
    categories: [
      cat('Filamentos', true), cat('Sacos plásticos'), cat('Caixas e embalagens'), cat('Etiquetas'),
      cat('Fitas adesivas'), cat('Cola e adesivos'), cat('Pincéis'), cat('Lixas'),
      cat('Ferramentas e acessórios'), cat('Peças de reposição'), cat('Outros consumíveis'),
    ],
    parties: [],
    materials: [],
    lots: [],
    purchases: [],
    movements: [],
    printers: [],
    channels: [],
    overheads: [],
    projects: [],
    quotes: [],
    orders: [],
    finishedGoods: [],
    trends: [],
    accounts: [],
    finCategories: [
      fin(SYS_FIN.vendaProdutos, 'in', 'receita_venda', true),
      fin('Outras receitas', 'in', 'receita_outra'),
      fin('Aporte de capital', 'in', 'aporte'),
      fin(SYS_FIN.compraInsumos, 'out', 'estoque', true),
      fin(SYS_FIN.taxasVenda, 'out', 'custo_variavel', true),
      fin(SYS_FIN.freteVenda, 'out', 'custo_variavel', true),
      fin('Internet', 'out', 'despesa_fixa'),
      fin('Software e assinaturas', 'out', 'despesa_fixa'),
      fin('Aluguel / espaço', 'out', 'despesa_fixa'),
      fin('Contabilidade', 'out', 'despesa_fixa'),
      fin('Energia elétrica', 'out', 'despesa_fixa'),
      fin('Manutenção de equipamentos', 'out', 'despesa_fixa'),
      fin('Impressoras e equipamentos', 'out', 'investimento'),
      fin('Retirada dos sócios', 'out', 'retirada'),
      fin('Outras despesas', 'out', 'outros'),
    ],
    titles: [],
    sales: [],
    audit: [],
  };
}

/** Valida e migra um objeto lido do armazenamento ou de um backup. */
export function migrate(raw: unknown): DB {
  if (!raw || typeof raw !== 'object') throw new BusinessError('Arquivo de dados inválido.');
  const obj = raw as Partial<DB>;
  if (obj.schemaVersion !== 1) throw new BusinessError(`Versão de dados não suportada: ${String(obj.schemaVersion)}.`);
  const base = createEmptyDB();
  // Garante que coleções adicionadas em versões futuras existam.
  const db = { ...base, ...obj, settings: { ...base.settings, ...obj.settings } } as DB;
  for (const key of Object.keys(base) as (keyof DB)[]) {
    if (Array.isArray(base[key]) && !Array.isArray(db[key])) throw new BusinessError(`Coleção "${key}" corrompida no arquivo de dados.`);
  }
  migrateBrandTexts(db);
  return db;
}

/** v0.1 guardava marca/fabricante como texto livre no filamento: vira item das listas de Cadastros. */
function migrateBrandTexts(db: DB) {
  const ensure = (list: DB['brands'], name?: string) => {
    const n = (name ?? '').trim();
    if (!n) return undefined;
    const found = list.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (found) return found.id;
    const item = { id: newId(), name: n, active: true };
    list.push(item);
    return item.id;
  };
  for (const m of db.materials) {
    if (!m.brandId && m.filament?.brand) m.brandId = ensure(db.brands, m.filament.brand);
    if (!m.manufacturerId && m.filament?.manufacturer) m.manufacturerId = ensure(db.manufacturers, m.filament.manufacturer);
  }
}

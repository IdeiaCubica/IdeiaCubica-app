/**
 * Modelo de dados da Ideia Cúbica.
 *
 * Convenções:
 * - Valores monetários e custos unitários: DecStr (string decimal).
 * - Percentuais: DecStr em pontos percentuais ("12.5" = 12,5%).
 * - Quantidades físicas: number, sempre somadas via Decimal.
 * - Datas: ISO "AAAA-MM-DD"; instantes: ISO completo.
 * - Campos `null` significam "não informado" — nunca são tratados como zero
 *   silenciosamente nos cálculos (ver costing.ts).
 *
 * O mesmo modelo é espelhado em supabase/migrations/0001_schema.sql.
 */
import type { DecStr } from './money';

export type ID = string;
export type ISODate = string;
export type ISODateTime = string;

/* ------------------------------------------------------------------ */
/* Unidades                                                            */
/* ------------------------------------------------------------------ */
export type Unit = 'g' | 'kg' | 'un' | 'm' | 'cm' | 'ml' | 'l' | 'pacote' | 'rolo';

/* ------------------------------------------------------------------ */
/* Cadastros                                                           */
/* ------------------------------------------------------------------ */
export interface Category {
  id: ID;
  name: string;
  /** Categorias de filamento habilitam os campos técnicos e são usadas como material de impressão. */
  isFilament: boolean;
  active: boolean;
  /** Sigla usada no código dos insumos (ex.: FL → FL00001, FL00002…). */
  code?: string;
}

export type PartyKind = 'fornecedor' | 'cliente';
export interface Party {
  id: ID;
  kind: PartyKind;
  /** Nome completo (cliente) ou razão social/nome (fornecedor). */
  name: string;
  /** Endereço formatado em uma linha (gerado a partir de addressParts quando existir). */
  address?: string;
  addressParts?: AddressParts;
  phone?: string;
  /** CPF ou CNPJ (somente dígitos ou formatado). */
  document?: string;
  /** Fonte de captação do cliente (lista configurável em Parâmetros de Custos). */
  sourceId?: ID;
  /** Campo livre da v0.1, mantido para cadastros antigos. */
  contact?: string;
  notes?: string;
}

export interface AddressParts {
  cep?: string;
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
}

/** Item de lista simples e configurável (marcas, fabricantes, fontes de captação). */
export interface NamedItem {
  id: ID;
  name: string;
  active: boolean;
}

export interface FilamentSpec {
  /** Textos livres da v0.1 — migrados para brandId/manufacturerId do material. */
  manufacturer?: string;
  brand?: string;
  materialType: string; // PLA, PETG, ABS, TPU, ASA, outro
  color: string;
  colorHex?: string;
  netWeightG?: number | null;
  grossWeightG?: number | null;
  spoolWeightG?: number | null;
  diameterMm?: number | null;
}

export interface Material {
  id: ID;
  code: string;
  name: string;
  categoryId: ID;
  /** Unidade em que o estoque é controlado (filamento: g). */
  unit: Unit;
  active: boolean;
  brandId?: ID;
  manufacturerId?: ID;
  filament?: FilamentSpec;
  /**
   * Custo de referência por unidade do material (R$/g para filamento).
   * Usado no orçamento apenas quando ainda não existe compra/lote do material.
   */
  referenceCost?: DecStr | null;
  /** De onde vem o preço nos orçamentos: 'compra' (padrão: última compra) ou 'cadastro' (sempre o preço de referência). */
  costSource?: 'compra' | 'cadastro';
  minStock?: number | null;
  safetyStock?: number | null;
  leadTimeDays?: number | null;
  location?: string;
  notes?: string;
  createdAt: ISODateTime;
}

/** Lote = cada entrada física de um material com custo próprio (ex.: um carretel ou pacote). */
export interface Lot {
  id: ID;
  code: string;
  materialId: ID;
  origin: 'compra' | 'estoque_inicial';
  purchaseId?: ID;
  supplierId?: ID;
  date: ISODate;
  batchNumber?: string;
  /** Quantidade recebida, na unidade do material. */
  initialQty: number;
  /** Custo por unidade de estoque, incluindo custos de aquisição atribuíveis. Precisão total. */
  unitCost: DecStr;
  /** Composição do custo do lote; desconto da compra rateado reduz o custo. */
  cost: { goods: DecStr; freight: DecStr; other: DecStr; discount?: DecStr };
  notes?: string;
}

/* ------------------------------------------------------------------ */
/* Compras                                                             */
/* ------------------------------------------------------------------ */
export interface PurchaseItem {
  materialId: ID;
  qty: number;
  /** Valor total da mercadoria deste item (sem frete). */
  price: DecStr;
  batchNumber?: string;
  lotId: ID;
}

export interface PaymentTerms {
  mode: 'avista' | 'aprazo';
  accountId?: ID; // obrigatório à vista
  method?: string;
  installments: number;
  firstDue: ISODate;
  intervalDays: number;
}

/**
 * Equipamento comprado (impressora, ferramenta durável): é investimento, não
 * entra no estoque de insumos nem vira custo direto; a impressora entra no
 * custo das peças pela depreciação por hora.
 */
export interface PurchaseEquipment {
  id: ID;
  description: string;
  qty: number;
  /** Valor total da mercadoria (sem frete). */
  price: DecStr;
  /** Frete e outros custos atribuídos pelo rateio. */
  freight: DecStr;
  other: DecStr;
  /** Desconto da compra atribuído pelo rateio. */
  discount?: DecStr;
  /** Custo total de aquisição = mercadoria + frete + outros − desconto. */
  total: DecStr;
  printerId?: ID;
  /** A impressora foi cadastrada por esta compra. */
  printerCreated?: boolean;
  /** Valor de aquisição anterior da impressora existente (para estorno). */
  prevAcquisition?: DecStr | null;
}

export interface Purchase {
  id: ID;
  number: string;
  date: ISODate;
  supplierId?: ID;
  items: PurchaseItem[];
  equipment?: PurchaseEquipment[];
  freight: DecStr;
  otherCosts: DecStr;
  /** Desconto obtido na compra (o preço do insumo no cadastro não muda; o custo do lote sim). */
  discount?: DecStr;
  total: DecStr;
  payment: PaymentTerms;
  status: 'ativa' | 'cancelada';
  cancelReason?: string;
  notes?: string;
  createdAt: ISODateTime;
  editedAt?: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* Estoque                                                             */
/* ------------------------------------------------------------------ */
export type MovementType =
  | 'entrada'      // + físico (compra / estoque inicial)
  | 'consumo'      // − físico (produção)
  | 'perda'        // − físico (falha, desperdício, avaria)
  | 'ajuste_pos'   // + físico (inventário)
  | 'ajuste_neg'   // − físico (inventário)
  | 'devolucao'    // − físico (devolução ao fornecedor / estorno de compra)
  | 'reserva'      // + reservado
  | 'liberacao';   // − reservado

export interface StockMovement {
  id: ID;
  date: ISODate;
  lotId: ID;
  materialId: ID;
  type: MovementType;
  /** Sempre positivo; o sinal vem do tipo. */
  qty: number;
  ref: { kind: 'compra' | 'estoque_inicial' | 'op' | 'inventario' | 'perda' | 'manual' | 'venda'; id?: ID };
  /** Chave de idempotência: impede que a mesma operação movimente o estoque duas vezes. */
  key: string;
  reason?: string;
  createdAt: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* Impressoras e parâmetros de custo                                   */
/* ------------------------------------------------------------------ */
export interface MaintenanceRecord {
  id: ID;
  date: ISODate;
  kind: 'preventiva' | 'corretiva' | 'falha';
  description: string;
  cost: DecStr;
  downtimeHours?: number | null;
}

export interface Printer {
  id: ID;
  name: string;
  manufacturer: string;
  model: string;
  acquisitionValue: DecStr | null;
  residualValue: DecStr | null;
  usefulLifeHours: number | null;
  /** Horas já utilizadas antes do cadastro no sistema. */
  initialHours: number;
  /** 'medido' = kWh/h medido com tomada medidora; 'estimado' = derivado de potência média. */
  energyMode: 'medido' | 'estimado';
  kwhPerHour: DecStr | null;
  /** Custo de manutenção/desgaste por hora de impressão, calibrável. */
  maintenancePerHour: DecStr | null;
  availableHoursPerMonth: number | null;
  active: boolean;
  notes?: string;
  maintenance: MaintenanceRecord[];
}

export interface SalesChannel {
  id: ID;
  name: string;
  /** Todos em pontos percentuais sobre a receita. */
  taxPct: DecStr;
  commissionPct: DecStr;
  paymentFeePct: DecStr;
  otherPct: DecStr;
  fixedFeePerOrder: DecStr;
  active: boolean;
  notes?: string;
}

/** Despesa indireta mensal prevista, usada para rateio no orçamento. */
export interface Overhead {
  id: ID;
  name: string;
  monthlyAmount: DecStr;
  includeInCost: boolean;
  notes?: string;
}

export type RoundingRule = 'nenhum' | 'final90' | 'final99' | 'inteiro' | 'meio';

export interface Settings {
  companyName: string;
  energyTariff: DecStr | null;
  laborHourCost: DecStr | null;
  /** Horas produtivas de máquina por mês (todas as impressoras) — base do rateio de despesas indiretas. */
  productiveHoursPerMonth: number | null;
  /** Markup padrão: lucro desejado sobre o CUSTO (os encargos do canal são somados por fora). */
  defaultMarkupPct?: DecStr | null;
  /** Campo da v0.1 (margem sobre a venda); não é mais usado nos cálculos. */
  defaultTargetMarginPct?: DecStr | null;
  defaultRounding: RoundingRule;
  /* Padrões aplicados a cada novo orçamento (sempre visíveis e alteráveis no orçamento). */
  defaultPrinterId?: ID | null;
  defaultChannelId?: ID | null;
  defaultFailureRatePct?: DecStr | null;
  defaultLaborOrderMin?: number | null;
  defaultLaborUnitMin?: number | null;
  /** Endereço de origem dos envios (CEP usado no cálculo de frete). */
  companyAddress?: AddressParts;
  /** Embalagem padrão para cotação de frete. */
  shippingBox?: ShippingBox;
  /** Textos e contatos do orçamento enviado ao cliente. */
  clientQuote?: ClientQuoteSettings;
  /** Quantidade de dígitos por contador de numeração (padrão 4). Ex.: { quote: 8 } → ORC-00000203. */
  codeDigits?: Record<string, number>;
  /** Migrações de dados já aplicadas (executadas uma única vez). */
  appliedMigrations?: string[];
}

export interface ClientQuoteSettings {
  validityDays: number | null;
  /** Prazo de produção em dias úteis após a aprovação. */
  productionDays: number | null;
  paymentTerms: string;
  notes: string;
  whatsapp: string;
  instagram: string;
  email: string;
  site: string;
}

/* ------------------------------------------------------------------ */
/* Projetos                                                            */
/* ------------------------------------------------------------------ */
export interface ProjectFileVersion {
  id: ID;
  version: string;
  fileName: string;
  date: ISODate;
  notes?: string;
}

export interface Project {
  id: ID;
  code: string;
  name: string;
  sourceUrl?: string;
  creator?: string;
  license?: string;
  commercialUse: 'autorizado' | 'nao_autorizado' | 'verificar' | 'proprio';
  recommendedMaterial?: string;
  colors?: string;
  printerId?: ID;
  printProfile?: string;
  files: ProjectFileVersion[];
  notes?: string;
  createdAt: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* Orçamentos                                                          */
/* ------------------------------------------------------------------ */
export type DataOrigin = 'usuario' | 'geometria' | 'fatiador' | 'estimativa' | 'pendente';

export interface QuoteSource {
  kind: 'manual' | 'stl' | '3mf' | 'makerworld';
  fileName?: string;
  url?: string;
  /** Informações extraídas com sua origem, para rastreabilidade. */
  facts: { label: string; value: string; origin: DataOrigin }[];
}

export interface QuoteMaterialLine {
  materialId: ID;
  /** Lote específico (opcional). Sem lote, o custo segue a política do material (última compra → referência). */
  lotId?: ID;
  /** Consumo por unidade, na unidade do material (g para filamento). */
  qtyPerUnit: number;
}

export interface QuoteExtraLine {
  id: ID;
  kind: 'acabamento' | 'embalagem' | 'outro';
  description: string;
  /** Se vinculado a um lote, o custo vem do lote; senão, `manualUnitCost`. */
  lotId?: ID;
  /**
   * Complemento do estoque (luminária, ímã, parafuso…): insumo cadastrado. O custo vem da política
   * do insumo (última compra → preço do cadastro) e o item é reservado/baixado na produção.
   */
  materialId?: ID;
  manualUnitCost?: DecStr | null;
  qtyPerUnit: number;
}

/** Tempo humano em minutos: preparação/fatiamento/atendimento (por pedido) e retirada/acabamento/embalagem (por peça). */
export interface LaborMinutes {
  perOrder: number;
  perUnit: number;
}

export interface QuoteInput {
  quantity: number;
  source: QuoteSource;
  materials: QuoteMaterialLine[];
  /** 'total' = consumo do fatiador já inclui suportes, purga, brim; 'peca' = só a peça (aplica perda %). */
  consumptionBasis: 'total' | 'peca';
  wastePct: DecStr | null;
  printHoursPerUnit: number | null;
  plates: number | null;
  printerId?: ID;
  labor: LaborMinutes;
  failureRatePct: DecStr | null;
  failureSource: 'historico' | 'manual';
  extras: QuoteExtraLine[];
  freightSubsidyPerOrder: DecStr | null;
  /** Dimensões aproximadas de 1 peça (opcional; aparecem no orçamento do cliente). */
  dimensionsCm?: PieceDimensions | null;
  /** Parte do custo do kit de entrega do pedido atribuída a esta peça (custo interno, oculto ao cliente). */
  deliveryKitShare?: DecStr | null;
  /** Envio deste orçamento: caixa da peça e CEPs. Novo orçamento parte do padrão de Parâmetros → Envios. */
  shipping?: QuoteShipping;
  development: { mode: 'nenhum' | 'diluir' | 'cobrar'; hours: number; licenseCost: DecStr | null; expectedUnits: number | null };
  channelId?: ID;
  /** Markup desejado sobre o custo total (%). */
  markupPct: DecStr | null;
  /** Campo da v0.1 (margem); ignorado nos cálculos atuais. */
  targetMarginPct?: DecStr | null;
  discountPct: DecStr | null;
  marketPriceUnit: DecStr | null;
  premium: { amountPerUnit: DecStr | null; justification: string };
  manualPriceUnit: DecStr | null;
  rounding: RoundingRule;
  /** Valores de rubricas ajustados manualmente pelo usuário (total do pedido), por chave do componente. */
  overrides?: Record<string, DecStr>;
}

/** Altura × largura × profundidade aproximadas de 1 peça, em cm (cada medida é opcional). */
export interface PieceDimensions { height: number | null; width: number | null; depth: number | null }

/** Parâmetros resolvidos no momento do cálculo — gravados em cada versão (snapshot). */
export interface CostParams {
  capturedAt: ISODateTime;
  lots: Record<ID, { label: string; unitCost: DecStr; unit: Unit; materialId: ID }>;
  /** Custo por material conforme a política de custeio (última compra → referência do cadastro). */
  materials?: Record<ID, { label: string; unitCost: DecStr | null; unit: Unit; source: string }>;
  printer: null | {
    id: ID;
    name: string;
    depreciationPerHour: DecStr | null;
    kwhPerHour: DecStr | null;
    energyMode: 'medido' | 'estimado';
    maintenancePerHour: DecStr | null;
  };
  energyTariff: DecStr | null;
  laborHourCost: DecStr | null;
  overheadPerMachineHour: DecStr | null;
  overheadBasis: string;
  channel: null | Omit<SalesChannel, 'active' | 'notes'>;
}

/** Resumo para auditoria (o detalhamento é recalculado deterministicamente de input + params). */
export interface QuoteSummary { totalCost: DecStr | null; unitCost: DecStr | null; unitPrice: DecStr | null; marginPct: DecStr | null; complete: boolean; hours?: DecStr | null; orderPrice?: DecStr | null; markupPct?: DecStr | null }

/** Uma peça do orçamento, dentro de uma versão (imutável). */
export interface QuoteVersionItem {
  /** Identificador estável da peça entre as versões do orçamento. */
  itemId: ID;
  name: string;
  image?: string | null;
  input: QuoteInput;
  params: CostParams;
  summary: QuoteSummary;
  /** Peça orçada a partir do estoque de peças prontas (não precisa produzir). */
  finishedGoodId?: ID;
}

export interface QuoteVersion {
  version: number;
  createdAt: ISODateTime;
  items: QuoteVersionItem[];
  /** Envio do orçamento inteiro (caixa, CEPs, frete cobrado do cliente). */
  shipping?: QuoteShipping;
  /** Kit de entrega escolhido (custo distribuído entre as peças; nunca aparece no orçamento do cliente). */
  deliveryKit?: QuoteDeliveryKit;
  note?: string;
}

export interface QuoteDeliveryKit { kitId: ID; name: string; qty: number; unitCost: DecStr; total: DecStr }

/** Modelo de kit de entrega: acessórios que acompanham o pedido (saquinho, cartão, adesivo da marca…). */
export interface DeliveryKit {
  id: ID;
  name: string;
  active: boolean;
  /** Itens do estoque (baixados na venda/entrega). Quantidade na unidade do insumo, por kit. */
  items: { materialId: ID; qty: number }[];
  /** Custos sem estoque (ex.: impressão do cartão), por kit. */
  extras: { description: string; cost: DecStr }[];
  notes?: string;
  createdAt: ISODateTime;
}

/** Situação de cada peça (não versionada). "producao" é derivada do pedido ativo. */
export type QuoteItemStatus = 'aberto' | 'aprovado' | 'recusado';

export type QuoteStatus = 'rascunho' | 'enviado' | 'aprovado' | 'recusado' | 'convertido';
export interface ShippingBox { lengthCm: number | null; widthCm: number | null; heightCm: number | null; packagingWeightG: number | null }

export interface QuoteShipping extends ShippingBox {
  /** CEP de saída (8 dígitos). */
  originCep: string | null;
  /** CEP de destino; vazio = CEP do cadastro do cliente. */
  destCep: string | null;
  /** Frete cotado que será cobrado do cliente (aparece no orçamento enviado). */
  clientFreight?: { service: string; price: DecStr; deliveryMin: number | null; deliveryMax: number | null } | null;
}

export interface Quote {
  id: ID;
  number: string;
  name: string;
  projectId?: ID;
  customerId?: ID;
  status: QuoteStatus;
  createdAt: ISODateTime;
  versions: QuoteVersion[];
  /** Situação de cada peça pelo itemId (ausente = aberto). */
  itemStatus?: Record<ID, QuoteItemStatus>;
  /** Orçamento já enviado ao cliente (documento gerado). */
  sentAt?: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* Produção                                                            */
/* ------------------------------------------------------------------ */
export type OrderStatus =
  | 'planejada' | 'aguardando_material' | 'pronta' | 'em_producao'
  | 'aguardando_acabamento' | 'em_inspecao' | 'concluida' | 'cancelada';

export interface FailureRecord {
  id: ID;
  description: string;
  lotId?: ID;
  qtyLost: number;
  hoursLost: number;
}

export interface ProductionOrder {
  id: ID;
  number: string;
  projectId?: ID;
  quoteId?: ID;
  quoteVersion?: number;
  /** Peça do orçamento que gerou este pedido. */
  quoteItemId?: ID;
  description: string;
  printerId?: ID;
  qtyPlanned: number;
  /** Produção para estoque: custo e preço sugerido calculados na criação (sem orçamento prévio). */
  estimate?: { input: QuoteInput; params: CostParams; summary: QuoteSummary };
  /** Sem lotId, a reserva escolhe lotes do material por ordem de entrada (primeiro que entra, primeiro que sai). */
  plannedMaterials: { materialId: ID; lotId?: ID; qty: number }[];
  plannedHours: number | null;
  status: OrderStatus;
  responsible?: string;
  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  actual?: {
    materials: { lotId: ID; qty: number }[];
    hours: number;
    qtyApproved: number;
    qtyRejected: number;
    laborMinutes: number | null;
    failures: FailureRecord[];
    notes?: string;
  };
  cancelReason?: string;
  notes?: string;
  /** pedido = encomenda de um cliente; estoque = peças para pronta-entrega. Ausente (dados antigos) = pedido. */
  purpose?: 'pedido' | 'estoque';
  customerId?: ID;
  /** Data prometida ao cliente. */
  dueDate?: ISODate;
  /** Posição na fila de produção (menor = primeiro). */
  sequence?: number;
  /** Lote de peças prontas gerado ao concluir uma OP de estoque. */
  finishedGoodId?: ID;
  /** Foto da peça (produção para estoque); passa para as peças prontas ao concluir. */
  image?: string | null;
  /** Dimensões de 1 peça (produção para estoque); passam para as peças prontas. */
  dimensionsCm?: PieceDimensions | null;
}

/**
 * Peças prontas em estoque para venda (pronta-entrega). Saldo = produzidas −
 * vendidas (vendas ativas com finishedGoodId) − baixas manuais.
 */
export interface FinishedGood {
  id: ID;
  code: string;
  description: string;
  orderId?: ID;
  projectId?: ID;
  quoteId?: ID;
  qtyProduced: number;
  /** Custo unitário de fabricação (snapshot na conclusão). */
  unitCost: DecStr | null;
  costStatus: 'realizado' | 'estimado' | 'pendente';
  /** Preço sugerido (valor ao cliente do orçamento), se houver. */
  suggestedPrice?: DecStr | null;
  producedAt: ISODate;
  location?: string;
  image?: string | null;
  adjustments: { id: ID; date: ISODate; qty: number; reason: string }[];
  /** Peças separadas para pedidos aprovados (orçamento feito a partir do estoque), ainda não vendidas. */
  allocations?: { id: ID; quoteId: ID; itemId: ID; qty: number; customerId?: ID; dueDate?: ISODate; createdAt: ISODateTime }[];
  /** Consumo real da produção (total do lote produzido), para consulta no estoque. */
  production?: { materials: { label: string; qty: number; unit: string }[]; hours: number; qtyMade: number };
  /** Dimensões aproximadas de 1 peça; vão para o orçamento feito a partir desta peça. */
  dimensionsCm?: PieceDimensions | null;
  notes?: string;
  createdAt: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* Financeiro                                                          */
/* ------------------------------------------------------------------ */
export interface Account {
  id: ID;
  name: string;
  kind: 'caixa' | 'banco' | 'carteira_digital';
  openingBalance: DecStr;
  openingDate: ISODate;
  active: boolean;
}

export type FinNature =
  | 'receita_venda'   // entra no resultado como receita
  | 'receita_outra'
  | 'custo_variavel'  // taxas, frete de venda — custo variável no resultado
  | 'despesa_fixa'    // estrutura — despesa no resultado por competência
  | 'estoque'         // compra de insumos: ativo; vira custo quando consumido/vendido
  | 'investimento'    // ativos (impressoras, ferramentas duráveis): não é custo de uma peça
  | 'aporte'          // capital dos sócios
  | 'retirada'        // pró-labore / distribuição
  | 'outros';

export interface FinCategory {
  id: ID;
  name: string;
  direction: 'in' | 'out';
  nature: FinNature;
  system?: boolean; // usada por integrações; não pode ser removida
}

export interface Settlement {
  id: ID;
  date: ISODate;
  amount: DecStr;
  accountId: ID;
  method?: string;
  reversed?: { at: ISODateTime; reason: string };
}

export interface FinTitle {
  id: ID;
  direction: 'in' | 'out';
  description: string;
  categoryId: ID;
  amount: DecStr;
  competenceDate: ISODate;
  dueDate: ISODate;
  partyId?: ID;
  projectId?: ID;
  origin: { kind: 'compra' | 'venda' | 'manual'; id?: ID };
  installment?: { n: number; of: number };
  method?: string;
  status: 'aberto' | 'liquidado' | 'cancelado';
  settlements: Settlement[];
  cancelReason?: string;
  notes?: string;
  createdAt: ISODateTime;
}

export interface Sale {
  id: ID;
  number: string;
  date: ISODate;
  customerId?: ID;
  projectId?: ID;
  quoteId?: ID;
  orderId?: ID;
  /** Venda de peças prontas do estoque (baixa o saldo do lote de peças). */
  finishedGoodId?: ID;
  quoteItemId?: ID;
  description: string;
  qty: number;
  unitPrice: DecStr;
  discount: DecStr;
  freightCharged: DecStr;
  freightCost: DecStr;
  channelId?: ID;
  /** Encargos calculados no momento da venda (snapshot das alíquotas do canal). */
  fees: { ratesPct: DecStr; fixed: DecStr; total: DecStr };
  feesWithheld: boolean;
  /** Kit de entrega enviado com a venda: materiais baixados do estoque e custo real (entra no resultado). */
  deliveryKit?: { kitId: ID; name: string; qty: number; cost: DecStr };
  /** Custo unitário de fabricação usado para margem: realizado (OP) ou estimado (orçamento). */
  unitCost: DecStr | null;
  costStatus: 'realizado' | 'estimado' | 'pendente';
  payment: PaymentTerms;
  status: 'ativa' | 'cancelada';
  cancelReason?: string;
  notes?: string;
  createdAt: ISODateTime;
  editedAt?: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* Auditoria e raiz                                                    */
/* ------------------------------------------------------------------ */
export interface AuditEntry {
  at: ISODateTime;
  action: string;
  detail?: string;
}

export interface DB {
  schemaVersion: 1;
  counters: Record<string, number>;
  settings: Settings;
  categories: Category[];
  parties: Party[];
  brands: NamedItem[];
  manufacturers: NamedItem[];
  leadSources: NamedItem[];
  materials: Material[];
  lots: Lot[];
  purchases: Purchase[];
  movements: StockMovement[];
  printers: Printer[];
  channels: SalesChannel[];
  overheads: Overhead[];
  projects: Project[];
  quotes: Quote[];
  orders: ProductionOrder[];
  finishedGoods: FinishedGood[];
  deliveryKits: DeliveryKit[];
  accounts: Account[];
  finCategories: FinCategory[];
  titles: FinTitle[];
  sales: Sale[];
  audit: AuditEntry[];
}

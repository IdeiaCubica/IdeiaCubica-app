/**
 * Kits de entrega (acessórios complementares): saquinho, cartão, adesivo da marca…
 *
 * - O modelo do kit lista itens do estoque (por kit) e custos sem estoque.
 * - No orçamento, o custo do kit entra no custo das peças (rubrica "Kit de entrega"),
 *   e portanto no preço — mas nunca aparece no documento enviado ao cliente.
 * - Na venda, os itens do kit saem do estoque (lotes mais antigos primeiro) e o custo
 *   real dos lotes entra no resultado da venda.
 */
import type { DB, DeliveryKit, ID, ISODate, QuoteDeliveryKit } from './types';
import { D, Decimal, ZERO, cents, sum } from './money';
import { BusinessError, assert, audit, byId, newId, nowISO, requireText } from './core';
import { addMovement, lotBalance } from './inventory';
import { materialCostPolicy } from './quotes';
import { materialLabel } from './catalog';
import { allocate } from './purchases';

export interface DeliveryKitInput {
  name: string;
  active: boolean;
  items: { materialId: ID; qty: number }[];
  extras: { description: string; cost: string }[];
  notes?: string;
}

export function saveDeliveryKit(db: DB, input: DeliveryKitInput, id?: ID): DeliveryKit {
  const name = requireText(input.name, 'o nome do kit');
  assert(!db.deliveryKits.some((k) => k.id !== id && k.name.trim().toLowerCase() === name.toLowerCase()), `Já existe um kit chamado "${name}".`);
  const items = input.items.filter((it) => it.materialId).map((it, i) => {
    const m = byId(db.materials, it.materialId, `Insumo do item ${i + 1}`);
    assert(Number.isFinite(it.qty) && it.qty > 0, `Informe a quantidade de "${m.name}" por kit.`);
    return { materialId: m.id, qty: it.qty };
  });
  const extras = input.extras.filter((e) => e.description.trim() || e.cost).map((e, i) => {
    const cost = cents(D(e.cost || '0'));
    assert(!cost.isNegative(), `Custo do item extra ${i + 1} inválido.`);
    return { description: requireText(e.description, `a descrição do custo extra ${i + 1}`), cost: cost.toString() };
  });
  assert(items.length + extras.length > 0, 'Adicione ao menos um item ao kit.');
  if (id) {
    const k = byId(db.deliveryKits, id, 'Kit de entrega');
    Object.assign(k, { name, active: input.active, items, extras, notes: input.notes });
    audit(db, 'Kit de entrega alterado', name);
    return k;
  }
  const k: DeliveryKit = { id: newId(), name, active: input.active, items, extras, notes: input.notes, createdAt: nowISO() };
  db.deliveryKits.push(k);
  audit(db, 'Kit de entrega cadastrado', name);
  return k;
}

/** Kit usado em orçamento ou venda não é excluído (fica inativo); senão é removido. */
export function deleteDeliveryKit(db: DB, id: ID) {
  const k = byId(db.deliveryKits, id, 'Kit de entrega');
  const used = db.quotes.some((q) => q.versions.some((v) => v.deliveryKit?.kitId === id)) || db.sales.some((s) => s.deliveryKit?.kitId === id);
  if (used) { k.active = false; audit(db, 'Kit de entrega inativado', k.name); return 'inativado' as const; }
  db.deliveryKits = db.deliveryKits.filter((x) => x.id !== id);
  audit(db, 'Kit de entrega excluído', k.name);
  return 'excluido' as const;
}

/** Custo estimado de UM kit (preço atual dos insumos: última compra → referência). */
export function kitUnitCost(db: DB, kit: DeliveryKit) {
  const missing: string[] = [];
  const lines = kit.items.map((it) => {
    const m = db.materials.find((x) => x.id === it.materialId);
    const pol = materialCostPolicy(db, it.materialId);
    if (!pol.unitCost) missing.push(m ? materialLabel(m) : 'insumo removido');
    return { label: m ? materialLabel(m) : 'Insumo removido', qty: it.qty, unit: m?.unit ?? '', cost: pol.unitCost ? pol.unitCost.times(it.qty) : null };
  });
  const total = sum(lines.map((l) => l.cost ?? ZERO)).plus(sum(kit.extras.map((e) => D(e.cost))));
  return { lines, total: cents(total), missing };
}

/** Kit escolhido no orçamento: snapshot do custo (quantidade de kits × custo atual). */
export function quoteKit(db: DB, kitId: ID, qty: number): QuoteDeliveryKit {
  const kit = byId(db.deliveryKits, kitId, 'Kit de entrega');
  assert(Number.isInteger(qty) && qty > 0, 'Quantidade de kits deve ser um inteiro maior que zero.');
  const unit = kitUnitCost(db, kit);
  if (unit.missing.length) throw new BusinessError(`Sem preço para: ${unit.missing.join(', ')}. Registre a compra ou o preço de referência desses insumos.`);
  return { kitId: kit.id, name: kit.name, qty, unitCost: unit.total.toString(), total: cents(unit.total.times(qty)).toString() };
}

/** Distribui o custo do kit entre as peças, pela quantidade de peças de cada item (centavos exatos). */
export function splitKitCost(total: Decimal.Value, quantities: number[]): Decimal[] {
  return allocate(cents(D(total)), quantities.map((q) => D(Math.max(q, 0))));
}

/** Baixa os itens do kit do estoque (lotes mais antigos primeiro). Retorna o custo real. */
export function consumeKit(db: DB, kitId: ID, qty: number, ref: { kind: 'venda'; id: ID }, date?: ISODate): Decimal {
  const kit = byId(db.deliveryKits, kitId, 'Kit de entrega');
  assert(Number.isInteger(qty) && qty > 0, 'Quantidade de kits inválida.');
  // Mesmo insumo em duas linhas vira uma baixa só (chave idempotente por lote).
  const byMat = new Map<ID, Decimal>();
  for (const it of kit.items) byMat.set(it.materialId, (byMat.get(it.materialId) ?? ZERO).plus(D(it.qty).times(qty)));
  const needs = [...byMat.entries()].map(([materialId, need]) => ({ materialId, need }));
  // Verifica tudo antes de movimentar (tudo ou nada).
  for (const it of needs) {
    const need = it.need;
    const avail = db.lots.filter((l) => l.materialId === it.materialId).reduce((a, l) => a.plus(lotBalance(db, l.id).available), ZERO);
    if (avail.lt(need)) {
      const m = db.materials.find((x) => x.id === it.materialId);
      throw new BusinessError(`Estoque insuficiente para o kit "${kit.name}": ${m ? materialLabel(m) : 'insumo'} — precisa ${need.toString()} ${m?.unit ?? ''}, disponível ${avail.toString()}. Registre a compra ou desmarque o kit.`);
    }
  }
  let cost = sum(kit.extras.map((e) => D(e.cost))).times(qty);
  for (const it of needs) {
    let remaining = it.need;
    const lots = db.lots.filter((l) => l.materialId === it.materialId).sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
    for (const lot of lots) {
      if (remaining.lte(0)) break;
      const free = lotBalance(db, lot.id).available;
      if (free.lte(0)) continue;
      const take = Decimal.min(free, remaining);
      addMovement(db, { lotId: lot.id, type: 'consumo', qty: take.toNumber(), date, ref, key: `${ref.kind}:${ref.id}:kit:${lot.id}`, reason: `Kit de entrega: ${kit.name}` });
      cost = cost.plus(take.times(D(lot.unitCost)));
      remaining = remaining.minus(take);
    }
  }
  return cents(cost);
}

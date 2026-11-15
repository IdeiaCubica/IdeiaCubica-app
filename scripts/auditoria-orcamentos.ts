/**
 * Auditoria somente leitura: peças de orçamentos APROVADOS/CONVERTIDOS que não estão cobradas
 * (nem conta a receber de pedido, nem venda). Uso: npx vite-node scripts/auditoria-orcamentos.ts <backup.json>
 */
import { readFileSync } from 'node:fs';
import { migrate } from '../src/domain/schema';
import { itemState, latestVersion, quoteItems } from '../src/domain/quotes';
import { D, ZERO, sum } from '../src/domain/money';
import type { DB } from '../src/domain/types';

const db: DB = migrate(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const brl = (d: { toFixed: (n: number) => string } | null) => (d ? `R$ ${d.toFixed(2).replace('.', ',')}` : '—');
const party = (id?: string) => db.parties.find((p) => p.id === id)?.name ?? '(sem cliente)';
const filter = process.argv[3]?.toLowerCase();
let missingTotal = ZERO;
for (const q of db.quotes) {
  if (filter && !party(q.customerId).toLowerCase().includes(filter) && !q.number.toLowerCase().includes(filter)) continue;
  const items = quoteItems(q);
  const rows = items.map((it) => {
    const st = itemState(db, q, it.itemId);
    const order = db.orders.find((o) => o.quoteId === q.id && o.quoteItemId === it.itemId && o.status !== 'cancelada');
    const orderTitle = order ? db.titles.find((t) => t.origin.kind === 'pedido' && t.origin.id === order.id && t.status !== 'cancelado') : undefined;
    const sale = db.sales.find((s) => s.status === 'ativa' && s.quoteId === q.id && (s.quoteItemId === it.itemId || (order && s.orderId === order.id)));
    const fg = it.finishedGoodId ? db.finishedGoods.find((g) => g.id === it.finishedGoodId) : undefined;
    const alloc = fg?.allocations?.find((a) => a.quoteId === q.id && a.itemId === it.itemId);
    const charged = !!orderTitle || !!sale;
    return { it, st, order, orderTitle, sale, fg, alloc, charged, price: it.summary.orderPrice ? D(it.summary.orderPrice) : null };
  });
  const anyCharged = rows.some((r) => r.charged);
  const missing = rows.filter((r) => !r.charged && r.st !== 'recusado' && (anyCharged || r.st === 'aprovado' || r.st === 'separado' || r.st === 'producao' || r.st === 'produzido'));
  if (!missing.length && !filter) continue;
  const total = sum(rows.filter((r) => r.st !== 'recusado').map((r) => r.price ?? ZERO));
  console.log(`\n## ${q.number} · ${party(q.customerId)} · status ${q.status} · total (sem recusadas) ${brl(total)}`);
  for (const r of rows) {
    console.log(`- ${r.it.name} · ${r.it.input.quantity} un · ${brl(r.price)} · situação: ${r.st}` +
      `${r.fg ? ` · PEÇA DO ESTOQUE ${r.fg.code}${r.alloc ? ' (separada)' : ''}` : ''}` +
      `${r.order ? ` · pedido ${r.order.number}` : ''}${r.orderTitle ? ` (conta a receber ${brl(D(r.orderTitle.amount))})` : ''}${r.sale ? ` · venda ${r.sale.number}` : ''}` +
      `${!r.charged && r.st !== 'recusado' ? '  ⚠ NÃO COBRADA' : ''}`);
  }
  const ship = latestVersion(q).shipping?.clientFreight;
  if (ship) console.log(`- frete do cliente: ${brl(D(ship.price))}`);
  const m = sum(missing.map((r) => r.price ?? ZERO));
  missingTotal = missingTotal.plus(m);
  if (missing.length) console.log(`→ Fora de Vendas/financeiro: ${brl(m)}`);
}
console.log(`\nTOTAL de peças aprovadas sem cobrança: ${brl(missingTotal)}`);

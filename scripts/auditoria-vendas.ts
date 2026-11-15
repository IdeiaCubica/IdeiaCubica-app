/**
 * Auditoria somente leitura: orçamento × pedido × venda × recebimentos.
 * Uso:  npx vite-node scripts/auditoria-vendas.ts <backup.json> [saida.md]
 * Não altera nada: lê o backup exportado (Configurações → Backup) e gera um relatório.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { migrate } from '../src/domain/schema';
import { quoteItemAt, quoteItems, latestVersion, itemState } from '../src/domain/quotes';
import { titlePaid, titleOpen } from '../src/domain/finance';
import { D, ZERO, cents, sum, type Decimal } from '../src/domain/money';
import type { DB, FinTitle, Sale } from '../src/domain/types';

const file = process.argv[2];
const out = process.argv[3];
if (!file) throw new Error('Informe o arquivo de backup.');
const db: DB = migrate(JSON.parse(readFileSync(file, 'utf8')));
const brl = (d: Decimal | null | undefined) => (d == null ? '—' : `R$ ${d.toFixed(2).replace('.', ',')}`);
const party = (id?: string) => db.parties.find((p) => p.id === id)?.name ?? '(sem cliente)';
const lines: string[] = [];
const say = (s = '') => lines.push(s);
const saleTitles = (s: Sale) => db.titles.filter((t) => t.origin.kind === 'venda' && t.origin.id === s.id && t.direction === 'in' && t.status !== 'cancelado');
const saleGross = (s: Sale) => cents(D(s.unitPrice).times(s.qty).minus(D(s.discount)));

/* 1) Orçamento × o que foi para pedido/venda */
say('# Auditoria de vendas e recebimentos');
say(`Backup: ${file}`);
say();
say('## 1. Orçamento × venda/pedido (por peça do orçamento)');
say('| Orçamento | Cliente | Peça | Situação | Valor no orçamento | Pedido (conta a receber) | Venda | Frete do orçamento (cliente) | Frete na venda | Diferença |');
say('|---|---|---|---|---|---|---|---|---|---|');
type Issue = { quote: string; customer: string; text: string; diff: Decimal };
const issues: Issue[] = [];
for (const q of db.quotes) {
  const v = latestVersion(q);
  const clientFreight = v.shipping?.clientFreight ? D(v.shipping.clientFreight.price) : ZERO;
  let freightCounted = false;
  for (const it of quoteItems(q)) {
    const st = itemState(db, q, it.itemId);
    const orders = db.orders.filter((o) => o.quoteId === q.id && o.quoteItemId === it.itemId && o.status !== 'cancelada');
    const sales = db.sales.filter((s) => s.status === 'ativa' && s.quoteId === q.id && (s.quoteItemId === it.itemId || orders.some((o) => o.id === s.orderId)));
    if (!orders.length && !sales.length) continue;
    // Valor do orçamento: o da versão enviada para produção (se houver pedido), senão o atual.
    const o = orders[0];
    const qi = o ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) ?? it : it;
    const quoted = qi.summary.orderPrice ? D(qi.summary.orderPrice) : null;
    const orderTitle = o ? db.titles.find((t) => t.origin.kind === 'pedido' && t.origin.id === o.id && t.status !== 'cancelado') : undefined;
    const sold = sum(sales.map(saleGross));
    const saleFreight = sum(sales.map((s) => D(s.freightCharged)));
    const charged = sales.length ? sold : orderTitle ? D(orderTitle.amount) : ZERO;
    const freightHere = !freightCounted ? clientFreight : ZERO;
    freightCounted = true;
    const diff = quoted ? cents(quoted.plus(freightHere).minus(charged).minus(saleFreight)) : ZERO;
    say(`| ${q.number} | ${party(q.customerId)} | ${it.name} | ${st} | ${brl(quoted)} | ${orderTitle ? brl(D(orderTitle.amount)) : '—'} | ${sales.length ? sales.map((s) => `${s.number} ${brl(saleGross(s))} (${s.qty} un × ${D(s.unitPrice).toFixed(4)})`).join('<br>') : '—'} | ${brl(freightHere)} | ${brl(saleFreight)} | ${diff.isZero() ? 'ok' : `**${brl(diff)}**`} |`);
    if (!diff.isZero()) {
      const qtyQuoted = qi.input.quantity;
      const qtySold = sales.reduce((s, x) => s + x.qty, 0);
      const why: string[] = [];
      if (freightHere.gt(0) && saleFreight.isZero()) why.push(`frete do cliente ${brl(freightHere)} não foi para a venda/pedido`);
      if (sales.length && qtySold !== qtyQuoted) why.push(`quantidade vendida ${qtySold} ≠ orçada ${qtyQuoted}`);
      if (sales.length && quoted) {
        const unitQuoted = quoted.div(qtyQuoted);
        const unitSold = sales[0] ? D(sales[0].unitPrice) : ZERO;
        if (!cents(unitQuoted).eq(cents(unitSold))) why.push(`preço por peça vendido ${brl(unitSold)} ≠ orçado ${brl(unitQuoted)}`);
        if (sales.some((s) => D(s.discount).gt(0))) why.push('venda com desconto');
      }
      if (!sales.length && orderTitle && quoted && !D(orderTitle.amount).eq(quoted)) why.push('conta do pedido ≠ valor do orçamento');
      issues.push({ quote: q.number, customer: party(q.customerId), text: `${it.name}: ${why.join('; ') || 'ver linha'}`, diff });
    }
  }
}
say();
say('### Diferenças encontradas');
if (!issues.length) say('Nenhuma.');
for (const i of issues) say(`- **${i.quote} · ${i.customer}** — ${i.text} → diferença ${brl(i.diff)}`);
say(`\nTotal em diferenças (orçado − cobrado): **${brl(sum(issues.map((i) => i.diff)))}**`);

/* 2) Recebimentos registrados (entradas do extrato) */
say();
say('## 2. Entradas no extrato (recebimentos de clientes)');
say('Marcado "AUTOMÁTICO À VISTA" = recebimento criado pela própria venda porque a condição ficou "À vista (recebido agora)".');
say('| Data | Cliente | Origem | Descrição | Valor recebido | Forma | Observação |');
say('|---|---|---|---|---|---|---|');
const autoRows: { t: FinTitle; amount: Decimal; sale?: Sale }[] = [];
for (const t of db.titles.filter((x) => x.direction === 'in')) {
  for (const s of t.settlements.filter((x) => !x.reversed)) {
    const sale = t.origin.kind === 'venda' ? db.sales.find((x) => x.id === t.origin.id) : undefined;
    const auto = !!sale && sale.payment.mode === 'avista' && !t.advance && s.date === t.competenceDate && D(s.amount).eq(D(t.amount)) && t.settlements.length === 1;
    if (auto) autoRows.push({ t, amount: D(s.amount), sale });
    const origin = t.origin.kind === 'venda' ? `Venda ${sale?.number ?? '?'}${t.advance ? ' (pago antes da entrega)' : ''}` : t.origin.kind === 'pedido' ? `Pedido ${db.orders.find((o) => o.id === t.origin.id)?.number ?? '?'}` : t.origin.kind;
    say(`| ${s.date} | ${party(t.partyId)} | ${origin} | ${t.description} | ${brl(D(s.amount))} | ${s.method ?? ''} | ${auto ? '**AUTOMÁTICO À VISTA**' : ''} |`);
  }
}
say();
say(`Recebimentos automáticos à vista: ${autoRows.length}, total ${brl(sum(autoRows.map((r) => r.amount)))}. Confira com o cliente quais de fato foram pagos.`);

/* 3) Saídas no extrato */
say();
say('## 3. Saídas no extrato (pagamentos)');
say('| Data | Fornecedor | Origem | Descrição | Valor | Observação |');
say('|---|---|---|---|---|---|');
for (const t of db.titles.filter((x) => x.direction === 'out')) {
  for (const s of t.settlements.filter((x) => !x.reversed)) {
    const autoBuy = t.origin.kind !== 'manual' && s.date === t.competenceDate && D(s.amount).eq(D(t.amount));
    say(`| ${s.date} | ${party(t.partyId)} | ${t.origin.kind} | ${t.description} | ${brl(D(s.amount))} | ${autoBuy ? 'pago na data do lançamento (à vista)' : ''} |`);
  }
}

/* 4) Pedidos por cliente (resumo) */
say();
say('## 4. Resumo por pedido (orçamento)');
say('| Orçamento | Cliente | Total orçado (+frete) | Cobrado (vendas + pedidos) | Recebido | A receber |');
say('|---|---|---|---|---|---|');
for (const q of db.quotes) {
  const orders = db.orders.filter((o) => o.quoteId === q.id && o.status !== 'cancelada');
  const sales = db.sales.filter((s) => s.status === 'ativa' && s.quoteId === q.id);
  if (!orders.length && !sales.length) continue;
  const v = latestVersion(q);
  const sold = new Set(sales.map((s) => s.orderId).filter(Boolean));
  const items = quoteItems(q).filter((it) => orders.some((o) => o.quoteItemId === it.itemId) || sales.some((s) => s.quoteItemId === it.itemId));
  const quoted = sum(items.map((it) => { const o = orders.find((x) => x.quoteItemId === it.itemId); const qi = o ? quoteItemAt(q, o.quoteVersion, o.quoteItemId) ?? it : it; return qi.summary.orderPrice ? D(qi.summary.orderPrice) : ZERO; }))
    .plus(v.shipping?.clientFreight ? D(v.shipping.clientFreight.price) : ZERO);
  const titles = [...sales.flatMap(saleTitles), ...orders.filter((o) => !sold.has(o.id)).map((o) => db.titles.find((t) => t.origin.kind === 'pedido' && t.origin.id === o.id && t.status !== 'cancelado')).filter(Boolean) as FinTitle[]];
  const charged = sum(titles.map((t) => D(t.amount)));
  const received = sum(titles.map(titlePaid));
  const open = sum(titles.map(titleOpen));
  say(`| ${q.number} | ${party(q.customerId)} | ${brl(quoted)} | ${brl(charged)}${cents(charged).eq(cents(quoted)) ? '' : ' ⚠'} | ${brl(received)} | ${brl(open)} |`);
}

const text = lines.join('\n');
if (out) writeFileSync(out, text, 'utf8');
console.log(text);

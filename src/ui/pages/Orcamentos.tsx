import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { DB, Quote, QuoteDeliveryKit, QuoteExtraLine, QuoteInput, QuoteItemStatus, QuoteShipping, QuoteStatus, QuoteVersion, QuoteVersionItem, RoundingRule } from '../../domain/types';
import {
  ITEM_STATE_LABEL, deleteQuote, emptyQuoteInput, evaluateQuote, isItemLocked, itemOrder, itemState, latestVersion, materialCostPolicy, perHour, quoteItems, quoteTotal,
  paramsForItem, quoteSanity, saveQuote, setItemStatus, setQuoteStatus, staleItems, withKitShares, type ItemState, type QuoteEvaluation, type QuoteItemDraft,
} from '../../domain/quotes';
import { kitUnitCost, quoteKit } from '../../domain/deliveryKits';
import { isLockedComponent, laborTotals, type CompStatus, type CostComponent } from '../../domain/costing';
import { ROUNDING_LABEL } from '../../domain/pricing';
import { createOrdersFromQuote, finishedGoodBalance, finishedGoodDraft, mergeQuotes } from '../../domain/production';
import { allocate } from '../../domain/purchases';
import { materialLabel, saveParty } from '../../domain/catalog';
import { fmtDate, fmtDateTime, fmtPhone, newId } from '../../domain/core';
import { D, Decimal, fmtBRL, fmtNum, fmtPct } from '../../domain/money';
import { fmtDuration } from '../../domain/conversions';
import { parse3MF } from '../../io/threeMF';
import { parseStl } from '../../io/stl';
import { compressImage } from '../image';
import { Alert, Badge, Check, Combobox, DataTable, DateField, DecField, Empty, Field, InlineDec, Kpi, Modal, PageHead, SelectField, Tabs, TextField, TimeField, useConfirm, type Tone } from '../components/ui';
import { perGramToPerKg } from '../../domain/conversions';
import { packageFor, piecesWeightG, quoteShipping, shippingDefaults } from '../../domain/shipping';
import { lookupCep } from '../../io/cep';
import { fmtCep, isValidCep } from '../../domain/address';
import { quoteFreight, type FreightOption } from '../../io/api';
import { ClientQuoteExport } from '../components/ClientQuoteExport';
import { PartyForm, priceLabel } from './Cadastros';

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: Tone }> = {
  rascunho: { label: 'Rascunho', tone: 'neutral' }, enviado: { label: 'Enviado ao cliente', tone: 'info' }, aprovado: { label: 'Aprovado', tone: 'success' },
  recusado: { label: 'Recusado', tone: 'error' }, convertido: { label: 'Em produção', tone: 'primary' },
};
const STATUS_BADGE: Record<CompStatus, { label: string; tone: Tone }> = {
  ok: { label: 'calculado', tone: 'success' }, estimado: { label: 'estimado', tone: 'warning' }, pendente: { label: 'pendente', tone: 'error' },
  ajustado: { label: 'ajustado por você', tone: 'info' }, nao_aplicavel: { label: 'n/a', tone: 'neutral' },
};

type ListTab = 'clientes' | 'pecas' | 'aprovados';

export function Orcamentos({ param }: { param?: string }) {
  if (param && param !== 'pecas' && param !== 'aprovados') return <QuoteEditor key={param} quoteId={param === 'novo' ? undefined : param} />;
  return <QuoteList tab={(param as ListTab) || 'clientes'} />;
}

/* ================================================================== */
/* Lista: por cliente (balões), por peça e aprovados                   */
/* ================================================================== */
function QuoteList({ tab }: { tab: ListTab }) {
  const { db } = useStore();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const customer = (id?: string) => db.parties.find((p) => p.id === id)?.name;
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  const rows = [...db.quotes].reverse()
    .filter((x) => !status || x.status === status)
    .filter((x) => match(`${x.number} ${x.name} ${customer(x.customerId) ?? ''} ${quoteItems(x).map((i) => i.name).join(' ')}`));
  const pieces = [...db.quotes].reverse().flatMap((x) => quoteItems(x).map((it) => ({ quote: x, it, state: itemState(db, x, it.itemId) })))
    .filter((r) => match(`${r.quote.number} ${r.it.name} ${customer(r.quote.customerId) ?? ''}`));
  const approvedStates: ItemState[] = ['aprovado', 'producao', 'produzido', 'separado'];
  const approved = pieces.filter((r) => approvedStates.includes(r.state));
  const approvedValue = approved.reduce((s, r) => s.plus(r.it.summary.orderPrice ?? 0), new Decimal(0));
  const [merging, setMerging] = useState(false);
  const [comparing, setComparing] = useState(false);
  return (
    <>
      <PageHead eyebrow="Orçamentos" title="Orçamentos" text="Orce várias peças por cliente, envie o orçamento de todas ou só de algumas e mande para produção as que o cliente aprovar."
        actions={<><button className="btn secondary" onClick={() => setComparing(true)} disabled={db.quotes.length < 1}>Comparar orçamentos</button>
          <button className="btn secondary" onClick={() => setMerging(true)} disabled={db.quotes.length < 2}>Juntar orçamentos (kit)</button><button className="btn primary" onClick={() => navigate('orcamentos/novo')}>Novo orçamento</button></>} />
      {merging && <MergeQuotesDialog onClose={() => setMerging(false)} />}
      {comparing && <CompareQuotesDialog onClose={() => setComparing(false)} />}
      <Tabs<ListTab> value={tab} onChange={(t) => navigate(t === 'clientes' ? 'orcamentos' : `orcamentos/${t}`)} tabs={[
        { id: 'clientes', label: 'Por cliente', count: db.quotes.length || undefined },
        { id: 'pecas', label: 'Por peça', count: pieces.length || undefined },
        { id: 'aprovados', label: 'Aprovados', count: approved.length || undefined },
      ]} />
      {db.quotes.length === 0 ? (
        <div className="card"><Empty title="Nenhum orçamento ainda" text="Informe cliente, peças, filamento, peso e tempo: o sistema calcula custo, R$/h e o valor para o cliente." action={<button className="btn primary" onClick={() => navigate('orcamentos/novo')}>Criar o primeiro orçamento</button>} /></div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 20 }}>
            <input type="search" className="search-lg" placeholder="Buscar por cliente, peça ou número…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar orçamentos" />
            {tab === 'clientes' && <div style={{ width: 260, maxWidth: '100%' }}>
              <Combobox ariaLabel="Filtrar por situação" value={status} onChange={setStatus} placeholder="Todas as situações" options={Object.entries(QUOTE_STATUS).map(([value, v]) => ({ value, label: v.label }))} />
            </div>}
            <span className="muted" style={{ marginLeft: 'auto' }}>{tab === 'clientes' ? `${rows.length} orçamento(s)` : `${(tab === 'pecas' ? pieces : approved).length} peça(s)`}</span>
          </div>
          {tab === 'clientes' && (rows.length === 0 ? <p className="muted">Nenhum orçamento encontrado.</p> : (
            <div className="quote-grid">{rows.map((x) => <QuoteCard key={x.id} quote={x} customer={customer(x.customerId)} />)}</div>
          ))}
          {tab !== 'clientes' && (
            <>
              {tab === 'aprovados' && <div className="kpis" style={{ marginBottom: 18 }}>
                <Kpi label="Peças aprovadas" value={approved.length} accent />
                <Kpi label="Valor aprovado" value={fmtBRL(approvedValue)} />
                <Kpi label="Aguardando produção" value={approved.filter((r) => r.state === 'aprovado').length} hint="aprovadas e ainda sem pedido" />
              </div>}
              <PieceTable rows={tab === 'pecas' ? pieces : approved} customer={customer} />
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * Comparador: dois modelos lado a lado (entradas, rubricas por peça e preço), com as diferenças
 * em destaque e a explicação de onde vem a diferença de valor. Usa o valor SALVO de cada um.
 */
function CompareQuotesDialog({ onClose }: { onClose: () => void }) {
  const { db } = useStore();
  const options = [...db.quotes].reverse().flatMap((q) => quoteItems(q).map((it) => ({ value: `${q.id}|${it.itemId}`, label: `${q.number} · ${q.name}${quoteItems(q).length > 1 ? ` → ${it.name}` : ''}` })));
  const [a, setA] = useState(options[0]?.value ?? '');
  const [b, setB] = useState(options[1]?.value ?? '');
  const load = (key: string) => {
    const [qid, iid] = key.split('|');
    const q = db.quotes.find((x) => x.id === qid);
    const it = q ? quoteItems(q).find((x) => x.itemId === iid) : undefined;
    if (!q || !it) return null;
    try { return { q, it, ev: evaluateQuote(it.input, it.params) }; } catch { return null; }
  };
  const A = load(a), B = load(b);
  type Row = { label: string; a: string; b: string; diff?: boolean };
  const rows: Row[] = [];
  const add = (label: string, fa: (x: NonNullable<typeof A>) => string) => {
    if (!A || !B) return;
    const va = fa(A), vb = fa(B);
    rows.push({ label, a: va, b: vb, diff: va !== vb });
  };
  const per = (x: NonNullable<typeof A>, v: Decimal | null | undefined) => (v ? fmtBRL(v.div(x.it.input.quantity), 4) : '—');
  const matText = (x: NonNullable<typeof A>) => x.ev.costs.materialLines.map((l) => `${l.label}: ${fmtNum(l.qtyOrder.div(x.it.input.quantity))} g × ${l.unitCost ? `${fmtBRL(perGramToPerKg(l.unitCost))}/kg` : 'sem preço'}`).join(' + ') || '—';
  add('Quantidade do modelo', (x) => `${x.it.input.quantity} peça(s)`);
  add('Filamento de 1 peça', matText);
  add('Tempo de 1 peça', (x) => (x.it.input.printHoursPerUnit ? fmtDuration(x.it.input.printHoursPerUnit) : 'não informado'));
  add('Impressora', (x) => x.it.params.printer?.name ?? '—');
  add('Mão de obra por orçamento', (x) => `${fmtNum(laborTotals(x.it.input.labor).perOrder)} min`);
  add('Mão de obra por peça', (x) => `${fmtNum(laborTotals(x.it.input.labor).perUnit)} min`);
  add('Taxa de falha', (x) => `${fmtNum(x.it.input.failureRatePct ?? 0)}%`);
  add('Markup', (x) => `${fmtNum(x.it.input.markupPct ?? 0)}%`);
  add('Canal de venda', (x) => (x.it.params.channel ? `${x.it.params.channel.name} (${fmtNum(D(x.it.params.channel.taxPct).plus(x.it.params.channel.commissionPct).plus(x.it.params.channel.paymentFeePct).plus(x.it.params.channel.otherPct))}% + ${fmtBRL(x.it.params.channel.fixedFeePerOrder)})` : '—'));
  add('Arredondamento', (x) => ROUNDING_LABEL[x.it.input.rounding]);
  add('Desconto', (x) => `${fmtNum(x.it.input.discountPct ?? 0)}%`);
  add('Preço digitado à mão', (x) => (x.it.input.manualPriceUnit ? fmtBRL(x.it.input.manualPriceUnit) : 'não (sugerido)'));
  const keys = A && B ? [...new Set([...A.ev.costs.components, ...B.ev.costs.components].map((c) => c.key))] : [];
  const comp = (x: NonNullable<typeof A>, k: string) => x.ev.costs.components.find((c) => c.key === k);
  const compRows = keys.map((k) => {
    const ca = comp(A!, k), cb = comp(B!, k);
    const pa = ca?.value ? ca.value.div(A!.it.input.quantity) : D(0), pb = cb?.value ? cb.value.div(B!.it.input.quantity) : D(0);
    return { k, label: (ca ?? cb)!.label, a: ca?.value ? per(A!, ca.value) : '—', b: cb?.value ? per(B!, cb.value) : '—', delta: pa.minus(pb), adjusted: ca?.status === 'ajustado' || cb?.status === 'ajustado' };
  });
  const unitA = A?.ev.pricing.analysis?.effectiveUnitPrice, unitB = B?.ev.pricing.analysis?.effectiveUnitPrice;
  const reasons: string[] = [];
  if (A && B && unitA && unitB) {
    for (const r of [...compRows].sort((x, y) => y.delta.abs().cmp(x.delta.abs())).filter((r) => r.delta.abs().gte('0.01')).slice(0, 4)) {
      reasons.push(`${r.label}: ${fmtBRL(r.delta.abs(), 2)} por peça a ${r.delta.isPositive() ? 'mais' : 'menos'} no orçamento 1${r.adjusted ? ' (valor ajustado à mão em um deles)' : ''}.`);
    }
    const roundA = A.ev.pricing.recommendedRoundedUnit && A.ev.pricing.recommendedUnit ? A.ev.pricing.recommendedRoundedUnit.minus(A.ev.pricing.recommendedUnit) : null;
    const roundB = B.ev.pricing.recommendedRoundedUnit && B.ev.pricing.recommendedUnit ? B.ev.pricing.recommendedRoundedUnit.minus(B.ev.pricing.recommendedUnit) : null;
    if (roundA && roundB && roundA.minus(roundB).abs().gte('0.05')) reasons.push(`Arredondamento: +${fmtBRL(roundA, 2)} por peça no 1 e +${fmtBRL(roundB, 2)} no 2.`);
    if (A.it.input.manualPriceUnit || B.it.input.manualPriceUnit) reasons.push('Um dos modelos tem o preço digitado à mão: o valor não segue o cálculo.');
    const perOrderA = laborTotals(A.it.input.labor).perOrder, perOrderB = laborTotals(B.it.input.labor).perOrder;
    if ((perOrderA > 0 || perOrderB > 0) && A.it.input.quantity !== B.it.input.quantity) reasons.push(`Custos por orçamento (mão de obra de ${fmtNum(Math.max(perOrderA, perOrderB))} min, taxa fixa do canal) são divididos pela quantidade: com menos peças, cada uma carrega uma parte maior.`);
  }
  return (
    <Modal wide title="Comparar orçamentos" subtitle="Escolha dois modelos para ver, lado a lado, o que foi preenchido, o custo de cada rubrica por peça e de onde vem a diferença de valor. Usa os valores salvos." onClose={onClose}
      footer={<button className="btn primary" onClick={onClose}>Fechar</button>}>
      <div className="stack">
        <div className="grid g2">
          <SelectField label="Orçamento 1" value={a} onChange={setA} options={options} />
          <SelectField label="Orçamento 2" value={b} onChange={setB} options={options} />
        </div>
        {A && B && <>
          <div className="kpis">
            <Kpi label="1 peça — orçamento 1" value={unitA ? fmtBRL(unitA) : '—'} hint={`total ${fmtBRL(A.ev.pricing.analysis?.revenue)}`} />
            <Kpi label="1 peça — orçamento 2" value={unitB ? fmtBRL(unitB) : '—'} hint={`total ${fmtBRL(B.ev.pricing.analysis?.revenue)}`} />
            <Kpi label="Diferença por peça" value={unitA && unitB ? fmtBRL(unitA.minus(unitB)) : '—'} accent />
          </div>
          {reasons.length > 0 && <Alert tone="info" title="De onde vem a diferença"><ul style={{ margin: 0, paddingLeft: 18 }}>{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></Alert>}
          <div className="card"><table className="tbl"><thead><tr><th>O que foi preenchido</th><th>Orçamento 1</th><th>Orçamento 2</th></tr></thead><tbody>
            {rows.map((r) => <tr key={r.label} className={r.diff ? 'diff-row' : ''}><td>{r.label}</td><td>{r.diff ? <b>{r.a}</b> : r.a}</td><td>{r.diff ? <b>{r.b}</b> : r.b}</td></tr>)}
          </tbody></table></div>
          <div className="card"><table className="tbl"><thead><tr><th>Custo por peça</th><th className="num">Orçamento 1</th><th className="num">Orçamento 2</th></tr></thead><tbody>
            {compRows.map((r) => <tr key={r.k} className={r.delta.abs().gte('0.01') ? 'diff-row' : ''}><td>{r.label}{r.adjusted && <Badge tone="info">ajustado à mão</Badge>}</td><td className="num">{r.a}</td><td className="num">{r.b}</td></tr>)}
          </tbody><tfoot><tr><td>Custo de 1 peça</td><td className="num">{fmtBRL(A.ev.costs.unitTotal)}</td><td className="num">{fmtBRL(B.ev.costs.unitTotal)}</td></tr></tfoot></table></div>
          <p className="small muted" style={{ margin: 0 }}>Linhas em destaque são diferentes entre os dois. Se o orçamento foi salvo antes da v1.8, o arredondamento antigo (por peça) continua no valor salvo: abra o orçamento e use “Atualizar para os custos de hoje”.</p>
        </>}
      </div>
    </Modal>
  );
}

/** Orçamento kit: junta vários orçamentos (ex.: peças do estoque) num só, mantendo os valores de cada peça. */
function MergeQuotesDialog({ onClose }: { onClose: () => void }) {
  const { db, run } = useStore();
  const [sel, setSel] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [del, setDel] = useState(true);
  const [q, setQ] = useState('');
  const customer = (id?: string) => db.parties.find((p) => p.id === id)?.name;
  const candidates = [...db.quotes].reverse().filter((x) => quoteItems(x).some((it) => itemState(db, x, it.itemId) !== 'recusado'))
    .filter((x) => !q.trim() || `${x.number} ${x.name} ${customer(x.customerId) ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const blocked = (x: Quote) => quoteItems(x).some((it) => isItemLocked(db, x, it.itemId));
  const chosen = db.quotes.filter((x) => sel.includes(x.id));
  const total = chosen.reduce((s, x) => s.plus(quoteTotal(db, x).price), new Decimal(0));
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const submit = () => run((d) => mergeQuotes(d, sel, { name, customerId: customerId || undefined, deleteSources: del }), 'Orçamento kit criado.')
    .then((r) => { if (r.ok) { onClose(); navigate(`orcamentos/${r.value.id}`); } });
  return (
    <Modal wide title="Juntar orçamentos num kit" subtitle="As peças em aberto dos orçamentos escolhidos vão para um orçamento único, com os mesmos valores. Ideal para o cliente que compra várias peças do estoque." onClose={onClose}
      footer={<><span className="muted" style={{ marginRight: 'auto' }}>{sel.length} selecionado(s) · total {fmtBRL(total)}</span><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={sel.length < 2}>Criar orçamento kit</button></>}>
      <div className="stack">
        <div className="grid g3">
          <TextField label="Nome do orçamento kit" value={name} onChange={setName} placeholder="Ex.: Kit decoração da Ana" />
          <SelectField label="Cliente" value={customerId} onChange={setCustomerId} placeholder="— o mesmo dos orçamentos —" options={db.parties.filter((p) => p.kind === 'cliente').map((p) => ({ value: p.id, label: p.name }))} />
          <Check label="Excluir os orçamentos de origem depois de juntar" checked={del} onChange={setDel} />
        </div>
        <input type="search" className="search-lg" placeholder="Buscar orçamento…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar orçamentos" />
        <div className="card"><table className="tbl"><thead><tr><th></th><th>Orçamento</th><th>Peças</th><th>Cliente</th><th className="num">Valor</th></tr></thead><tbody>
          {candidates.map((x) => { const b = blocked(x); return (
            <tr key={x.id} className={b ? 'muted' : ''}>
              <td><input type="checkbox" aria-label={`Selecionar ${x.number}`} checked={sel.includes(x.id)} disabled={b} onChange={() => toggle(x.id)} /></td>
              <td><span className="mono">{x.number}</span><div className="small">{x.name}</div></td>
              <td className="small">{quoteItems(x).filter((it) => itemState(db, x, it.itemId) !== 'recusado').map((it) => `${it.name}${it.finishedGoodId ? ' (estoque)' : ''}`).join(', ')}{b && <div className="small">tem peça em produção/separada</div>}</td>
              <td>{customer(x.customerId) ?? '—'}</td>
              <td className="num">{fmtBRL(quoteTotal(db, x).price)}</td>
            </tr>); })}
        </tbody></table></div>
        <p className="small muted">Peças recusadas ficam de fora. Dentro do orçamento você também pode usar <b>+ Peça do estoque</b> para montar o kit direto.</p>
      </div>
    </Modal>
  );
}

const ITEM_TONE: Record<ItemState, Tone> = { aberto: 'neutral', aprovado: 'success', recusado: 'error', producao: 'primary', produzido: 'info', separado: 'success' };

function PieceTable({ rows, customer }: { rows: { quote: Quote; it: QuoteVersionItem; state: ItemState }[]; customer: (id?: string) => string | undefined }) {
  return (
    <div className="card">
      <DataTable rows={rows} rowKey={(r) => r.quote.id + r.it.itemId} onRowClick={(r) => navigate(`orcamentos/${r.quote.id}`)}
        empty={<Empty title="Nenhuma peça nesta lista" />}
        columns={[
          { key: 'i', header: 'Peça', render: (r) => <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>{r.it.image ? <img src={r.it.image} alt="" className="kb-thumb" /> : null}<div><b>{r.it.name}</b><div className="muted small">{r.it.finishedGoodId ? 'pronta-entrega (estoque)' : `${r.it.input.quantity} un`}</div></div></div>, sort: (r) => r.it.name },
          { key: 'c', header: 'Cliente', render: (r) => customer(r.quote.customerId) ?? <span className="muted">—</span>, sort: (r) => customer(r.quote.customerId) ?? '' },
          { key: 'n', header: 'Orçamento', render: (r) => <span className="mono">{r.quote.number}</span>, sort: (r) => r.quote.number },
          { key: 'v', header: 'Valor', num: true, render: (r) => fmtBRL(r.it.summary.orderPrice), sort: (r) => Number(r.it.summary.orderPrice ?? 0) },
          { key: 'u', header: 'Por peça', num: true, render: (r) => fmtBRL(r.it.summary.unitPrice) },
          { key: 's', header: 'Situação', render: (r) => <Badge tone={ITEM_TONE[r.state]}>{ITEM_STATE_LABEL[r.state]}</Badge>, sort: (r) => r.state },
          { key: 'd', header: 'Data', render: (r) => fmtDate(latestVersion(r.quote).createdAt), sort: (r) => latestVersion(r.quote).createdAt },
        ]} />
    </div>
  );
}

function QuoteCard({ quote, customer }: { quote: Quote; customer?: string }) {
  const { db } = useStore();
  const v = latestVersion(quote);
  const items = v.items;
  const tot = quoteTotal(db, quote);
  const perH = tot.hours.gt(0) ? tot.price.div(tot.hours) : null;
  const img = items.find((i) => i.image)?.image;
  const approved = items.filter((i) => ['aprovado', 'producao', 'produzido', 'separado'].includes(itemState(db, quote, i.itemId))).length;
  return (
    <button className="quote-card" onClick={() => navigate(`orcamentos/${quote.id}`)} aria-label={`Abrir orçamento ${quote.number}: ${quote.name}`}>
      <div className="qc-img">{img ? <img src={img} alt="" /> : <img className="ph" src="/brand/10_icone_simbolo_transparente.svg" alt="" />}{items.length > 1 && <span className="qc-count">{items.length} peças</span>}</div>
      <div className="qc-body">
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span className="mono muted">{quote.number}</span>
          <Badge tone={QUOTE_STATUS[quote.status].tone}>{QUOTE_STATUS[quote.status].label}</Badge>
        </div>
        <h3 className="qc-title">{quote.name}</h3>
        <p className="muted qc-client">{customer ?? 'Cliente não informado'}{items.length > 1 ? ` · ${items.map((i) => i.name).slice(0, 3).join(', ')}${items.length > 3 ? '…' : ''}` : items[0].input.quantity > 1 ? ` · ${items[0].input.quantity} peças` : ''}</p>
        <div className="qc-price">{tot.count ? fmtBRL(tot.price) : '—'}<span>valor para o cliente</span></div>
        <div className="qc-meta">
          <span>Custo <b>{fmtBRL(tot.cost)}</b></span>
          <span>R$/h <b>{perH ? fmtBRL(perH) : '—'}</b></span>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span className="small muted">{fmtDate(v.createdAt)} · v{quote.versions.length}{items.length > 1 ? ` · ${approved}/${items.length} aprovadas` : ''}</span>
          {items.some((i) => !i.summary.complete) && <Badge tone="warning">incompleto</Badge>}
        </div>
      </div>
    </button>
  );
}

/* ================================================================== */
/* Orçamento (novo ou detalhe)                                         */
/* ================================================================== */
/**
 * Bloco do orçamento. Com `collapsible` (chave), ganha o botão Ocultar/Mostrar; a escolha fica
 * lembrada neste navegador e, oculto, mostra só o `summary` (o que já foi preenchido).
 */
function Section({ title, subtitle, children, right, collapsible, summary }: { title: string; subtitle?: string; children: ReactNode; right?: ReactNode; collapsible?: string; summary?: ReactNode }) {
  const storeKey = collapsible ? `ic:orc-secao:${collapsible}` : '';
  const [open, setOpen] = useState(() => {
    if (!storeKey) return true;
    try { return localStorage.getItem(storeKey) !== 'oculto'; } catch { return true; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem(storeKey, o ? 'oculto' : 'aberto'); } catch { /* armazenamento indisponível */ }
    return !o;
  });
  return (
    <div className={`card${open ? '' : ' section-collapsed'}`}>
      <div className="card-head">
        <div><h2>{title}</h2>{open ? subtitle && <p className="muted small">{subtitle}</p> : summary && <p className="small">{summary}</p>}</div>
        <div className="row" style={{ gap: 8 }}>
          {open && right}
          {collapsible && <button type="button" className="btn ghost sm" aria-expanded={open} onClick={toggle}>{open ? 'Ocultar ▴' : 'Mostrar ▾'}</button>}
        </div>
      </div>
      {open && <div className="card-body stack">{children}</div>}
    </div>
  );
}

const filamentMaterials = (db: DB) => db.materials.filter((m) => m.active && m.filament);

interface DraftItem { itemId?: string; name: string; image: string | null; input: QuoteInput; finishedGoodId?: string }

const newDraft = (db: DB): DraftItem => {
  const base = emptyQuoteInput(db.settings);
  const first = filamentMaterials(db)[0];
  return { name: '', image: null, input: first ? { ...base, materials: [{ materialId: first.id, qtyPerUnit: 0 }] } : base };
};
const draftsOf = (q: Quote): DraftItem[] => latestVersion(q).items.map((it) => ({
  itemId: it.itemId, name: it.name, image: it.image ?? null, input: { overrides: {}, ...structuredClone(it.input) }, finishedGoodId: it.finishedGoodId,
}));
function QuoteEditor({ quoteId }: { quoteId?: string }) {
  const { db, run, toast } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const quote = quoteId ? db.quotes.find((q) => q.id === quoteId) : undefined;
  const [items, setItems] = useState<DraftItem[]>(() => (quote ? draftsOf(quote) : [newDraft(db)]));
  const [active, setActive] = useState(0);
  const [shipping, setShipping] = useState<QuoteShipping>(() => (quote ? latestVersion(quote).shipping ?? quoteShipping(db, latestVersion(quote).items[0].input) : shippingDefaults(db.settings)));
  const [meta, setMeta] = useState({ title: quote && quote.name !== latestVersion(quote).items[0]?.name ? quote.name : '', customerId: quote?.customerId ?? '', note: '' });
  const [newClient, setNewClient] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [producing, setProducing] = useState(false);
  const [addingStock, setAddingStock] = useState(false);
  // Novo orçamento começa sem modelo: o usuário escolhe "Criar nova peça" ou "Peça do estoque".
  const [blankStart, setBlankStart] = useState(!quote);
  const isPristine = (it: DraftItem) => !it.itemId && !it.name.trim() && !it.finishedGoodId && !it.image
    && it.input.materials.every((m) => !m.qtyPerUnit) && !it.input.printHoursPerUnit && !it.input.extras.length;
  const idx = Math.min(active, items.length - 1);
  const cur = items[idx];
  const input = cur.input;
  const patchItem = (i: number, p: Partial<DraftItem>) => setItems((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const patch = (p: Partial<QuoteInput>) => setItems((s) => s.map((x, k) => (k === idx ? { ...x, input: { ...x.input, ...p } } : x)));
  const stateOf = (it: DraftItem): ItemState => (quote && it.itemId ? itemState(db, quote, it.itemId) : 'aberto');
  const lockedItem = (it: DraftItem) => !!quote && !!it.itemId && isItemLocked(db, quote, it.itemId);
  const curLocked = lockedItem(cur);
  // Kit de entrega do pedido: custo distribuído entre as peças (oculto ao cliente).
  const [kit, setKit] = useState<QuoteDeliveryKit | null>(() => (quote ? latestVersion(quote).deliveryKit ?? null : null));
  const qtyKey = items.map((it) => it.input.quantity).join(',');
  useEffect(() => {
    setItems((prev) => { const next = withKitShares(prev, kit, lockedItem); return next.every((x, i) => x === prev[i]) ? prev : next; });
  }, [kit, qtyKey, items.length]);
  const unsaved = !!quote && (JSON.stringify(items) !== JSON.stringify(draftsOf(quote))
    || JSON.stringify(shipping) !== JSON.stringify(latestVersion(quote).shipping ?? quoteShipping(db, latestVersion(quote).items[0].input))
    || JSON.stringify(kit ?? null) !== JSON.stringify(latestVersion(quote).deliveryKit ?? null)
    || (meta.customerId || undefined) !== quote.customerId);

  // Mesma regra da lista e do documento do cliente: peça salva e não alterada usa o valor salvo.
  // "Atualizar custos" passa a usar os custos de hoje (e salva como nova versão).
  const [refreshCosts, setRefreshCosts] = useState(false);
  const paramsOf = (it: DraftItem) => paramsForItem(db, quote, it.itemId, it.input, refreshCosts);
  const stale = useMemo(() => (quote ? staleItems(db, quote) : []), [db, quote]);
  const params = useMemo(() => paramsOf(cur), [db, input, refreshCosts, quote, cur.itemId]);
  const evaluation = useMemo<{ ev?: QuoteEvaluation; error?: string }>(() => {
    try { return { ev: evaluateQuote(input, params) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [input, params]);
  // Totais de todas as peças (não recusadas), pela mesma regra.
  const totals = useMemo(() => {
    let price = new Decimal(0), cost = new Decimal(0), pending = false, count = 0, pieces = 0;
    const rows: { i: number; name: string; qty: number; unit: Decimal | null; total: Decimal | null; refused: boolean }[] = [];
    items.forEach((it, i) => {
      const refused = stateOf(it) === 'recusado';
      let unit: Decimal | null = null, total: Decimal | null = null;
      try {
        const ev = evaluateQuote(it.input, paramsOf(it));
        unit = ev.pricing.analysis?.effectiveUnitPrice ?? null;
        total = ev.pricing.analysis?.revenue ?? null;
        if (!refused) { cost = cost.plus(ev.costs.total); if (!total) pending = true; }
      } catch { if (!refused) pending = true; }
      rows.push({ i, name: it.name || `Modelo ${i + 1}`, qty: it.input.quantity, unit, total, refused });
      if (refused) return;
      count++;
      pieces += it.input.quantity;
      if (total) price = price.plus(total);
    });
    return { price, cost, pending, count, pieces, rows };
  }, [items, db, refreshCosts, quote]);
  const unsavedAll = unsaved || (refreshCosts && stale.length > 0);

  if (quoteId && !quote) return <Empty title="Orçamento não encontrado" action={<button className="btn secondary" onClick={() => navigate('orcamentos')}>Voltar</button>} />;

  const save = () => run((d) => saveQuote(d, { quoteId: quote?.id, name: meta.title || undefined, customerId: meta.customerId || undefined, note: meta.note || (refreshCosts && stale.length ? 'Custos atualizados' : undefined), projectId: quote?.projectId, refreshCosts, deliveryKit: kit },
    items.map((it) => ({ itemId: it.itemId, name: it.name, image: it.image, input: it.input, finishedGoodId: it.finishedGoodId })), shipping),
    quote ? 'Orçamento atualizado (nova versão salva; as anteriores ficam no histórico).' : 'Orçamento criado.')
    .then((r) => {
      if (!r.ok) return;
      setMeta((m) => ({ ...m, note: '' }));
      setRefreshCosts(false);
      if (!quote) navigate(`orcamentos/${r.value.id}`);
      else setItems(draftsOf(r.value));
    });

  const remove = async () => {
    if (!quote) return;
    const reason = await confirm({ title: `Excluir o orçamento ${quote.number}?`, danger: true, confirmLabel: 'Excluir orçamento', reasonLabel: 'Motivo da exclusão',
      text: 'O orçamento sai das listas. Só é possível sem pedidos ativos, vendas ou peças separadas. Uma cópia fica no histórico automático de backups (Configurações).' });
    if (!reason) return;
    const r = await run((d) => deleteQuote(d, quote.id, reason), `Orçamento ${quote.number} excluído.`);
    if (r.ok) navigate('orcamentos');
  };
  const addItem = () => { setItems((s) => [...s, newDraft(db)]); setActive(items.length); };
  const duplicate = () => { setItems((s) => [...s, { ...structuredClone(cur), itemId: undefined, finishedGoodId: undefined, name: cur.name ? `${cur.name} (cópia)` : '' }]); setActive(items.length); };
  const removeItem = async () => {
    if (items.length === 1) return toast('warning', 'O orçamento precisa ter ao menos uma peça.');
    if (curLocked) return toast('warning', 'Esta peça está em produção e não pode ser removida.');
    const ok = await confirm({ title: `Remover "${cur.name || `Peça ${idx + 1}`}"?`, confirmLabel: 'Remover peça', danger: true, text: 'A peça sai do orçamento ao salvar. Versões anteriores continuam no histórico.' });
    if (ok === null) return;
    setItems((s) => s.filter((_, k) => k !== idx));
    setActive(Math.max(0, idx - 1));
  };
  const setStatus = (it: DraftItem, status: QuoteItemStatus) => {
    if (!quote || !it.itemId) return toast('warning', 'Salve o orçamento antes de aprovar ou recusar peças.');
    if (unsaved) return toast('warning', 'Há alterações não salvas. Salve antes de mudar a situação das peças.');
    run((d) => setItemStatus(d, quote.id, it.itemId!, status), status === 'aprovado' ? (it.finishedGoodId ? 'Pedido aprovado: peças do estoque separadas.' : 'Peça aprovada.') : status === 'recusado' ? 'Peça recusada.' : 'Peça reaberta.');
  };
  const onImage = async (file: File) => {
    try { patchItem(idx, { image: null }); const img = await compressImage(file); patchItem(idx, { image: img }); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Falha ao ler a imagem.'); }
  };
  const onSliceFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      if (/\.stl$/i.test(file.name)) {
        const s = parseStl(buf);
        toast('info', `STL lido: ${fmtNum(s.sizeMm.x, 1)} × ${fmtNum(s.sizeMm.y, 1)} × ${fmtNum(s.sizeMm.z, 1)} mm, ${fmtNum(s.volumeCm3)} cm³. Um STL não traz peso nem tempo: fatie e informe os valores.`);
        return;
      }
      const info = await parse3MF(buf);
      if (!info.sliced || info.totals.weightG === null || info.totals.hours === null) {
        toast('warning', 'Este 3MF não contém resultado de fatiamento. No Bambu Studio/Orca, fatie e exporte como "placa fatiada" — ou digite peso e tempo.');
        return;
      }
      const mats = input.materials.length ? input.materials.map((m, i) => (i === 0 ? { ...m, qtyPerUnit: Number(info.totals.weightG!.toFixed(2)) } : m)) : input.materials;
      patch({ printHoursPerUnit: Number(info.totals.hours.toFixed(4)), plates: info.plates.length, materials: mats, consumptionBasis: 'total' });
      toast('success', `Do fatiador: ${fmtNum(info.totals.weightG)} g e ${fmtNum(info.totals.hours, 2)} h (arquivo inteiro). Confira se corresponde a 1 peça.`);
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Arquivo inválido.'); }
  };

  const ev = evaluation.ev;
  const sanity = quoteSanity(db, input, params, ev);
  const title = meta.title || items[0]?.name || 'Novo orçamento';
  const producible = quote ? items.filter((it) => it.itemId && !it.finishedGoodId && ['aberto', 'aprovado'].includes(stateOf(it))) : [];
  const curState = stateOf(cur);
  const curOrder = quote && cur.itemId ? itemOrder(db, quote, cur.itemId) : undefined;
  return (
    <>
      <PageHead eyebrow={quote ? `Orçamento ${quote.number} · versão ${quote.versions.length} · ${items.length} peça(s)` : 'Novo orçamento'} title={title}
        actions={<>
          <button className="btn ghost" onClick={() => navigate('orcamentos')}>Voltar</button>
          {quote && <button className="btn ghost danger-text" onClick={remove}>Excluir</button>}
          {quote && <Badge tone={QUOTE_STATUS[quote.status].tone}>{QUOTE_STATUS[quote.status].label}</Badge>}
          {quote && (quote.status === 'rascunho' || quote.status === 'enviado') && <button className="btn ghost" onClick={() => run((d) => setQuoteStatus(d, quote.id, quote.status === 'enviado' ? 'rascunho' : 'enviado'), 'Situação atualizada.')}>{quote.status === 'enviado' ? 'Voltar para rascunho' : 'Marcar como enviado'}</button>}
          {quote && <button className="btn secondary" onClick={() => setExporting(true)}>Orçamento para o cliente</button>}
          {quote && <button className="btn navy" onClick={() => (unsavedAll ? toast('warning', 'Salve as alterações antes de enviar para produção.') : setProducing(true))} disabled={producible.length === 0}>Enviar para produção</button>}
          <button className="btn primary" onClick={save}>{quote ? 'Salvar alterações' : 'Salvar orçamento'}</button>
        </>} />

      {stale.length > 0 && !refreshCosts && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warning" title="Os custos mudaram desde que este orçamento foi salvo">
            Os valores mostrados aqui, na lista e no documento do cliente são os <b>salvos</b>. Com os custos de hoje
            (filamento, parâmetros, impressora) {stale.map((s) => `“${s.it.name}” passaria de ${fmtBRL(s.saved)} para ${fmtBRL(s.current)}`).join('; ')}.{' '}
            <button type="button" className="link-btn" onClick={() => setRefreshCosts(true)}>Atualizar para os custos de hoje</button>
          </Alert>
        </div>
      )}
      {refreshCosts && stale.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="info" title="Mostrando com os custos de hoje">
            Clique em <b>Salvar alterações</b> para gravar como nova versão (a anterior fica no histórico). Até salvar, a lista e o documento do cliente continuam com o valor anterior.{' '}
            <button type="button" className="link-btn" onClick={() => setRefreshCosts(false)}>Voltar aos valores salvos</button>
          </Alert>
        </div>
      )}

      <div className="split">
        <div className="stack">
          {/* 1. Cliente */}
          <Section title="1. Cliente" collapsible="cliente" summary={`${db.parties.find((p) => p.id === meta.customerId)?.name ?? 'Cliente não informado'}${meta.title ? ` · ${meta.title}` : ''}`}>
            <div className="grid g2">
              <Field label="Cliente">
                <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                  <Combobox className="grow" ariaLabel="Cliente" value={meta.customerId} onChange={(v) => setMeta((m) => ({ ...m, customerId: v }))} placeholder="— digite o nome do cliente —"
                    options={db.parties.filter((p) => p.kind === 'cliente').map((p) => ({ value: p.id, label: p.phone ? `${p.name} · ${fmtPhone(p.phone)}` : p.name }))} />
                  <button type="button" className="btn secondary" onClick={() => setNewClient(true)}>+ Novo</button>
                </div>
              </Field>
              <TextField label="Nome do orçamento (opcional)" value={meta.title} onChange={(v) => setMeta((m) => ({ ...m, title: v }))} placeholder={items[0]?.name || 'Ex.: Lembrancinhas do aniversário'} hint="Vazio = nome da primeira peça" />
            </div>
          </Section>

          {blankStart ? (
            <div className="card">
              <div className="card-head"><div><h2>2. Primeira peça do orçamento</h2><p className="muted small">Escolha como começar. Depois você pode adicionar outros modelos, novos ou do estoque.</p></div></div>
              <div className="card-body">
                <div className="start-choice">
                  <button type="button" className="start-option" onClick={() => setBlankStart(false)}>
                    <b>Criar nova peça</b><span>Peça sob encomenda: você informa filamento, peso e tempo de 1 peça e a quantidade.</span>
                  </button>
                  <button type="button" className="start-option" onClick={() => setAddingStock(true)}>
                    <b>Peça do estoque</b><span>Peça pronta (pronta-entrega) de Estoque → Peças produzidas, com o preço previsto dela.</span>
                  </button>
                </div>
              </div>
            </div>
          ) : <>
          {/* 2. Peças */}
          <Section title="2. Modelos de peça" collapsible="modelos" summary={`${items.length} modelo(s): ${items.map((it, i) => it.name || `Modelo ${i + 1}`).join(', ')}`}
            subtitle="Um modelo para cada peça diferente (ex.: 10 chaveiros + 10 vasos = 2 modelos). O cliente pode aprovar uns e outros não. Clique num modelo para editar."
            right={<><button type="button" className="btn secondary sm" onClick={duplicate}>Duplicar modelo</button>
                <button type="button" className="btn secondary sm" onClick={() => setAddingStock(true)}>+ Peça do estoque</button>
                <button type="button" className="btn primary sm" onClick={addItem}>+ Criar nova peça</button></>}>
            <div>
              <div className="piece-tabs" role="tablist" aria-label="Peças do orçamento">
                {items.map((it, i) => {
                  const st = stateOf(it);
                  let price: Decimal | null = null;
                  try { price = evaluateQuote(it.input, paramsOf(it)).pricing.analysis?.revenue ?? null; } catch { price = null; }
                  return (
                    <button key={it.itemId ?? `novo-${i}`} type="button" role="tab" aria-selected={i === idx} className={`piece-tab${i === idx ? ' on' : ''}${st === 'recusado' ? ' refused' : ''}`} onClick={() => setActive(i)}>
                      {it.image ? <img src={it.image} alt="" /> : <span className="piece-num">{i + 1}</span>}
                      <span className="piece-txt"><b>{it.name || `Modelo ${i + 1}`}</b><small>{it.input.quantity} peça{it.input.quantity === 1 ? '' : 's'} · {price ? `${fmtBRL(price)} total` : '—'}</small></span>
                      <Badge tone={ITEM_TONE[st]}>{ITEM_STATE_LABEL[st]}</Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          </Section>

          {curLocked && <Alert tone="info" title={`“${cur.name}” · ${ITEM_STATE_LABEL[curState]}`}>
            Somente leitura enquanto estiver em produção ou separada do estoque.{curOrder && <> Pedido <b>{curOrder.number}</b>{curOrder.dueDate ? ` · entrega ${fmtDate(curOrder.dueDate)}` : ''}. <a href="#/producao/pedidos">Ver pedidos</a></>}
          </Alert>}
          {cur.finishedGoodId && <Alert tone="info" title="Peça a pronta-entrega">Vem do estoque de peças prontas ({db.finishedGoods.find((g) => g.id === cur.finishedGoodId)?.code}). Ao aprovar, vira “Pedido aprovado” e as peças são separadas; não precisa produzir.</Alert>}

          <fieldset disabled={curLocked} className="stack">
            <Section title={`3. Modelo: ${cur.name || `Modelo ${idx + 1}`}`} collapsible="modelo" summary={`${input.quantity} peça${input.quantity === 1 ? '' : 's'}${input.dimensionsCm ? ' · com dimensões' : ''}${cur.image ? ' · com foto' : ''}`} subtitle="Preencha tudo para 1 peça deste modelo (peso, tempo, custos por peça). A quantidade multiplica e forma o valor total do modelo." right={quote && cur.itemId && !curLocked ? (
              <div className="row">
                {curState !== 'aprovado' && <button type="button" className="btn secondary sm" onClick={() => setStatus(cur, 'aprovado')}>{cur.finishedGoodId ? 'Pedido aprovado' : 'Cliente aprovou'}</button>}
                {curState !== 'recusado' && <button type="button" className="btn ghost sm" onClick={() => setStatus(cur, 'recusado')}>Cliente recusou</button>}
                {curState !== 'aberto' && <button type="button" className="btn ghost sm" onClick={() => setStatus(cur, 'aberto')}>Reabrir</button>}
              </div>) : undefined}>
              <div className="grid g2">
                <TextField label="Nome do modelo" required value={cur.name} onChange={(v) => patchItem(idx, { name: v })} placeholder="Ex.: Chaveiro personalizado com logo" />
                <DecField label="Quantidade deste modelo" required value={input.quantity} onChange={(v) => patch({ quantity: v === null ? 0 : Math.max(0, Math.round(Number(v))) })} suffix="peças"
                  hint="Quantas peças iguais o cliente quer deste modelo" />
                <Field label="Link do MakerWorld">
                  <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                    <input value={input.source.url ?? ''} placeholder="https://makerworld.com/..." aria-label="Link do MakerWorld" style={{ flex: 1 }}
                      onChange={(e) => patch({ source: { ...input.source, url: e.target.value, kind: e.target.value ? 'makerworld' : 'manual' } })} />
                    {input.source.url && /^https?:\/\//.test(input.source.url) && <a className="btn secondary" href={input.source.url} target="_blank" rel="noreferrer noopener">Abrir ↗</a>}
                  </div>
                </Field>
                <div className="row" style={{ alignItems: 'end', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn ghost sm" onClick={removeItem} disabled={items.length === 1}>Remover este modelo</button>
                </div>
              </div>
              <div className="stack" style={{ gap: 8 }}>
                <Check label="Informar as dimensões aproximadas de 1 peça (opcional — aparecem no orçamento do cliente)" checked={!!input.dimensionsCm}
                  onChange={(v) => patch({ dimensionsCm: v ? { height: null, width: null, depth: null } : null })} />
                {input.dimensionsCm && <div className="grid g3">
                  <DecField label="Altura" suffix="cm" value={input.dimensionsCm.height} onChange={(v) => patch({ dimensionsCm: { ...input.dimensionsCm!, height: v === null ? null : Number(v) } })} />
                  <DecField label="Largura" suffix="cm" value={input.dimensionsCm.width} onChange={(v) => patch({ dimensionsCm: { ...input.dimensionsCm!, width: v === null ? null : Number(v) } })} />
                  <DecField label="Profundidade" suffix="cm" value={input.dimensionsCm.depth} onChange={(v) => patch({ dimensionsCm: { ...input.dimensionsCm!, depth: v === null ? null : Number(v) } })}
                    hint="Preencha só as medidas que quiser" />
                </div>}
              </div>
              <Field label="Imagem da peça" hint="Opcional. Vai no orçamento do cliente. A imagem é reduzida automaticamente antes de salvar.">
                <div className="image-drop">
                  {cur.image ? <img src={cur.image} alt="Imagem da peça" /> : <span className="muted">Nenhuma imagem</span>}
                  <div className="row">
                    <label className="btn secondary">{cur.image ? 'Trocar imagem' : 'Escolher imagem'}<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImage(f); e.target.value = ''; }} /></label>
                    {cur.image && <button type="button" className="btn ghost" onClick={() => patchItem(idx, { image: null })}>Remover</button>}
                  </div>
                </div>
              </Field>
            </Section>

            <FilamentSection db={db} input={input} patch={patch} />

            <Section title="Tempo de produção (1 peça)" subtitle="Tempo de impressão de 1 peça, como aparece no fatiador." collapsible="tempo"
              summary={input.printHoursPerUnit ? `${fmtDuration(input.printHoursPerUnit)} por peça × ${input.quantity} = ${fmtDuration(input.printHoursPerUnit * input.quantity)} no modelo · ${db.printers.find((p) => p.id === input.printerId)?.name ?? 'sem impressora'}` : <span className="err-text">Falta o tempo de impressão de 1 peça</span>}>
              <TimeField label="Tempo de impressão de 1 peça" required value={input.printHoursPerUnit} onChange={(v) => patch({ printHoursPerUnit: v })}
                hint={input.printHoursPerUnit && input.quantity > 1 ? `Modelo inteiro: ${input.quantity} × ${fmtDuration(input.printHoursPerUnit)} = ${fmtDuration(input.printHoursPerUnit * input.quantity)}` : 'como aparece no fatiador (ex.: 1 h 20 min)'} />
              <div className="grid g2">
                <SelectField label="Impressora" value={input.printerId ?? ''} onChange={(v) => patch({ printerId: v || undefined })} placeholder="— selecione —"
                  options={db.printers.filter((p) => p.active || p.id === input.printerId).map((p) => ({ value: p.id, label: p.name }))}
                  hint={db.printers.length === 0 ? <a href="#/parametros/impressoras">Cadastre a impressora em Parâmetros de Custos</a> : undefined} />
                <Field label="Preencher a partir do arquivo (opcional)" hint="3MF fatiado (Bambu Studio/Orca) preenche peso e tempo.">
                  <input type="file" accept=".3mf,.stl,.zip" onChange={(e) => { const f = e.target.files?.[0]; if (f) onSliceFile(f); e.target.value = ''; }} />
                </Field>
              </div>
            </Section>

            <ComplementsSection db={db} input={input} patch={patch} />

            <ParamsSection db={db} input={input} patch={patch} />
          </fieldset>

          {/* Frete do orçamento inteiro */}
          <FreightSection db={db} items={items} shipping={shipping} setShipping={setShipping} setItems={setItems} customerId={meta.customerId} lockedIds={items.filter(lockedItem).map((it) => it.itemId!)} />
          <DeliveryKitSection db={db} kit={kit} setKit={setKit} items={items} />

          {quote && <Section title="Observação desta versão" collapsible="observacao" summary={meta.note || 'Sem observação'}><TextField label="O que mudou (opcional)" value={meta.note} onChange={(v) => setMeta((m) => ({ ...m, note: v }))} /></Section>}
          {quote && <VersionHistory quote={quote} onLoad={(v) => { setItems(v.items.map((it) => ({ itemId: it.itemId, name: it.name, image: it.image ?? null, input: { overrides: {}, ...structuredClone(it.input) }, finishedGoodId: it.finishedGoodId }))); setActive(0); if (v.shipping) setShipping(structuredClone(v.shipping)); setKit(v.deliveryKit ? structuredClone(v.deliveryKit) : null); }} />}
          </>}
        </div>

        {blankStart ? <div className="sticky stack"><div className="card"><div className="card-body"><p className="muted small" style={{ margin: 0 }}>O valor do orçamento aparece aqui assim que você escolher a primeira peça.</p></div></div></div> :
        <div className="sticky stack">
          <div className="card quote-total-card">
            <div className="card-body">
              <span className="muted small">Total do orçamento ({totals.count} modelo{totals.count === 1 ? '' : 's'} · {totals.pieces} peça{totals.pieces === 1 ? '' : 's'}{items.length > totals.count ? ` · ${items.length - totals.count} recusado(s)` : ''})</span>
              <b className="qt-price">{fmtBRL(totals.price)}</b>
              <span className="small">Custo total {fmtBRL(totals.cost)}{totals.pending ? ' · valores parciais' : ''}</span>
            </div>
            {items.length > 1 && <table className="tbl quote-models">
              <thead><tr><th>Modelo</th><th className="num">Qtd.</th><th className="num">1 peça</th><th className="num">Total</th></tr></thead>
              <tbody>{totals.rows.map((r) => (
                <tr key={r.i} className={`${r.i === idx ? 'on' : ''}${r.refused ? ' refused' : ''}`} onClick={() => setActive(r.i)} style={{ cursor: 'pointer' }} title="Abrir este modelo">
                  <td>{r.refused ? <s>{r.name}</s> : r.name}</td><td className="num">{r.qty}</td>
                  <td className="num">{r.unit ? fmtBRL(r.unit) : '—'}</td><td className="num"><b>{r.total ? fmtBRL(r.total) : '—'}</b></td>
                </tr>))}
              </tbody>
              <tfoot><tr><td>Total</td><td className="num">{totals.pieces}</td><td /><td className="num">{fmtBRL(totals.price)}</td></tr></tfoot>
            </table>}
          </div>
          <p className="section-title" style={{ margin: '4px 0 -4px' }}>Detalhes do modelo: {cur.name || `Modelo ${idx + 1}`} · {input.quantity} peça{input.quantity === 1 ? '' : 's'}</p>
          {sanity.length > 0 && <Alert tone="error" title="Confira antes de enviar ao cliente">
            <ul style={{ margin: 0, paddingLeft: 18 }}>{sanity.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </Alert>}
          {evaluation.error ? <Alert tone="error" title="Não foi possível calcular">{evaluation.error}</Alert>
            : ev && <ResultPanel ev={ev} input={input} patch={patch} locked={curLocked} />}
        </div>}
      </div>
      {newClient && <PartyForm kind="cliente" onClose={() => setNewClient(false)}
        onSave={(v) => run((d) => saveParty(d, v), 'Cliente cadastrado.').then((r) => { if (r.ok) { setMeta((m) => ({ ...m, customerId: r.value.id })); setNewClient(false); } })} />}
      {exporting && quote && <ClientQuoteExport quote={quote} onClose={() => setExporting(false)} unsaved={unsavedAll} />}
      {producing && quote && <ProduceDialog quote={quote} onClose={() => setProducing(false)} />}
      {addingStock && <StockPieceDialog db={db} exclude={items.map((it) => it.finishedGoodId).filter(Boolean) as string[]} onClose={() => setAddingStock(false)}
        onAdd={(d) => {
          const piece = { name: d.name, image: d.image ?? null, input: d.input, finishedGoodId: d.finishedGoodId };
          // Peça do estoque no lugar do modelo vazio inicial (não deixa um "Modelo 1" em branco sobrando).
          const replace = items.length === 1 && isPristine(items[0]);
          setItems((s) => (replace ? [piece] : [...s, piece]));
          setActive(replace ? 0 : items.length); setAddingStock(false); setBlankStart(false);
        }} />}
      {confirmEl}
    </>
  );
}

/* ---------------- Enviar peças para produção ---------------- */
function ProduceDialog({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const { db, run } = useStore();
  const items = quoteItems(quote).filter((it) => !it.finishedGoodId && ['aberto', 'aprovado'].includes(itemState(db, quote, it.itemId)));
  const [sel, setSel] = useState<string[]>(() => items.filter((it) => itemState(db, quote, it.itemId) === 'aprovado').map((it) => it.itemId).concat(
    items.every((it) => itemState(db, quote, it.itemId) !== 'aprovado') ? items.map((it) => it.itemId) : []));
  const [dueDate, setDueDate] = useState('');
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const submit = () => run((d) => createOrdersFromQuote(d, quote.id, sel, { dueDate }), `${sel.length} pedido(s) criado(s) e colocados no quadro pela data de entrega.`)
    .then((r) => { if (r.ok) { onClose(); navigate('producao/quadro'); } });
  return (
    <Modal title="Enviar para produção" subtitle={`${quote.number} · cada peça vira um pedido`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit} disabled={!sel.length}>Criar {sel.length} pedido(s)</button></>}>
      <div className="stack">
        <DateField label="Data de entrega ao cliente" required value={dueDate} onChange={setDueDate} hint="O quadro de produção é organizado por esta data (próximas entregas no topo)." />
        <p className="section-title">Peças que o cliente aprovou</p>
        {items.map((it) => (
          <Check key={it.itemId} checked={sel.includes(it.itemId)} onChange={() => toggle(it.itemId)}
            label={`${it.name} · ${it.input.quantity} un · ${fmtBRL(it.summary.orderPrice)} · ${ITEM_STATE_LABEL[itemState(db, quote, it.itemId)]}`} />
        ))}
        <p className="small muted">As peças enviadas ficam travadas no orçamento. Para alterar depois, use “Retornar para o orçamento” no pedido.</p>
      </div>
    </Modal>
  );
}

/* ---------------- Filamentos ---------------- */
function FilamentSection({ db, input, patch }: { db: DB; input: QuoteInput; patch: (p: Partial<QuoteInput>) => void }) {
  const mats = filamentMaterials(db);
  const lines = input.materials;
  const setLine = (i: number, p: Partial<QuoteInput['materials'][number]>) => patch({ materials: lines.map((l, k) => (k === i ? { ...l, ...p } : l)) });
  const add = () => patch({ materials: [...lines, { materialId: mats.find((m) => !lines.some((l) => l.materialId === m.id))?.id ?? mats[0]?.id ?? '', qtyPerUnit: 0 }] });
  if (mats.length === 0 && lines.length === 0) {
    return (
      <Section title="Filamento de 1 peça">
        <Empty title="Nenhum filamento cadastrado" text="Cadastre o filamento com o preço de referência (R$/kg) para poder orçar." action={<a className="btn primary" href="#/cadastros/materiais">Cadastrar filamento</a>} />
      </Section>
    );
  }
  return (
    <Section title="Filamento de 1 peça" collapsible="filamento" subtitle="Peso de UMA peça deste modelo, por cor/material (do fatiador). O preço vem do cadastro (última compra ou preço do cadastro)."
      summary={lines.length ? lines.map((l) => { const m = db.materials.find((x) => x.id === l.materialId); return `${m ? materialLabel(m) : 'filamento'}: ${fmtNum(l.qtyPerUnit)} g`; }).join(' + ') : 'Nenhum filamento'}>
      {lines.map((l, i) => {
        const mat = db.materials.find((m) => m.id === (l.materialId || db.lots.find((x) => x.id === l.lotId)?.materialId));
        const pol = mat ? materialCostPolicy(db, mat.id) : null;
        const options = mats.map((m) => {
          const brand = db.brands.find((b) => b.id === m.brandId)?.name;
          return { value: m.id, label: `${m.name} — ${m.filament!.materialType} ${m.filament!.color}${brand ? ` · ${brand}` : ''}` };
        });
        if (mat && !options.some((o) => o.value === mat.id)) options.push({ value: mat.id, label: `${mat.name} (inativo)` });
        return (
          <div key={i} className="filament-line">
            <SelectField label={`Filamento ${lines.length > 1 ? i + 1 : ''}`.trim()} value={mat?.id ?? ''} onChange={(v) => setLine(i, { materialId: v, lotId: undefined })} placeholder="— digite para buscar o filamento —" options={options} />
            <DecField label="Peso de 1 peça" suffix="g" value={l.qtyPerUnit || null} onChange={(v) => setLine(i, { qtyPerUnit: v === null ? 0 : Number(v) })}
              hint={l.qtyPerUnit && input.quantity > 1 ? `Modelo: ${input.quantity} × ${fmtNum(l.qtyPerUnit)} g = ${fmtNum(l.qtyPerUnit * input.quantity)} g` : undefined} />
            <Field label="Preço do filamento" hint={pol?.unitCost ? pol.source : <a href="#/cadastros/materiais">Cadastre o preço deste filamento</a>}>
              <div className={`readonly-value ${pol?.unitCost ? '' : 'missing'}`} aria-live="polite">{pol?.unitCost && mat ? priceLabel(mat, pol.unitCost) : 'sem preço cadastrado'}</div>
            </Field>
            {lines.length > 1 && <button type="button" className="btn ghost sm remove" onClick={() => patch({ materials: lines.filter((_, k) => k !== i) })} aria-label={`Remover filamento ${i + 1}`}>✕</button>}
          </div>
        );
      })}
      <div><button type="button" className="btn secondary sm" onClick={add} disabled={mats.length === 0}>+ Adicionar outro filamento</button></div>
    </Section>
  );
}


/* ---------------- Complementos de 1 peça ---------------- */
/** Itens que vão na peça além do filamento: do estoque (luminária, ímã — custo da última compra) ou digitados. */
function ComplementsSection({ db, input, patch }: { db: DB; input: QuoteInput; patch: (p: Partial<QuoteInput>) => void }) {
  const setX = (id: string, p: Partial<QuoteExtraLine>) => patch({ extras: input.extras.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  const stock = db.materials.filter((m) => !m.filament && (m.active || input.extras.some((e) => e.materialId === m.id)));
  const options = stock.map((m) => { const pol = materialCostPolicy(db, m.id); return { value: m.id, label: `${m.code} · ${m.name} · ${pol.unitCost ? `${fmtBRL(pol.unitCost, 4)}/${m.unit}` : 'sem preço'}` }; });
  const addStock = () => patch({ extras: [...input.extras, { id: newId(), kind: 'outro', description: '', qtyPerUnit: 1, manualUnitCost: null, materialId: stock[0]?.id ?? '' }] });
  const addManual = () => patch({ extras: [...input.extras, { id: newId(), kind: 'outro', description: '', qtyPerUnit: 1, manualUnitCost: null }] });
  const lineCost = (e: QuoteExtraLine) => {
    const uc = e.materialId ? materialCostPolicy(db, e.materialId).unitCost : e.manualUnitCost ? D(e.manualUnitCost) : null;
    return uc ? uc.times(e.qtyPerUnit || 0) : null;
  };
  const totalPiece = input.extras.reduce((s, e) => s.plus(lineCost(e) ?? 0), D(0));
  return (
    <Section title="Complementos de 1 peça" collapsible="complementos"
      summary={input.extras.length ? `${input.extras.length} item(ns) · ${fmtBRL(totalPiece)} por peça · ${fmtBRL(totalPiece.times(input.quantity))} no modelo` : 'Sem complementos (só filamento)'}
      subtitle="O que vai junto na peça além do filamento: luminária, ímã, parafuso, argola… Escolha do estoque (preço da última compra, baixado na produção) ou digite um custo avulso.">
      {input.extras.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nenhum complemento. Use os botões abaixo se a peça leva algo além do filamento.</p>}
      {input.extras.map((e) => {
        const mat = e.materialId ? db.materials.find((m) => m.id === e.materialId) : undefined;
        const cost = lineCost(e);
        return (
          <div key={e.id} className="filament-line">
            {e.materialId !== undefined
              ? <SelectField label="Complemento do estoque" value={e.materialId ?? ''} onChange={(v) => setX(e.id, { materialId: v, description: db.materials.find((m) => m.id === v)?.name ?? '' })} placeholder="— escolha o insumo —" options={options}
                  hint={stock.length === 0 ? <a href="#/cadastros/materiais">Cadastre o insumo (ex.: luminária) em Cadastros → Materiais</a> : undefined} />
              : <TextField label="Descrição (custo avulso)" value={e.description} onChange={(v) => setX(e.id, { description: v })} placeholder="Ex.: pintura à mão" />}
            <DecField label={`Quantidade por peça${mat ? ` (${mat.unit})` : ''}`} value={e.qtyPerUnit || null} onChange={(v) => setX(e.id, { qtyPerUnit: Number(v ?? 0) })}
              hint={cost ? `${fmtBRL(cost)} por peça · ${fmtBRL(cost.times(input.quantity))} no modelo` : undefined} />
            {e.materialId !== undefined
              ? <Field label="Custo unitário"><div className={`readonly-value ${mat && materialCostPolicy(db, mat.id).unitCost ? '' : 'missing'}`}>{mat ? (() => { const p = materialCostPolicy(db, mat.id); return p.unitCost ? `${fmtBRL(p.unitCost, 4)}/${mat.unit} · ${p.source}` : 'sem preço — registre a compra'; })() : '—'}</div></Field>
              : <DecField label="Custo unitário" suffix="R$" value={e.manualUnitCost ?? null} onChange={(v) => setX(e.id, { manualUnitCost: v })} />}
            <button type="button" className="btn ghost sm remove" onClick={() => patch({ extras: input.extras.filter((x) => x.id !== e.id) })} aria-label="Remover complemento">✕</button>
          </div>
        );
      })}
      <div className="row">
        <button type="button" className="btn secondary sm" onClick={addStock}>+ Complemento do estoque</button>
        <button type="button" className="btn ghost sm" onClick={addManual}>+ Custo avulso</button>
      </div>
    </Section>
  );
}

/* ---------------- Parâmetros deste orçamento ---------------- */
function ParamsSection({ db, input, patch }: { db: DB; input: QuoteInput; patch: (p: Partial<QuoteInput>) => void }) {
  const lab = laborTotals(input.labor);
  return (
    <div className="card">
      <details className="params-details">
        <summary>
          <div><h2>Parâmetros deste modelo</h2><p className="muted small">Markup, canal, taxa de falha, mão de obra (por orçamento e por peça), arredondamento e desconto. Vêm de Parâmetros de Custos; abra para alterar só neste modelo.</p></div>
        </summary>
        <div className="card-body stack" style={{ paddingTop: 0 }}>
          <div className="grid g3">
            <DecField label="Markup" suffix="%" value={input.markupPct} onChange={(v) => patch({ markupPct: v })} hint="Lucro desejado sobre o custo" />
            <SelectField label="Canal de venda" value={input.channelId ?? ''} onChange={(v) => patch({ channelId: v || undefined })} placeholder="— selecione —"
              options={db.channels.filter((c) => c.active || c.id === input.channelId).map((c) => ({ value: c.id, label: c.name }))}
              hint={db.channels.length === 0 ? <a href="#/parametros/canais">Cadastre um canal</a> : 'Tributos e taxas'} />
            <DecField label="Taxa de falha" suffix="%" value={input.failureRatePct} onChange={(v) => patch({ failureRatePct: v, failureSource: 'manual' })} />
            <DecField label="Mão de obra por orçamento" suffix="min" value={lab.perOrder || null} onChange={(v) => patch({ labor: { perOrder: Number(v ?? 0), perUnit: lab.perUnit } })} hint="Arquivo, fatiamento, atendimento" />
            <DecField label="Mão de obra por peça" suffix="min" value={lab.perUnit || null} onChange={(v) => patch({ labor: { perOrder: lab.perOrder, perUnit: Number(v ?? 0) } })} hint="Retirada, acabamento, embalagem" />
            <SelectField label="Arredondamento" value={input.rounding} onChange={(v) => patch({ rounding: v as RoundingRule })} options={Object.entries(ROUNDING_LABEL).map(([value, label]) => ({ value, label }))} />
            <DecField label="Desconto" suffix="%" value={input.discountPct} onChange={(v) => patch({ discountPct: v })} />
            <DecField label="Frete pago pela empresa" suffix="R$" value={input.freightSubsidyPerOrder} onChange={(v) => patch({ freightSubsidyPerOrder: v })} hint="Vazio se o cliente paga" />
          </div>
        </div>
      </details>
    </div>
  );
}

/* ---------------- Frete (SuperFrete) ---------------- */
/** Adiciona ao orçamento uma peça pronta do estoque (preço sugerido da peça). */
function StockPieceDialog({ db, exclude, onClose, onAdd }: { db: DB; exclude: string[]; onClose: () => void; onAdd: (d: QuoteItemDraft) => void }) {
  const { toast } = useStore();
  const options = db.finishedGoods.map((g) => ({ g, available: finishedGoodBalance(db, g.id).available })).filter((x) => x.available > 0 && !exclude.includes(x.g.id));
  const [fgId, setFgId] = useState(options[0]?.g.id ?? '');
  const [qty, setQty] = useState<string | null>('1');
  const [price, setPrice] = useState<string | null>(null);
  const sel = options.find((x) => x.g.id === fgId);
  const add = () => {
    try { onAdd(finishedGoodDraft(db, fgId, { qty: Math.round(Number(qty ?? 0)), unitPrice: price })); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Modal title="Adicionar peça do estoque" subtitle="Peças prontas (pronta-entrega). Ao aprovar, as peças são separadas para este pedido." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={add} disabled={!sel}>Adicionar ao orçamento</button></>}>
      {options.length === 0 ? <Empty title="Nenhuma peça disponível em estoque" text="Registre peças em Produção → Produções para estoque (ou em Estoque → Peças produzidas)." /> : (
        <div className="stack">
          <SelectField label="Peça" value={fgId} onChange={(v) => { setFgId(v); setPrice(null); }} options={options.map(({ g, available }) => ({ value: g.id, label: `${g.code} · ${g.description} · ${available} disponível(is)${g.suggestedPrice ? ` · ${fmtBRL(g.suggestedPrice)}` : ''}` }))} />
          <div className="grid g2">
            <DecField label="Quantidade" value={qty} onChange={setQty} suffix="un" hint={sel ? `máximo ${sel.available}` : undefined} />
            <DecField label="Preço por peça" value={price ?? sel?.g.suggestedPrice ?? null} onChange={setPrice} suffix="R$" hint="Vazio = preço sugerido da peça" />
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Kit de entrega (acessórios complementares): custo interno do pedido, nunca mostrado ao cliente. */
function DeliveryKitSection({ db, kit, setKit, items }: { db: DB; kit: QuoteDeliveryKit | null; setKit: (k: QuoteDeliveryKit | null) => void; items: DraftItem[] }) {
  const { toast } = useStore();
  const kits = db.deliveryKits.filter((k) => k.active || k.id === kit?.kitId);
  const choose = (kitId: string, qty: number) => {
    if (!kitId) return setKit(null);
    try { setKit(quoteKit(db, kitId, qty)); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
  };
  const model = kit ? db.deliveryKits.find((k) => k.id === kit.kitId) : undefined;
  const current = model ? kitUnitCost(db, model) : null;
  const changed = !!(kit && current && !current.missing.length && !current.total.eq(kit.unitCost));
  return (
    <Section title="5. Kit de entrega" collapsible="kit" summary={kit ? `${kit.name} · ${kit.qty} kit(s) · ${fmtBRL(kit.total)} no custo (oculto ao cliente)` : 'Sem kit de entrega'}
      subtitle="Acessórios que vão junto com o pedido (saquinho, cartão, adesivo…). O custo entra no preço das peças e não aparece no orçamento do cliente.">
      {kits.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nenhum kit cadastrado. <a href="#/cadastros/kits">Cadastre os modelos de kit em Cadastros → Kits de entrega</a>.</p> : (<>
        <div className="grid g3">
          <SelectField label="Modelo do kit" value={kit?.kitId ?? ''} onChange={(v) => choose(v, kit?.qty ?? 1)} placeholder="— sem kit —"
            options={kits.map((k) => { const c = kitUnitCost(db, k); return { value: k.id, label: `${k.name} · ${c.missing.length ? 'sem preço' : fmtBRL(c.total)}` }; })} />
          <DecField label="Quantidade de kits" value={kit?.qty ?? null} onChange={(v) => kit && choose(kit.kitId, Math.max(1, Math.round(Number(v ?? 1))))} suffix="kit(s)" hint="Normalmente 1 por pedido" />
          <Field label="Custo do kit no pedido"><div className="readonly-value">{kit ? `${fmtBRL(kit.total)} (${kit.qty} × ${fmtBRL(kit.unitCost)})` : '—'}</div></Field>
        </div>
        {kit && <p className="small muted" style={{ margin: '8px 0 0' }}>Distribuído pela quantidade de peças: {items.map((it, i) => `${it.name || `Peça ${i + 1}`} ${fmtBRL(it.input.deliveryKitShare ?? 0)}`).join(' · ')}. Os itens do kit saem do estoque quando a venda é registrada.</p>}
        {changed && <Alert tone="warning" title="O custo deste kit mudou">Hoje o kit custa {fmtBRL(current!.total)} (salvo: {fmtBRL(kit!.unitCost)}). <button type="button" className="link-btn" onClick={() => choose(kit!.kitId, kit!.qty)}>Usar o custo de hoje</button></Alert>}
      </>)}
    </Section>
  );
}

function FreightSection({ db, items, shipping, setShipping, setItems, customerId, lockedIds }: {
  db: DB; items: DraftItem[]; shipping: QuoteShipping; setShipping: (s: QuoteShipping) => void;
  setItems: (fn: (s: DraftItem[]) => DraftItem[]) => void; customerId: string; lockedIds: string[];
}) {
  const { toast } = useStore();
  const customer = db.parties.find((p) => p.id === customerId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<FreightOption[] | null>(null);
  const ship = shipping;
  const setShip = (p: Partial<QuoteShipping>) => { setOptions(null); setShipping({ ...ship, ...p }); };
  const editable = items.filter((it) => !it.itemId || !lockedIds.includes(it.itemId));
  /** Frete pago pela empresa: rateado entre as peças editáveis pelo peso (entra no custo de cada uma). */
  const setSubsidy = (price: string | null) => setItems((s) => {
    const targets = s.filter((it) => !it.itemId || !lockedIds.includes(it.itemId));
    const weights = targets.map((it) => piecesWeightG(db, it.input));
    const parts = price ? allocate(new Decimal(price), weights.some((w) => w.gt(0)) ? weights : weights.map(() => new Decimal(1))) : [];
    return s.map((it) => { const k = targets.indexOf(it); return k < 0 ? it : { ...it, input: { ...it.input, freightSubsidyPerOrder: price ? parts[k].toString() : null } }; });
  });
  const customerCep = (customer?.addressParts?.cep ?? '').replace(/\D/g, '');
  const destCep = (ship.destCep || customerCep).replace(/\D/g, '');
  const origin = (ship.originCep ?? '').replace(/\D/g, '');
  const defaults = shippingDefaults(db.settings);
  const isDefault = (['originCep', 'lengthCm', 'widthCm', 'heightCm', 'packagingWeightG'] as const).every((k) => (ship[k] ?? null) === (defaults[k] ?? null));
  const [originCity, setOriginCity] = useState<string | null>(null);
  useEffect(() => {
    setOriginCity(null);
    if (!isValidCep(origin)) return;
    let alive = true;
    lookupCep(origin).then((a) => { if (alive) setOriginCity(a.city && a.state ? `${a.city}/${a.state}` : null); }).catch(() => undefined);
    return () => { alive = false; };
  }, [origin]);
  const { pkg, missing, piecesG } = packageFor(db, items.filter((it) => it.input.quantity > 0).map((it) => it.input), ship);
  const calc = async () => {
    setError(null); setOptions(null);
    if (!isValidCep(origin)) return setError('Informe o CEP de saída (8 dígitos). O padrão fica em Parâmetros de Custos → Gerais → Envios.');
    if (!isValidCep(destCep)) return setError('Informe um CEP de destino válido (8 dígitos) ou cadastre o CEP do cliente.');
    if (!pkg) return setError(`Falta informar: ${missing.join(', ')}.`);
    setLoading(true);
    try {
      const r = await quoteFreight({ from: origin, to: destCep, package: pkg });
      setOptions(r.options);
      if (!r.options.length) setError('A SuperFrete não retornou opções para este trecho.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao cotar o frete.'); }
    finally { setLoading(false); }
  };
  const companyPays = (o: FreightOption) => {
    if (!editable.length) return toast('warning', 'Todas as peças estão em produção; o custo delas não pode mais mudar.');
    setSubsidy(o.price);
    setShipping({ ...ship, clientFreight: null });
    toast('success', `Frete ${o.name} (${fmtBRL(o.price)}) rateado no custo das peças como “Frete pago pela empresa”. O cliente vê “Frete grátis”. Salve o orçamento.`);
  };
  const clientPays = (o: FreightOption) => {
    setSubsidy(null);
    setShipping({ ...ship, clientFreight: { service: o.name, price: o.price!, deliveryMin: o.deliveryMin, deliveryMax: o.deliveryMax } });
    toast('success', `Frete ${o.name} (${fmtBRL(o.price)}) será somado ao total no orçamento do cliente. Salve o orçamento.`);
  };
  const cf = ship.clientFreight;
  return (
    <Section title="4. Frete do orçamento (SuperFrete)" collapsible="frete"
      summary={cf ? `Cliente paga: ${cf.service} · ${fmtBRL(cf.price)}` : items.some((it) => D(it.input.freightSubsidyPerOrder ?? 0).gt(0)) ? 'Empresa paga o frete (já no custo das peças)' : 'Sem frete calculado (opcional)'}
      subtitle={`Todos os modelos na mesma caixa. CEPs e caixa vêm do padrão e podem ser alterados só neste orçamento. Opcional.`}>
      <div className="grid g2">
        <Field label="CEP de saída" hint={!isValidCep(origin) ? <a href="#/parametros/gerais">Cadastre o endereço padrão de saída em Parâmetros → Envios</a>
          : ship.originCep === defaults.originCep ? `Padrão da empresa${originCity ? ` · ${originCity}` : ''}` : `Alterado neste orçamento${originCity ? ` · ${originCity}` : ''}`}>
          <input inputMode="numeric" value={fmtCep(ship.originCep ?? '')} placeholder="00000-000" aria-label="CEP de saída"
            onChange={(e) => setShip({ originCep: e.target.value.replace(/\D/g, '').slice(0, 8) || null })} />
        </Field>
        <Field label="CEP de destino" hint={!ship.destCep && customerCep ? `Do cadastro de ${customer!.name}` : ship.destCep ? 'Digitado neste orçamento' : 'Cadastre o CEP do cliente ou digite aqui'}>
          <input inputMode="numeric" value={fmtCep(ship.destCep || customerCep)} placeholder="00000-000" aria-label="CEP de destino"
            onChange={(e) => setShip({ destCep: e.target.value.replace(/\D/g, '').slice(0, 8) || null })} />
        </Field>
      </div>
      <p className="section-title">Caixa do envio</p>
      <div className="grid g4">
        <DecField label="Comprimento" suffix="cm" value={ship.lengthCm} onChange={(v) => setShip({ lengthCm: v === null ? null : Number(v) })} />
        <DecField label="Largura" suffix="cm" value={ship.widthCm} onChange={(v) => setShip({ widthCm: v === null ? null : Number(v) })} />
        <DecField label="Altura" suffix="cm" value={ship.heightCm} onChange={(v) => setShip({ heightCm: v === null ? null : Number(v) })} />
        <DecField label="Peso da embalagem" suffix="g" value={ship.packagingWeightG} onChange={(v) => setShip({ packagingWeightG: v === null ? null : Number(v) })} />
      </div>
      <div className="grid g3" style={{ alignItems: 'end' }}>
        <Field label="Pacote para cotação" hint={pkg ? `${fmtNum(piecesG)} g de peças + ${fmtNum(ship.packagingWeightG ?? 0)} g de embalagem` : `Falta: ${missing.join(', ')}`}>
          <div className={`readonly-value ${pkg ? '' : 'missing'}`}>{pkg ? `${fmtNum(pkg.weightKg, 3)} kg · ${fmtNum(pkg.lengthCm)}×${fmtNum(pkg.widthCm)}×${fmtNum(pkg.heightCm)} cm` : 'incompleto'}</div>
        </Field>
        <Field label=" "><button type="button" className="btn secondary" onClick={calc} disabled={loading}>{loading ? 'Cotando…' : 'Calcular frete'}</button></Field>
        <Field label=" ">{!isDefault && <button type="button" className="btn ghost" onClick={() => setShip({ ...defaults, destCep: ship.destCep })}>Voltar ao padrão (saída e caixa)</button>}</Field>
      </div>
      {error && <Alert tone="warning">{error}</Alert>}
      {options && options.length > 0 && (
        <div className="card"><table className="tbl"><thead><tr><th>Serviço</th><th className="num">Preço</th><th>Prazo</th><th /></tr></thead><tbody>
          {options.map((o) => (
            <tr key={o.id}>
              <td><b>{o.name}</b>{o.company && <div className="muted small">{o.company}</div>}</td>
              <td className="num">{o.error ? '—' : <b>{fmtBRL(o.price)}</b>}</td>
              <td>{o.error ? <span className="muted small">{o.error}</span> : o.deliveryMin !== null ? (o.deliveryMin === o.deliveryMax ? `${o.deliveryMin} dia(s) úteis` : `${o.deliveryMin} a ${o.deliveryMax} dias úteis`) : '—'}</td>
              <td>{!o.error && o.price && <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                <button type="button" className="btn secondary sm" onClick={() => clientPays(o)}>Cliente paga</button>
                <button type="button" className="btn ghost sm" onClick={() => companyPays(o)}>Empresa paga</button></div>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {cf && (
        <Alert tone="info" title={`Frete cobrado do cliente: ${cf.service} · ${fmtBRL(cf.price)}`}>
          Aparece no orçamento do cliente e é somado ao total (não entra no custo da peça).{' '}
          <button type="button" className="link-btn" onClick={() => setShip({ clientFreight: null })}>Remover</button>
        </Alert>
      )}
      <p className="small muted"><b>Cliente paga</b>: o frete vai para o orçamento do cliente, somado ao total. <b>Empresa paga</b>: o valor entra no custo do pedido e o cliente vê “frete grátis”. Valores da SuperFrete no momento da consulta.</p>
    </Section>
  );
}

/* ---------------- Histórico ---------------- */
function VersionHistory({ quote, onLoad }: { quote: Quote; onLoad: (v: QuoteVersion) => void }) {
  if (quote.versions.length < 2) return null;
  const sumOf = (v: QuoteVersion, k: 'totalCost' | 'orderPrice') => v.items.reduce((s, it) => s.plus(it.summary[k] ?? 0), new Decimal(0));
  return (
    <div className="card">
      <details className="params-details">
        <summary><div><h2>Histórico de versões ({quote.versions.length})</h2><p className="muted small">Versões anteriores nunca são alteradas. Carregar traz a versão para a tela; salve para valer.</p></div></summary>
        <table className="tbl"><thead><tr><th>Versão</th><th>Data</th><th className="num">Peças</th><th className="num">Custo</th><th className="num">Valor</th><th>Nota</th><th /></tr></thead><tbody>
          {[...quote.versions].reverse().map((v) => (
            <tr key={v.version}><td><b>v{v.version}</b></td><td>{fmtDateTime(v.createdAt)}</td><td className="num">{v.items.length}</td><td className="num">{fmtBRL(sumOf(v, 'totalCost'))}</td><td className="num">{fmtBRL(sumOf(v, 'orderPrice'))}</td>
              <td className="small">{v.note ?? ''}</td><td><button type="button" className="btn ghost sm" onClick={() => onLoad(v)}>Carregar</button></td></tr>
          ))}
        </tbody></table>
      </details>
    </div>
  );
}

/* ================================================================== */
/* Resultado: rubricas editáveis e valores finais                      */
/* ================================================================== */
function ResultPanel({ ev, input, patch, locked }: { ev: QuoteEvaluation; input: QuoteInput; patch: (p: Partial<QuoteInput>) => void; locked: boolean }) {
  const { costs, pricing } = ev;
  const q = input.quantity;
  const a = pricing.analysis;
  const { costPerHour, pricePerHour } = perHour(ev);
  const overrides = input.overrides ?? {};
  const setOverride = (key: string, v: string | null) => {
    const next = { ...overrides };
    if (v === null) delete next[key]; else next[key] = v;
    patch({ overrides: next });
  };
  const neg = (d: Decimal | null | undefined) => (d && d.isNegative() ? { color: 'var(--error)' } : undefined);
  const missing = [...costs.pending, ...pricing.errors];
  return (
    <>
      {missing.length > 0 && (
        <Alert tone="warning" title="Faltam informações — valores parciais">
          <ul>{missing.map((p) => <li key={p}>{p}</li>)}</ul>
        </Alert>
      )}

      {Object.keys(overrides).length > 0 && (
        <Alert tone="warning" title={`${Object.keys(overrides).length} rubrica(s) ajustada(s) à mão`}>
          {costs.components.filter((c) => c.status === 'ajustado').map((c) => c.label).join(', ')}: esses valores são fixos para o modelo inteiro e <b>não mudam</b> com a quantidade, o peso ou o filamento.
          {' '}<button type="button" className="link-btn" onClick={() => patch({ overrides: {} })} disabled={locked}>Voltar todas ao calculado</button>
        </Alert>
      )}

      <Section title="Valor deste modelo" collapsible="valores" summary={a ? `1 peça ${fmtBRL(a.effectiveUnitPrice)} · ${q} peça(s) ${fmtBRL(a.revenue)} · lucro ${fmtBRL(a.result)}` : 'Faltam informações'}>
        <div className="stack" style={{ gap: 16 }}>
          <div className="big-figures">
            <div><span>Custo de 1 peça</span><b>{fmtBRL(costs.unitTotal)}</b><small>{q > 1 ? `modelo (${q} peças): ${fmtBRL(costs.total)}` : 'modelo com 1 peça'}</small></div>
            <div><span>Custo por hora</span><b>{costPerHour ? fmtBRL(costPerHour) : '—'}</b><small>{costs.machineHours ? `${fmtNum(costs.machineHours, 2)} h de impressão no modelo` : 'informe o tempo'}</small></div>
          </div>
          <div className="client-price">
            <span>Valor para o cliente — 1 peça</span>
            <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
              <InlineDec prefix="R$" ariaLabel="Valor para o cliente por peça" value={input.manualPriceUnit} onChange={(v) => patch({ manualPriceUnit: v })}
                placeholder={pricing.recommendedRoundedUnit ? pricing.recommendedRoundedUnit.toFixed(2).replace('.', ',') : '—'} disabled={locked} />
              {input.manualPriceUnit && <button type="button" className="btn ghost sm" onClick={() => patch({ manualPriceUnit: null })} disabled={locked}>Usar sugerido</button>}
            </div>
            <small>Sugerido: <b>{fmtBRL(pricing.recommendedRoundedUnit)}</b> (markup {input.markupPct ? fmtNum(input.markupPct) + '%' : '—'} sobre o custo{pricing.channel ? ` + encargos de ${pricing.channel.name}` : ''}) · Mínimo: {fmtBRL(pricing.minimumUnit)}</small>
            {pricing.recommendedUnit && pricing.recommendedRoundedUnit && <small>
              Calculado {fmtBRL(pricing.recommendedUnit.times(q), 2)} no modelo → {fmtBRL(pricing.recommendedRoundedUnit.times(q))} ({ROUNDING_LABEL[input.rounding].toLowerCase()}{pricing.roundingLimited ? ': passaria de +5% e ficou só nos centavos' : ''}; arredondado uma vez no total do modelo, não em cada peça)
            </small>}
          </div>
          {a && (
            <>
              <div className="big-figures">
                <div><span>Total deste modelo ({q} peça{q === 1 ? '' : 's'})</span><b>{fmtBRL(a.revenue)}</b><small>{q} × {fmtBRL(a.effectiveUnitPrice)}{a.discountPct.gt(0) ? ` (com ${fmtNum(a.discountPct)}% de desconto)` : ''}</small></div>
                <div><span>R$/h (valor ÷ horas)</span><b>{pricePerHour ? fmtBRL(pricePerHour) : '—'}</b><small>quanto cada hora de máquina fatura</small></div>
                <div><span>Lucro estimado do modelo</span><b style={neg(a.result)}>{fmtBRL(a.result)}</b><small>{q > 1 ? `${fmtBRL(a.result.div(q))} por peça · ` : ''}após custos e taxas ({fmtBRL(a.fees)})</small></div>
              </div>
              <div className="ratio-pair">
                <div><span>Markup</span><b style={neg(a.markupPct)}>{fmtPct(a.markupPct)}</b><small>lucro ÷ custo</small></div>
                <div><span>Margem de lucro sobre a venda</span><b style={neg(a.marginPct)}>{fmtPct(a.marginPct)}</b><small>lucro ÷ valor de venda</small></div>
              </div>
            </>
          )}
          {a && a.contributionMargin.isNegative() && <Alert tone="error">Este valor não cobre os custos: cada venda gera prejuízo.</Alert>}
        </div>
      </Section>

      <Section title="Composição do custo" collapsible="composicao" summary={`Custo de 1 peça ${fmtBRL(costs.unitTotal)} · modelo ${fmtBRL(costs.total)}`}
        subtitle={`Você pode alterar as rubricas (menos o filamento, que vem do cadastro); apague o campo para voltar ao calculado.${q > 1 ? ` Os valores editáveis são do modelo inteiro (${q} peças); a última coluna mostra quanto fica em 1 peça.` : ''}`}>
        <div className="tbl-scroll"><table className="tbl rubricas">
          <thead><tr><th>Rubrica</th><th className="num">Calculado</th><th className="num">{q > 1 ? `Modelo (${q} peças)` : 'Valor usado'}</th>{q > 1 && <th className="num">1 peça</th>}</tr></thead>
          <tbody>
            {costs.components.map((c) => <RubricaRow key={c.key} c={c} q={q} override={overrides[c.key]} onChange={(v) => setOverride(c.key, v)} disabled={locked} />)}
          </tbody>
          <tfoot><tr><td>Custo total</td><td /><td className="num">{fmtBRL(costs.total)}</td>{q > 1 && <td className="num">{fmtBRL(costs.unitTotal)}</td>}</tr></tfoot>
        </table></div>
        <details className="disclosure"><summary>Como cada valor foi calculado</summary>
          <ul className="small" style={{ paddingLeft: 20, margin: 0 }}>
            {costs.materialLines.map((l, i) => <li key={i}><b>{l.label}:</b> {fmtNum(l.qtyOrder)} {l.unit} × {l.unitCost ? `${fmtBRL(perGramToPerKg(l.unitCost))}/kg` : '—'} ({l.source || 'sem preço'}) = {l.cost ? fmtBRL(l.cost) : '—'}</li>)}
            {costs.components.map((c) => <li key={c.key}><b>{c.label}:</b> {c.formula}</li>)}
          </ul>
        </details>
      </Section>
    </>
  );
}

function RubricaRow({ c, q, override, onChange, disabled }: { c: CostComponent; q: number; override?: string; onChange: (v: string | null) => void; disabled: boolean }) {
  return (
    <tr title={c.formula}>
      <td><div>{c.label}</div><Badge tone={STATUS_BADGE[c.status].tone}>{STATUS_BADGE[c.status].label}</Badge></td>
      <td className="num muted">{c.calculated ? fmtBRL(c.calculated) : 'pendente'}</td>
      <td className="num">{isLockedComponent(c.key)
        ? <span title="O preço do filamento vem do cadastro e não pode ser alterado no orçamento"><b>{c.value ? fmtBRL(c.value) : '—'}</b><div className="small muted">do cadastro</div></span>
        : <InlineDec prefix="R$" ariaLabel={`Valor usado para ${c.label}`} value={override ?? null} onChange={onChange}
          placeholder={c.calculated ? c.calculated.toFixed(2).replace('.', ',') : 'informe'} disabled={disabled} />}</td>
      {q > 1 && <td className="num muted">{c.value ? fmtBRL(c.value.div(q), 4) : '—'}</td>}
    </tr>
  );
}

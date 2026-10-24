import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { DB, Quote, QuoteExtraLine, QuoteInput, QuoteItemStatus, QuoteShipping, QuoteStatus, QuoteVersion, QuoteVersionItem, RoundingRule } from '../../domain/types';
import {
  ITEM_STATE_LABEL, deleteQuote, emptyQuoteInput, evaluateQuote, isItemLocked, itemOrder, itemState, latestVersion, materialCostPolicy, perHour, quoteItems, quoteTotal,
  paramsForItem, saveQuote, setItemStatus, setQuoteStatus, staleItems, type ItemState, type QuoteEvaluation,
} from '../../domain/quotes';
import { isLockedComponent, laborTotals, type CompStatus, type CostComponent } from '../../domain/costing';
import { ROUNDING_LABEL } from '../../domain/pricing';
import { createOrdersFromQuote } from '../../domain/production';
import { allocate } from '../../domain/purchases';
import { saveParty } from '../../domain/catalog';
import { fmtDate, fmtDateTime, fmtPhone, newId } from '../../domain/core';
import { Decimal, fmtBRL, fmtNum, fmtPct } from '../../domain/money';
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
  return (
    <>
      <PageHead eyebrow="Orçamentos" title="Orçamentos" text="Orce várias peças por cliente, envie o orçamento de todas ou só de algumas e mande para produção as que o cliente aprovar."
        actions={<button className="btn primary" onClick={() => navigate('orcamentos/novo')}>Novo orçamento</button>} />
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
function Section({ title, subtitle, children, right }: { title: string; subtitle?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><div><h2>{title}</h2>{subtitle && <p className="muted small">{subtitle}</p>}</div>{right}</div>
      <div className="card-body stack">{children}</div>
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
  const idx = Math.min(active, items.length - 1);
  const cur = items[idx];
  const input = cur.input;
  const patchItem = (i: number, p: Partial<DraftItem>) => setItems((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const patch = (p: Partial<QuoteInput>) => setItems((s) => s.map((x, k) => (k === idx ? { ...x, input: { ...x.input, ...p } } : x)));
  const stateOf = (it: DraftItem): ItemState => (quote && it.itemId ? itemState(db, quote, it.itemId) : 'aberto');
  const lockedItem = (it: DraftItem) => !!quote && !!it.itemId && isItemLocked(db, quote, it.itemId);
  const curLocked = lockedItem(cur);
  const unsaved = !!quote && (JSON.stringify(items) !== JSON.stringify(draftsOf(quote))
    || JSON.stringify(shipping) !== JSON.stringify(latestVersion(quote).shipping ?? quoteShipping(db, latestVersion(quote).items[0].input))
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
    let price = new Decimal(0), cost = new Decimal(0), pending = false, count = 0;
    items.forEach((it) => {
      if (stateOf(it) === 'recusado') return;
      count++;
      try {
        const ev = evaluateQuote(it.input, paramsOf(it));
        cost = cost.plus(ev.costs.total);
        if (ev.pricing.analysis) price = price.plus(ev.pricing.analysis.revenue); else pending = true;
      } catch { pending = true; }
    });
    return { price, cost, pending, count };
  }, [items, db, refreshCosts, quote]);
  const unsavedAll = unsaved || (refreshCosts && stale.length > 0);

  if (quoteId && !quote) return <Empty title="Orçamento não encontrado" action={<button className="btn secondary" onClick={() => navigate('orcamentos')}>Voltar</button>} />;

  const save = () => run((d) => saveQuote(d, { quoteId: quote?.id, name: meta.title || undefined, customerId: meta.customerId || undefined, note: meta.note || (refreshCosts && stale.length ? 'Custos atualizados' : undefined), projectId: quote?.projectId, refreshCosts },
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
          <Section title="1. Cliente">
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

          {/* 2. Peças */}
          <div className="card">
            <div className="card-head"><div><h2>2. Peças do orçamento</h2><p className="muted small">Orce várias peças: o cliente pode aprovar algumas e outras não. Clique numa peça para editar.</p></div>
              <div className="row"><button type="button" className="btn secondary sm" onClick={duplicate}>Duplicar peça</button><button type="button" className="btn primary sm" onClick={addItem}>+ Adicionar peça</button></div></div>
            <div className="card-body">
              <div className="piece-tabs" role="tablist" aria-label="Peças do orçamento">
                {items.map((it, i) => {
                  const st = stateOf(it);
                  let price: Decimal | null = null;
                  try { price = evaluateQuote(it.input, paramsOf(it)).pricing.analysis?.revenue ?? null; } catch { price = null; }
                  return (
                    <button key={it.itemId ?? `novo-${i}`} type="button" role="tab" aria-selected={i === idx} className={`piece-tab${i === idx ? ' on' : ''}${st === 'recusado' ? ' refused' : ''}`} onClick={() => setActive(i)}>
                      {it.image ? <img src={it.image} alt="" /> : <span className="piece-num">{i + 1}</span>}
                      <span className="piece-txt"><b>{it.name || `Peça ${i + 1}`}</b><small>{it.input.quantity} un · {price ? fmtBRL(price) : '—'}</small></span>
                      <Badge tone={ITEM_TONE[st]}>{ITEM_STATE_LABEL[st]}</Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {curLocked && <Alert tone="info" title={`“${cur.name}” · ${ITEM_STATE_LABEL[curState]}`}>
            Somente leitura enquanto estiver em produção ou separada do estoque.{curOrder && <> Pedido <b>{curOrder.number}</b>{curOrder.dueDate ? ` · entrega ${fmtDate(curOrder.dueDate)}` : ''}. <a href="#/producao/pedidos">Ver pedidos</a></>}
          </Alert>}
          {cur.finishedGoodId && <Alert tone="info" title="Peça a pronta-entrega">Vem do estoque de peças prontas ({db.finishedGoods.find((g) => g.id === cur.finishedGoodId)?.code}). Ao aprovar, vira “Pedido aprovado” e as peças são separadas; não precisa produzir.</Alert>}

          <fieldset disabled={curLocked} className="stack">
            <Section title={`3. ${cur.name || `Peça ${idx + 1}`}`} right={quote && cur.itemId && !curLocked ? (
              <div className="row">
                {curState !== 'aprovado' && <button type="button" className="btn secondary sm" onClick={() => setStatus(cur, 'aprovado')}>{cur.finishedGoodId ? 'Pedido aprovado' : 'Cliente aprovou'}</button>}
                {curState !== 'recusado' && <button type="button" className="btn ghost sm" onClick={() => setStatus(cur, 'recusado')}>Cliente recusou</button>}
                {curState !== 'aberto' && <button type="button" className="btn ghost sm" onClick={() => setStatus(cur, 'aberto')}>Reabrir</button>}
              </div>) : undefined}>
              <div className="grid g2">
                <TextField label="Descrição da peça" required value={cur.name} onChange={(v) => patchItem(idx, { name: v })} placeholder="Ex.: Chaveiro personalizado com logo" />
                <DecField label="Quantidade de peças" required value={input.quantity} onChange={(v) => patch({ quantity: v === null ? 0 : Math.max(0, Math.round(Number(v))) })} suffix="un" />
                <Field label="Link do MakerWorld">
                  <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                    <input value={input.source.url ?? ''} placeholder="https://makerworld.com/..." aria-label="Link do MakerWorld" style={{ flex: 1 }}
                      onChange={(e) => patch({ source: { ...input.source, url: e.target.value, kind: e.target.value ? 'makerworld' : 'manual' } })} />
                    {input.source.url && /^https?:\/\//.test(input.source.url) && <a className="btn secondary" href={input.source.url} target="_blank" rel="noreferrer noopener">Abrir ↗</a>}
                  </div>
                </Field>
                <div className="row" style={{ alignItems: 'end', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn ghost sm" onClick={removeItem} disabled={items.length === 1}>Remover esta peça</button>
                </div>
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

            <Section title="Tempo de produção" subtitle="Tempo de impressão de 1 peça (do fatiador).">
              <TimeField label="Tempo de impressão de 1 peça" required value={input.printHoursPerUnit} onChange={(v) => patch({ printHoursPerUnit: v })} hint="como aparece no fatiador (ex.: 1 h 20 min)" />
              <div className="grid g2">
                <SelectField label="Impressora" value={input.printerId ?? ''} onChange={(v) => patch({ printerId: v || undefined })} placeholder="— selecione —"
                  options={db.printers.filter((p) => p.active || p.id === input.printerId).map((p) => ({ value: p.id, label: p.name }))}
                  hint={db.printers.length === 0 ? <a href="#/parametros/impressoras">Cadastre a impressora em Parâmetros de Custos</a> : undefined} />
                <Field label="Preencher a partir do arquivo (opcional)" hint="3MF fatiado (Bambu Studio/Orca) preenche peso e tempo.">
                  <input type="file" accept=".3mf,.stl,.zip" onChange={(e) => { const f = e.target.files?.[0]; if (f) onSliceFile(f); e.target.value = ''; }} />
                </Field>
              </div>
            </Section>

            <ParamsSection db={db} input={input} patch={patch} />
          </fieldset>

          {/* Frete do orçamento inteiro */}
          <FreightSection db={db} items={items} shipping={shipping} setShipping={setShipping} setItems={setItems} customerId={meta.customerId} lockedIds={items.filter(lockedItem).map((it) => it.itemId!)} />

          {quote && <Section title="Observação desta versão"><TextField label="O que mudou (opcional)" value={meta.note} onChange={(v) => setMeta((m) => ({ ...m, note: v }))} /></Section>}
          {quote && <VersionHistory quote={quote} onLoad={(v) => { setItems(v.items.map((it) => ({ itemId: it.itemId, name: it.name, image: it.image ?? null, input: { overrides: {}, ...structuredClone(it.input) }, finishedGoodId: it.finishedGoodId }))); setActive(0); if (v.shipping) setShipping(structuredClone(v.shipping)); }} />}
        </div>

        <div className="sticky stack">
          <div className="card quote-total-card">
            <div className="card-body">
              <span className="muted small">Total do orçamento ({totals.count} peça{totals.count === 1 ? '' : 's'}{items.length > totals.count ? `, ${items.length - totals.count} recusada(s)` : ''})</span>
              <b className="qt-price">{fmtBRL(totals.price)}</b>
              <span className="small">Custo total {fmtBRL(totals.cost)}{totals.pending ? ' · valores parciais' : ''}</span>
            </div>
          </div>
          <p className="section-title" style={{ margin: '4px 0 -4px' }}>{cur.name || `Peça ${idx + 1}`}</p>
          {evaluation.error ? <Alert tone="error" title="Não foi possível calcular">{evaluation.error}</Alert>
            : ev && <ResultPanel ev={ev} input={input} patch={patch} locked={curLocked} />}
        </div>
      </div>
      {newClient && <PartyForm kind="cliente" onClose={() => setNewClient(false)}
        onSave={(v) => run((d) => saveParty(d, v), 'Cliente cadastrado.').then((r) => { if (r.ok) { setMeta((m) => ({ ...m, customerId: r.value.id })); setNewClient(false); } })} />}
      {exporting && quote && <ClientQuoteExport quote={quote} onClose={() => setExporting(false)} unsaved={unsavedAll} />}
      {producing && quote && <ProduceDialog quote={quote} onClose={() => setProducing(false)} />}
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
      <Section title="2. Filamentos utilizados">
        <Empty title="Nenhum filamento cadastrado" text="Cadastre o filamento com o preço de referência (R$/kg) para poder orçar." action={<a className="btn primary" href="#/cadastros/materiais">Cadastrar filamento</a>} />
      </Section>
    );
  }
  return (
    <Section title="2. Filamentos utilizados" subtitle="Um filamento por cor/material. O preço é o cadastrado no sistema (última compra ou preço do cadastro).">
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
            <DecField label="Peso da peça" suffix="g" value={l.qtyPerUnit || null} onChange={(v) => setLine(i, { qtyPerUnit: v === null ? 0 : Number(v) })} />
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


/* ---------------- Parâmetros deste orçamento ---------------- */
function ParamsSection({ db, input, patch }: { db: DB; input: QuoteInput; patch: (p: Partial<QuoteInput>) => void }) {
  const lab = laborTotals(input.labor);
  const setX = (id: string, p: Partial<QuoteExtraLine>) => patch({ extras: input.extras.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  return (
    <div className="card">
      <details className="params-details">
        <summary>
          <div><h2>4. Parâmetros deste orçamento</h2><p className="muted small">Vêm de Parâmetros de Custos. Abra para alterar só neste orçamento.</p></div>
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
          <p className="section-title">Outros custos por peça (embalagem, ímãs, parafusos…)</p>
          {input.extras.map((e) => (
            <div key={e.id} className="filament-line">
              <TextField label="Descrição" value={e.description} onChange={(v) => setX(e.id, { description: v })} placeholder="Ex.: caixa + saquinho" />
              <DecField label="Quantidade por peça" value={e.qtyPerUnit || null} onChange={(v) => setX(e.id, { qtyPerUnit: Number(v ?? 0) })} />
              <DecField label="Custo unitário" suffix="R$" value={e.manualUnitCost ?? null} onChange={(v) => setX(e.id, { manualUnitCost: v })} />
              <button type="button" className="btn ghost sm remove" onClick={() => patch({ extras: input.extras.filter((x) => x.id !== e.id) })} aria-label="Remover custo">✕</button>
            </div>
          ))}
          <div><button type="button" className="btn secondary sm" onClick={() => patch({ extras: [...input.extras, { id: newId(), kind: 'embalagem', description: '', qtyPerUnit: 1, manualUnitCost: null }] })}>+ Adicionar custo</button></div>
        </div>
      </details>
    </div>
  );
}

/* ---------------- Frete (SuperFrete) ---------------- */
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
    <Section title="4. Frete do orçamento (SuperFrete)" subtitle={`Todas as ${items.length} peça(s) na mesma caixa. CEPs e caixa vêm do padrão e podem ser alterados só neste orçamento. Opcional.`}>
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

      <div className="card result-total">
        <div className="card-body stack" style={{ gap: 16 }}>
          <div className="big-figures">
            <div><span>Custo total {q > 1 ? `(${q} peças)` : 'da peça'}</span><b>{fmtBRL(costs.total)}</b>{q > 1 && <small>{fmtBRL(costs.unitTotal)} por peça</small>}</div>
            <div><span>Custo por hora</span><b>{costPerHour ? fmtBRL(costPerHour) : '—'}</b><small>{costs.machineHours ? `${fmtNum(costs.machineHours, 2)} h de impressão` : 'informe o tempo'}</small></div>
          </div>
          <div className="client-price">
            <span>Valor para o cliente {q > 1 ? '(por peça)' : ''}</span>
            <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
              <InlineDec prefix="R$" ariaLabel="Valor para o cliente por peça" value={input.manualPriceUnit} onChange={(v) => patch({ manualPriceUnit: v })}
                placeholder={pricing.recommendedRoundedUnit ? pricing.recommendedRoundedUnit.toFixed(2).replace('.', ',') : '—'} disabled={locked} />
              {input.manualPriceUnit && <button type="button" className="btn ghost sm" onClick={() => patch({ manualPriceUnit: null })} disabled={locked}>Usar sugerido</button>}
            </div>
            <small>Sugerido: <b>{fmtBRL(pricing.recommendedRoundedUnit)}</b> (markup {input.markupPct ? fmtNum(input.markupPct) + '%' : '—'} sobre o custo{pricing.channel ? ` + encargos de ${pricing.channel.name}` : ''}) · Mínimo: {fmtBRL(pricing.minimumUnit)}</small>
          </div>
          {a && (
            <>
              <div className="big-figures">
                <div><span>Total do pedido</span><b>{fmtBRL(a.revenue)}</b>{a.discountPct.gt(0) && <small>com {fmtNum(a.discountPct)}% de desconto</small>}</div>
                <div><span>R$/h (valor ÷ horas)</span><b>{pricePerHour ? fmtBRL(pricePerHour) : '—'}</b><small>quanto cada hora de máquina fatura</small></div>
                <div><span>Lucro estimado</span><b style={neg(a.result)}>{fmtBRL(a.result)}</b><small>após custos e taxas ({fmtBRL(a.fees)})</small></div>
              </div>
              <div className="ratio-pair">
                <div><span>Markup</span><b style={neg(a.markupPct)}>{fmtPct(a.markupPct)}</b><small>lucro ÷ custo</small></div>
                <div><span>Margem de lucro sobre a venda</span><b style={neg(a.marginPct)}>{fmtPct(a.marginPct)}</b><small>lucro ÷ valor de venda</small></div>
              </div>
            </>
          )}
          {a && a.contributionMargin.isNegative() && <Alert tone="error">Este valor não cobre os custos: cada venda gera prejuízo.</Alert>}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><h2>Composição do custo</h2><p className="muted small">Você pode alterar as rubricas (menos o filamento, que vem do cadastro); apague o campo para voltar ao calculado.{q > 1 ? ` Valores do pedido (${q} peças).` : ''}</p></div></div>
        <table className="tbl rubricas">
          <thead><tr><th>Rubrica</th><th className="num">Calculado</th><th className="num">Valor usado</th></tr></thead>
          <tbody>
            {costs.components.map((c) => <RubricaRow key={c.key} c={c} override={overrides[c.key]} onChange={(v) => setOverride(c.key, v)} disabled={locked} />)}
          </tbody>
          <tfoot><tr><td>Custo total</td><td /><td className="num">{fmtBRL(costs.total)}</td></tr></tfoot>
        </table>
        <div className="card-body" style={{ paddingTop: 8 }}>
          <details className="disclosure"><summary>Como cada valor foi calculado</summary>
            <ul className="small" style={{ paddingLeft: 20, margin: 0 }}>
              {costs.materialLines.map((l, i) => <li key={i}><b>{l.label}:</b> {fmtNum(l.qtyOrder)} {l.unit} × {l.unitCost ? `${fmtBRL(perGramToPerKg(l.unitCost))}/kg` : '—'} ({l.source || 'sem preço'}) = {l.cost ? fmtBRL(l.cost) : '—'}</li>)}
              {costs.components.map((c) => <li key={c.key}><b>{c.label}:</b> {c.formula}</li>)}
            </ul>
          </details>
        </div>
      </div>
    </>
  );
}

function RubricaRow({ c, override, onChange, disabled }: { c: CostComponent; override?: string; onChange: (v: string | null) => void; disabled: boolean }) {
  return (
    <tr title={c.formula}>
      <td><div>{c.label}</div><Badge tone={STATUS_BADGE[c.status].tone}>{STATUS_BADGE[c.status].label}</Badge></td>
      <td className="num muted">{c.calculated ? fmtBRL(c.calculated) : 'pendente'}</td>
      <td className="num">{isLockedComponent(c.key)
        ? <span title="O preço do filamento vem do cadastro e não pode ser alterado no orçamento"><b>{c.value ? fmtBRL(c.value) : '—'}</b><div className="small muted">do cadastro</div></span>
        : <InlineDec prefix="R$" ariaLabel={`Valor usado para ${c.label}`} value={override ?? null} onChange={onChange}
          placeholder={c.calculated ? c.calculated.toFixed(2).replace('.', ',') : 'informe'} disabled={disabled} />}</td>
    </tr>
  );
}

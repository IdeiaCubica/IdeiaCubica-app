/**
 * Estoque de peças produzidas (pronta-entrega): balões de resumo e um cartão
 * horizontal por lote de peças com filamento gasto, tempo, custo e preço previsto.
 */
import { useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { FinishedGood } from '../../domain/types';
import { daysInStock, deleteFinishedGood, finishedGoodBalance, isUntouchedFinishedGood, quoteFromFinishedGood, registerFinishedGood, updateFinishedGood, writeOffFinishedGood } from '../../domain/production';
import { fmtDuration } from '../../domain/conversions';
import { fmtDate, todayISO } from '../../domain/core';
import { D, ZERO, fmtBRL, fmtNum, toInputBR } from '../../domain/money';
import { Badge, Check, Combobox, DateField, Empty, Field, Kpi, Modal, NumField, SelectField, TextArea, TextField, dec, num, useConfirm, useForm, type Tone } from '../components/ui';
import { SaleForm } from './Financeiro';
import { ImagePicker } from '../components/ImagePicker';

export function finishedStockSummary(db: ReturnType<typeof useStore>['db']) {
  const rows = db.finishedGoods.map((g) => ({ g, b: finishedGoodBalance(db, g.id) })).filter((r) => r.b.available > 0);
  const pieces = rows.reduce((s, r) => s + r.b.available, 0);
  const invested = rows.reduce((s, r) => s.plus(r.g.unitCost ? D(r.g.unitCost).times(r.b.available) : ZERO), ZERO);
  const potential = rows.reduce((s, r) => s.plus(r.g.suggestedPrice ? D(r.g.suggestedPrice).times(r.b.available) : ZERO), ZERO);
  const noPrice = rows.filter((r) => !r.g.suggestedPrice).length;
  return { rows, pieces, invested, potential, noPrice, items: rows.length };
}

const ageTone = (d: number): Tone => (d > 90 ? 'error' : d > 60 ? 'warning' : d > 30 ? 'info' : 'success');

export function PecasProntas() {
  const { db, run } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [onlyBalance, setOnlyBalance] = useState(true);
  const [q, setQ] = useState('');
  const [selling, setSelling] = useState<FinishedGood | null>(null);
  const [quoting, setQuoting] = useState<FinishedGood | null>(null);
  const [adding, setAdding] = useState(false);
  const today = todayISO();
  const sum = finishedStockSummary(db);
  const rows = db.finishedGoods.map((g) => ({ g, b: finishedGoodBalance(db, g.id), days: daysInStock(g, today) }))
    .filter((r) => !onlyBalance || r.b.available > 0 || r.b.allocated > 0)
    .filter((r) => !q.trim() || `${r.g.code} ${r.g.description} ${r.g.location ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.days - a.days);
  const writeOff = async (g: FinishedGood) => {
    const reason = await confirm({ title: `Dar baixa em 1 peça de ${g.code}?`, danger: true, confirmLabel: 'Dar baixa', reasonLabel: 'Motivo (avaria, brinde, uso próprio…)', text: 'Use para peças que saíram sem venda. Para várias peças, repita.' });
    if (reason) run((d) => writeOffFinishedGood(d, g.id, 1, reason), 'Baixa registrada.');
  };
  const [editing, setEditing] = useState<FinishedGood | null>(null);
  const remove = async (g: FinishedGood) => {
    const reason = await confirm({ title: `Excluir ${g.code} · ${g.description}?`, danger: true, confirmLabel: 'Excluir', reasonLabel: 'Motivo',
      text: 'Use para lançamentos feitos por engano. As peças saem do estoque (fica registrado na auditoria). O material consumido na produção não volta.' });
    if (reason) run((d) => deleteFinishedGood(d, g.id, reason), 'Peças excluídas do estoque.');
  };
  const margin = sum.potential.gt(0) ? sum.potential.minus(sum.invested).div(sum.potential) : null;
  return (
    <>
      <div className="kpis" style={{ marginBottom: 18 }}>
        <Kpi label="Peças em estoque" value={sum.pieces} hint={`${sum.items} item(ns) produzidos para venda`} accent />
        <Kpi label="Valor investido" value={fmtBRL(sum.invested)} hint="Custo de fabricação das peças disponíveis" />
        <Kpi label="Potencial de venda" value={fmtBRL(sum.potential)} hint={sum.noPrice ? `${sum.noPrice} item(ns) sem preço previsto` : margin ? `margem prevista ${fmtNum(margin.times(100), 1)}%` : 'pelo preço previsto'} />
      </div>
      <div className="card">
        <div className="card-head"><div><h2>Peças produzidas para estoque</h2><p className="muted small">Entram aqui ao concluir uma produção para estoque. Quando alguém pedir o valor, use “Orçar para cliente”; a peça só sai do estoque no “Pedido aprovado”.</p></div>
          <div className="row"><button className="btn secondary" onClick={() => setAdding(true)}>Cadastrar peças já existentes</button><button className="btn primary" onClick={() => navigate('producao/estoque')}>Nova produção para estoque</button></div></div>
        <div className="card-body stack">
          <div className="row">
            <input type="search" className="search-lg" placeholder="Buscar peça, código ou local…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar peças" />
            <Check label="Somente com saldo" checked={onlyBalance} onChange={setOnlyBalance} />
          </div>
          {rows.length === 0 ? <Empty title="Nenhuma peça produzida em estoque" text="Crie uma produção para estoque em Produção e conclua: as peças aprovadas aparecem aqui com custo e preço previsto." /> : (
            <div className="fg-list">
              {rows.map(({ g, b, days }) => {
                const order = g.orderId ? db.orders.find((o) => o.id === g.orderId) : undefined;
                const per = g.production && g.production.qtyMade > 0 ? g.production.qtyMade : null;
                const unitProfit = g.unitCost && g.suggestedPrice ? D(g.suggestedPrice).minus(g.unitCost) : null;
                return (
                  <article key={g.id} className="fg-card">
                    <div className="fg-img">{g.image ? <img src={g.image} alt="" /> : <img className="ph" src="/brand/10_icone_simbolo_transparente.svg" alt="" />}</div>
                    <div className="fg-main">
                      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                        <span className="mono muted small">{g.code}{order ? ` · ${order.number}` : ' · cadastro manual'}</span>
                        <Badge tone={ageTone(days)}>parada há {days} dia{days === 1 ? '' : 's'}</Badge>
                      </div>
                      <h3>{g.description}</h3>
                      <p className="small muted">Produzida em {fmtDate(g.producedAt)}{g.location ? ` · ${g.location}` : ''}</p>
                      <dl className="fg-facts">
                        <div><dt>Filamento gasto</dt><dd>{g.production?.materials.length ? g.production.materials.map((m) => `${fmtNum(per ? m.qty / per : m.qty, 1)} ${m.unit}`).join(' + ') + (per ? ' por peça' : '') : '—'}
                          {g.production?.materials.length ? <small>{g.production.materials.map((m) => m.label).join(', ')}</small> : null}</dd></div>
                        <div><dt>Tempo de impressão</dt><dd>{g.production ? `${fmtDuration(per ? g.production.hours / per : g.production.hours)}${per ? ' por peça' : ''}` : '—'}{g.production && <small>{fmtDuration(g.production.hours)} no lote de {g.production.qtyMade}</small>}</dd></div>
                        <div><dt>Custo por peça</dt><dd>{g.unitCost ? fmtBRL(g.unitCost) : <Badge tone="warning">pendente</Badge>}<small>{g.costStatus}</small></dd></div>
                        <div><dt>Valor previsto de venda</dt><dd className="fg-price">{g.suggestedPrice ? fmtBRL(g.suggestedPrice) : '—'}{unitProfit && <small>lucro {fmtBRL(unitProfit)} por peça</small>}</dd></div>
                      </dl>
                    </div>
                    <div className="fg-side">
                      <div className="fg-qty"><b>{b.available}</b><span>{b.available === 1 ? 'disponível' : 'disponíveis'}</span></div>
                      <small className="muted">de {b.produced} · {b.sold} vendida(s){b.allocated ? ` · ${b.allocated} separada(s)` : ''}{b.adjusted ? ` · ${b.adjusted} baixa(s)` : ''}</small>
                      {b.available > 0 && <>
                        <button className="btn primary sm" onClick={() => setQuoting(g)}>Orçar para cliente</button>
                        <button className="btn secondary sm" onClick={() => setSelling(g)}>Vender direto</button>
                        <button className="btn ghost sm" onClick={() => writeOff(g)}>Dar baixa</button>
                      </>}
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn ghost sm" onClick={() => setEditing(g)}>Editar</button>
                        {isUntouchedFinishedGood(db, g.id) && <button className="btn ghost sm danger-text" onClick={() => remove(g)}>Excluir</button>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {selling && <SaleForm preset={{ finishedGoodId: selling.id }} onClose={() => setSelling(null)} />}
      {quoting && <QuoteFromStock fg={quoting} onClose={() => setQuoting(null)} />}
      {adding && <FinishedGoodForm onClose={() => setAdding(false)} />}
      {editing && <FinishedGoodForm fg={editing} onClose={() => setEditing(null)} />}
      {confirmEl}
    </>
  );
}

function QuoteFromStock({ fg, onClose }: { fg: FinishedGood; onClose: () => void }) {
  const { db, run } = useStore();
  const b = finishedGoodBalance(db, fg.id);
  const [f, set] = useForm({ customerId: '', qty: '1', price: fg.suggestedPrice ? fg.suggestedPrice.replace('.', ',') : '' });
  const submit = () => run((d) => quoteFromFinishedGood(d, fg.id, { customerId: f.customerId || undefined, qty: num(f.qty) ?? 0, unitPrice: dec(f.price) }), 'Orçamento criado a partir da peça do estoque.')
    .then((r) => { if (r.ok) { onClose(); navigate(`orcamentos/${r.value.id}`); } });
  return (
    <Modal title={`Orçar ${fg.description}`} subtitle={`${fg.code} · ${b.available} disponível(is)`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Criar orçamento</button></>}>
      <div className="stack">
        <Field label="Cliente">
          <Combobox ariaLabel="Cliente" value={f.customerId} onChange={set('customerId')} placeholder="— digite o nome do cliente —"
            options={db.parties.filter((p) => p.kind === 'cliente').map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        <div className="grid g2">
          <NumField label="Quantidade" required value={f.qty} onChange={set('qty')} />
          <NumField label="Valor por peça" suffix="R$" value={f.price} onChange={set('price')} hint="Vem do valor previsto de venda" />
        </div>
        <p className="small muted">A peça continua no estoque. No orçamento, ao marcar “Pedido aprovado”, as peças são separadas para o cliente e aparecem em Produção → Pedidos.</p>
      </div>
    </Modal>
  );
}

function FinishedGoodForm({ onClose, fg }: { onClose: () => void; fg?: FinishedGood }) {
  const { db, run } = useStore();
  const editing = !!fg;
  // Quantidade, custo e data: só em peças cadastradas à mão e ainda não movimentadas.
  const coreEditable = !fg || (!fg.orderId && isUntouchedFinishedGood(db, fg.id));
  const [f, set] = useForm({
    description: fg?.description ?? '', projectId: fg?.projectId ?? '', qty: fg ? String(fg.qtyProduced) : '1',
    unitCost: fg?.unitCost ? toInputBR(fg.unitCost, 4) : '', suggestedPrice: fg?.suggestedPrice ? toInputBR(fg.suggestedPrice) : '',
    producedAt: fg?.producedAt ?? todayISO(), location: fg?.location ?? '', notes: fg?.notes ?? '',
  });
  const [image, setImage] = useState<string | null>(fg?.image ?? null);
  const submit = () => run((d) => (editing
    ? updateFinishedGood(d, fg!.id, { description: f.description, location: f.location, suggestedPrice: dec(f.suggestedPrice), notes: f.notes, image,
      ...(coreEditable ? { qty: num(f.qty) ?? 0, unitCost: dec(f.unitCost), producedAt: f.producedAt } : {}) })
    : registerFinishedGood(d, {
      description: f.description, projectId: f.projectId || undefined, qty: num(f.qty) ?? 0, unitCost: dec(f.unitCost), suggestedPrice: dec(f.suggestedPrice),
      producedAt: f.producedAt, location: f.location, notes: f.notes, image,
    })), editing ? 'Peças atualizadas.' : 'Peças cadastradas no estoque.').then((r) => r.ok && onClose());
  return (
    <Modal title={editing ? `Editar ${fg!.code}` : 'Cadastrar peças prontas já existentes'} subtitle={editing ? (coreEditable ? 'Cadastro manual ainda não movimentado: tudo pode ser corrigido.' : 'Quantidade, custo e data vêm da produção ou já tiveram movimento; o restante pode ser alterado.') : 'Para peças produzidas antes de usar o sistema. Não movimenta o estoque de materiais.'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>{editing ? 'Salvar' : 'Cadastrar'}</button></>}>
      <div className="grid g2">
        <TextField label="Peça / descrição" required value={f.description} onChange={set('description')} />
        {!editing && <SelectField label="Projeto" value={f.projectId} onChange={set('projectId')} placeholder="— nenhum —" options={db.projects.map((p) => ({ value: p.id, label: p.name }))} />}
        <NumField label="Quantidade" required value={f.qty} onChange={set('qty')} disabled={!coreEditable} />
        <DateField label="Data de produção" required value={f.producedAt} onChange={coreEditable ? set('producedAt') : () => undefined} />
        <NumField label="Custo unitário de fabricação (por peça)" suffix="R$" value={f.unitCost} onChange={set('unitCost')} disabled={!coreEditable} hint="Custo de UMA peça. Vazio = margem pendente na venda." />
        <NumField label="Valor previsto de venda" suffix="R$" value={f.suggestedPrice} onChange={set('suggestedPrice')} />
        <TextField label="Local de armazenamento" value={f.location} onChange={set('location')} placeholder="Ex.: prateleira A" />
      </div>
      <div style={{ marginTop: 12 }}><ImagePicker value={image} onChange={setImage} hint="Aparece no estoque de peças e no orçamento feito a partir desta peça." /></div>
      <div style={{ marginTop: 12 }}><TextArea label="Observações" value={f.notes} onChange={set('notes')} /></div>
    </Modal>
  );
}

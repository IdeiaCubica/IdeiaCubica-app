import { useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { Overhead, Printer, RoundingRule, SalesChannel } from '../../domain/types';
import { addMaintenance, depreciationPerHour, overheadRate, saveChannel, saveOverhead, savePrinter, type PrinterInput } from '../../domain/catalog';
import { printerStats } from '../../domain/production';
import { channelRates, ROUNDING_LABEL } from '../../domain/pricing';
import { BusinessError, fmtDate, todayISO } from '../../domain/core';
import { D, fmtBRL, fmtNum, fmtPct, toInputBR } from '../../domain/money';
import { Alert, Badge, Check, DataTable, DateField, DecField, Empty, Kpi, Modal, NumField, PageHead, SelectField, Tabs, TextArea, TextField, dec, num, useForm } from '../components/ui';
import { NamedListManager } from './Cadastros';
import { wattsToKwhPerHour } from '../../domain/conversions';
import { generalRecommendations, printerRecommendations, type RecSource, type Recommendation } from '../../domain/recommendations';
import { isValidCep } from '../../domain/address';
import { AddressFields } from '../components/AddressFields';
import type { AddressParts } from '../../domain/types';

type Tab = 'gerais' | 'impressoras' | 'canais' | 'indiretas' | 'fontes';

export function Parametros({ param }: { param?: string }) {
  const { db } = useStore();
  const tab = (param as Tab) || 'gerais';
  return (
    <>
      <PageHead eyebrow="Parâmetros de Custos" title="Parâmetros de Custos" text="Valores padrão usados em todos os orçamentos. Cada orçamento já nasce com eles e você pode alterá-los caso a caso." />
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`parametros/${t}`)} tabs={[
        { id: 'gerais', label: 'Parâmetros gerais' }, { id: 'impressoras', label: 'Impressoras', count: db.printers.length },
        { id: 'canais', label: 'Canais de venda', count: db.channels.length }, { id: 'indiretas', label: 'Despesas indiretas', count: db.overheads.length },
        { id: 'fontes', label: 'Fontes de captação', count: db.leadSources.length },
      ]} />
      {tab === 'gerais' && <Gerais />}
      {tab === 'impressoras' && <Impressoras />}
      {tab === 'canais' && <Canais />}
      {tab === 'indiretas' && <Indiretas />}
      {tab === 'fontes' && <NamedListManager list="leadSources" title="Fontes de captação de clientes" singular="fonte" usedIn="clientes" />}
    </>
  );
}

/* ---------------- Parâmetros gerais ---------------- */
function Gerais() {
  const { db, run, toast } = useStore();
  const s = db.settings;
  const [f, set, setF] = useForm({
    companyName: s.companyName, energyTariff: toInputBR(s.energyTariff), laborHourCost: toInputBR(s.laborHourCost),
    productiveHoursPerMonth: toInputBR(s.productiveHoursPerMonth), defaultMarkupPct: toInputBR(s.defaultMarkupPct ?? null), defaultRounding: s.defaultRounding,
    defaultPrinterId: s.defaultPrinterId ?? '', defaultChannelId: s.defaultChannelId ?? '', defaultFailureRatePct: toInputBR(s.defaultFailureRatePct ?? null),
    defaultLaborOrderMin: toInputBR(s.defaultLaborOrderMin ?? null), defaultLaborUnitMin: toInputBR(s.defaultLaborUnitMin ?? null),
    boxLength: toInputBR(s.shippingBox?.lengthCm ?? null), boxWidth: toInputBR(s.shippingBox?.widthCm ?? null), boxHeight: toInputBR(s.shippingBox?.heightCm ?? null),
    boxWeight: toInputBR(s.shippingBox?.packagingWeightG ?? null),
  });
  const [origin, setOrigin] = useState<AddressParts>(s.companyAddress ?? {});
  const oh = overheadRate(db);
  /** Preenche só os campos vazios do formulário com as sugestões (o usuário ainda precisa salvar). */
  const fillEmpty = () => {
    const next = { ...f } as Record<string, string>;
    let n = 0;
    for (const r of generalRecommendations()) {
      if (r.key === 'defaultRounding') { if (f.defaultRounding === 'nenhum') { next.defaultRounding = r.value; n++; } continue; }
      if (r.key in next && !next[r.key]?.trim()) { next[r.key] = r.value.replace('.', ','); n++; }
    }
    setF(next as typeof f);
    toast(n ? 'info' : 'warning', n ? `${n} campo(s) preenchido(s) com as sugestões. Revise e clique em "Salvar parâmetros".` : 'Nenhum campo vazio para preencher.');
  };
  const createA1 = () => run((d) => {
    const rec = Object.fromEntries(printerRecommendations().map((r) => [r.key, r.value]));
    const p = savePrinter(d, { name: 'Bambu Lab A1', manufacturer: 'Bambu Lab', model: 'A1', acquisitionValue: rec.acquisitionValue, residualValue: rec.residualValue,
      usefulLifeHours: Number(rec.usefulLifeHours), initialHours: 0, energyMode: 'estimado', kwhPerHour: rec.kwhPerHour, maintenancePerHour: rec.maintenancePerHour,
      availableHoursPerMonth: Number(rec.availableHoursPerMonth), active: true, notes: 'Cadastrada com os valores sugeridos; calibre energia e manutenção com dados reais.' });
    if (!d.settings.defaultPrinterId) d.settings.defaultPrinterId = p.id;
    return p;
  }, 'Bambu Lab A1 cadastrada com os valores sugeridos.').then((r) => { if (r.ok && !f.defaultPrinterId) set('defaultPrinterId')(r.value.id); });
  const hasA1 = db.printers.some((p) => /a1/i.test(p.model) && !/mini/i.test(p.model));
  const save = () => run((d) => {
    const h = num(f.productiveHoursPerMonth);
    if (h !== null && h <= 0) throw new BusinessError('Horas produtivas devem ser maiores que zero.');
    const m = dec(f.defaultMarkupPct);
    if (m !== null && D(m).lt(0)) throw new BusinessError('O markup não pode ser negativo.');
    const fr = dec(f.defaultFailureRatePct);
    if (fr !== null && (D(fr).lt(0) || D(fr).gte(90))) throw new BusinessError('Taxa de falha deve estar entre 0 e 90%.');
    const lo = num(f.defaultLaborOrderMin), lu = num(f.defaultLaborUnitMin);
    if ((lo ?? 0) < 0 || (lu ?? 0) < 0) throw new BusinessError('Tempos de mão de obra não podem ser negativos.');
    const box = { lengthCm: num(f.boxLength), widthCm: num(f.boxWidth), heightCm: num(f.boxHeight), packagingWeightG: num(f.boxWeight) };
    if (Object.values(box).some((v) => v !== null && v <= 0)) throw new BusinessError('Medidas e peso da embalagem devem ser maiores que zero.');
    if (origin.cep && !isValidCep(origin.cep)) throw new BusinessError('CEP de origem deve ter 8 dígitos.');
    d.settings = { ...d.settings, companyName: f.companyName.trim() || 'Ideia Cúbica', energyTariff: dec(f.energyTariff), laborHourCost: dec(f.laborHourCost),
      productiveHoursPerMonth: h, defaultMarkupPct: m, defaultRounding: f.defaultRounding as RoundingRule,
      defaultPrinterId: f.defaultPrinterId || null, defaultChannelId: f.defaultChannelId || null, defaultFailureRatePct: fr,
      defaultLaborOrderMin: lo, defaultLaborUnitMin: lu, companyAddress: origin, shippingBox: box };
  }, 'Parâmetros salvos. Novos orçamentos usarão estes valores; os já salvos mantêm os da época.');
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><div><h2>Custos de produção</h2><p className="muted small">Base do cálculo de energia, mão de obra e rateio das despesas fixas.</p></div></div>
        <div className="card-body grid g3">
          <NumField label="Tarifa de energia" suffix="R$/kWh" value={f.energyTariff} onChange={set('energyTariff')}
            hint="Valor da conta ÷ kWh consumidos (com tributos e bandeira)." />
          <NumField label="Custo da hora de trabalho" suffix="R$/h" value={f.laborHourCost} onChange={set('laborHourCost')}
            hint="Quanto vale 1 hora de trabalho humano. Não é o tempo de impressão." />
          <NumField label="Horas produtivas de máquina por mês" suffix="h" value={f.productiveHoursPerMonth} onChange={set('productiveHoursPerMonth')}
            hint={<>Base do rateio das despesas indiretas. Taxa atual: <b>{oh.rate ? `${fmtBRL(oh.rate, 4)}/h` : '—'}</b> ({fmtBRL(oh.monthly)}/mês em despesas).</>} />
        </div>
      </div>
      <div className="card">
        <div className="card-head"><div><h2>Padrões de cada novo orçamento</h2><p className="muted small">Preenchidos automaticamente; podem ser alterados dentro do orçamento.</p></div></div>
        <div className="card-body grid g3">
          <SelectField label="Impressora padrão" value={f.defaultPrinterId} onChange={set('defaultPrinterId')} placeholder="— nenhuma —" options={db.printers.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))}
            hint={db.printers.length === 0 ? <a href="#/parametros/impressoras">Cadastre a impressora</a> : 'Define depreciação, energia e manutenção.'} />
          <SelectField label="Canal de venda padrão" value={f.defaultChannelId} onChange={set('defaultChannelId')} placeholder="— nenhum —" options={db.channels.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))}
            hint={db.channels.length === 0 ? <a href="#/parametros/canais">Cadastre um canal</a> : 'Define tributos e taxas sobre o preço.'} />
          <NumField label="Markup" suffix="%" value={f.defaultMarkupPct} onChange={set('defaultMarkupPct')}
            hint={<>Lucro desejado sobre o custo. Ex.: custo R$ 50 com 100% → lucro de R$ 50. Os encargos do canal são somados por fora. A margem sobre a venda aparece no orçamento.</>} />
          <NumField label="Taxa de falha esperada" suffix="%" value={f.defaultFailureRatePct} onChange={set('defaultFailureRatePct')} hint="Reimpressões esperadas. Use 0 se não houver." />
          <NumField label="Mão de obra por orçamento" suffix="min" value={f.defaultLaborOrderMin} onChange={set('defaultLaborOrderMin')} hint="Preparar arquivo, fatiar, atender o cliente." />
          <NumField label="Mão de obra por peça" suffix="min" value={f.defaultLaborUnitMin} onChange={set('defaultLaborUnitMin')} hint="Retirar, remover suportes, acabar, embalar." />
          <SelectField label="Arredondamento do preço" value={f.defaultRounding} onChange={(v) => set('defaultRounding')(v as RoundingRule)}
            options={Object.entries(ROUNDING_LABEL).map(([value, label]) => ({ value, label }))} hint="Sempre para cima." />
          <TextField label="Nome da empresa" value={f.companyName} onChange={set('companyName')} />
        </div>
      </div>

      <div className="card rec-card">
        <div className="card-head">
          <div><h2>Recomendação para começar</h2><p className="muted small">Pontos de partida para a operação com a Bambu Lab A1 (R$ 4.769,10). Ajuste com os seus dados reais — o sistema não aplica nada sozinho.</p></div>
          <div className="row">
            <button className="btn secondary" onClick={fillEmpty}>Preencher campos vazios</button>
            {!hasA1 && <button className="btn primary" onClick={createA1}>Cadastrar a A1 com estes valores</button>}
          </div>
        </div>
        <div className="card-body stack">
          <RecTable title="Parâmetros gerais e padrões do orçamento" rows={generalRecommendations()} />
          <RecTable title="Impressora Bambu Lab A1 (cadastro em Impressoras)" rows={printerRecommendations()} />
          <Alert tone="info" title="Como ler">
            <b>informado</b> = dado seu · <b>fabricante</b> = publicação da Bambu Lab · <b>estimativa</b> = ponto de partida para calibrar.
            Exemplo com esses valores: uma peça de 40 g de PLA a R$ 100/kg e 2 h de impressão custa cerca de R$ 4,00 de filamento + R$ 0,18 de energia + R$ 1,27 de depreciação + R$ 0,40 de manutenção, mais mão de obra e rateio.
          </Alert>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><h2>Envios (frete)</h2><p className="muted small">Origem e embalagem padrão usadas para calcular o frete no orçamento.</p></div></div>
        <div className="card-body stack">
          <AddressFields value={origin} onChange={setOrigin} title="Endereço de origem dos envios" />
          <p className="section-title">Embalagem padrão</p>
          <div className="grid g4">
            <NumField label="Comprimento" suffix="cm" value={f.boxLength} onChange={set('boxLength')} />
            <NumField label="Largura" suffix="cm" value={f.boxWidth} onChange={set('boxWidth')} />
            <NumField label="Altura" suffix="cm" value={f.boxHeight} onChange={set('boxHeight')} />
            <NumField label="Peso da embalagem" suffix="g" value={f.boxWeight} onChange={set('boxWeight')} hint="Caixa + proteção; somado ao peso das peças." />
          </div>
        </div>
      </div>

      <Alert tone="info" title="Tributos">Alíquotas não são presumidas: configure-as por canal de venda conforme o regime da empresa e valide com seu contador.</Alert>
      <div className="row"><button className="btn primary" onClick={save}>Salvar parâmetros</button></div>
    </div>
  );
}

const SOURCE_TONE: Record<RecSource, 'success' | 'info' | 'warning'> = { informado: 'success', fabricante: 'info', estimativa: 'warning' };
function RecTable({ title, rows }: { title: string; rows: Recommendation[] }) {
  return (
    <div>
      <p className="section-title">{title}</p>
      <div className="card"><table className="tbl">
        <thead><tr><th>Parâmetro</th><th className="num">Sugestão</th><th>Origem</th><th>Por quê</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key}>
            <td><b>{r.label}</b></td>
            <td className="num nowrap"><b>{r.key === 'defaultRounding' ? ROUNDING_LABEL.final90 : `${r.unit === 'R$' ? 'R$ ' : ''}${fmtNum(r.value, 4)}${r.unit && r.unit !== 'R$' ? ` ${r.unit}` : ''}`}</b></td>
            <td><Badge tone={SOURCE_TONE[r.source]}>{r.source}</Badge></td>
            <td className="small">{r.why}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

/* ---------------- Canais ---------------- */
function Canais() {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<SalesChannel | 'novo' | null>(null);
  return (
    <div className="card">
      <div className="card-head"><div><h2>Canais de venda</h2><p className="muted small">Cada canal tem encargos próprios sobre a receita (venda direta, marketplace, loja virtual…).</p></div>
        <button className="btn primary" onClick={() => setEdit('novo')}>Novo canal</button></div>
      <DataTable rows={db.channels} rowKey={(c) => c.id} onRowClick={setEdit}
        empty={<Empty title="Nenhum canal cadastrado" text="Os orçamentos precisam de um canal para calcular tributos, comissões e taxas." action={<button className="btn primary" onClick={() => setEdit('novo')}>Cadastrar canal</button>} />}
        columns={[
          { key: 'n', header: 'Canal', render: (c) => <><b>{c.name}</b> {!c.active && <Badge>inativo</Badge>}</>, sort: (c) => c.name },
          { key: 't', header: 'Tributos', num: true, render: (c) => fmtPct(D(c.taxPct).div(100), 2) },
          { key: 'c', header: 'Comissão', num: true, render: (c) => fmtPct(D(c.commissionPct).div(100), 2) },
          { key: 'p', header: 'Taxa pagamento', num: true, render: (c) => fmtPct(D(c.paymentFeePct).div(100), 2) },
          { key: 'o', header: 'Outros', num: true, render: (c) => fmtPct(D(c.otherPct).div(100), 2) },
          { key: 'f', header: 'Taxa fixa/pedido', num: true, render: (c) => fmtBRL(c.fixedFeePerOrder) },
          { key: 'r', header: 'Total %', num: true, render: (c) => <b>{fmtPct(channelRates(c)!.rates, 2)}</b> },
        ]} />
      {edit && <ChannelForm channel={edit === 'novo' ? undefined : edit} onClose={() => setEdit(null)} onSave={(v, id) => run((d) => saveChannel(d, v, id), 'Canal salvo.').then((r) => r.ok && setEdit(null))} />}
    </div>
  );
}

function ChannelForm({ channel, onClose, onSave }: { channel?: SalesChannel; onClose: () => void; onSave: (v: Omit<SalesChannel, 'id'>, id?: string) => void }) {
  const [f, set] = useForm({
    name: channel?.name ?? '', taxPct: toInputBR(channel?.taxPct), commissionPct: toInputBR(channel?.commissionPct),
    paymentFeePct: toInputBR(channel?.paymentFeePct), otherPct: toInputBR(channel?.otherPct), fixedFeePerOrder: toInputBR(channel?.fixedFeePerOrder), active: channel?.active ?? true,
  });
  const { toast } = useStore();
  const submit = () => {
    const fields = [f.taxPct, f.commissionPct, f.paymentFeePct, f.otherPct, f.fixedFeePerOrder];
    if (fields.some((x) => x.trim() === '')) { toast('error', 'Preencha todos os encargos. Use 0 quando o encargo realmente não existir neste canal.'); return; }
    onSave({ name: f.name, taxPct: dec(f.taxPct) ?? '', commissionPct: dec(f.commissionPct) ?? '', paymentFeePct: dec(f.paymentFeePct) ?? '',
      otherPct: dec(f.otherPct) ?? '', fixedFeePerOrder: dec(f.fixedFeePerOrder) ?? '', active: f.active }, channel?.id);
  };
  return (
    <Modal title={channel ? 'Editar canal' : 'Novo canal de venda'} subtitle="Informe 0 apenas quando o encargo realmente não existir." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></>}>
      <div className="grid g2">
        <TextField label="Nome do canal" required value={f.name} onChange={set('name')} placeholder="Ex.: Venda direta, Shopee, Mercado Livre" />
        <NumField label="Tributos sobre a venda" suffix="%" required value={f.taxPct} onChange={set('taxPct')} hint="Conforme regime tributário — valide com o contador." />
        <NumField label="Comissão do marketplace/vendedor" suffix="%" required value={f.commissionPct} onChange={set('commissionPct')} />
        <NumField label="Taxa de pagamento/antecipação" suffix="%" required value={f.paymentFeePct} onChange={set('paymentFeePct')} />
        <NumField label="Outros encargos variáveis" suffix="%" required value={f.otherPct} onChange={set('otherPct')} />
        <NumField label="Taxa fixa por pedido" suffix="R$" required value={f.fixedFeePerOrder} onChange={set('fixedFeePerOrder')} />
      </div>
      <div style={{ marginTop: 12 }}><Check label="Canal ativo" checked={f.active} onChange={set('active')} /></div>
    </Modal>
  );
}

/* ---------------- Despesas indiretas ---------------- */
function Indiretas() {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<Overhead | 'novo' | null>(null);
  const oh = overheadRate(db);
  return (
    <div className="stack">
      <Alert tone="info" title="Como o rateio funciona">
        Despesas marcadas "entra no custo" são somadas e divididas pelas horas produtivas de máquina por mês ({db.settings.productiveHoursPerMonth ?? 'não configurado'} h).
        Cada orçamento recebe: horas de máquina × taxa. Despesas não marcadas são apenas acompanhadas no Financeiro.
        <div style={{ marginTop: 6 }}><b>Taxa atual: {oh.rate ? `${fmtBRL(oh.rate, 4)} por hora de máquina` : 'não calculável'}</b> <span>({oh.basis})</span></div>
      </Alert>
      <div className="card">
        <div className="card-head"><h2>Despesas indiretas mensais previstas</h2><button className="btn primary" onClick={() => setEdit('novo')}>Nova despesa</button></div>
        <DataTable rows={db.overheads} rowKey={(o) => o.id} onRowClick={setEdit}
          empty={<Empty title="Nenhuma despesa indireta cadastrada" text="Ex.: internet, software, assinatura do fatiador, aluguel, contabilidade. Se a operação não tiver despesas indiretas, deixe vazio — o orçamento mostrará rateio de R$ 0,00." action={<button className="btn primary" onClick={() => setEdit('novo')}>Cadastrar despesa</button>} />}
          columns={[
            { key: 'n', header: 'Despesa', render: (o) => o.name, sort: (o) => o.name },
            { key: 'v', header: 'Valor mensal', num: true, render: (o) => fmtBRL(o.monthlyAmount), sort: (o) => D(o.monthlyAmount).toNumber() },
            { key: 'i', header: 'No custo?', render: (o) => o.includeInCost ? <Badge tone="success">entra no custo</Badge> : <Badge>só acompanhamento</Badge> },
          ]}
          footer={db.overheads.length ? <tr><td>Total no custo</td><td className="num">{fmtBRL(oh.monthly)}</td><td /></tr> : undefined} />
      </div>
      {edit && <OverheadForm item={edit === 'novo' ? undefined : edit} onClose={() => setEdit(null)} onSave={(v, id) => run((d) => saveOverhead(d, v, id), 'Despesa salva.').then((r) => r.ok && setEdit(null))} />}
    </div>
  );
}

function OverheadForm({ item, onClose, onSave }: { item?: Overhead; onClose: () => void; onSave: (v: Omit<Overhead, 'id'>, id?: string) => void }) {
  const [f, set] = useForm({ name: item?.name ?? '', monthlyAmount: toInputBR(item?.monthlyAmount), includeInCost: item?.includeInCost ?? true, notes: item?.notes ?? '' });
  return (
    <Modal title={item ? 'Editar despesa' : 'Nova despesa indireta'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave({ name: f.name, monthlyAmount: dec(f.monthlyAmount) ?? '', includeInCost: f.includeInCost, notes: f.notes }, item?.id)}>Salvar</button></>}>
      <div className="stack">
        <TextField label="Descrição" required value={f.name} onChange={set('name')} placeholder="Ex.: Internet" />
        <NumField label="Valor mensal" suffix="R$" required value={f.monthlyAmount} onChange={set('monthlyAmount')} />
        <Check label="Ratear no custo das peças (por hora de máquina)" checked={f.includeInCost} onChange={set('includeInCost')} />
        <TextField label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Impressoras                                                         */
/* ================================================================== */
function Impressoras() {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<Printer | 'nova' | null>(null);
  const [view, setView] = useState<Printer | null>(null);
  return (
    <div className="card">
      <div className="card-head"><div><h2>Impressoras</h2><p className="muted small">Parâmetros de depreciação, energia e manutenção usados nos orçamentos.</p></div><button className="btn primary" onClick={() => setEdit('nova')}>Nova impressora</button></div>
      <DataTable rows={db.printers} rowKey={(p) => p.id} onRowClick={setView}
        empty={<Empty title="Nenhuma impressora cadastrada" text="Ex.: Bambu Lab A1 (perfil encontrado nos seus arquivos 3MF). Informe valor de compra, vida útil e consumo de energia medido." action={<button className="btn primary" onClick={() => setEdit('nova')}>Cadastrar impressora</button>} />}
        columns={[
          { key: 'n', header: 'Impressora', render: (p) => <><b>{p.name}</b><div className="muted small">{p.manufacturer} {p.model}</div></> },
          { key: 'd', header: 'Depreciação/h', num: true, render: (p) => { const d = depreciationPerHour(p); return d ? fmtBRL(d, 4) : <Badge tone="error">incompleto</Badge>; } },
          { key: 'e', header: 'Energia', num: true, render: (p) => p.kwhPerHour ? <>{fmtNum(p.kwhPerHour, 3)} kWh/h <Badge tone={p.energyMode === 'medido' ? 'success' : 'warning'}>{p.energyMode}</Badge></> : <Badge tone="error">não informado</Badge> },
          { key: 'm', header: 'Manutenção/h', num: true, render: (p) => p.maintenancePerHour ? fmtBRL(p.maintenancePerHour, 4) : <Badge tone="error">não informado</Badge> },
          { key: 'h', header: 'Horas totais', num: true, render: (p) => fmtNum(printerStats(db, p.id).totalHours, 1) },
          { key: 's', header: 'Taxa de sucesso', num: true, render: (p) => fmtPct(printerStats(db, p.id).successRate) },
        ]} />
      {edit && <PrinterForm item={edit === 'nova' ? undefined : edit} onClose={() => setEdit(null)} onSave={(v, id) => run((d) => savePrinter(d, v, id), 'Impressora salva.').then((r) => r.ok && setEdit(null))} />}
      {view && <PrinterDetail printer={view} onClose={() => setView(null)} onEdit={() => { setEdit(view); setView(null); }} />}
    </div>
  );
}

function PrinterForm({ item, onClose, onSave }: { item?: Printer; onClose: () => void; onSave: (v: PrinterInput, id?: string) => void }) {
  const [f, set] = useForm({ name: item?.name ?? '', manufacturer: item?.manufacturer ?? '', model: item?.model ?? '', acquisitionValue: item?.acquisitionValue ?? null, residualValue: item?.residualValue ?? null,
    usefulLifeHours: item?.usefulLifeHours ?? null, initialHours: item?.initialHours ?? 0, energyMode: item?.energyMode ?? 'medido', kwhPerHour: item?.kwhPerHour ?? null,
    avgW: '', maintenancePerHour: item?.maintenancePerHour ?? null, availableHoursPerMonth: item?.availableHoursPerMonth ?? null, active: item?.active ?? true, notes: item?.notes ?? '' });
  const dep = depreciationPerHour({ acquisitionValue: f.acquisitionValue, residualValue: f.residualValue, usefulLifeHours: f.usefulLifeHours });
  const n = (v: string | null) => (v === null ? null : Number(v));
  return (
    <Modal wide title={item ? 'Editar impressora' : 'Nova impressora'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => { const { avgW: _a, ...rest } = f; onSave({ ...rest, energyMode: f.energyMode as Printer['energyMode'] }, item?.id); }}>Salvar</button></>}>
      <div className="stack">
        <div className="grid g3">
          <TextField label="Nome / apelido" required value={f.name} onChange={set('name')} placeholder="Ex.: A1 #1" />
          <TextField label="Fabricante" value={f.manufacturer} onChange={set('manufacturer')} placeholder="Bambu Lab" />
          <TextField label="Modelo" value={f.model} onChange={set('model')} placeholder="A1" />
        </div>
        <p className="section-title">Depreciação</p>
        <div className="grid g4">
          <DecField label="Valor de aquisição" suffix="R$" value={f.acquisitionValue} onChange={set('acquisitionValue')} />
          <DecField label="Valor residual estimado" suffix="R$" value={f.residualValue} onChange={set('residualValue')} hint="Valor de revenda ao fim da vida útil" />
          <DecField label="Vida útil (horas produtivas)" suffix="h" value={f.usefulLifeHours} onChange={(v) => set('usefulLifeHours')(n(v))} />
          <DecField label="Horas já utilizadas" suffix="h" value={f.initialHours} onChange={(v) => set('initialHours')(n(v) ?? 0)} />
        </div>
        <p className="small muted">Depreciação por hora = (aquisição − residual) ÷ vida útil = <b>{dep ? fmtBRL(dep, 4) : 'preencha os campos'}</b>. A compra da impressora deve ser lançada no Financeiro como <b>investimento</b>, nunca como custo de uma peça.</p>
        <p className="section-title">Energia</p>
        <div className="grid g4">
          <SelectField label="Origem do consumo" value={f.energyMode} onChange={(v) => set('energyMode')(v as Printer['energyMode'])} options={[{ value: 'medido', label: 'Medido (tomada medidora)' }, { value: 'estimado', label: 'Estimado (potência média)' }]} />
          {f.energyMode === 'estimado' && <NumField label="Potência média real" suffix="W" value={f.avgW} onChange={(v) => { set('avgW')(v); const w = num(v); if (w !== null) set('kwhPerHour')(wattsToKwhPerHour(w).toString()); }} hint="Não use a potência máxima da fonte" />}
          <DecField label="Consumo médio" suffix="kWh/h" value={f.kwhPerHour} onChange={set('kwhPerHour')} hint={f.energyMode === 'medido' ? 'kWh medidos ÷ horas de impressão' : 'Calculado da potência média'} />
        </div>
        <p className="section-title">Manutenção e capacidade</p>
        <div className="grid g3">
          <DecField label="Manutenção e desgaste por hora" suffix="R$/h" value={f.maintenancePerHour} onChange={set('maintenancePerHour')} hint="Ex.: (bicos + mesa + correias por ano) ÷ horas por ano. Calibre com o histórico." />
          <DecField label="Horas disponíveis por mês" suffix="h" value={f.availableHoursPerMonth} onChange={(v) => set('availableHoursPerMonth')(n(v))} hint="Base da taxa de utilização" />
        </div>
        <TextArea label="Observações" value={f.notes} onChange={set('notes')} />
        <Check label="Impressora ativa" checked={f.active} onChange={set('active')} />
      </div>
    </Modal>
  );
}

function PrinterDetail({ printer, onClose, onEdit }: { printer: Printer; onClose: () => void; onEdit: () => void }) {
  const { db, run } = useStore();
  const p = db.printers.find((x) => x.id === printer.id)!;
  const s = printerStats(db, p.id);
  const [m, set] = useForm({ date: todayISO(), kind: 'preventiva', description: '', cost: '', downtime: '' });
  const enough = s.orders >= 3;
  return (
    <Modal wide title={p.name} subtitle={`${p.manufacturer} ${p.model}`} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Fechar</button><button className="btn primary" onClick={onEdit}>Editar parâmetros</button></>}>
      <div className="stack">
        <div className="kpis">
          <Kpi label="Horas de operação" value={`${fmtNum(s.totalHours, 1)} h`} hint={`${fmtNum(s.systemHours, 1)} h registradas no sistema`} />
          <Kpi label="Utilização no mês" value={s.utilization ? fmtPct(s.utilization) : '—'} hint={s.availableMonth ? `${fmtNum(s.monthHours, 1)} de ${s.availableMonth} h` : 'Informe horas disponíveis'} />
          <Kpi label="Taxa de sucesso" value={fmtPct(s.successRate)} hint={`${s.orders} OP(s)${!enough ? ' — amostra pequena' : ''}`} />
          <Kpi label="Material consumido" value={`${fmtNum(s.material)} g`} />
          <Kpi label="Vida útil consumida" value={s.lifeUsed ? fmtPct(s.lifeUsed) : '—'} />
          <Kpi label="Manutenção registrada" value={fmtBRL(s.maintenanceCost)} hint={`${fmtNum(s.downtime)} h paradas`} />
        </div>
        <p className="small muted">Utilização não é rentabilidade: uma máquina pode trabalhar muitas horas produzindo itens com margem insuficiente. Veja a rentabilidade em Financeiro → Resultado por produto.</p>
        <h3>Manutenções, falhas e reparos</h3>
        {p.maintenance.length > 0 && <div className="card"><table className="tbl"><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th className="num">Custo</th><th className="num">Parada</th></tr></thead><tbody>
          {[...p.maintenance].reverse().map((x) => <tr key={x.id}><td>{fmtDate(x.date)}</td><td>{x.kind}</td><td>{x.description}</td><td className="num">{fmtBRL(x.cost)}</td><td className="num">{fmtNum(x.downtimeHours)} h</td></tr>)}</tbody></table></div>}
        <div className="grid g4" style={{ alignItems: 'end' }}>
          <DateField label="Data" value={m.date} onChange={set('date')} />
          <SelectField label="Tipo" value={m.kind} onChange={set('kind')} options={[{ value: 'preventiva', label: 'Preventiva' }, { value: 'corretiva', label: 'Corretiva' }, { value: 'falha', label: 'Falha' }]} />
          <TextField label="Descrição" value={m.description} onChange={set('description')} placeholder="Troca de bico" />
          <NumField label="Custo" suffix="R$" value={m.cost} onChange={set('cost')} />
          <NumField label="Horas parada" suffix="h" value={m.downtime} onChange={set('downtime')} />
          <button className="btn secondary" onClick={() => run((d) => addMaintenance(d, p.id, { date: m.date, kind: m.kind as 'preventiva', description: m.description, cost: dec(m.cost) ?? '0', downtimeHours: num(m.downtime) }), 'Registro adicionado.')}>Registrar</button>
        </div>
        <p className="small muted">Para que o custo da peça de reposição entre no financeiro, lance a compra em Financeiro (categoria Manutenção de equipamentos) ou como compra de insumo, conforme o caso.</p>
      </div>
    </Modal>
  );
}


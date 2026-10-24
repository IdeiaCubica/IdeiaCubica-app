import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { Account, FinCategory, FinNature } from '../../domain/types';
import { saveAccount } from '../../domain/catalog';
import { accountBalance } from '../../domain/finance';
import { migrate } from '../../domain/schema';
import { readLocalBrowserData, type Snapshot } from '../../data/repository';
import { BusinessError, fmtDate, fmtDateTime, newId, todayISO } from '../../domain/core';
import { fmtBRL, fmtNum, toInputBR } from '../../domain/money';
import { Alert, Badge, Check, DataTable, DateField, Empty, Modal, NumField, PageHead, SelectField, Tabs, TextField, dec, useConfirm, useForm } from '../components/ui';

type Tab = 'contas' | 'categorias' | 'backup';

export function Configuracoes({ param }: { param?: string }) {
  const tab = (param as Tab) || 'contas';
  return (
    <>
      <PageHead eyebrow="Configurações" title="Configurações" text="Contas financeiras, categorias do financeiro, backup e trilha de auditoria." />
      <Tabs<Tab> value={tab} onChange={(t) => navigate(`config/${t}`)} tabs={[
        { id: 'contas', label: 'Contas financeiras' },
        { id: 'categorias', label: 'Categorias financeiras' }, { id: 'backup', label: 'Backup e auditoria' },
      ]} />
      {tab === 'contas' && <Contas />}
      {tab === 'categorias' && <Categorias />}
      {tab === 'backup' && <Backup />}
    </>
  );
}

/* ---------------- Contas ---------------- */
function Contas() {
  const { db, run } = useStore();
  const [edit, setEdit] = useState<Account | 'nova' | null>(null);
  return (
    <div className="card">
      <div className="card-head"><div><h2>Contas financeiras</h2><p className="muted small">Caixa, bancos e carteiras digitais. O saldo é calculado pelas movimentações.</p></div>
        <button className="btn primary" onClick={() => setEdit('nova')}>Nova conta</button></div>
      <DataTable rows={db.accounts} rowKey={(a) => a.id} onRowClick={setEdit}
        empty={<Empty title="Nenhuma conta cadastrada" text="Cadastre ao menos uma conta (ex.: conta bancária da empresa) para registrar pagamentos e recebimentos." action={<button className="btn primary" onClick={() => setEdit('nova')}>Cadastrar conta</button>} />}
        columns={[
          { key: 'n', header: 'Conta', render: (a) => <><b>{a.name}</b> {!a.active && <Badge>inativa</Badge>}</> },
          { key: 'k', header: 'Tipo', render: (a) => ({ caixa: 'Caixa', banco: 'Banco', carteira_digital: 'Carteira digital' })[a.kind] },
          { key: 'o', header: 'Saldo inicial', num: true, render: (a) => `${fmtBRL(a.openingBalance)} em ${fmtDate(a.openingDate)}` },
          { key: 'b', header: 'Saldo atual', num: true, render: (a) => <b>{fmtBRL(accountBalance(db, a.id))}</b> },
        ]} />
      {edit && <AccountForm item={edit === 'nova' ? undefined : edit} onClose={() => setEdit(null)} onSave={(v, id) => run((d) => saveAccount(d, v, id), 'Conta salva.').then((r) => r.ok && setEdit(null))} />}
    </div>
  );
}

function AccountForm({ item, onClose, onSave }: { item?: Account; onClose: () => void; onSave: (v: Omit<Account, 'id'>, id?: string) => void }) {
  const [f, set] = useForm({ name: item?.name ?? '', kind: item?.kind ?? 'banco', openingBalance: toInputBR(item?.openingBalance), openingDate: item?.openingDate ?? todayISO(), active: item?.active ?? true });
  const { toast } = useStore();
  const submit = () => {
    if (f.openingBalance.trim() === '') { toast('error', 'Informe o saldo inicial (use 0 se a conta começa zerada).'); return; }
    onSave({ name: f.name, kind: f.kind as Account['kind'], openingBalance: dec(f.openingBalance) ?? '0', openingDate: f.openingDate, active: f.active }, item?.id);
  };
  return (
    <Modal title={item ? 'Editar conta' : 'Nova conta financeira'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></>}>
      <div className="grid g2">
        <TextField label="Nome" required value={f.name} onChange={set('name')} placeholder="Ex.: Banco PJ" />
        <SelectField label="Tipo" value={f.kind} onChange={(v) => set('kind')(v as Account['kind'])} options={[{ value: 'banco', label: 'Banco' }, { value: 'caixa', label: 'Caixa (dinheiro)' }, { value: 'carteira_digital', label: 'Carteira digital' }]} />
        <NumField label="Saldo inicial" suffix="R$" required value={f.openingBalance} onChange={set('openingBalance')} />
        <DateField label="Data do saldo inicial" value={f.openingDate} onChange={set('openingDate')} />
      </div>
      <div style={{ marginTop: 12 }}><Check label="Conta ativa" checked={f.active} onChange={set('active')} /></div>
    </Modal>
  );
}

/* ---------------- Categorias financeiras ---------------- */
export const NATURE_LABEL: Record<FinNature, string> = {
  receita_venda: 'Receita de vendas', receita_outra: 'Outra receita', custo_variavel: 'Custo variável', despesa_fixa: 'Despesa fixa/estrutura',
  estoque: 'Estoque (ativo)', investimento: 'Investimento em ativo', aporte: 'Aporte de capital', retirada: 'Retirada dos sócios', outros: 'Outros',
};

function Categorias() {
  const { db, run } = useStore();
  const [f, set, setF] = useForm({ name: '', direction: 'out', nature: 'despesa_fixa' });
  const [edit, setEdit] = useState<FinCategory | null>(null);
  const add = () => run((d) => {
    const name = f.name.trim();
    if (!name) throw new BusinessError('Informe o nome da categoria.');
    if (d.finCategories.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new BusinessError('Categoria já existe.');
    d.finCategories.push({ id: newId(), name, direction: f.direction as 'in' | 'out', nature: f.nature as FinNature });
  }, 'Categoria criada.').then((r) => r.ok && setF({ ...f, name: '' }));
  return (
    <div className="stack">
      <div className="card"><div className="card-body">
        <div className="grid g4" style={{ alignItems: 'end' }}>
          <TextField label="Nova categoria" value={f.name} onChange={set('name')} placeholder="Ex.: Marketing" />
          <SelectField label="Direção" value={f.direction} onChange={set('direction')} options={[{ value: 'out', label: 'Saída' }, { value: 'in', label: 'Entrada' }]} />
          <SelectField label="Natureza (efeito no resultado)" value={f.nature} onChange={set('nature')} options={Object.entries(NATURE_LABEL).map(([value, label]) => ({ value, label }))} />
          <button className="btn primary" onClick={add}>Adicionar</button>
        </div>
      </div></div>
      <div className="card">
        <DataTable<FinCategory> rows={db.finCategories} rowKey={(c) => c.id} empty={null} onRowClick={(c) => !c.system && setEdit(c)}
          columns={[
            { key: 'n', header: 'Categoria', render: (c) => <>{c.name} {c.system && <Badge tone="info" title="Usada pelas integrações automáticas">sistema</Badge>}</>, sort: (c) => c.name },
            { key: 'd', header: 'Direção', render: (c) => c.direction === 'in' ? 'Entrada' : 'Saída' },
            { key: 'na', header: 'Natureza', render: (c) => NATURE_LABEL[c.nature] },
            { key: 'a', header: '', render: (c) => c.system ? <span className="muted small">protegida</span> : <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setEdit(c); }}>Editar</button> },
          ]} />
      </div>
      {edit && <CategoryEditModal category={edit} onClose={() => setEdit(null)} />}
      <Alert tone="info">A natureza define o tratamento gerencial: compras de insumos são <b>estoque</b> (viram custo quando consumidas/vendidas) e impressoras são <b>investimento</b> — nenhuma delas entra integralmente no custo de uma peça.</Alert>
    </div>
  );
}

function CategoryEditModal({ category, onClose }: { category: FinCategory; onClose: () => void }) {
  const { db, run } = useStore();
  const used = db.titles.some((t) => t.categoryId === category.id);
  const [f, set] = useForm({ name: category.name, direction: category.direction as string, nature: category.nature as string });
  const save = () => run((d) => {
    const c = d.finCategories.find((x) => x.id === category.id);
    if (!c || c.system) throw new BusinessError('Categorias do sistema não podem ser alteradas.');
    const name = f.name.trim();
    if (!name) throw new BusinessError('Informe o nome da categoria.');
    if (d.finCategories.some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) throw new BusinessError('Já existe uma categoria com esse nome.');
    if (used && f.direction !== c.direction) throw new BusinessError('A categoria já tem lançamentos; a direção (entrada/saída) não pode mudar.');
    Object.assign(c, { name, direction: f.direction as 'in' | 'out', nature: f.nature as FinNature });
  }, 'Categoria atualizada.').then((r) => r.ok && onClose());
  return (
    <Modal title={`Editar categoria "${category.name}"`} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Salvar</button></>}>
      <div className="stack">
        <TextField label="Nome" required value={f.name} onChange={set('name')} />
        <SelectField label="Direção" value={f.direction} onChange={set('direction')} options={[{ value: 'out', label: 'Saída' }, { value: 'in', label: 'Entrada' }]} hint={used ? 'Já tem lançamentos: a direção fica fixa.' : undefined} />
        <SelectField label="Natureza (efeito no resultado)" value={f.nature} onChange={set('nature')} options={Object.entries(NATURE_LABEL).map(([value, label]) => ({ value, label }))} />
      </div>
    </Modal>
  );
}

/* ---------------- Histórico de versões (Supabase) ---------------- */
function Snapshots() {
  const { repo, replaceAll, toast } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const [rows, setRows] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => repo.listSnapshots!().then(setRows).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const restore = async (s: Snapshot) => {
    const ok = await confirm({ title: `Restaurar a versão ${s.version}?`, danger: true, confirmLabel: 'Restaurar esta versão',
      text: <>Os dados voltarão a ser como estavam em <b>{fmtDateTime(s.savedAt)}</b>. A situação atual não é perdida: ela continua no histórico e pode ser restaurada depois.</> });
    if (ok === null) return;
    try { await replaceAll(await repo.loadSnapshot!(s.id)); toast('success', `Versão ${s.version} restaurada.`); load(); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Falha ao restaurar.'); }
  };
  return (
    <div className="card">
      <div className="card-head"><div><h2>Histórico de versões dos dados</h2><p className="muted small">Cada gravação gera uma cópia no banco. São mantidas as 100 mais recentes.</p></div>
        <button className="btn ghost sm" onClick={load}>Atualizar</button></div>
      {error ? <div className="card-body"><Alert tone="error">{error}</Alert></div> : !rows ? <div className="card-body muted">Carregando…</div> : (
        <DataTable rows={rows} rowKey={(s) => String(s.id)} empty={<Empty title="Nenhuma versão gravada ainda" />}
          columns={[
            { key: 'v', header: 'Versão', render: (s) => <b>v{s.version}</b> },
            { key: 'd', header: 'Gravada em', render: (s) => fmtDateTime(s.savedAt) },
            { key: 'b', header: 'Tamanho', num: true, render: (s) => `${fmtNum(s.bytes / 1024, 0)} KB` },
            { key: 'a', header: '', render: (s) => <button className="btn ghost sm" onClick={() => restore(s)}>Restaurar</button> },
          ]} />
      )}
      {confirmEl}
    </div>
  );
}

/* ---------------- Backup ---------------- */
function Backup() {
  const { db, replaceAll, toast, repo } = useStore();
  const [confirm, confirmEl] = useConfirm();
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ideia-cubica-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('success', 'Backup exportado.');
  };
  const importJson = async (file: File) => {
    try {
      const next = migrate(JSON.parse(await file.text()));
      const ok = await confirm({ title: 'Restaurar backup?', danger: true, confirmLabel: 'Substituir todos os dados',
        text: <>Todos os dados atuais serão substituídos pelo conteúdo de <b>{file.name}</b> ({next.materials.length} materiais, {next.quotes.length} orçamentos, {next.titles.length} títulos). Exporte um backup atual antes, se necessário.</> });
      if (ok === null) return;
      await replaceAll(next);
      toast('success', 'Backup restaurado.');
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Arquivo inválido.'); }
  };
  const local = repo.kind === 'supabase' ? readLocalBrowserData() : null;
  const importLocal = async () => {
    if (!local) return;
    const ok = await confirm({ title: 'Importar dados deste navegador para a nuvem?', danger: true, confirmLabel: 'Importar e substituir',
      text: <>Os dados da nuvem serão substituídos pelos que estavam salvos neste navegador ({local.materials.length} materiais, {local.quotes.length} orçamentos, {local.parties.length} cadastros). A versão atual da nuvem continua no histórico e pode ser restaurada.</> });
    if (ok === null) return;
    try { await replaceAll(local); toast('success', 'Dados do navegador importados para a nuvem.'); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Falha ao importar.'); }
  };
  return (
    <div className="stack">
      <Alert tone={repo.kind === 'supabase' ? 'info' : 'warning'} title="Onde seus dados estão">
        {repo.description}{repo.kind === 'local' && ' Limpar os dados do navegador apaga as informações.'}
      </Alert>
      <div className="card"><div className="card-body row">
        <button className="btn primary" onClick={exportJson}>Exportar backup (.json)</button>
        <label className="btn secondary">Restaurar backup…<input type="file" accept="application/json,.json" hidden onChange={(e) => { const fl = e.target.files?.[0]; if (fl) importJson(fl); e.target.value = ''; }} /></label>
        {local && <button className="btn secondary" onClick={importLocal}>Importar dados deste navegador</button>}
      </div></div>
      {repo.listSnapshots && <Snapshots />}
      <div className="card">
        <div className="card-head"><h2>Trilha de auditoria</h2><span className="muted small">Últimas 300 operações</span></div>
        <DataTable rows={[...db.audit].reverse().slice(0, 300).map((a, i) => ({ ...a, i }))} rowKey={(a) => String(a.i)} search={(a) => `${a.action} ${a.detail ?? ''}`}
          empty={<Empty title="Nenhuma operação registrada ainda" />}
          columns={[
            { key: 'at', header: 'Quando', render: (a) => <span className="nowrap">{fmtDateTime(a.at)}</span> },
            { key: 'ac', header: 'Operação', render: (a) => <b>{a.action}</b> },
            { key: 'd', header: 'Detalhe', render: (a) => a.detail },
          ]} />
      </div>
      {confirmEl}
    </div>
  );
}

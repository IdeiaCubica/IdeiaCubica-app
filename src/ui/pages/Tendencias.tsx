import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../App';
import type { TrendIdea, TrendReport } from '../../domain/types';
import { estimateIdea, saveTrendReport } from '../../domain/trends';
import { fmtDate, fmtDateTime, todayISO } from '../../domain/core';
import { fmtBRL, fmtNum, fmtPct } from '../../domain/money';
import { fmtDuration } from '../../domain/conversions';
import { fetchTrends } from '../../io/api';
import { usesSupabase } from '../../data/supabase';
import { Alert, Badge, Combobox, Empty, Field, Kpi, PageHead, type Tone } from '../components/ui';

const DIFFICULTY: Record<NonNullable<TrendIdea['difficulty']>, { label: string; tone: Tone }> = {
  baixa: { label: 'fácil', tone: 'success' }, media: { label: 'média', tone: 'warning' }, alta: { label: 'difícil', tone: 'error' },
};

/** Evita duas pesquisas simultâneas (StrictMode, abas). */
let inFlight: Promise<unknown> | null = null;

export function Tendencias() {
  const { db, run, toast } = useStore();
  const today = todayISO();
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filaments = db.materials.filter((m) => m.active && m.filament);
  const [materialId, setMaterialId] = useState(filaments[0]?.id ?? '');
  const report: TrendReport | undefined = db.trends.find((r) => r.id === selectedId) ?? db.trends[0];
  const hasToday = db.trends.some((r) => r.date === today);
  const autoTried = useRef(false);

  const generate = async () => {
    if (inFlight) return;
    setLoading(true); setError(null);
    const avoid = db.trends.slice(0, 5).flatMap((r) => r.ideas.map((i) => i.title)).slice(0, 30);
    inFlight = fetchTrends({ today, avoid });
    try {
      const data = (await inFlight) as Awaited<ReturnType<typeof fetchTrends>>;
      const r = await run((d) => saveTrendReport(d, data), 'Tendências do dia atualizadas.');
      if (r.ok) setSelectedId(r.value.id);
      if (data.notice) toast('info', data.notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao pesquisar tendências.');
    } finally {
      inFlight = null;
      setLoading(false);
    }
  };

  // Uma pesquisa por dia: ao abrir a tela pela primeira vez no dia.
  useEffect(() => {
    if (autoTried.current || hasToday || !usesSupabase) return;
    autoTried.current = true;
    void generate();
  }, [hasToday]);

  const estimates = report?.ideas.map((idea) => ({ idea, est: estimateIdea(db, idea, materialId || undefined) })) ?? [];
  const ranked = [...estimates].sort((a, b) => (b.est.profitPerHour?.toNumber() ?? -Infinity) - (a.est.profitPerHour?.toNumber() ?? -Infinity));
  const best = ranked.find((r) => r.est.profitPerHour);

  return (
    <>
      <PageHead eyebrow="Mercado" title="Tendências de produção"
        text="Ideias de peças em alta, pesquisadas na internet uma vez por dia, com custo e lucro estimados pelos seus parâmetros."
        actions={<button className="btn primary" onClick={generate} disabled={loading || !usesSupabase}>{loading ? 'Pesquisando… (1 a 3 min)' : hasToday ? 'Pesquisar novamente' : 'Pesquisar agora'}</button>} />

      {!usesSupabase && <Alert tone="info" title="Disponível na versão publicada">A pesquisa roda no servidor (Vercel) e exige login. Neste modo local, só os relatórios já salvos aparecem.</Alert>}
      {loading && <Alert tone="info" title="Pesquisando tendências">O assistente está buscando anúncios e listas de mais vendidos. Isso leva de 1 a 3 minutos; pode continuar usando o sistema.</Alert>}
      {error && <Alert tone="warning" title="Não foi possível pesquisar">{error}</Alert>}

      {!report ? (
        <div className="card"><Empty title="Nenhuma pesquisa ainda" text="A primeira pesquisa do dia é feita automaticamente ao abrir esta tela (versão publicada), ou clique em “Pesquisar agora”." /></div>
      ) : (
        <div className="stack">
          <div className="grid g3" style={{ alignItems: 'end' }}>
            <Field label="Relatório">
              <Combobox ariaLabel="Relatório" value={report.id} onChange={(v) => v && setSelectedId(v)}
                options={db.trends.map((r) => ({ value: r.id, label: `${fmtDate(r.date)} · ${r.ideas.length} ideias` }))} />
            </Field>
            <Field label="Filamento usado na estimativa" hint="O custo usa o preço deste filamento e seus parâmetros de custos.">
              <Combobox ariaLabel="Filamento" value={materialId} onChange={(v) => setMaterialId(v)} placeholder="— cadastre um filamento —"
                options={filaments.map((m) => ({ value: m.id, label: `${m.name} — ${m.filament!.materialType} ${m.filament!.color}` }))} />
            </Field>
            <div className="small muted">Gerado em {fmtDateTime(report.generatedAt)}{report.model ? ` · ${report.model}` : ''}</div>
          </div>

          <div className="card"><div className="card-body">
            <p style={{ margin: 0 }}>{report.summary}</p>
            {report.notice && <p className="small muted" style={{ marginBottom: 0 }}>{report.notice}</p>}
          </div></div>

          <div className="kpis">
            <Kpi label="Ideias pesquisadas" value={report.ideas.length} />
            <Kpi label="Melhor lucro por hora de máquina" value={best?.est.profitPerHour ? fmtBRL(best.est.profitPerHour) : '—'} hint={best ? best.idea.title : 'precisa de peso, tempo e preço'} accent />
            <Kpi label="Com preço de mercado encontrado" value={estimates.filter((e) => e.est.marketUnit).length} />
          </div>

          <div className="trend-grid">
            {ranked.map(({ idea, est }, i) => (
              <article key={i} className="card trend-card">
                <div className="card-body stack" style={{ gap: 10 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                    <div><h3 style={{ margin: 0 }}>{idea.title}</h3><div className="small muted">{idea.category}{idea.audience ? ` · ${idea.audience}` : ''}</div></div>
                    {idea.difficulty && <Badge tone={DIFFICULTY[idea.difficulty].tone}>{DIFFICULTY[idea.difficulty].label}</Badge>}
                  </div>
                  <p className="small" style={{ margin: 0 }}>{idea.why}</p>
                  <dl className="dl small">
                    <dt>Preço no mercado</dt><dd className="right">{idea.priceMin || idea.priceMax ? `${idea.priceMin ? fmtBRL(idea.priceMin) : '?'} a ${idea.priceMax ? fmtBRL(idea.priceMax) : '?'}` : <span className="muted">não encontrado</span>}</dd>
                    <dt>Peso / tempo (estimados)</dt><dd className="right">{idea.estWeightG ? `${fmtNum(idea.estWeightG)} g` : '?'} · {idea.estPrintHours ? fmtDuration(idea.estPrintHours) : '?'}</dd>
                    <dt>Material</dt><dd className="right">{idea.material || '—'}</dd>
                    <dt>Seu custo por peça</dt><dd className="right">{est.unitCost ? <b>{fmtBRL(est.unitCost)}</b> : <span className="muted">falta {est.pending.join(', ')}</span>}</dd>
                    <dt>Preço pelo seu markup</dt><dd className="right">{est.recommendedUnit ? fmtBRL(est.recommendedUnit) : '—'}</dd>
                    <dt>Lucro ao preço médio de mercado</dt><dd className="right">{est.market ? <span className={est.market.result.isNegative() ? 'err-text' : 'ok-text'}><b>{fmtBRL(est.market.result)}</b>{est.market.markupPct ? ` · markup ${fmtPct(est.market.markupPct)}` : ''}</span> : '—'}</dd>
                    <dt>Lucro por hora de máquina</dt><dd className="right">{est.profitPerHour ? <b>{fmtBRL(est.profitPerHour)}/h</b> : '—'}</dd>
                  </dl>
                  {!est.complete && est.unitCost && <p className="small muted" style={{ margin: 0 }}>Custo parcial: {est.pending.join(' ')}</p>}
                  {idea.licenseNote && <p className="small" style={{ margin: 0 }}><b>Licença:</b> {idea.licenseNote}</p>}
                  {idea.sources.length > 0 && (
                    <div className="small"><b>Fontes:</b> {idea.sources.map((s, k) => <span key={k}>{k > 0 && ' · '}<a href={s.url} target="_blank" rel="noreferrer noopener">{s.title.length > 50 ? `${s.title.slice(0, 50)}…` : s.title}</a></span>)}</div>
                  )}
                  <div><button className="btn secondary sm" onClick={() => navigate('orcamentos/novo')}>Orçar esta peça</button></div>
                </div>
              </article>
            ))}
          </div>
          <p className="small muted">
            Peso, tempo e preços de mercado vêm da pesquisa e são <b>estimativas</b>: confirme fatiando o modelo antes de produzir.
            Custos e lucros são calculados com os seus Parâmetros de Custos, o filamento escolhido acima e o primeiro canal de venda ativo.
            Ordenado pelo lucro por hora de máquina. Confira sempre a licença comercial do modelo.
          </p>
        </div>
      )}
    </>
  );
}

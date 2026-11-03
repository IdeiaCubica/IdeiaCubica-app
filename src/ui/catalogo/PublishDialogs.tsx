/** Publicar o catálogo (validade, mesmo link ou link novo) e compartilhar (copiar, WhatsApp, QR Code). */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useStore } from '../store';
import type { CatalogRecord } from '../../domain/catalogo';
import { activeLink, catalogStatus, publishProblems } from '../../domain/catalogo';
import { fmtDateTime } from '../../domain/core';
import { catalogRepository } from '../../data/catalogRepo';
import { Alert, Kpi, Modal } from '../components/ui';
import { publicUrl } from '../pages/Catalogo';

/** "2026-12-24T18:00" (hora local) → ISO; vazio → null. */
const localToISO = (v: string) => (v ? new Date(v).toISOString() : null);
const isoToLocal = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function PublishDialog({ rec, onClose, onDone }: { rec: CatalogRecord | null; onClose: () => void; onDone: (rec: CatalogRecord) => void }) {
  const { toast } = useStore();
  const st = rec ? catalogStatus(rec) : 'rascunho';
  const current = rec ? activeLink(rec) ?? rec.links[0] : null;
  const [mode, setMode] = useState<'sem' | 'data'>(current?.expiresAt ? 'data' : 'sem');
  const [until, setUntil] = useState(isoToLocal(current?.expiresAt));
  const [linkMode, setLinkMode] = useState<'mesmo' | 'novo'>('mesmo');
  const [busy, setBusy] = useState(false);
  if (!rec) return null;
  const problems = publishProblems(rec);
  const expiresAt = mode === 'data' ? localToISO(until) : null;
  const pastDate = mode === 'data' && (!until || new Date(until) <= new Date());
  const publish = async () => {
    setBusy(true);
    try {
      const repo = catalogRepository();
      // Expirado e "mesmo link": reativa o endereço antigo com o conteúdo atual.
      if (st === 'expirado' && linkMode === 'mesmo' && current) {
        await repo.reactivate(rec.id, expiresAt);
        await repo.publish(rec, { expiresAt, newLink: false });
      } else {
        await repo.publish(rec, { expiresAt, newLink: linkMode === 'novo' || !current });
      }
      const fresh = await repo.get(rec.id);
      toast('success', st === 'publicado' ? 'Publicação atualizada.' : 'Catálogo publicado!');
      onDone(fresh ?? rec);
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Modal title={st === 'publicado' ? `Atualizar publicação — ${rec.name}` : `Publicar — ${rec.name}`}
      subtitle="O cliente vê uma cópia do catálogo como está agora. Custos, margens e dados dos orçamentos nunca são publicados." onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || problems.length > 0 || pastDate} onClick={publish}>{busy ? 'Publicando…' : st === 'publicado' ? 'Atualizar publicação' : 'Publicar catálogo'}</button></>}>
      <div className="stack">
        {problems.length > 0 && <Alert tone="warning" title="Antes de publicar"><ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert>}
        <fieldset className="cat-radio">
          <legend>Validade do link</legend>
          <label><input type="radio" name="validade" checked={mode === 'sem'} onChange={() => setMode('sem')} /> Sem expiração automática <span className="muted small">(você expira quando quiser)</span></label>
          <label><input type="radio" name="validade" checked={mode === 'data'} onChange={() => setMode('data')} /> Expira em data e horário</label>
          {mode === 'data' && <input type="datetime-local" className="month-input" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Data e hora de expiração" />}
          {pastDate && until && <span className="err-text small">Escolha uma data e hora no futuro.</span>}
        </fieldset>
        {current && (
          <fieldset className="cat-radio">
            <legend>Endereço</legend>
            <label><input type="radio" name="link" checked={linkMode === 'mesmo'} onChange={() => setLinkMode('mesmo')} /> {st === 'expirado' ? 'Reativar o mesmo link' : 'Manter o mesmo link'} <span className="muted small mono">…/c/{current.slug}</span></label>
            <label><input type="radio" name="link" checked={linkMode === 'novo'} onChange={() => setLinkMode('novo')} /> Gerar um link novo <span className="muted small">(o anterior para de funcionar e fica no histórico)</span></label>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}

export function ShareDialog({ rec, onClose, onChanged }: { rec: CatalogRecord; onClose: () => void; onChanged: () => void }) {
  const { toast } = useStore();
  const [links, setLinks] = useState(rec.links);
  const [stats, setStats] = useState(rec.stats);
  const [qr, setQr] = useState<string | null>(null);
  const link = links.find((l) => l.active) ?? null;
  const url = link ? publicUrl(link.slug) : '';
  useEffect(() => {
    catalogRepository().list().then((l) => { const r = l.find((x) => x.id === rec.id); if (r) { setLinks(r.links); setStats(r.stats); } }).catch(() => undefined);
  }, [rec.id]);
  useEffect(() => {
    if (!url) { setQr(null); return; }
    QRCode.toDataURL(url, { width: 360, margin: 2, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(null));
  }, [url]);
  const expired = link?.expiresAt && new Date(link.expiresAt) <= new Date();
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('success', 'Link copiado.'); } catch { toast('warning', 'Não foi possível copiar. Selecione o link e copie.'); } };
  const share = async () => {
    if (navigator.share) { try { await navigator.share({ title: rec.name, url }); } catch { /* cancelado */ } } else copy();
  };
  const expire = async () => {
    try { await catalogRepository().expire(rec.id); toast('success', 'Link expirado.'); onChanged(); onClose(); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Modal wide title={`Compartilhar — ${rec.name}`} subtitle="Só quem tem o link consegue abrir. O cliente não precisa instalar nada nem fazer cadastro." onClose={onClose}
      footer={<>{link && <button className="btn ghost danger-text" onClick={expire}>Expirar link agora</button>}<button className="btn primary" onClick={onClose}>Fechar</button></>}>
      {!link ? <Alert tone="warning" title="Sem link ativo">Este catálogo não está publicado agora. Use “Publicar” para gerar ou reativar o link.</Alert> : (
        <div className="grid g2">
          <div className="stack">
            {expired && <Alert tone="warning">A validade deste link já passou: os clientes veem a página de catálogo indisponível.</Alert>}
            <div className="field"><label>Link do catálogo</label><input readOnly value={url} onFocus={(e) => e.target.select()} className="mono" /></div>
            <div className="row">
              <button className="btn primary" onClick={copy}>Copiar link</button>
              <button className="btn secondary" onClick={share}>Compartilhar</button>
              <a className="btn secondary" href={`https://wa.me/?text=${encodeURIComponent(`${rec.name}: ${url}`)}`} target="_blank" rel="noreferrer noopener">WhatsApp</a>
              <a className="btn ghost" href={url} target="_blank" rel="noreferrer noopener">Ver catálogo publicado ↗</a>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Publicado em {fmtDateTime(link.publishedAt)} · {link.expiresAt ? `expira em ${fmtDateTime(link.expiresAt)}` : 'sem expiração automática'}.</p>
            <div className="kpis">
              <Kpi label="Visitas" value={stats?.visits ?? 0} hint={stats?.lastVisit ? `última ${fmtDateTime(stats.lastVisit)}` : 'nenhuma ainda'} />
              <Kpi label="Produtos abertos" value={stats?.productViews ?? 0} />
              <Kpi label="Cliques em contato" value={stats?.contacts ?? 0} />
              <Kpi label="Compartilhamentos" value={stats?.shares ?? 0} />
            </div>
            {links.length > 1 && <details><summary className="small">Links anteriores ({links.length - 1})</summary>
              <ul className="small muted">{links.filter((l) => !l.active).map((l) => <li key={l.slug} className="mono">…/c/{l.slug} · publicado {fmtDateTime(l.publishedAt)}{l.revokedAt ? ` · desativado ${fmtDateTime(l.revokedAt)}` : ''}</li>)}</ul>
            </details>}
          </div>
          <div className="stack" style={{ alignItems: 'center' }}>
            {qr ? <img src={qr} alt={`QR Code do catálogo ${rec.name}`} className="cat-qr" /> : <span className="muted">Gerando QR Code…</span>}
            {qr && <a className="btn secondary" href={qr} download={`catalogo-${link.slug}.png`}>Baixar QR Code</a>}
            <p className="small muted" style={{ textAlign: 'center' }}>Imprima ou coloque no Instagram: o cliente aponta a câmera e abre o catálogo.</p>
          </div>
        </div>
      )}
    </Modal>
  );
}

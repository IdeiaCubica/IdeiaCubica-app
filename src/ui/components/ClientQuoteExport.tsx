/**
 * Exportação do orçamento para o cliente: pré-visualização A4, textos ajustáveis
 * e "Baixar PDF" (impressão do navegador → Salvar como PDF).
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import type { ClientQuoteSettings, Quote } from '../../domain/types';
import { buildClientQuote, clientQuoteSettings } from '../../domain/clientQuote';
import { BusinessError, fmtDate } from '../../domain/core';
import { fmtBRL } from '../../domain/money';
import { ClientQuoteDocument } from './ClientQuoteDocument';
import { Alert, Check, Modal, NumField, TextArea, TextField, num } from './ui';

type Form = { validityDays: string; productionDays: string; paymentTerms: string; notes: string; whatsapp: string; instagram: string; email: string; site: string };
const toForm = (s: ClientQuoteSettings): Form => ({
  validityDays: s.validityDays === null ? '' : String(s.validityDays), productionDays: s.productionDays === null ? '' : String(s.productionDays),
  paymentTerms: s.paymentTerms, notes: s.notes, whatsapp: s.whatsapp, instagram: s.instagram, email: s.email, site: s.site,
});
const fromForm = (f: Form): ClientQuoteSettings => ({
  validityDays: num(f.validityDays), productionDays: num(f.productionDays), paymentTerms: f.paymentTerms, notes: f.notes,
  whatsapp: f.whatsapp, instagram: f.instagram, email: f.email, site: f.site,
});

/** Campos de textos e contatos (usados aqui e em Parâmetros). */
export function ClientQuoteFields({ value, onChange, contacts = true }: { value: Form; onChange: (f: Form) => void; contacts?: boolean }) {
  const set = (k: keyof Form) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid g2">
        <NumField label="Validade do orçamento" suffix="dias" value={value.validityDays} onChange={set('validityDays')} hint="Vazio = não mostrar" />
        <NumField label="Prazo de produção" suffix="dias úteis" value={value.productionDays} onChange={set('productionDays')} hint="Após a aprovação" />
      </div>
      <TextField label="Condições de pagamento" value={value.paymentTerms} onChange={set('paymentTerms')} placeholder="Ex.: PIX ou cartão, 50% na aprovação" />
      <TextArea label="Observações para o cliente" value={value.notes} onChange={set('notes')} />
      {contacts && (
        <div className="grid g2">
          <TextField label="WhatsApp" value={value.whatsapp} onChange={set('whatsapp')} placeholder="(11) 99999-9999" />
          <TextField label="Instagram" value={value.instagram} onChange={set('instagram')} placeholder="@ideiacubica" />
          <TextField label="E-mail" value={value.email} onChange={set('email')} />
          <TextField label="Site" value={value.site} onChange={set('site')} />
        </div>
      )}
    </div>
  );
}

export function useClientQuoteForm() {
  const { db } = useStore();
  return useState<Form>(() => toForm(clientQuoteSettings(db)));
}

export function saveClientQuoteDefaults(f: Form) {
  return (d: { settings: { clientQuote?: ClientQuoteSettings } }) => {
    const s = fromForm(f);
    if (s.validityDays !== null && (s.validityDays < 1 || !Number.isInteger(s.validityDays))) throw new BusinessError('Validade deve ser um número inteiro de dias.');
    if (s.productionDays !== null && (s.productionDays < 0 || !Number.isInteger(s.productionDays))) throw new BusinessError('Prazo de produção deve ser um número inteiro de dias.');
    d.settings.clientQuote = s;
  };
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '').trim();

export function ClientQuoteExport({ quote, onClose, unsaved }: { quote: Quote; onClose: () => void; unsaved?: boolean }) {
  const { db, run, toast } = useStore();
  const [form, setForm] = useClientQuoteForm();
  const [asDefault, setAsDefault] = useState(false);
  const built = useMemo(() => {
    try { return { doc: buildClientQuote(db, quote, fromForm(form)) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [db, quote, form]);
  const doc = built.doc;

  // Nome sugerido do PDF = título da página durante a impressão.
  useEffect(() => {
    if (!doc) return;
    const original = document.title;
    const title = safeName(`Orçamento ${doc.number}${doc.customer ? ` - ${doc.customer.name}` : ''} - Ideia Cúbica`);
    const before = () => { document.title = title; };
    const after = () => { document.title = original; };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); document.title = original; };
  }, [doc]);

  const download = async () => {
    if (asDefault) {
      const r = await run((d) => saveClientQuoteDefaults(form)(d), 'Textos salvos como padrão.');
      if (!r.ok) return;
    }
    toast('info', 'Na janela que abrir, escolha “Salvar como PDF” como destino.');
    setTimeout(() => window.print(), 50);
  };

  const message = doc ? [
    `Olá${doc.customer ? `, ${doc.customer.name.split(' ')[0]}` : ''}! Segue o orçamento ${doc.number} da Ideia Cúbica:`,
    `• ${doc.item.description} — ${doc.item.quantity} ${doc.item.quantity === 1 ? 'peça' : 'peças'}`,
    `• Total: ${fmtBRL(doc.total)}${doc.freight?.free ? ' (frete grátis)' : doc.freight ? ` (inclui ${doc.freight.label.toLowerCase()})` : ''}`,
    doc.productionDays !== null ? `• Produção: até ${doc.productionDays} dias úteis após a aprovação` : '',
    doc.validUntil ? `• Válido até ${fmtDate(doc.validUntil)}` : '',
    'Obrigado pela confiança! Qualquer dúvida, é só chamar.',
  ].filter(Boolean).join('\n') : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(message); toast('success', 'Mensagem copiada. Cole no WhatsApp junto com o PDF.'); }
    catch { toast('warning', 'Não foi possível copiar automaticamente.'); }
  };

  return (
    <Modal wide title="Orçamento para o cliente" subtitle={`Versão ${quote.versions.length} salva · sem custos nem dados internos`} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Fechar</button>
        <button className="btn secondary" onClick={copy} disabled={!doc}>Copiar mensagem</button>
        <button className="btn primary" onClick={download} disabled={!doc}>Baixar PDF</button>
      </>}>
      <div className="cq-export">
        <div className="stack">
          {unsaved && <Alert tone="warning" title="Há alterações não salvas">O documento usa a última versão salva. Feche, clique em “Salvar alterações” e gere de novo.</Alert>}
          <ClientQuoteFields value={form} onChange={setForm} contacts={false} />
          <Check label="Salvar estes textos como padrão" checked={asDefault} onChange={setAsDefault} />
          <p className="small muted">Contatos do rodapé (WhatsApp, Instagram, e-mail): Parâmetros de Custos → Gerais → Orçamento para o cliente.</p>
          {!quote.image && <p className="small muted">Sem foto neste orçamento: o documento fica sem imagem. Para incluir, adicione a foto no orçamento e salve.</p>}
        </div>
        {built.error ? <Alert tone="warning" title="Não foi possível gerar">{built.error}</Alert> : (
          <div className="cq-preview" aria-label="Pré-visualização do orçamento">
            <div className="cq-preview-scale"><ClientQuoteDocument doc={doc!} /></div>
          </div>
        )}
      </div>
      {doc && createPortal(<div className="cq-print-root"><ClientQuoteDocument doc={doc} /></div>, document.body)}
    </Modal>
  );
}

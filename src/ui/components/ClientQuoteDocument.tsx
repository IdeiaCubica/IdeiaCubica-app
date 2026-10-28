/**
 * Documento do orçamento enviado ao cliente (A4). Recebe apenas o ClientQuoteDoc,
 * que não contém custos nem dados internos.
 */
import type { ClientQuoteDoc } from '../../domain/clientQuote';
import { fmtDate, fmtPhone } from '../../domain/core';
import { cents, fmtBRL, fmtNum } from '../../domain/money';
import '../clientQuote.css';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

export function ClientQuoteDocument({ doc }: { doc: ClientQuoteDoc }) {
  const single = doc.items.length === 1 ? doc.items[0] : null;
  const qty = single?.quantity ?? 0;
  const contacts = [
    doc.contacts.whatsapp && { label: 'WhatsApp', value: fmtPhone(doc.contacts.whatsapp) || doc.contacts.whatsapp },
    doc.contacts.instagram && { label: 'Instagram', value: doc.contacts.instagram.startsWith('@') ? doc.contacts.instagram : `@${doc.contacts.instagram}` },
    doc.contacts.email && { label: 'E-mail', value: doc.contacts.email },
    doc.contacts.site && { label: 'Site', value: doc.contacts.site.replace(/^https?:\/\//, '') },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <article className={`cq-page${doc.items.length > 4 ? ' multi' : ''}`} aria-label={`Orçamento ${doc.number}`}>
      <header className="cq-head">
        <div className="cq-brand">
          <img src="/brand/10_icone_simbolo_transparente.svg" alt="" />
          <div>
            <b>ideia cúbica</b>
            <span>IMPRESSÃO 3D</span>
          </div>
        </div>
        <div className="cq-meta">
          <span className="cq-kicker">Orçamento</span>
          <strong>{doc.number}</strong>
          <dl>
            <dt>Emitido em</dt><dd>{fmtDate(doc.issueDate)}</dd>
            {doc.validUntil && <><dt>Válido até</dt><dd>{fmtDate(doc.validUntil)}</dd></>}
          </dl>
        </div>
      </header>
      <div className="cq-rule" />

      <section className="cq-hello">
        <h1>{doc.customer ? `Olá, ${firstName(doc.customer.name)}!` : 'Olá!'}</h1>
        <p>
          Obrigado por escolher a <b>Ideia Cúbica</b>. Preparamos este orçamento especialmente para você,
          com todo o cuidado para transformar a sua ideia em uma peça real.
        </p>
        {doc.customer && (
          <div className="cq-to">
            <span>Para</span>
            <b>{doc.customer.name}</b>
            {doc.customer.phone && <em>{fmtPhone(doc.customer.phone)}</em>}
            {doc.customer.address && <em>{doc.customer.address}</em>}
          </div>
        )}
      </section>

      {single ? (
        <section className={`cq-item${single.image ? '' : ' no-image'}`}>
          {single.image && <div className="cq-photo"><img src={single.image} alt={single.description} /></div>}
          <div className="cq-item-info">
            <span className="cq-kicker">Sua peça</span>
            <h2>{single.description}</h2>
            <ul className="cq-chips">
              {single.materials.length > 0 && <li><span>Material</span>{single.materials.join(' + ')}</li>}
              {single.dimensions && <li><span>Dimensões aprox.</span>{single.dimensions}</li>}
              <li><span>Quantidade</span>{qty} {qty === 1 ? 'peça' : 'peças'}</li>
              <li><span>Produção</span>{single.ready ? 'Pronta-entrega' : 'Impressão 3D sob medida'}</li>
            </ul>
          </div>
        </section>
      ) : (
        <section className="cq-list">
          <span className="cq-kicker">Suas peças ({doc.items.length})</span>
          {doc.items.map((it, i) => (
            <div key={i} className={`cq-row${it.image ? '' : ' no-image'}`}>
              {it.image && <div className="cq-thumb"><img src={it.image} alt={it.description} /></div>}
              <div className="cq-row-info">
                <b>{it.description}</b>
                <span>{[it.materials.join(' + '), it.ready ? 'pronta-entrega' : 'sob medida'].filter(Boolean).join(' · ')}</span>
                {it.dimensions && <span className="cq-dim">Dimensões aprox.: <b>{it.dimensions}</b></span>}
              </div>
              <div className="cq-row-qty">{it.quantity} × {fmtBRL(it.unitPrice)}</div>
              <div className="cq-row-total">{fmtBRL(cents(it.unitPrice.times(it.quantity)))}{it.discount.gt(0) && <small>− {fmtBRL(it.discount)} ({fmtNum(it.discountPct)}%)</small>}</div>
            </div>
          ))}
        </section>
      )}

      <section className="cq-values">
        <table>
          <tbody>
            {single ? <>
              <tr><th>Valor por peça</th><td>{fmtBRL(single.unitPrice)}</td></tr>
              {qty > 1 && <tr><th>Quantidade</th><td>× {qty}</td></tr>}
            </> : <tr><th>Peças</th><td>{doc.items.reduce((s, x) => s + x.quantity, 0)} un</td></tr>}
            {(qty > 1 || !single || doc.discount.gt(0) || doc.freight) && <tr className="cq-sub"><th>Subtotal</th><td>{fmtBRL(doc.subtotal)}</td></tr>}
            {doc.discount.gt(0) && <tr className="cq-discount"><th>Desconto{single?.discountPct.gt(0) ? ` (${fmtNum(single.discountPct)}%)` : ''}</th><td>− {fmtBRL(doc.discount)}</td></tr>}
            {doc.freight && (
              <tr><th>{doc.freight.label}{doc.freight.delivery && <small>Entrega em {doc.freight.delivery} após o envio</small>}</th>
                <td>{doc.freight.free ? <span className="cq-free">Grátis</span> : fmtBRL(doc.freight.price)}</td></tr>
            )}
          </tbody>
        </table>
        <div className="cq-total">
          <span>Total do pedido</span>
          <strong>{fmtBRL(doc.total)}</strong>
          {!doc.freight && <small>Frete não incluso</small>}
        </div>
      </section>

      <section className="cq-terms">
        {doc.productionDays !== null && <div><span>Prazo de produção</span><b>até {doc.productionDays} {doc.productionDays === 1 ? 'dia útil' : 'dias úteis'}</b><em>após a aprovação</em></div>}
        {doc.paymentTerms && <div><span>Pagamento</span><b>{doc.paymentTerms}</b></div>}
        {doc.validUntil && <div><span>Validade</span><b>até {fmtDate(doc.validUntil)}</b><em>valores garantidos até esta data</em></div>}
      </section>

      {doc.notes && <p className="cq-notes">{doc.notes}</p>}

      <section className="cq-next">
        <div>
          <b>Gostou? É só aprovar.</b>
          <p>Responda esta mensagem{doc.contacts.whatsapp ? ' ou chame no WhatsApp' : ''} e começamos a produção da sua peça.</p>
        </div>
        <p className="cq-thanks">Muito obrigado pela confiança!<br /><span>Equipe Ideia Cúbica</span></p>
      </section>

      <footer className="cq-foot">
        <p className="cq-slogan">Do pensamento à realidade, <b>em 3 dimensões.</b></p>
        {contacts.length > 0 && <ul>{contacts.map((c) => <li key={c.label}><span>{c.label}</span>{c.value}</li>)}</ul>}
      </footer>
    </article>
  );
}

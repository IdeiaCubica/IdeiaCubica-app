/**
 * Documento do orçamento enviado ao cliente (A4). Recebe apenas o ClientQuoteDoc,
 * que não contém custos nem dados internos.
 */
import type { ClientQuoteDoc } from '../../domain/clientQuote';
import { fmtDate, fmtPhone } from '../../domain/core';
import { fmtBRL, fmtNum } from '../../domain/money';
import '../clientQuote.css';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

export function ClientQuoteDocument({ doc }: { doc: ClientQuoteDoc }) {
  const qty = doc.item.quantity;
  const contacts = [
    doc.contacts.whatsapp && { label: 'WhatsApp', value: fmtPhone(doc.contacts.whatsapp) || doc.contacts.whatsapp },
    doc.contacts.instagram && { label: 'Instagram', value: doc.contacts.instagram.startsWith('@') ? doc.contacts.instagram : `@${doc.contacts.instagram}` },
    doc.contacts.email && { label: 'E-mail', value: doc.contacts.email },
    doc.contacts.site && { label: 'Site', value: doc.contacts.site.replace(/^https?:\/\//, '') },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <article className="cq-page" aria-label={`Orçamento ${doc.number}`}>
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

      <section className={`cq-item${doc.item.image ? '' : ' no-image'}`}>
        {doc.item.image && <div className="cq-photo"><img src={doc.item.image} alt={doc.item.description} /></div>}
        <div className="cq-item-info">
          <span className="cq-kicker">Sua peça</span>
          <h2>{doc.item.description}</h2>
          <ul className="cq-chips">
            {doc.item.materials.length > 0 && <li><span>Material</span>{doc.item.materials.join(' + ')}</li>}
            <li><span>Quantidade</span>{qty} {qty === 1 ? 'peça' : 'peças'}</li>
            <li><span>Produção</span>Impressão 3D sob medida</li>
          </ul>
        </div>
      </section>

      <section className="cq-values">
        <table>
          <tbody>
            <tr><th>Valor por peça</th><td>{fmtBRL(doc.unitPrice)}</td></tr>
            {qty > 1 && <tr><th>Quantidade</th><td>× {qty}</td></tr>}
            {(qty > 1 || doc.discount.gt(0) || doc.freight) && <tr className="cq-sub"><th>Subtotal</th><td>{fmtBRL(doc.subtotal)}</td></tr>}
            {doc.discount.gt(0) && <tr className="cq-discount"><th>Desconto{doc.discountPct.gt(0) ? ` (${fmtNum(doc.discountPct)}%)` : ''}</th><td>− {fmtBRL(doc.discount)}</td></tr>}
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

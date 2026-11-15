/**
 * Módulo Vendas: peças entregues (vendidas), com a situação do pagamento — pago ou a pagar.
 * As vendas entram aqui pelo quadro de produção (Produzidas → Peça entregue), pelos pedidos,
 * pelo estoque de peças produzidas ou pelo botão Registrar venda.
 */
import { useState } from 'react';
import { PageHead } from '../components/ui';
import { OrdersInProduction, SaleForm, SalesList } from './Financeiro';

export function Vendas() {
  const [selling, setSelling] = useState(false);
  return (
    <>
      <PageHead eyebrow="Vendas" title="Vendas" text="Pedidos de venda em produção (já cobráveis: registre o sinal) e peças entregues aos clientes, com a situação de cada pagamento. Clique numa venda para editar; use Sinal ou Receber quando o cliente pagar."
        actions={<button className="btn primary" onClick={() => setSelling(true)}>Registrar venda</button>} />
      <div className="stack">
        <OrdersInProduction />
        <SalesList onNew={() => setSelling(true)} />
      </div>
      {selling && <SaleForm onClose={() => setSelling(false)} />}
    </>
  );
}

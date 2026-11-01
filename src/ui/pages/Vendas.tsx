/**
 * Módulo Vendas: peças entregues (vendidas), com a situação do pagamento — pago ou a pagar.
 * As vendas entram aqui pelo quadro de produção (Produzidas → Peça entregue), pelos pedidos,
 * pelo estoque de peças produzidas ou pelo botão Registrar venda.
 */
import { useState } from 'react';
import { PageHead } from '../components/ui';
import { SaleForm, SalesList } from './Financeiro';

export function Vendas() {
  const [selling, setSelling] = useState(false);
  return (
    <>
      <PageHead eyebrow="Vendas" title="Vendas" text="Peças entregues aos clientes e a situação de cada pagamento: pago ou a pagar. Clique numa venda para editar; use Receber quando o cliente pagar."
        actions={<button className="btn primary" onClick={() => setSelling(true)}>Registrar venda</button>} />
      <SalesList onNew={() => setSelling(true)} />
      {selling && <SaleForm onClose={() => setSelling(false)} />}
    </>
  );
}

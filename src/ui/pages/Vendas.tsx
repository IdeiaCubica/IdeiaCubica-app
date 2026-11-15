/**
 * Módulo Vendas: o PEDIDO completo (todas as peças do orçamento), entregue ou não, com a situação do
 * pagamento. Os pedidos entram aqui quando a peça vai para produção como Venda; as vendas avulsas
 * (Registrar venda, estoque de peças prontas) formam um pedido sozinhas (v1.29).
 */
import { useState } from 'react';
import { PageHead } from '../components/ui';
import { SaleForm } from './Financeiro';
import { PedidosVendas } from './VendasPedidos';

export function Vendas() {
  const [selling, setSelling] = useState(false);
  return (
    <>
      <PageHead eyebrow="Vendas" title="Vendas" text="Cada linha é um pedido completo, com todas as peças. Filtre por entregues e não entregues; abra o pedido para receber o sinal ou uma parte (rateado pelas peças) e ver a purga real por cor."
        actions={<button className="btn primary" onClick={() => setSelling(true)}>Registrar venda</button>} />
      <PedidosVendas onNew={() => setSelling(true)} />
      {selling && <SaleForm onClose={() => setSelling(false)} />}
    </>
  );
}

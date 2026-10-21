# Regras de cálculo — v0.1

Todas as fórmulas estão implementadas uma única vez em `src/domain/` e cobertas por testes (`*.test.ts`).
Valores monetários usam aritmética decimal (decimal.js), arredondamento a centavos *meio para cima* apenas nos totais
financeiros; custos unitários (R$/g) mantêm precisão total.

## 1. Custo de aquisição (compras) — `purchases.ts`

- **Custo por unidade do lote** = (mercadoria + frete atribuído + outros custos atribuídos) ÷ quantidade recebida.
  Ex.: (R$ 100 + R$ 10) ÷ 1.000 g = **R$ 0,11/g**.
- **Rateio** de frete/outros entre itens de uma compra: proporcional ao valor da mercadoria; o resíduo de centavos vai ao último item
  (a soma sempre fecha). Sem valor de mercadoria, rateio igualitário.
- O custo fica gravado no lote e **nunca é alterado**.

### Política de preço do filamento no orçamento (`quotes.ts → materialCostPolicy`)

1. Custo do lote da **compra mais recente** do material (custo de aquisição real, com frete).
2. Sem compras: **preço de referência** do cadastro do material (digitado em R$/kg, gravado em R$/g).
3. Nenhum dos dois: rubrica pendente.

O preço do filamento **não pode ser digitado nem ajustado no orçamento**: ele sempre vem do sistema. Para mudar, atualize o preço
no cadastro do material ou registre a compra. Não há custo médio automático. O preço usado fica gravado na versão do orçamento
(snapshot) e não muda se o cadastro ou as compras mudarem depois.
- Conversão de unidades apenas dentro do mesmo grupo (g↔kg, ml↔l, cm↔m); conversões incompatíveis são bloqueadas.

## 2. Custo do orçamento — `costing.ts`

Todos os valores são calculados **por pedido** (Q peças) e divididos por Q para o unitário.

| Componente | Fórmula | Grupo |
| --- | --- | --- |
| Material | Σ (consumo por peça × Q × fator de perda × custo do lote) | direto |
| Fator de perda | 1 se o consumo é o **total do fatiador**; 1 + perda% se o consumo é **somente a peça** | — |
| Energia | horas de máquina × kWh/h × tarifa | direto |
| Depreciação | horas de máquina × (aquisição − residual) ÷ vida útil em horas | direto |
| Manutenção/desgaste | horas de máquina × R$/h calibrável | direto |
| Falhas | (material + energia + depreciação + manutenção) × f ÷ (1 − f) | direto |
| Mão de obra | (min. por pedido + min. por peça × Q) ÷ 60 × custo da hora | direto |
| Acabamento/embalagem/outros | Σ (qtd. por peça × Q × custo unitário do insumo) | direto |
| Frete subsidiado | valor por pedido | direto |
| Desenvolvimento "cobrar" | horas × custo da hora + direitos de uso | direto |
| Desenvolvimento "diluir" | (horas × custo da hora + direitos) ÷ vendas previstas × Q | estrutura |
| Despesas indiretas | horas de máquina × (Σ despesas mensais marcadas ÷ horas produtivas/mês) | estrutura |

Regras contra duplicidade:
- Perda percentual nunca é aplicada sobre um consumo que já é o total do fatiador.
- A taxa de falha usa o número esperado de tentativas, 1 ÷ (1 − f), e incide só sobre recursos gastos na impressão;
  acabamento e embalagem ocorrem apenas nas peças aprovadas.
- Tempo de impressão é recurso de máquina; não gera mão de obra.
- A depreciação entra **apenas** por hora de máquina; a compra da impressora é lançada como investimento e não como despesa do período.

Status de cada componente: **calculado** (parâmetro medido/informado), **estimado** (potência média, falha manual, rateio, amortização),
**ajustado por você** ou **pendente** (falta parâmetro — fica fora do total e o orçamento é marcado *incompleto*).

**Ajuste manual de rubrica**: o usuário pode substituir o valor de qualquer rubrica, exceto a de filamento (total do pedido). O valor calculado continua
visível; o ajustado entra no total, resolve a pendência daquela rubrica e é gravado na versão. Valores negativos são bloqueados.
Falhas são calculadas sobre os valores finais (já ajustados) de material, energia, depreciação e manutenção.

Mão de obra = (minutos por orçamento + minutos por peça × quantidade) ÷ 60 × custo da hora. Os minutos padrão vêm de
Parâmetros de Custos e podem ser alterados em cada orçamento.

**Indicadores por hora** (pedido inteiro, horas = tempo por peça × quantidade):
- Custo por hora = custo total ÷ horas de impressão.
- R$/h = valor cobrado do cliente (após desconto) ÷ horas de impressão — quanto cada hora de máquina fatura.

## 3. Preço — `pricing.ts`

- r = tributos% + comissão% + taxa de pagamento% + outros% (do canal) · F = taxa fixa por pedido · k = **markup** (Parâmetros de Custos,
  alterável no orçamento).
- **Preço mínimo sustentável** = (custos diretos + F) ÷ (1 − r). Cobre custos incrementais e encargos; **não** cobre a estrutura.
- **Preço sugerido** = (custo total × (1 + k) + F) ÷ (1 − r). O markup incide sobre o custo e os encargos do canal são somados por
  fora: depois de pagar as taxas, o lucro é custo × k.
- **Arredondamento** sempre para cima (,90 · ,99 · inteiro · múltiplos de R$ 0,50 · centavos); markup e margem são recalculados no
  preço arredondado (por isso podem ficar um pouco acima do pedido).
- **Premium** = sugerido arredondado + valor agregado por peça, apenas com justificativa comercial.
- Análise em qualquer preço P (com desconto d) — exibida no resumo do orçamento:
  - receita = P × (1 − d) × Q
  - encargos = receita × r + F
  - **margem de contribuição** = receita − (custos diretos + encargos)
  - **lucro** = margem de contribuição − estrutura
  - **markup** = lucro ÷ custo total · **margem de lucro sobre a venda** = lucro ÷ receita

Exemplo (sem taxas): custo R$ 50, markup 100% → preço R$ 100, lucro R$ 50, margem sobre a venda 50%.

## 4. Cadastros — `catalog.ts`

- **Cliente**: nome completo, endereço, telefone (DDD + número), CPF/CNPJ e fonte de captação são obrigatórios; observações opcionais.
  CPF/CNPJ é validado pelos dígitos verificadores e não pode repetir entre clientes. Fornecedor exige apenas o nome.
- **Fontes de captação** (Parâmetros de Custos), **marcas** e **fabricantes** (Cadastros) são listas configuráveis. Itens em uso não podem
  ser excluídos, apenas desativados (somem das listas, mas o histórico continua).
- Marca e fabricante digitados como texto na v0.1 são convertidos automaticamente em itens dessas listas ao abrir o sistema.

## 5. Estoque — `inventory.ts`

- Saldos são derivados das movimentações: **físico** = entradas − saídas; **reservado** = reservas − liberações;
  **disponível** = físico − reservado.
- Bloqueios: saldo físico negativo, liberação maior que a reserva, reserva maior que o disponível.
- Cada movimentação tem **chave de idempotência**: a mesma operação (ex.: consumo da OP X no lote Y) não é aplicada duas vezes.
- Valor do estoque = Σ físico × custo do lote (custo histórico específico).
- **Ponto de pedido** = estoque mínimo + segurança + consumo médio diário (90 dias, consumo + perdas) × prazo de reposição;
  sugestão = ponto de pedido − **disponível**.

## 6. Produção — `production.ts`

- Preparar OP: reserva **tudo ou nada**; com falta de material, a OP fica "Aguardando material" sem reservas parciais.
- Linha sem lote fixo (orçamento por material): a reserva usa os lotes do material **por ordem de entrada** (o mais antigo primeiro),
  dividindo entre lotes se necessário. A conclusão parte dos lotes reservados e o usuário confirma o consumo real.
- Concluir: libera as reservas da OP e baixa o consumo **real** (movimento "consumo") e as falhas (movimento "perda").
  Concluir de novo é bloqueado.
- **Custo realizado** = mesmo motor de custos com consumo real total (inclui perdas), horas reais (inclui horas perdidas),
  taxa de falha 0 (as falhas reais já estão no consumo) e os parâmetros do orçamento original.
  Custo por peça aprovada = custo realizado ÷ peças aprovadas. Sem mão de obra real informada, usa a do orçamento (marcado estimado).
- Taxa de falha histórica = peças rejeitadas ÷ (aprovadas + rejeitadas) nas OPs concluídas (filtrável por impressora).

## 7. Financeiro — `finance.ts` e `sales.ts`

- Cada compra/venda/lançamento gera **títulos** reconhecidos uma única vez na competência; pagamentos e recebimentos são
  **liquidações** do título (podem ser parciais e estornadas). À vista = título já liquidado na data.
- Parcelas: divisão em centavos com o resíduo na última parcela.
- Venda: valor a receber = receita − desconto + frete cobrado − encargos (se retidos pelo canal). Encargos não retidos e frete pago
  pela empresa geram contas a pagar.
- **Resultado gerencial** (competência) = receita − encargos ± frete − custo dos produtos vendidos − despesas fixas ± outras.
  Compras de estoque, investimentos, aportes e retiradas não entram no resultado.
- O resultado é marcado como **realizado**, **estimado** (custos de orçamento ou mão de obra não apurada) ou **parcial**
  (vendas sem custo).
- **Ponto de equilíbrio** = despesas indiretas mensais ÷ margem de contribuição média do período.
- **Caixa projetado (30 dias)** = saldo atual + a receber − a pagar com vencimento até 30 dias.

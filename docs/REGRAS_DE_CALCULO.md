# Regras de cálculo — v1.1

Todas as fórmulas estão implementadas uma única vez em `src/domain/` e cobertas por testes (`*.test.ts`).
Valores monetários usam aritmética decimal (decimal.js), arredondamento a centavos *meio para cima* apenas nos totais
financeiros; custos unitários (R$/g) mantêm precisão total.

## 1. Custo de aquisição (compras) — `purchases.ts`

- **Custo por unidade do lote** = (mercadoria + frete atribuído + outros custos atribuídos − desconto atribuído) ÷ quantidade recebida.
  Ex.: (R$ 100 + R$ 10) ÷ 1.000 g = **R$ 0,11/g**.
- **Rateio** de frete/outros/desconto entre itens de uma compra: proporcional ao valor da mercadoria; o resíduo de centavos vai ao último item
  (a soma sempre fecha). Sem valor de mercadoria, rateio igualitário.
- **Desconto da compra** (v1.6): reduz o valor pago e o custo dos lotes. O preço de referência do cadastro não muda.
  Ex.: filamento R$ 89,37 + etiquetas R$ 10,63, desconto R$ 10 → R$ 8,94 no filamento e R$ 1,06 nas etiquetas.
- **Unidade da compra** (v1.6): filamento é digitado por **carretel** (peso líquido do cadastro) ou **kg** — nunca em gramas por padrão.
  "1 g" a R$ 89,37 daria R$ 89.370/kg (1.000× maior).
- **Custo improvável** (`costSanity.ts`): filamento fora de R$ 20–800/kg gera alerta na compra (confirmação obrigatória), na lista de
  compras, no cadastro e no orçamento.
- O custo fica gravado no lote. **Edição da compra** (v1.6) recalcula lotes, rateios e títulos juntos enquanto não houver pagamento
  do usuário (a saída à vista da própria compra é refeita); lote já usado mantém o insumo e não pode ficar abaixo do que já saiu.
- Vale para qualquer insumo (filamento em g; etiquetas, caixas etc. na unidade cadastrada). Ex.: 500 etiquetas por R$ 40
  com R$ 0,08 de frete atribuído = R$ 40,08 ÷ 500 = **R$ 0,08016/un**.
- **Equipamentos** (impressora, ferramenta durável) participam do rateio de frete, mas não geram lote nem estoque:
  custo total = mercadoria + frete + outros atribuídos, lançado como investimento ("Impressoras e equipamentos"), fora do
  resultado do mês. Impressora vinculada recebe esse custo total como **valor de aquisição** (base da depreciação por hora).

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
- **Saldo por insumo** (v1.6): físico = comprado + estoque inicial − usado na produção − perdas ± ajustes − devoluções.
  O estoque só entra por compra/estoque inicial e só sai pela produção (conclusão da OP ou “já produzi”), perdas, ajustes e kits de entrega vendidos.
- **Já produzi** (v1.6, `produceForStockNow`): cria a produção para estoque e conclui na hora, baixando o material pelos lotes mais antigos
  (tudo ou nada); as peças entram com o custo real dos lotes.
- **Demanda planejada** = Σ material previsto das OPs "Planejada" e "Aguardando material" (ainda sem reserva; as demais já estão no reservado,
  então não contam duas vezes). **Projetado** = disponível − demanda planejada.
- **Ponto de pedido** = estoque mínimo + segurança + consumo médio diário (90 dias, consumo + perdas) × prazo de reposição;
  sugestão = ponto de pedido − **projetado**. Situação: **comprar já** se projetado < 0 (mesmo sem mínimo cadastrado; sugestão = falta);
  **repor** se projetado < ponto de pedido.
- No Kanban, a falta também é calculada **na ordem da fila**: o disponível de cada material é consumido da 1ª para a última OP não reservada.

### Tempo
- O tempo é digitado em **horas inteiras + minutos** e guardado em horas decimais: h + min ÷ 60 (1 h 20 min = 1,3333 h).
  Exibição arredonda ao minuto com “vai um” (1,9999 h → 2 h 0 min).

## 5a. Orçamento com várias peças — `quotes.ts`

- Cada versão do orçamento guarda a lista de peças; cada peça tem entrada, snapshot de parâmetros e resumo próprios
  (os cálculos de custo e preço são os mesmos da peça única, peça a peça).
- Total do orçamento = Σ valor das peças não recusadas (ou das escolhidas no documento) + frete cobrado do cliente.
- Situação da peça: aberta / aprovada / recusada (definida pelo usuário); “em produção” e “produzida” vêm do pedido ativo;
  “pedido aprovado (estoque)” quando a peça vem do estoque de peças prontas e foi separada.
- Peça com pedido ativo ou separada fica **travada**: uma nova versão do orçamento precisa mantê-la igual e não pode removê-la.
- Situação geral: todas recusadas → recusado; todas as não recusadas em produção/separadas → em produção; alguma aprovada → aprovado.
- Frete “empresa paga”: rateado entre as peças editáveis proporcionalmente ao peso (g) de cada uma; entra no custo de cada peça.
- **Kit de entrega** (v1.6, `deliveryKits.ts`): custo de 1 kit = Σ quantidade × preço atual do insumo (última compra → referência)
  + custos sem estoque. Custo no pedido = kits × custo do kit (snapshot na versão). Rateado entre as peças editáveis pela
  **quantidade de peças**, em centavos exatos (resíduo na última); entra na rubrica “Kit de entrega” do custo e, portanto, no preço.
  Nunca aparece no documento do cliente.
- **Orçamento kit** (v1.6): junta as peças não recusadas de vários orçamentos num só, mantendo o snapshot (custo e preço) de cada peça.
  Peças em produção/separadas impedem a junção. Opcionalmente exclui os orçamentos de origem.
- **Conferência** (`quoteSanity`): alerta para filamento fora de R$ 20–800/kg, peso > 5 kg por peça, tempo > 200 h por peça e preço abaixo do custo.

## 6. Produção — `production.ts`

- **Pedido** (PED-…): uma peça aprovada do orçamento, com data de entrega obrigatória. **Produção para estoque** (EST-…): sem orçamento;
  custo e preço sugerido calculados na criação com os parâmetros padrão (1 lote = quantidade produzida, sem mão de obra por pedido).
- Quadro (Kanban): cada coluna em ordem de data de entrega crescente; sem data por último; empate pela ordem de criação.
- Retornar pedido ao orçamento: só antes de concluir; libera reservas, cancela o pedido e a peça volta a “aprovada”.
- Orçamento a partir de peça pronta: preço = valor previsto de venda da peça (editável). “Pedido aprovado” separa as peças
  (saldo disponível = produzidas − vendidas − baixas − separadas); a venda consome a separação.

- Preparar OP: reserva **tudo ou nada**; com falta de material, a OP fica "Aguardando material" sem reservas parciais.
- Linha sem lote fixo (orçamento por material): a reserva usa os lotes do material **por ordem de entrada** (o mais antigo primeiro),
  dividindo entre lotes se necessário. A conclusão parte dos lotes reservados e o usuário confirma o consumo real.
- Concluir: libera as reservas da OP e baixa o consumo **real** (movimento "consumo") e as falhas (movimento "perda").
  Concluir de novo é bloqueado.
- **Custo realizado** = mesmo motor de custos com consumo real total (inclui perdas), horas reais (inclui horas perdidas),
  taxa de falha 0 (as falhas reais já estão no consumo) e os parâmetros do orçamento original.
  Custo por peça aprovada = custo realizado ÷ peças aprovadas. Sem mão de obra real informada, usa a do orçamento (marcado estimado).
- Taxa de falha histórica = peças rejeitadas ÷ (aprovadas + rejeitadas) nas OPs concluídas (filtrável por impressora).
- **Peças prontas** (OP do tipo Estoque): ao concluir, cria um lote de peças com quantidade = aprovadas, custo unitário = custo realizado
  por peça aprovada (4 casas) e data de produção = data da conclusão. Saldo = produzidas − vendidas (vendas ativas) − baixas.
  Dias parado = hoje − data de produção. A venda usa o custo do lote (snapshot) e não pode exceder o saldo; cancelar a venda devolve o saldo.

## 6a. Frete — `shipping.ts`

- Peso do pacote = Σ peso de filamento por peça × quantidade + peso da embalagem, em kg arredondado para cima (3 casas),
  com as medidas da caixa **do orçamento** (novo orçamento copia a caixa e o CEP de saída padrão; orçamentos anteriores à v1.2
  usam o padrão atual). É estimativa (suportes removidos pesam menos). “Empresa paga” lança o valor cotado como
  frete pago pela empresa no custo do pedido.

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
- **Kit na venda** (v1.6): os itens saem do estoque (lotes mais antigos) e o custo real entra no custo da venda. Se o custo vem do
  orçamento (que já inclui a parte do kit), essa parte é descontada para não contar duas vezes. Cancelar a venda devolve o kit ao estoque.
- **Edição** (v1.6): venda e título podem ser corrigidos enquanto não houver recebimento/pagamento do usuário; títulos são refeitos.
  Título de compra/venda só muda descrição, vencimento e observações (valores: edite a compra/venda).
- **Caixa projetado (30 dias)** = saldo atual + a receber − a pagar com vencimento até 30 dias.

# Histórico de versões

Formato: [versionamento semântico](docs/VERSIONAMENTO.md). Datas no padrão DD/MM/AAAA.

## v1.6.3 — 24/10/2026

### Orçamento por modelo: preencha 1 peça, a quantidade multiplica
- A tela fala em **modelos de peça** (ex.: 10 chaveiros + 10 vasos = 2 modelos). Em cada modelo: nome, **quantidade deste modelo**,
  **peso de 1 peça**, **tempo de 1 peça** e custos por peça; o sistema mostra o total do modelo ao lado (ex.: 10 × 12 g = 120 g; 10 × 30 min = 5 h).
- Detalhe do modelo com **custo de 1 peça**, **valor de 1 peça**, **total do modelo** (10 × R$ 2,04 = R$ 20,40) e lucro por peça.
  A composição do custo ganhou a coluna **1 peça** ao lado do total do modelo.
- Painel lateral com o **resumo do orçamento por modelo** (quantidade, valor de 1 peça e total); clique numa linha para abrir o modelo.
- **Frete**, **Kit de entrega** e **Tempo de produção** têm botão **Ocultar/Mostrar**; ocultos, mostram um resumo do que foi preenchido.
  A escolha fica lembrada no navegador.
- Numeração das seções corrigida (1. Cliente, 2. Modelos, 3. Modelo, 4. Frete, 5. Kit de entrega).

## v1.6.2 — 24/10/2026

### Correção: editar o cadastro do filamento não corrigia o preço
- Causa: com compra registrada, o orçamento usa o **custo da última compra**; o preço digitado no cadastro era ignorado.
- Na edição do insumo há a nova seção **Custo das compras deste insumo**: mostra o preço usado hoje nos orçamentos e cada
  compra/estoque com o custo. **Corrigir** ajusta a quantidade recebida (carretel, kg ou g) e o valor pago; a compra, o estoque
  e o financeiro são recalculados juntos (o frete continua rateado).
- Nova opção no cadastro: **“Usar este preço do cadastro nos orçamentos”**, que vale mesmo com compras registradas.
- Orçamentos já salvos mantêm o valor salvo e mostram o aviso “os custos mudaram” com o botão para atualizar.

## v1.6.1 — 24/10/2026

### Exclusão e relançamento de insumos
- **Compras → abrir a compra → Excluir / Excluir e relançar**: apaga a compra lançada por engano por inteiro (lotes, entrada no
  estoque, títulos e saída do caixa à vista) e, no relançamento, abre uma nova compra já preenchida com os mesmos dados para corrigir.
  Só é possível enquanto o material não foi usado e sem pagamento registrado pelo usuário; depois disso use **Editar compra**.
  Compras canceladas também podem ser excluídas.
- **Cadastros → Materiais → abrir o insumo**: **Excluir** e **Excluir e relançar** para cadastros sem histórico. Com histórico
  (compras, orçamentos, produções, kits), **Inativar e relançar**: o antigo fica inativo e abre um cadastro novo com os mesmos dados.

## v1.6.0 — 24/10/2026

### Correção: filamento com R$/kg 1.000× maior (ex.: R$ 91.770,00/kg)
- Causa: na compra, a unidade padrão do filamento era **grama**. Digitar “1” (um carretel) com R$ 89,37 + frete virava
  R$ 91,77 **por grama**. Agora o filamento é comprado por **carretel** (peso líquido do cadastro) ou **kg**; grama só se escolhida.
- Custo fora da faixa normal (R$ 20–800/kg) gera alerta na compra (com confirmação), na lista de compras, no cadastro e no orçamento.
- Compras com custo improvável aparecem no topo de Compras com o atalho para corrigir.

### Compras
- **Desconto na compra**: rateado pelo valor dos itens; reduz o valor pago e o custo dos lotes (o preço do cadastro não muda).
- **Editar compra**: corrige quantidade, unidade, valores, frete, desconto, data, fornecedor e pagamento. Lotes, custos e financeiro
  são refeitos juntos (mesmo número de compra). Bloqueia só se já houver pagamento do usuário; lote já usado mantém o insumo.

### Estoque
- Nova aba **Saldo por insumo**: comprado − usado na produção − perdas/ajustes = saldo. O saldo saiu do cadastro de materiais
  (lá fica o preço de referência e o preço usado nos orçamentos).
- Produção para estoque com a opção **“Já produzi (baixar material agora)”**: baixa o filamento e lança as peças prontas com o custo real.
- Nome do insumo com **tipo e cor do filamento** em todas as listas de seleção (produção, estoque inicial, compras, kits).

### Orçamentos
- **Kits de entrega** (Cadastros → Kits de entrega): modelos com saquinho, cartão, adesivo etc. No orçamento, o custo do kit entra no
  preço das peças e **não aparece para o cliente**; na venda, os itens do kit saem do estoque.
- **Orçamento kit**: “Juntar orçamentos (kit)” reúne vários orçamentos num só com os mesmos valores; “+ Peça do estoque” adiciona
  peças prontas direto no orçamento.
- **Conferência antes de enviar**: alerta para custo de filamento improvável, peso/tempo absurdos e preço abaixo do custo.

### Edição em todas as telas
- Vendas (preço, quantidade, desconto, frete, canal, cliente, data, recebimento), títulos financeiros e categorias financeiras
  agora podem ser editados. Compras, estoque inicial e peças produzidas já podiam.

## v1.5.4 — 24/10/2026

### Correção: valor do orçamento diferente entre as telas
- A lista e o documento do cliente usavam o valor **salvo** do orçamento, mas a tela do orçamento recalculava com os
  **custos de hoje** (ex.: Gancho R$ 14,90 na lista e no PDF, R$ 15,90 na tela). Agora todas as telas usam a mesma regra:
  peça salva e não alterada mostra o valor salvo.
- Quando os custos mudam depois de salvar (filamento, parâmetros, impressora), a tela avisa quanto a peça passaria a custar
  e oferece **“Atualizar para os custos de hoje”**, que grava uma nova versão (a anterior fica no histórico).
- Salvar um orçamento sem mexer numa peça não muda mais o preço dela sozinho.

## v1.5.3 — 23/10/2026

### Proteção do banco contra excesso de requisições
- O projeto registrou ~26 milhões de leituras dos dados (sistema iniciando repetidamente), o que levou a CPU do Supabase a 100%.
- Novo **disjuntor** no navegador: se uma aba passar de 120 requisições ao banco em 1 minuto (contando também recargas da página),
  ela é pausada por 5 minutos com um aviso, em vez de sobrecarregar o banco. O uso normal fica muito abaixo desse limite.

## v1.5.2 — 23/10/2026

### Correção: tela parada em “Verificando permissões…”
- A renovação automática do login podia ficar presa na trava de sessão entre abas do navegador, e a verificação de
  permissões esperava para sempre. Agora a trava é só da aba, e cada etapa tem limite de tempo.
- Se o servidor não responder, aparece uma mensagem com **Tentar novamente** e **Sair e entrar novamente**
  (que limpa o login salvo no navegador mesmo sem resposta do servidor). Depois de 6 segundos esperando, os mesmos atalhos aparecem.
- O carregamento dos dados também tem limite de tempo e mostra a mensagem de erro em vez de “Carregando…” sem fim.

## v1.5.1 — 22/10/2026

### Correção: preço por kg 1.000× maior
- **Cadastro de insumo** controlado em gramas (que não é filamento): o “Preço de referência” pedia R$ por **grama**, mas o sistema
  mostra R$/kg; um preço de pacote digitado ali virava 1.000× maior (ex.: 75,58 → R$ 75.580/kg). Agora todo insumo em gramas
  tem o preço digitado em **R$/kg**, com aviso quando o valor está fora do normal.
- **Lançar estoque inicial**: o custo era pedido por grama. Agora é o **valor total pago** pela quantidade (padrão), ou R$/kg,
  com a prévia do custo por kg antes de salvar e aviso de valor fora do normal.
- Lotes mostram o custo em R$/kg para materiais em gramas.

### Corrigir e excluir lançamentos de estoque
- Estoque inicial ainda não usado: **Editar lançamento** (quantidade, valor, data, lote) e **Excluir lançamento**.
- Peças prontas cadastradas à mão: editar tudo ou excluir enquanto não houver venda, baixa, separação ou orçamento;
  peças produzidas: editar descrição, local, preço previsto e observações.

## v1.5.0 — 22/10/2026

### Orçamentos com várias peças
- Um orçamento agora tem **várias peças**, cada uma com filamento, tempo, parâmetros, foto e preço próprios.
- Cada peça tem situação própria: aguardando cliente, **aprovada**, **recusada**, em produção, produzida.
- O documento para o cliente permite escolher **quais peças** enviar (todas ou só algumas); várias peças aparecem em lista.
- Frete passa a ser do orçamento inteiro (todas as peças na mesma caixa); “empresa paga” é rateado no custo das peças pelo peso.
- Novas sub abas: **Por cliente**, **Por peça** e **Aprovados**.
- Exclusão de orçamento (sem pedidos ativos, vendas ou peças separadas; fica no histórico de backups).
- Numeração: novos orçamentos a partir de **ORC-00000203**.
- Orçamentos antigos (uma peça) são convertidos automaticamente; nada é perdido.

### Produção: pedidos e produções para estoque
- “OP” virou **Pedido** (PED-…) e **Produção para estoque** (EST-…). Abas: Quadro, Pedidos a partir de orçamento, Produções para estoque, Histórico.
- **Enviar para produção** escolhe as peças aprovadas e exige a **data de entrega**; cada peça vira um pedido.
- O **Kanban é ordenado pela data de entrega** (próximas no topo; selo de “atrasado” e de entrega em até 3 dias).
- **Retornar para o orçamento**: cancela o pedido, libera o material e a peça volta a ficar aprovada e editável.
- Produção para estoque calcula **custo e valor sugerido de venda** na criação; ao concluir, as peças vão para o estoque.
- **Orçar para cliente** a partir de uma peça do estoque: a peça só sai do estoque no **“Pedido aprovado”**.
- **Cartão de agradecimento** por pedido, no modelo oficial (frente e verso, 12 × 12 cm), com opção de personalizar o nome.

### Estoque
- Nova aba **Peças produzidas**: balões com quantidade, valor investido e potencial de venda; um cartão horizontal por peça
  com filamento gasto, tempo, custo, valor previsto de venda e dias parada.

### Cadastros e parâmetros
- Código dos insumos pela **sigla da categoria**: FL00002 → próximo filamento FL00003; etiquetas ET00001… (sigla editável na categoria).
- **Recomendações** viraram uma sub aba ao lado de “Fontes de captação”, e cada campo mostra o valor recomendado logo abaixo.

## v1.4.0 — 21/10/2026

### Orçamento para o cliente
- Botão **“Orçamento para o cliente”** em cada orçamento salvo: documento A4 com a identidade da marca, pronto para
  **Baixar PDF** (pela janela de impressão → “Salvar como PDF”) e **Copiar mensagem** para o WhatsApp.
- Conteúdo pensado para o cliente: saudação e agradecimento, foto da peça (só quando o orçamento tem foto), material,
  quantidade, valor por peça, desconto, frete, total em destaque, prazo de produção, pagamento, validade e contatos.
  **Nenhum custo, margem, markup, peso ou tempo de máquina** aparece (coberto por teste).
- Frete no orçamento: novo botão **“Cliente paga”** (o frete escolhido aparece e é somado no documento); “Empresa paga”
  mostra “Frete grátis” ao cliente.
- Textos e contatos padrão em Parâmetros de Custos → Gerais → Orçamento para o cliente (podem ser ajustados a cada envio).

## v1.3.0 — 21/10/2026

### Compras da empresa
- O módulo Compras agora registra **todas as compras**: insumos de qualquer categoria (filamento, etiquetas, embalagens,
  cola, lixas…) e **equipamentos** (impressora, ferramentas duráveis).
- Insumos vão para o estoque com custo por unidade; dá para **cadastrar um insumo novo dentro da própria compra**.
- Equipamento é **investimento**: não entra no estoque nem como despesa do mês. Impressora pode ser cadastrada pela compra
  (o custo total, com frete rateado, vira o valor de aquisição) ou atualizar o valor de uma impressora já cadastrada.
- Frete e outros custos são rateados por valor entre todos os itens; o financeiro separa os títulos em “Compra de insumos”
  e “Impressoras e equipamentos”. Cancelar a compra desfaz estoque, títulos e a impressora (se não tiver uso).
- Novo insumo que não é filamento já começa na unidade “un”.

## v1.2.0 — 21/10/2026

### Frete por orçamento
- Cada orçamento tem a **sua caixa** (comprimento, largura, altura e peso da embalagem) e o seu **CEP de saída**, salvos na versão do orçamento.
- Novo orçamento já vem com o endereço padrão de saída e a caixa padrão de Parâmetros de Custos → Gerais → Envios; dá para
  alterar só naquele orçamento e voltar ao padrão com um clique. O CEP de destino vem do cliente e também pode ser trocado.
- O endereço de saída fica só nos dados da empresa (Supabase, protegido por login), nunca no código público.

## v1.1.1 — 21/10/2026

### Removido
- Módulo **Tendências de produção** (dependia de uma API paga). Removidos a tela, a função `/api/tendencias`, a variável
  `ANTHROPIC_API_KEY` e as bibliotecas `@anthropic-ai/sdk` e `zod`. Relatórios salvos na v1.1.0 são descartados ao abrir.

## v1.1.0 — 21/10/2026

### Correções importantes de cálculo
- **Tempo de produção**: o campo agora tem horas e minutos separados. Antes, “1,20” era lido como 1,2 h (1 h 12 min) e
  o campo apagava números durante a digitação. 1 h 20 min = 1,3333 h; testes cobrem todas as combinações de 0 a 30 h × 0 a 59 min.
- Campos decimais não apagam mais “0” ao digitar “0,5”. Conversões R$/kg ↔ R$/g e W → kWh/h auditadas com testes.

### Novidades
- **Produção reorganizada**: quadro Kanban (sequência da fila, em produção, acabamento/inspeção, produzidas) com arrastar e soltar
  e setas para mudar a ordem; aba **Pedidos de clientes** (cliente, prazo, valor, situação, registrar venda na entrega);
  aba **Peças prontas** (pronta-entrega) com data de produção, dias parado, custo real, preço sugerido, venda e baixa.
- OP do tipo **Estoque** envia as peças aprovadas para Peças prontas ao concluir; vendas dessas peças baixam o saldo.
- **Sinal de compra**: o estoque projetado desconta o material de ordens ainda não reservadas; “comprar já” quando falta
  material para as ordens abertas (também na ordem da fila, no Kanban), selo no menu Estoque, alerta no Painel e em Cadastros.
- **CEP automático** (ViaCEP) em todos os endereços; cadastros de clientes/fornecedores só exigem o nome.
- **Frete pela SuperFrete** no orçamento (CEP do cliente, caixa padrão e peso das peças); opção “empresa paga” entra no custo.
- **Tendências de produção**: pesquisa diária na internet (Claude, com fontes) de peças em alta, com custo, preço pelo markup
  e lucro por hora de máquina calculados com os seus parâmetros.
- **Recomendações** em Parâmetros de Custos, com a Bambu Lab A1 de R$ 4.769,10 (depreciação R$ 0,6359/h) e botão para criá-la.

### Configuração
- Novas variáveis secretas na Vercel: `SUPERFRETE_TOKEN` e `ANTHROPIC_API_KEY` (ver docs/DEPLOY.md).

## v1.0.1 — 21/10/2026

### Ajustes visuais
- Logo maior na barra superior e na tela de login: novo arquivo do símbolo oficial recortado no contorno
  (`public/brand/simbolo_recortado_fundo_escuro.svg`), sem a margem interna que o deixava pequeno.

## v1.0.0 — 20/10/2026

Primeira versão publicada (Supabase + Vercel).

### Infraestrutura
- Dados no **Supabase** (PostgreSQL), com login por e-mail e senha (Supabase Auth) e um único usuário com acesso total.
- Segurança por RLS: somente usuários liberados em `app_members` leem e gravam; visitantes não têm acesso.
- Gravação transacional com controle de versão (evita que uma aba sobrescreva outra) e **histórico automático** das 100 últimas versões, com restauração pela tela.
- Importação dos dados que estavam no navegador; exportação/restauração de backup em JSON.
- Deploy na **Vercel**; verificação automática (tipagem, testes, build) no GitHub Actions.

### Funcionalidades
- **Orçamentos**: lista em balões; cliente, descrição, filamentos com peso, tempo, link do MakerWorld, imagem; preço do filamento vindo do cadastro; rubricas ajustáveis; custo total, custo/hora, valor sugerido (markup) e valor para o cliente; R$/h, lucro, markup e margem sobre a venda; versões imutáveis.
- **Produção**: ordens a partir do orçamento, reserva por ordem de entrada, consumo real, falhas, previsto × realizado, projetos.
- **Estoque**: lotes, saldos físico/reservado/disponível, inventário, perdas, reposição.
- **Compras**: lote + estoque + financeiro numa operação, rateio de frete, à vista ou parcelado.
- **Financeiro**: contas a pagar/receber, vendas, fluxo de caixa, resultado gerencial e por produto.
- **Cadastros**: materiais, clientes (dados obrigatórios, CPF/CNPJ validado, fonte de captação), fornecedores, marcas, fabricantes.
- **Parâmetros de Custos**: parâmetros gerais e padrões, impressoras, canais, despesas indiretas, fontes de captação.
- Listas suspensas pesquisáveis em todo o sistema; layout responsivo; identidade visual da marca.

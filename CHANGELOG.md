# Histórico de versões

Formato: [versionamento semântico](docs/VERSIONAMENTO.md). Datas no padrão DD/MM/AAAA.

## v1.23.1 — 09/11/2026

### Domínio próprio (ideiacubica.com.br)
- Usando o sistema em `sistema.ideiacubica.com.br`, os links, o WhatsApp e o QR Code dos catálogos saem em
  `catalogo.ideiacubica.com.br/c/<link>` (no endereço da Vercel continua como antes). `VITE_CATALOG_URL` fixa outro endereço, se precisar.
- `catalogo.ideiacubica.com.br` aberto sem link mostra uma página da Ideia Cúbica, nunca a tela de login do sistema.
- Links antigos (`ideiacubica-app.vercel.app/c/…`) continuam funcionando.

## v1.23.0 — 09/11/2026

### Produção: peso real da peça e resultado reajustado
- Ao passar de **Em produção** para **Acabamento/Inspeção** (arrastando, pelo botão do cartão ou dentro do pedido),
  o sistema pede o **peso real de 1 peça** e a **purga/descarte do lote** (torre de purga, “poop”, brim, suportes).
  Mostra na hora o filamento real por peça e a diferença para o orçamento. Não é obrigatório: para seguir sem medir,
  é preciso marcar **“Não informar desta vez”**. Dá para medir ou corrigir depois, dentro do pedido.
- No pedido, o novo bloco **Resultado da peça** mostra lado a lado **Previsto (orçamento)**, **Realizado** (consumo e
  tempo reais da conclusão) e **Reajustado** (o orçamento recalculado com o peso e a purga reais, ao mesmo preço
  vendido): filamento por peça, custo por peça e do pedido, valor líquido, resultado e margem.
- Mostra o **preço sugerido com o peso real** (mesmo markup do orçamento) para acertar os próximos orçamentos.
- Na conclusão, o consumo de filamento já vem preenchido com a medição (peso × quantidade + purga).

## v1.22.0 — 09/11/2026

### Catálogo
- **5 produtos por linha** no computador (celular: 2; telas médias: 3 ou 4).
- **Barra de navegação fixa no topo** com um botão por seção (Destaques, Produtos selecionados, Kits promocionais,
  Ofertas especiais, Mais vendidos, Novidades ou as seções que você criar): o cliente toca e vai direto à seção.
- **Catálogo Geral** (Novo catálogo → Catálogo Geral): junta catálogos já montados. Cada catálogo incluído vira um
  **módulo** (categoria). O cliente vê a **Visão geral** com todas as peças, agrupadas por módulo, ou entra num módulo e
  navega pelas seções dele. O visual, o contato, o carrinho e o desconto são os do Catálogo Geral. Os módulos podem ser
  renomeados e reordenados. Ao publicar, o geral usa o conteúdo atual dos catálogos incluídos (alterou um deles:
  “Atualizar publicação” no geral também).

## v1.21.1 — 05/11/2026

### Causa raiz da CPU no limite: conflito repetido sem parar
**Requer rodar no Supabase:** `supabase/migrations/20261105100000_v1_14_conflito_sem_repeticao.sql`.
- Quando dois aparelhos gravavam quase ao mesmo tempo, a gravação desatualizada era recusada com o código **40001**
  ("conflito entre transações" do Postgres). A API do Supabase **repete automaticamente** operações com esse código,
  e como o nosso conflito não se resolve sozinho, ela repetia sem parar — 1 tentativa por segundo por gravação presa,
  até a CPU esgotar. Agora o conflito usa o código **PT409**: a API devolve na hora "recarregue a página", sem repetir.
- O SQL também encerra as chamadas que estavam presas nesse ciclo.
- A gravação no app tem limite de tempo (45 s): se o servidor não responder, aparece um aviso em vez de “Salvando…” para sempre.

## v1.21.0 — 05/11/2026

### Desempenho: fim da sobrecarga de CPU do banco
**Requer rodar no Supabase:** `supabase/migrations/20261105000000_v1_13_desempenho.sql`. Até lá, o sistema funciona do jeito antigo.

Causas encontradas e corrigidas:
- **Cada operação regravava o sistema inteiro** (um documento de vários MB) no banco. Agora cada registro é uma linha
  (`app_records`) e cada gravação envia só o que mudou — normalmente poucos KB. Os dados atuais são divididos
  automaticamente pelo SQL, sem perda (conferido com testes num Postgres local).
- **Cópia de segurança de vários MB a cada 10 minutos de uso:** agora no máximo 1 por hora, montada no próprio banco
  (mantém 48 = 2 dias). O histórico antigo fica com as 10 cópias mais recentes.
- **Todas as fotos eram baixadas do banco a cada login:** agora ficam guardadas no navegador; o banco só entrega as novas.
- **Catálogo:** a gravação automática reenviava todas as fotos a cada alteração (até a cada tecla). Agora só envia foto
  nova e grava 2,5 s depois da última alteração.
- **Catálogo público:** cada visitante buscava cada foto direto no banco. Agora as fotos passam por `/api/catalogo-foto`,
  com cache da Vercel e do navegador.
- **Permissões (RLS)** eram verificadas para cada linha lida; agora uma vez por consulta. Índice novo para as visitas do catálogo.
- Auditoria cortada em lote (não regrava a lista inteira a cada operação).

## v1.20.0 — 02/11/2026

### Catálogo: carrinho do cliente
- O cliente monta o **pedido (o kit dele)** com produtos e kits do catálogo: “Adicionar ao pedido”, quantidade com + e −,
  barra fixa com itens e **total previsto**. O pedido fica guardado só no navegador do cliente.
- **Desconto por valor:** pedidos **acima de R$ 200,00 ganham 5%** (padrão; valor e % ajustáveis em Loja e contato).
  O cliente vê quanto falta para ganhar o desconto. Itens sem preço exibido entram como “a combinar”.
- **Enviar pedido pelo WhatsApp:** a mensagem chega com a lista (quantidade, preço, subtotal), desconto, total previsto
  e a observação do cliente, para negociar e seguir para produção/pagamento.

### Catálogo: botão PERSONALIZADO
- Faixa “Quer uma peça do seu jeito?” com o botão **PERSONALIZADO**, que abre o WhatsApp para o cliente pedir um
  produto sob medida. Texto e exibição configuráveis.

### Catálogo: layout próprio e temáticas novas
- Temática **Personalizado (meu layout)**: cores (fundo, cartões, textos, principal, destaque, preço), degradê da capa,
  fontes dos títulos e do texto, formato dos selos, **ícones** e **imagem de fundo**. Pode começar copiando uma temática.
- Temáticas novas: **Corporativo**, **Eventos (aniversários, casamentos, shows)** e **Itens Religiosos**.

## v1.19.1 — 02/11/2026
- Corrige a configuração de publicação (vercel.json) que impediu a v1.19.0 de entrar no ar.

## v1.19.0 — 02/11/2026

### Novo: Catálogo digital (menu Catálogo)
**Requer rodar no Supabase:** `supabase/migrations/20261103000000_v1_12_catalogo.sql` (SQL Editor → colar → Run).

- **Lista de catálogos:** nome e temática, data de criação, situação (Rascunho, Publicado, Expirado), visitas, validade do
  link e ações (editar, duplicar, publicar/atualizar, visualizar e compartilhar, expirar, excluir).
- **12 temáticas** com cores, fontes, enfeites e banner próprios: Natal, Ano Novo, Carnaval, Black Friday, Dia das Mães,
  Dia dos Pais, Dia dos Namorados, Páscoa, Dia das Crianças, Halloween, Liquidação de Verão e Minimalista/Profissional.
  Trocar a temática muda só o visual.
- **Produtos:** busca nas peças dos orçamentos e nas peças prontas do estoque. Cada produto é uma **cópia**: nome comercial,
  descrição, foto própria (ou a da peça), preço original, preço promocional, exibir ou não o preço, selo e ordem.
  Editar o catálogo nunca altera o orçamento; mudar ou excluir o orçamento não estraga o catálogo.
- **Kits promocionais:** dois ou mais produtos do catálogo, com nome, descrição, imagem, preço de referência (soma dos
  produtos), preço promocional e selo. Aparecem em destaque com a composição, o desconto e quanto o cliente economiza.
- **Selos:** MAIS VENDIDO, LANÇAMENTO, OFERTA ESPECIAL, EXCLUSIVO, ÚLTIMAS UNIDADES, COMBO PROMOCIONAL, PRESENTE IDEAL,
  DESTAQUE ou texto próprio. **Banners** no cabeçalho e antes de cada seção.
- **Seções** (Destaques, Ofertas especiais, Kits promocionais, Mais vendidos, Novidades, Produtos selecionados ou nome
  próprio), com ordem das seções e dos produtos.
- **Personalização:** nome da loja, logotipo, capa, texto de apresentação, cores principais, contatos e validade da campanha.
- **Pré-visualização ao vivo** em modo celular e computador. Grava sozinho a cada alteração.
- **Publicação:** link aleatório e não sequencial (`/c/<12 caracteres>`), sem expiração, com data e hora, ou expiração
  manual. Atualizar no mesmo link, reativar ou gerar um link novo (os antigos ficam no histórico).
  Copiar, compartilhar, WhatsApp, **QR Code** (com download) e ver o catálogo publicado.
- **Página do cliente:** sem login e sem instalar nada, feita para o celular; capa, banners, seções, produtos e kits,
  preços “De/Por”, abrir produto, compartilhar produto e **botão fixo de WhatsApp** com a mensagem do produto.
  Link expirado mostra uma página amigável. Sem checkout nem pagamento nesta versão.
- **Segurança:** o link e a validade são conferidos no banco a cada acesso; o cliente só recebe a cópia publicada
  (nunca custos, margens ou dados dos orçamentos). Não existe lista pública de catálogos.
- **Estatísticas:** visitas (uma por sessão), produtos abertos, cliques em contato e compartilhamentos, com data e hora.
  Nenhum dado pessoal do visitante é guardado.

## v1.18.0 — 02/11/2026

### Estoque de peças produzidas
- O número grande agora é **em estoque** (o que está na prateleira), com o detalhe “livres para venda · separadas para
  pedido”. Antes, a peça separada para o cliente aparecia como “0 disponíveis”, parecendo que tinha sumido.

### Quadro de produção (Kanban)
- A área de soltar ocupa a **coluna inteira, até embaixo**: todas as colunas têm a altura da mais longa.
- Cada cartão tem o botão de **próxima etapa**: Iniciar produção → Enviar para acabamento → Concluir (produzida) →
  Estoque ou entregue. Faz o mesmo que arrastar.

## v1.17.0 — 02/11/2026

### Retornar ao orçamento em qualquer etapa
- **Retornar para o orçamento** agora aparece em todo pedido de orçamento (fila, produzindo, produzido, no estoque
  ou entregue). Já produzido: a produção é desfeita (o filamento consumido volta ao estoque e as peças prontas geradas saem).
- Pedido de cliente enviado ao estoque (peças separadas para ele) não fica mais travado para excluir ou retornar.
- Quando algo precisa ser desfeito antes, o pedido mostra o aviso **“desfaça antes”** com os botões no próprio pedido:
  **Ver recebimentos** (para estornar), **Cancelar venda** e o link para as peças produzidas.

## v1.16.0 — 02/11/2026

### Recebimento do cliente desde o “A produzir”
- Ao **enviar a peça para produção**, o valor do pedido entra em **Financeiro → Contas a pagar e receber** como conta a
  receber, com **vencimento na data de entrega** (marcada como “pedido em produção”).
- O cliente pode pagar **antes** — sinal ou total — a qualquer momento: no pedido (quadro de Produção → abrir o pedido →
  **Pagamento do cliente → Registrar recebimento**) ou em Contas a receber. O cartão do quadro mostra “sinal R$ …” ou “pago”.
- Na entrega, a **venda aproveita o que já foi pago**: entra como recebido e só o restante vira conta a receber
  (sem duplicar). Pago todo antes: a venda já nasce paga.
- Cancelar a venda devolve o que foi pago para a conta do pedido. Retornar o pedido ao orçamento, cancelar ou excluir
  retira a conta (com pagamento registrado, pede o estorno antes).
- Não é receita: o resultado continua contando a venda na entrega; o dinheiro recebido aparece no extrato no dia em que entrou.

### Pedidos que já estavam na esteira
- Ao abrir o sistema, os pedidos na fila, em produção, aguardando destino ou separados no estoque para o cliente
  são levados automaticamente para Contas a receber (uma vez). Se algum ficar de fora, Contas a pagar e receber mostra
  o aviso com o botão **Levar para Contas a receber**.

## v1.15.0 — 02/11/2026

### Orçamentos → Peça de outro orçamento
- Novo orçamento ganhou a opção **Peça de outro orçamento** (junto de “Criar nova peça” e “Peça do estoque”), e dentro do
  orçamento o botão **+ Peça de outro orçamento**. Busca por peça, cliente ou número, escolhe UMA peça e a quantidade.
- A peça entra como modelo novo com tudo o que foi preenchido (filamento, peso, tempo, foto, dimensões, complementos e ajustes),
  sem duplicar o orçamento inteiro. O orçamento de origem não muda. O valor é recalculado com os custos de hoje.

## v1.14.0 — 02/11/2026

### Orçamentos → Por orçamento
- Nova sub-aba com a lista de orçamentos: **Valor, Por peça, Custo, Resultado, Total de horas e R$/h**, com totais no topo
  (valor, custo, resultado e % do valor, horas e R$/h médio). Filtra por situação e busca; colunas ordenáveis.
- Resultado = valor − taxas do canal − custo total (o mesmo do painel do orçamento). Peças recusadas ficam de fora.

### Financeiro → Extrato total
- Tudo o que entrou e saiu **desde o início** ou de **um mês** (clique no mês na tabela ou escolha no seletor), por conta.
- **Mês a mês**: entrou, saiu, entrou − saiu e saldo no fim de cada mês, com o total geral.
- **De onde veio / para onde foi o dinheiro**: agrupado por natureza (vendas, compra de insumos, equipamentos, despesas fixas, taxas…).
- **Resultado da empresa**: vendas − taxas ± frete − custo das peças vendidas = lucro das vendas − despesas fixas = resultado.
- **Onde está o dinheiro que saiu**: insumos e peças prontas em estoque (a custo), equipamentos pagos, a receber e a pagar —
  explica por que o caixa pode estar negativo mesmo com vendas lucrativas.
- **Resultado por venda**: valor, taxas, frete, custo das peças, lucro, margem e se já foi recebido.
- Lista completa de entradas e saídas e planilha CSV.

## v1.13.0 — 01/11/2026

### Peça produzida: estoque ou entregue
- No quadro de produção, a coluna **Produzidas** mostra as peças concluídas aguardando destino. Clicando na peça:
  **1 · Vai para o estoque** (Estoque → Peças produzidas; pedido de cliente fica separado para ele, com o botão
  **Entregar (registrar venda)**) ou **2 · Peça entregue** (registra a venda, pago ou a pagar). Depois disso a peça sai do quadro.
- Cancelar a venda devolve a peça para a coluna Produzidas.

### Módulo Vendas (menu, abaixo de Estoque)
- Todas as vendas com a situação do pagamento: **Pago** ou **A pagar** (com vencimento e aviso de atraso), lucro de cada venda,
  filtros por situação e mês, e o botão **Receber** para registrar o pagamento do cliente. Aviso no menu quando há atraso.

### Financeiro
- **Extrato**: entradas e saídas de dinheiro do mês, com saldo inicial, saldo acumulado linha a linha e o detalhe de cada uma
  (itens da compra, peça e cliente da venda, observação da despesa). Filtro por conta e download em planilha (CSV).
- **Fechamento mensal**: resultado do mês (vendas, taxas, custo das peças, margem, despesas fixas, lucro), caixa por categoria,
  resultado por peça vendida, despesas do mês com detalhe, material consumido e peças produzidas. **Fechar mês** registra os
  números; se algo for lançado depois, a tela mostra a diferença. Lista dos meses fechados para comparar.

## v1.12.0 — 31/10/2026

### Duplicar orçamento
- Novo botão **Duplicar orçamento** dentro do orçamento: cria um orçamento novo (número novo) com as mesmas peças, fotos,
  dimensões, valores salvos e kit de entrega, para outro cliente (escolhido na hora ou cadastrado ali mesmo).
- Na cópia, todas as peças começam “aguardando cliente”; o original não muda. O frete não é copiado, porque depende do endereço
  do novo cliente.

## v1.11.1 — 30/10/2026

### Lentidão no login (“Verificando permissões…”)
- Causa: o banco ficou lento (consultas simples levando até 15 s) por excesso de leitura/escrita em disco: cada gravação enviava
  vários MB (fotos dentro dos dados) e o histórico guardava cópias completas. A tabela de fotos da v1.11 ainda não tinha sido criada.
- Novo arquivo único `supabase/CORRIGIR_LENTIDAO.sql`: aplica de uma vez as atualizações v1.9, v1.10 e v1.11, deixa o histórico
  com as 10 cópias mais recentes e mostra os tamanhos no final.
- Ao abrir o sistema, se os dados ainda tiverem fotos dentro e o banco já tiver a tabela de fotos, o sistema separa as fotos
  sozinho, uma única vez, em segundo plano.

## v1.11.0 — 30/10/2026

### Gravação mais rápida
- Causa da lentidão: cada gravação (salvar orçamento, compra, venda…) enviava o sistema inteiro ao banco, **com todas as fotos**.
  Quanto mais peças com foto, mais lenta cada gravação, mesmo para uma alteração pequena.
- Agora cada foto é guardada **uma única vez** numa tabela própria (`app_images`), identificada pelo conteúdo, e o documento do
  sistema guarda só a referência. A gravação envia só os dados (pequenos); uma foto nova sobe uma vez só.
- Transparente para o uso: ao abrir o sistema, as fotos são carregadas normalmente. Restaurar uma versão do histórico também funciona.
- Aviso **“Salvando…”** quando a gravação passa de meio segundo.
- Configuração única: rodar `supabase/migrations/20261030000000_v1_11_fotos_separadas.sql` no SQL Editor (sem ele, o sistema
  continua funcionando do jeito antigo).

## v1.10.1 — 30/10/2026

- Login: quando o Supabase não responde (“Failed to fetch”, erro 522), a tela explica que o servidor do banco está fora do ar
  e como reiniciar o projeto, em vez da mensagem técnica do navegador.

## v1.10.0 — 29/10/2026

### Usuários (Configurações → Usuários)
- O **dono** do sistema cria usuários (nome, e-mail e senha), define a senha de qualquer usuário e remove acessos,
  tudo por dentro do sistema. Cada usuário pode **trocar a própria senha**.
- Papéis: **dono** (acesso total + administra usuários) e **usuário** (acesso total aos dados, sem administrar usuários).
- A criação de login usa a chave secreta do Supabase **só no servidor** (Vercel, `SUPABASE_SERVICE_ROLE_KEY`); ela nunca vai
  para o navegador nem para o código.
- Configuração única: rodar `supabase/migrations/20261029000000_v1_10_usuarios.sql` e cadastrar a chave na Vercel (docs/DEPLOY.md).

## v1.9.1 — 28/10/2026

### Dimensões da peça na proposta
- No orçamento, cada modelo tem os campos **Altura, Largura e Profundidade** (cm) sempre visíveis, sem caixa de marcar.
  São opcionais: medidas em branco não aparecem para o cliente.
- **Peças do estoque** também têm dimensões (ao lançar a produção para estoque e em Estoque → Peças produzidas → Editar);
  elas vão automaticamente para o orçamento feito com a peça.
- Ao **juntar orçamentos**, cada peça leva as suas dimensões para o novo orçamento, e a proposta do cliente mostra
  “Dimensões aprox.” em destaque em cada peça. As dimensões também aparecem na lista de “Juntar orçamentos” e no comparador.

## v1.9.0 — 28/10/2026

### Correção: “canceling statement due to statement timeout” ao gravar
- Causa: o sistema grava todos os dados num único registro e, a cada gravação, guardava uma cópia completa no histórico.
  As fotos das peças eram repetidas em cada versão de cada orçamento, e juntar orçamentos copiava as fotos de novo; os dados
  ficaram grandes a ponto de a gravação passar do tempo limite do Supabase (8 s) e ser cancelada (nada é gravado pela metade).
- Fotos dos orçamentos agora ficam só na versão atual (as versões antigas usam a foto atual). Os dados existentes são
  compactados automaticamente na próxima gravação.
- Banco (rodar uma vez `supabase/migrations/20261028000000_v1_9_gravacao_rapida.sql` no SQL Editor): tempo limite de 30 s e
  histórico com no máximo 1 cópia a cada 10 minutos (mantém as 30 mais recentes).
- Mensagem clara quando o banco cancela por tempo.

### Juntar orçamentos
- Sempre cria um orçamento **novo**; os orçamentos de origem nunca são excluídos nem alterados. A opção de excluir saiu da tela.

## v1.8.0 — 25/10/2026

### Correção de cálculo: arredondamento distorcia o valor de peças pequenas
- Causa: o arredondamento comercial (final ,90) era aplicado em **cada peça**. 4 peças de 10,10 g davam 4 × R$ 2,90 = R$ 11,60,
  enquanto 1 peça de 40,38 g com o mesmo filamento dava R$ 8,90. O mesmo efeito escondia a diferença de preço entre filamentos.
- Agora o arredondamento é feito **uma vez no total do modelo** e tem **limite de +5%** (acima disso, só centavos).
  O mesmo exemplo dá R$ 8,92 × R$ 8,90, e um filamento 33% mais caro dá um valor 33% maior.
- A tela mostra o valor calculado e o arredondado do modelo. Rubricas ajustadas à mão geram aviso (valores fixos que não mudam
  com quantidade, peso ou filamento), com o botão para voltar ao calculado.
- **Comparar orçamentos** (Orçamentos → Comparar orçamentos): dois modelos lado a lado, com o que foi preenchido, o custo por peça
  de cada rubrica e a explicação de onde vem a diferença.
- Orçamentos salvos antes desta versão mantêm o valor salvo e mostram o aviso “os custos mudaram”: use “Atualizar para os custos de hoje”.

### Novidades
- **Foto** na produção para estoque (ao lançar e depois, no pedido) e nas peças em Estoque → Peças produzidas.
- **Novo orçamento começa em branco** com duas opções: **Criar nova peça** ou **Peça do estoque** (sem “Modelo 1” vazio sobrando).
- **Complementos de 1 peça**: luminária, ímã, parafuso… escolhidos dos insumos cadastrados (preço da última compra) ou custo avulso.
  São reservados e baixados do estoque na produção.
- **Ocultar/Mostrar** em todos os blocos do orçamento (cliente, modelos, modelo, filamento, tempo, complementos, frete, kit,
  valor e composição do custo).

## v1.7.0 — 24/10/2026

### Novidades
- **Importar filamentos** (Cadastros → Materiais): baixe o modelo, preencha no Excel/Google Planilhas (uma linha por cor/tipo)
  e envie o .csv ou cole as células. A tela confere cada linha antes de gravar (cor, tipo, peso em gramas, preço R$/kg fora do
  normal, nomes repetidos), cria marcas e fabricantes que faltam e pode atualizar os filamentos já cadastrados.
- **Dimensões aproximadas da peça** (altura, largura, profundidade) no orçamento, opcionais. Aparecem no orçamento do cliente
  e não alteram o preço salvo.
- **Excluir pedido/produção por completo** (Produção → abrir o pedido → Excluir): desfaz reservas e baixas de material
  (o filamento volta ao estoque), apaga as peças produzidas por ele e, se veio de orçamento, a peça volta a “Aprovada”.
  Bloqueado só se houver venda ou se as peças já foram vendidas/separadas.

### Ajuste
- **Filamento sempre em gramas** na compra e na correção de custo (o custo continua em R$/kg). Ao lado da quantidade aparece a
  conferência “1.000 g = 1 kg = 1 carretel”, e custos fora do normal continuam com alerta.

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

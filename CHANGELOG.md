# Histórico de versões

Formato: [versionamento semântico](docs/VERSIONAMENTO.md). Datas no padrão DD/MM/AAAA.

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

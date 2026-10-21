# Histórico de versões

Formato: [versionamento semântico](docs/VERSIONAMENTO.md). Datas no padrão DD/MM/AAAA.

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

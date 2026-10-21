# Ideia Cúbica — Sistema de Gestão, Orçamentação e Produção 3D

Versão **1.0.0**. Aplicação web em React + TypeScript (Vite), com dados no **Supabase**, publicada na **Vercel** e
versionada no **GitHub**. Regras de negócio isoladas, cálculos em precisão decimal e testes automatizados.

| Documento | Conteúdo |
| --- | --- |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Passo a passo para colocar no ar (Supabase, usuário, Vercel) |
| [docs/VERSIONAMENTO.md](docs/VERSIONAMENTO.md) | Versões, migrations do banco e estratégia de backup |
| [docs/REGRAS_DE_CALCULO.md](docs/REGRAS_DE_CALCULO.md) | Todas as fórmulas do sistema |
| [CHANGELOG.md](CHANGELOG.md) | O que mudou em cada versão |

## Como executar no computador (Windows / CMD)

Pré-requisito: **Node.js 20 ou superior** (testado com 24). Verifique com `node -v`.

```bat
copy .env.example .env.local
```
Preencha `VITE_SUPABASE_ANON_KEY` no `.env.local` (ver docs/DEPLOY.md, passo 1). Depois:
```bat
npm install
npm run dev
```

O navegador abre em **http://localhost:5173**. Para parar o servidor: `Ctrl + C` no CMD.
Atalho: dê dois cliques em `iniciar.bat` (instala as dependências na primeira vez e inicia).
Para testar sem nuvem e sem login, use `VITE_STORAGE_DRIVER=local` no `.env.local`.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento com recarga automática ao editar o código |
| `npm test` | Executa os 67 testes automatizados (cálculos, estoque, financeiro, produção, leitura de arquivos) |
| `npm run typecheck` | Verificação de tipos TypeScript |
| `npm run build` | Gera a versão de produção em `dist/` (base para a Vercel) |

## Onde ficam os dados

- **Produção** (`VITE_STORAGE_DRIVER=supabase`): banco **Supabase**, acessível de qualquer dispositivo após o login.
  Somente usuários liberados em `app_members` acessam (v1: um único usuário com acesso total).
  Cada gravação é transacional, com controle de versão, e gera uma cópia no histórico (restaurável na tela de Backup).
- **Modo local** (`VITE_STORAGE_DRIVER=local`): navegador, sem login — útil para testes offline.

**Modelo de dados da v1:** o estado completo é um documento JSONB (`app_state`) gravado pela função `save_app_state`.
É a forma mais segura de colocar no ar sem reescrever as regras já testadas. A próxima etapa, com tabelas por entidade,
relatórios em SQL e múltiplos usuários, está desenhada em `supabase/planned/normalized_schema.sql`. Imagens dos
orçamentos ainda ficam dentro dos dados (reduzidas); a evolução prevista é o Supabase Storage.

## Primeiros passos no sistema

O Painel mostra um checklist. Nenhum parâmetro tem valor padrão oculto — enquanto faltar algo, os orçamentos aparecem como
**incompletos** e listam o que falta.

1. **Parâmetros de Custos → Parâmetros gerais**: tarifa de energia, custo da hora de trabalho, horas produtivas/mês e os padrões de
   cada novo orçamento (impressora, canal, **markup**, taxa de falha, mão de obra por orçamento e por peça, arredondamento).
   Em **Fontes de captação**, ajuste a lista (Instagram, Venda direta, Mercado Livre, Shopee…).
2. **Parâmetros de Custos → Impressoras**: valor, residual, vida útil, consumo de energia, manutenção por hora.
3. **Parâmetros de Custos → Canais de venda**: tributos, comissões e taxas (valide alíquotas com o contador).
4. **Parâmetros de Custos → Despesas indiretas**: internet, software, aluguel… (rateadas por hora de máquina).
5. **Cadastros → Marcas / Fabricantes**, depois **Materiais**: filamentos com marca, fabricante e **preço (R$/kg)** — o orçamento usa
   esse preço (ou o da última compra) e ele não é editável no orçamento.
   **Cadastros → Clientes** (nome completo, endereço, telefone, CPF/CNPJ, fonte de captação) e **Fornecedores**.
6. **Configurações → Contas financeiras**: conta bancária/caixa com saldo inicial.
7. **Orçamentos → Novo orçamento**: cliente, descrição, filamentos com peso, tempo, link do MakerWorld e imagem.

## Módulos

| Módulo | Implementado |
| --- | --- |
| **Orçamentos** | Lista em balões (imagem, cliente, valor, custo, R$/h, situação). Formulário simples: cliente (com cadastro rápido), descrição da peça, quantidade, um ou mais filamentos com peso por peça, tempo de produção, link do MakerWorld, imagem do item e leitura opcional de 3MF fatiado. Cada rubrica do custo aparece com o valor calculado e pode ser **ajustada**; resultado com custo total, custo por hora, valor sugerido e mínimo, **valor para o cliente** (editável), R$/h faturado e lucro. Parâmetros do orçamento (margem, canal, falha, mão de obra, desconto, frete, outros custos) num painel recolhível. Versões imutáveis com snapshot de parâmetros |
| **Produção** | OP a partir do orçamento ou manual; reserva tudo-ou-nada, escolhendo lotes por ordem de entrada quando o orçamento não fixa lote; etapas de acabamento/inspeção; conclusão com consumo real, falhas e perdas (baixa única e idempotente); previsto × realizado; projetos com licença e versões de arquivo |
| **Compras** | Compras com vários itens, rateio de frete, conversão de unidades (kg→g), à vista ou parcelada; lote com custo próprio; cancelamento com estorno rastreável |
| **Cadastros** | Materiais (filamento com dados técnicos, marca, fabricante e preço, ou insumo geral com unidade), categorias configuráveis, clientes com dados obrigatórios e CPF/CNPJ validado, fornecedores, marcas e fabricantes |
| **Parâmetros de Custos** | Parâmetros gerais e padrões do orçamento (markup), impressoras (com desempenho e manutenção), canais de venda, despesas indiretas e fontes de captação |

Todas as listas suspensas do sistema são pesquisáveis: clique, digite parte do nome (sem precisar de acento) e escolha com o mouse
ou com ↑/↓ e Enter.
| **Estoque** | Lotes com físico, reservado e disponível; movimentações rastreáveis; inventário (inclusive por pesagem com tara do carretel); perdas; sugestão de reposição considerando reservas e consumo médio |
| **Financeiro** | Contas a pagar/receber com parcelas, liquidação parcial, estorno e cancelamento; vendas com encargos do canal (retidos ou não), frete e custo realizado/estimado; painel com caixa, projeção de 30 dias, resultado gerencial por competência, ponto de equilíbrio, fluxo de caixa e despesas por categoria; resultado por produto |

### Limitações conhecidas (não simuladas)

- **MakerWorld**: sem importação automática (não há API pública e a página bloqueia leitura direta). O link é salvo e os dados são digitados.
- **STL** não fornece peso nem tempo: o sistema mostra apenas geometria. Peso/tempo vêm do fatiador (3MF fatiado ou digitação).
- Arquivos de modelo não são armazenados (apenas nome/versão); upload ficará para o Supabase Storage.
- Imagens dos orçamentos ficam no armazenamento local, reduzidas para até 1000 px (limite de ~450 KB cada). Com muitas imagens o
  navegador pode ficar sem espaço — o sistema avisa ao salvar.
- Sem pedidos de compra em trânsito: compras são lançadas no recebimento.
- Sem estoque de produtos acabados.
- Um único usuário com acesso total (perfis e permissões por função ficam para a etapa de múltiplos usuários).

## Arquitetura

```
src/
  domain/        Regras de negócio puras e testáveis (sem React)
    money.ts       Precisão decimal (decimal.js), formatação BR
    types.ts       Modelo de dados (espelhado em supabase/migrations)
    costing.ts     Motor de custos do orçamento
    pricing.ts     Formação de preço, margem, markup, arredondamento
    quotes.ts      Snapshot de parâmetros e versionamento
    purchases.ts   Compra → lote + estoque + financeiro (uma transação)
    inventory.ts   Movimentações, saldos derivados, reservas, reposição
    production.ts  OPs, consumo idempotente, previsto × realizado
    finance.ts     Títulos, liquidações, saldos, fluxo de caixa
    sales.ts       Vendas, resultado gerencial e por produto
  data/          Persistência substituível (Supabase em produção; navegador no modo local)
  io/            Leitura de STL e 3MF
  ui/            Interface (React), tema da marca e telas
supabase/
  migrations/    SQL aplicado no banco (v1: app_state, histórico, segurança)
  liberar_usuario.sql  Libera o usuário com acesso total
  planned/       Modelo normalizado previsto para a próxima etapa
.github/         CI: tipagem, testes e build a cada envio
docs/            Regras de cálculo documentadas
```

Princípios: cada operação integrada é uma **transação** (clona o estado, aplica, valida, grava — se algo falha, nada muda);
saldos de estoque são **derivados das movimentações**; nenhum histórico é apagado (cancelamentos e estornos ficam registrados);
toda operação relevante entra na **trilha de auditoria**.

Regras de cálculo detalhadas: [docs/REGRAS_DE_CALCULO.md](docs/REGRAS_DE_CALCULO.md).

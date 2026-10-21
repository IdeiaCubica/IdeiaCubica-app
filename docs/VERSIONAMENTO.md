# Versionamento e backups

## Versões do código (GitHub)

Seguimos **versionamento semântico** — `vMAIOR.MENOR.CORREÇÃO`:

| Mudança | Exemplo | Nova versão |
| --- | --- | --- |
| Correção sem mudar comportamento | ajuste de texto, bug de cálculo | `v1.0.1` |
| Funcionalidade nova compatível | novo relatório, novo campo | `v1.1.0` |
| Mudança que exige migração/ação manual | troca do modelo de dados | `v2.0.0` |

Fluxo de cada versão:

1. Desenvolver em uma branch (`feature/nome-curto`) ou direto na `main` para ajustes pequenos.
2. Atualizar `CHANGELOG.md` e a `version` do `package.json`.
3. Enviar para o GitHub — o **CI** roda tipagem, testes e build; a **Vercel** publica a `main` automaticamente
   (branches geram links de *preview* para testar antes).
4. Criar a tag da versão: `git tag -a v1.1.0 -m "v1.1.0"` e `git push origin v1.1.0`
   (ou pelo site do GitHub: **Releases → Draft a new release**).

Para voltar uma versão publicada: Vercel → **Deployments** → escolha um deploy anterior → **Promote to Production**.

## Mudanças no banco (Supabase)

- Cada alteração de estrutura vira um novo arquivo em `supabase/migrations/` com data no nome
  (`AAAAMMDDHHMMSS_descricao.sql`), nunca editando um arquivo já aplicado.
- Aplicar no **SQL Editor** (ou com a Supabase CLI) **antes** de publicar o código que depende dela.

## Backups dos dados

| Camada | Como funciona | Onde |
| --- | --- | --- |
| Histórico automático | Cada gravação guarda uma cópia completa; ficam as 100 mais recentes. Restaurar não apaga nada. | Configurações → Backup e auditoria → Histórico de versões |
| Backup manual (.json) | Arquivo com todos os dados. Recomendado **semanalmente** e antes de grandes mudanças; guarde fora do computador (ex.: OneDrive/Google Drive). | Configurações → Backup e auditoria → Exportar |
| Backups do Supabase | Plano gratuito: sem backup automático diário. Planos pagos: backup diário e restauração a um ponto no tempo. | Supabase → Database → Backups |
| Código | Todo o histórico no GitHub; cada versão marcada com tag. | GitHub |

Recomendação: enquanto estiver no plano gratuito do Supabase, mantenha o **backup manual semanal**.

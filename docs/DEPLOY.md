# Colocar o sistema no ar — Supabase + Vercel + GitHub

```
Navegador ──► Vercel (site estático, build do GitHub) ──► Supabase (login + banco PostgreSQL)
```

- **GitHub** (`IdeiaCubica/IdeiaCubica-app`): código-fonte e versões (tags `v1.0.0`, `v1.1.0`…).
- **Vercel**: publica o site automaticamente a cada envio para a branch `main`.
- **Supabase** (`https://csqxwlfgtaskunqtaqkb.supabase.co`): login do usuário e banco de dados.

> Segurança: o site usa apenas a chave **anon (pública)** do Supabase. Quem protege os dados é o banco (RLS):
> só usuários liberados em `app_members` conseguem ler ou gravar. A **service_role key** e a **senha do banco**
> nunca devem ir para o site, para a Vercel, para o GitHub ou para mensagens.

---

## Passo 1 — Pegar a chave pública do Supabase

Supabase → seu projeto → **Project Settings → API** (ou **API Keys**):

| Item | Onde usar |
| --- | --- |
| Project URL — `https://csqxwlfgtaskunqtaqkb.supabase.co` | `VITE_SUPABASE_URL` |
| **anon / public** key (começa com `eyJ…` ou `sb_publishable_…`) | `VITE_SUPABASE_ANON_KEY` |
| service_role / secret key | **Não usar.** |

## Passo 2 — Criar as tabelas (uma vez)

Supabase → **SQL Editor → New query** → cole todo o conteúdo de
`supabase/migrations/20261020000000_v1_app_state.sql` → **Run**. Deve terminar com "Success".

Isso cria: `app_members` (usuários liberados), `app_state` (dados do sistema), `app_state_history`
(cópias de segurança) e a função `save_app_state` (gravação segura com controle de versão).

Depois, na mesma tela (**New query**), rode também `supabase/migrations/20261028000000_v1_9_gravacao_rapida.sql`
(v1.9): aumenta o tempo limite para 30 s e grava no histórico no máximo uma cópia a cada 10 minutos (mantém as 30 mais
recentes). Corrige o erro “canceling statement due to statement timeout” ao salvar.

## Passo 3 — Criar o usuário e bloquear novos cadastros

1. **Authentication → Users → Add user → Create new user**: seu e-mail e uma senha forte; marque
   **Auto Confirm User**. (A senha é digitada por você; ninguém mais precisa conhecê-la.)
2. **Authentication → Sign In / Providers** (ou *Settings*): **desative "Allow new users to sign up"**.
   Assim ninguém consegue criar conta pelo site.
3. **Authentication → URL Configuration**: em **Site URL** coloque o endereço da Vercel
   (ex.: `https://ideiacubica-app.vercel.app`) e adicione-o também em **Redirect URLs**
   — necessário para o link de "Esqueci minha senha".

## Passo 4 — Liberar o usuário no sistema

SQL Editor → cole `supabase/liberar_usuario.sql`, troque `SEU-EMAIL-AQUI@exemplo.com` pelo e-mail do passo 3 → **Run**.
A consulta final deve mostrar 1 linha com o seu e-mail e o papel `owner` (acesso total).

## Passo 5 — Publicar na Vercel

1. Vercel → **Add New… → Project** → importe `IdeiaCubica/IdeiaCubica-app`.
2. Framework: **Vite** (detectado automaticamente; o `vercel.json` já define build `npm run build` e saída `dist`).
3. **Environment Variables** (marque Production, Preview e Development):

   | Nome | Valor |
   | --- | --- |
   | `VITE_STORAGE_DRIVER` | `supabase` |
   | `VITE_SUPABASE_URL` | `https://csqxwlfgtaskunqtaqkb.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | a chave anon do passo 1 |

4. **Deploy**. Ao final, abra o endereço gerado, entre com o e-mail e a senha do passo 3.
5. Variáveis alteradas depois exigem **Redeploy** (Deployments → ⋯ → Redeploy).

### Frete pela SuperFrete (v1.1)

O token é **secreto**: fica só nas variáveis de ambiente da Vercel, **sem** o prefixo `VITE_`
(o prefixo `VITE_` publicaria o token no navegador). Nunca coloque no repositório nem envie por chat.

| Nome | Para quê | Onde gerar |
| --- | --- | --- |
| `SUPERFRETE_TOKEN` | Calcular frete no orçamento (seção 5) | web.superfrete.com → Integrações → Desenvolvedores → gerar token |
| `SUPERFRETE_BASE_URL` (opcional) | Usar o sandbox: `https://sandbox.superfrete.com` | — padrão: `https://api.superfrete.com` |

Marque **Production** (e Preview, se quiser testar em previews) e faça **Redeploy**. A função `/api/frete` só atende
usuários logados e liberados em `app_members`; sem a variável, a tela mostra o aviso “não configurada”.

### Usuários adicionais (v1.10)

A tela **Configurações → Usuários** cria logins, define senhas e remove acessos. Configuração (uma vez):

1. **Banco**: Supabase → SQL Editor → New query → cole `supabase/migrations/20261029000000_v1_10_usuarios.sql` → **Run**.
   Cria os papéis *dono* (owner, administra usuários) e *usuário* (member, usa o sistema).
2. **Chave de administração** (só no servidor): Supabase → **Project Settings → API Keys** → em **Secret keys**, crie/copie
   uma chave secreta (`sb_secret_…`; ou, na aba *Legacy*, a `service_role`).
   Vercel → projeto → **Settings → Environment Variables** → **Add**: nome `SUPABASE_SERVICE_ROLE_KEY`, valor = a chave,
   ambiente **Production** (sem o prefixo `VITE_`) → Save → **Deployments → Redeploy**.
   Essa chave dá acesso total ao banco: não cole em chat, e-mail ou no código; ela só fica na Vercel.
3. No sistema, entre com o usuário dono → Configurações → Usuários → **Novo usuário** (nome, e-mail e senha).

Sem a chave, ainda é possível criar o usuário pelo painel: Supabase → Authentication → Users → Add user → Create new user
(marque *Auto Confirm User*, defina a senha) e depois, no SQL Editor:
`insert into public.app_members (user_id, role) select id, 'member' from auth.users where email = 'email-da-pessoa@exemplo.com';`

## Passo 6 — Trazer os dados que estavam no navegador (opcional)

Se você já usou o sistema localmente (`npm run dev`) e quer levar esses dados para a nuvem: abra o sistema **no mesmo
navegador e endereço local** já configurado com o Supabase (passo 7), entre, vá em **Configurações → Backup e auditoria →
Importar dados deste navegador**. Alternativa: no modo local, **Exportar backup (.json)**; depois, na versão online,
**Restaurar backup…**.

## Passo 7 — Rodar no computador conectado ao Supabase

```bat
copy .env.example .env.local
```
Edite `.env.local` e preencha `VITE_SUPABASE_ANON_KEY`. Depois:
```bat
npm install
npm run dev
```
Para testar sem nuvem e sem login, use `VITE_STORAGE_DRIVER=local`.

---

## Problemas comuns

| Mensagem | Causa / solução |
| --- | --- |
| "Configuração incompleta" | Falta variável na Vercel ou no `.env.local`. Cadastre e faça Redeploy / reinicie o `npm run dev`. |
| "O banco ainda não foi preparado" | A migration do passo 2 não foi executada. |
| "Acesso não liberado" | O usuário entrou, mas não está em `app_members`. Rode o passo 4 com o e-mail correto. |
| "E-mail ou senha incorretos" | Confira em Authentication → Users; redefina a senha por lá se precisar. |
| "Os dados foram alterados em outra aba ou dispositivo" | Outra aba gravou antes. Recarregue (F5); nada foi perdido. |
| "Failed to fetch" / "O servidor do banco de dados (Supabase) não respondeu" | O projeto no Supabase está pausado, reiniciando ou sobrecarregado (erro 522). Supabase → abra o projeto → veja o aviso no topo da página inicial: se estiver **Paused**, clique em **Restore project**; senão, **Project Settings → General → Restart project** (ou o botão de reiniciar no menu do projeto). Espere 2–5 min e entre de novo. Em **Reports / Observability** veja se CPU, memória ou disco estão no limite. |

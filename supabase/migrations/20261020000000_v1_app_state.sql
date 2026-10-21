-- ============================================================================
-- Ideia Cúbica — v1.0.0 — estrutura inicial do banco
--
-- Como aplicar: Supabase → SQL Editor → New query → cole este arquivo → Run.
-- (Pode ser executado de novo sem erro: todos os comandos são idempotentes.)
--
-- Modelo da v1: o estado completo do sistema é um documento JSONB em
-- `app_state` (1 linha), gravado SOMENTE pela função transacional
-- `save_app_state`, que:
--   * confere se o usuário está liberado em `app_members`;
--   * aplica controle de versão otimista (impede que uma aba/dispositivo
--     sobrescreva alterações mais novas de outro);
--   * guarda uma cópia de cada versão em `app_state_history` (backup).
-- A próxima etapa (tabelas normalizadas por entidade) está em
-- supabase/planned/normalized_schema.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Usuários liberados (v1: um único usuário, papel "owner" = acesso total)
-- ---------------------------------------------------------------------------
create table if not exists public.app_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now()
);
alter table public.app_members enable row level security;

drop policy if exists "membro lê o próprio cadastro" on public.app_members;
create policy "membro lê o próprio cadastro" on public.app_members
  for select to authenticated using (user_id = auth.uid());
-- Sem políticas de insert/update/delete: membros são liberados apenas pelo
-- administrador no SQL Editor (ver docs/DEPLOY.md, passo 4).

create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.app_members where user_id = auth.uid());
$$;
revoke all on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- ---------------------------------------------------------------------------
-- Estado do sistema
-- ---------------------------------------------------------------------------
create table if not exists public.app_state (
  id         smallint primary key default 1 check (id = 1),
  data       jsonb not null,
  version    integer not null check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);
alter table public.app_state enable row level security;

drop policy if exists "membros leem o estado" on public.app_state;
create policy "membros leem o estado" on public.app_state
  for select to authenticated using (public.is_member());
-- Escrita somente via save_app_state (não há política de insert/update/delete).

-- ---------------------------------------------------------------------------
-- Histórico (backup automático de cada gravação)
-- ---------------------------------------------------------------------------
create table if not exists public.app_state_history (
  id       bigint generated always as identity primary key,
  version  integer not null,
  data     jsonb not null,
  bytes    integer not null,
  saved_at timestamptz not null default now(),
  saved_by uuid references auth.users (id)
);
create index if not exists app_state_history_saved_at_idx on public.app_state_history (saved_at desc);
alter table public.app_state_history enable row level security;

drop policy if exists "membros leem o histórico" on public.app_state_history;
create policy "membros leem o histórico" on public.app_state_history
  for select to authenticated using (public.is_member());

-- Visitantes não autenticados não têm nenhum acesso direto às tabelas.
revoke all on public.app_members, public.app_state, public.app_state_history from anon;

-- ---------------------------------------------------------------------------
-- Gravação transacional com controle de versão
-- ---------------------------------------------------------------------------
create or replace function public.save_app_state(p_data jsonb, p_expected_version integer)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_current integer;
  v_new     integer;
begin
  if not public.is_member() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or (p_data ->> 'schemaVersion') is null then
    raise exception 'dados inválidos' using errcode = '22023';
  end if;

  select version into v_current from public.app_state where id = 1 for update;

  if v_current is null then
    if p_expected_version <> 0 then
      raise exception 'conflito de versão' using errcode = '40001';
    end if;
    v_new := 1;
    insert into public.app_state (id, data, version, updated_at, updated_by)
    values (1, p_data, v_new, now(), auth.uid());
  else
    if v_current <> p_expected_version then
      raise exception 'conflito de versão' using errcode = '40001';
    end if;
    v_new := v_current + 1;
    update public.app_state
       set data = p_data, version = v_new, updated_at = now(), updated_by = auth.uid()
     where id = 1;
  end if;

  insert into public.app_state_history (version, data, bytes, saved_by)
  values (v_new, p_data, octet_length(p_data::text), auth.uid());

  -- Retenção: mantém as 100 versões mais recentes.
  delete from public.app_state_history
   where id in (select id from public.app_state_history order by id desc offset 100);

  return v_new;
end;
$$;
revoke all on function public.save_app_state(jsonb, integer) from public, anon;
grant execute on function public.save_app_state(jsonb, integer) to authenticated;

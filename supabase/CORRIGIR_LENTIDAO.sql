-- ============================================================================
-- Ideia Cúbica — CORRIGIR LENTIDÃO (rodar uma vez; pode rodar de novo sem problema)
--
-- Supabase → SQL Editor → New query → cole TODO este arquivo → Run.
--
-- Junta as atualizações v1.9, v1.10 e v1.11 do banco e limpa o histórico pesado:
--   1. Tempo limite de 30 s e histórico com no máximo 1 cópia a cada 10 minutos.
--   2. Papéis de usuário (dono / usuário) e lista de usuários.
--   3. Tabela de fotos: cada foto guardada uma única vez (gravações pequenas).
--   4. Histórico: mantém só as 10 cópias mais recentes (as antigas tinham todas as
--      fotos dentro e ocupavam muito espaço e leitura de disco).
-- Os dados atuais do sistema NÃO são alterados.
-- No final aparece uma tabela com os tamanhos, para conferência.
-- ============================================================================

-- ---------- 1. Gravação rápida (v1.9) ----------
alter role authenticated set statement_timeout = '30s';
notify pgrst, 'reload config';

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

  if not exists (select 1 from public.app_state_history where saved_at > now() - interval '10 minutes') then
    insert into public.app_state_history (version, data, bytes, saved_by)
    values (v_new, p_data, pg_column_size(p_data), auth.uid());
    delete from public.app_state_history
     where id in (select id from public.app_state_history order by id desc offset 30);
  end if;

  return v_new;
end;
$$;
revoke all on function public.save_app_state(jsonb, integer) from public, anon;
grant execute on function public.save_app_state(jsonb, integer) to authenticated;

-- ---------- 2. Usuários (v1.10) ----------
alter table public.app_members drop constraint if exists app_members_role_check;
alter table public.app_members add constraint app_members_role_check check (role in ('owner', 'member'));
alter table public.app_members add column if not exists name text;

create or replace function public.is_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.app_members where user_id = auth.uid() and role = 'owner');
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

create or replace function public.admin_list_members()
returns table (user_id uuid, email text, name text, role text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Somente o dono do sistema pode ver os usuários.' using errcode = '42501';
  end if;
  return query
    select m.user_id, u.email::text, coalesce(m.name, u.raw_user_meta_data ->> 'name'), m.role, m.created_at, u.last_sign_in_at
      from public.app_members m
      join auth.users u on u.id = m.user_id
     order by m.role desc, m.created_at;
end;
$$;
revoke all on function public.admin_list_members() from public, anon;
grant execute on function public.admin_list_members() to authenticated;

-- ---------- 3. Fotos separadas (v1.11) ----------
create table if not exists public.app_images (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  data       text not null,
  bytes      integer not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
alter table public.app_images enable row level security;

drop policy if exists "membros leem fotos" on public.app_images;
create policy "membros leem fotos" on public.app_images
  for select to authenticated using (public.is_member());

drop policy if exists "membros enviam fotos" on public.app_images;
create policy "membros enviam fotos" on public.app_images
  for insert to authenticated with check (public.is_member() and octet_length(data) <= 1000000);

revoke all on public.app_images from anon;
grant select, insert on public.app_images to authenticated;
notify pgrst, 'reload schema';

-- ---------- 4. Histórico mais leve ----------
delete from public.app_state_history
 where id in (select id from public.app_state_history order by id desc offset 10);

-- ---------- Conferência ----------
select
  pg_size_pretty(pg_total_relation_size('public.app_state'))         as dados_do_sistema,
  pg_size_pretty(pg_total_relation_size('public.app_state_history')) as historico,
  (select count(*) from public.app_state_history)                    as copias_no_historico,
  pg_size_pretty(pg_total_relation_size('public.app_images'))        as fotos,
  pg_size_pretty(pg_database_size(current_database()))               as banco_inteiro;

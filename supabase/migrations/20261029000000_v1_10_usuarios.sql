-- ============================================================================
-- Ideia Cúbica — v1.10 — vários usuários e tela de administração
--
-- Como aplicar: Supabase → SQL Editor → New query → cole este arquivo → Run.
-- Pode ser executado de novo sem erro.
--
-- Papéis:
--   owner  = dono: acesso total + administra usuários (criar, senha, remover acesso)
--   member = usuário: acesso total aos dados do sistema, sem administrar usuários
-- ============================================================================

alter table public.app_members drop constraint if exists app_members_role_check;
alter table public.app_members add constraint app_members_role_check check (role in ('owner', 'member'));
alter table public.app_members add column if not exists name text;

-- O usuário logado é dono?
create or replace function public.is_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.app_members where user_id = auth.uid() and role = 'owner');
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- Lista dos usuários liberados (somente para o dono).
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

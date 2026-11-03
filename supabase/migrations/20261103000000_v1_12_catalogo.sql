-- ============================================================================
-- Ideia Cúbica — v1.12 — Catálogo digital (vitrine com link para o cliente)
--
-- Como aplicar: Supabase → SQL Editor → New query → cole este arquivo → Run.
-- Pode ser executado de novo sem erro.
--
-- Separação de acesso:
--   * Área administrativa (membros do sistema): lê e edita catálogos, links e
--     estatísticas, protegidos por RLS (is_member()).
--   * Cliente (sem login, papel anon): NÃO lê nenhuma tabela. Só chama três
--     funções que validam o link (ativo e dentro da validade) NO BANCO e devolvem
--     apenas a cópia publicada — nunca custos, margens ou dados do orçamento.
--   * Não existe listagem pública: sem o link (aleatório), não há como achar um catálogo.
-- ============================================================================

-- Catálogo (rascunho editável). Os produtos guardam uma CÓPIA dos dados comerciais
-- (nome, descrição, preços, foto): editar o catálogo nunca altera o orçamento.
create table if not exists public.catalogs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 120),
  theme       text not null check (length(theme) between 1 and 40),
  data        jsonb not null default '{}'::jsonb,
  status      text not null default 'rascunho' check (status in ('rascunho', 'publicado', 'expirado')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) default auth.uid()
);
alter table public.catalogs enable row level security;

-- Links publicados. Cada publicação guarda a fotografia pública do catálogo (snapshot).
-- Gerar um link novo desativa o anterior, que fica no histórico.
create table if not exists public.catalog_links (
  slug          text primary key check (slug ~ '^[a-z0-9]{10,32}$'),
  catalog_id    uuid not null references public.catalogs (id) on delete cascade,
  snapshot      jsonb not null,
  image_ids     text[] not null default '{}',
  expires_at    timestamptz,
  active        boolean not null default true,
  published_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  created_by    uuid references auth.users (id) default auth.uid()
);
create index if not exists catalog_links_catalog on public.catalog_links (catalog_id);
create unique index if not exists catalog_links_one_active on public.catalog_links (catalog_id) where active;
alter table public.catalog_links enable row level security;

-- Estatísticas: só o que aconteceu e quando. Nenhum dado pessoal (sem IP, sem navegador).
create table if not exists public.catalog_events (
  id          bigint generated always as identity primary key,
  catalog_id  uuid not null references public.catalogs (id) on delete cascade,
  slug        text not null,
  kind        text not null check (kind in ('visita', 'produto', 'contato', 'compartilhar')),
  item_id     text check (item_id is null or length(item_id) <= 64),
  at          timestamptz not null default now()
);
create index if not exists catalog_events_catalog on public.catalog_events (catalog_id, at);
alter table public.catalog_events enable row level security;

-- ---------------------------------------------------------------- permissões (área administrativa)
drop policy if exists "membros usam catalogos" on public.catalogs;
create policy "membros usam catalogos" on public.catalogs
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "membros usam links" on public.catalog_links;
create policy "membros usam links" on public.catalog_links
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "membros leem estatisticas" on public.catalog_events;
create policy "membros leem estatisticas" on public.catalog_events
  for select to authenticated using (public.is_member());

revoke all on public.catalogs, public.catalog_links, public.catalog_events from anon;
grant select, insert, update, delete on public.catalogs, public.catalog_links to authenticated;
grant select on public.catalog_events to authenticated;

-- ---------------------------------------------------------------- acesso do cliente (pelo link)
-- Link válido = existe, está ativo e (sem validade ou validade no futuro). Conferido aqui, no banco.
create or replace function public.get_public_catalog(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l public.catalog_links;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9]{10,32}$' then return jsonb_build_object('status', 'nao_encontrado'); end if;
  select * into l from public.catalog_links where slug = p_slug;
  if not found then return jsonb_build_object('status', 'nao_encontrado'); end if;
  if not l.active or (l.expires_at is not null and l.expires_at <= now()) then
    return jsonb_build_object('status', 'expirado');
  end if;
  return jsonb_build_object('status', 'ok', 'catalog', l.snapshot, 'expires_at', l.expires_at);
end $$;

-- Foto de um catálogo publicado: só as fotos que fazem parte daquela publicação válida.
create or replace function public.get_public_catalog_image(p_slug text, p_id text)
returns text language plpgsql stable security definer set search_path = public as $$
declare ok boolean;
begin
  select true into ok from public.catalog_links
   where slug = p_slug and active and (expires_at is null or expires_at > now()) and p_id = any (image_ids);
  if not coalesce(ok, false) then return null; end if;
  return (select data from public.app_images where id = p_id);
end $$;

-- Registro de visita/clique. Só aceita links válidos e tipos conhecidos; limite simples contra abuso.
create or replace function public.track_catalog_event(p_slug text, p_kind text, p_item text default null)
returns void language plpgsql security definer set search_path = public as $$
declare l public.catalog_links; recent integer;
begin
  if p_kind not in ('visita', 'produto', 'contato', 'compartilhar') then return; end if;
  select * into l from public.catalog_links
   where slug = p_slug and active and (expires_at is null or expires_at > now());
  if not found then return; end if;
  select count(*) into recent from public.catalog_events where slug = p_slug and at > now() - interval '1 minute';
  if recent > 300 then return; end if;
  insert into public.catalog_events (catalog_id, slug, kind, item_id) values (l.catalog_id, p_slug, p_kind, left(p_item, 64));
end $$;

revoke all on function public.get_public_catalog(text) from public;
revoke all on function public.get_public_catalog_image(text, text) from public;
revoke all on function public.track_catalog_event(text, text, text) from public;
grant execute on function public.get_public_catalog(text) to anon, authenticated;
grant execute on function public.get_public_catalog_image(text, text) to anon, authenticated;
grant execute on function public.track_catalog_event(text, text, text) to anon, authenticated;

-- Resumo das estatísticas por catálogo (respeita o RLS de quem chama).
create or replace function public.catalog_stats()
returns table (catalog_id uuid, visitas bigint, produtos bigint, contatos bigint, compartilhamentos bigint, ultima_visita timestamptz)
language sql stable security invoker set search_path = public as $$
  select catalog_id,
         count(*) filter (where kind = 'visita'),
         count(*) filter (where kind = 'produto'),
         count(*) filter (where kind = 'contato'),
         count(*) filter (where kind = 'compartilhar'),
         max(at) filter (where kind = 'visita')
    from public.catalog_events group by catalog_id
$$;
revoke all on function public.catalog_stats() from public;
grant execute on function public.catalog_stats() to authenticated;

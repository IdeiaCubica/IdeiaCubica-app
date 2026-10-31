-- ============================================================================
-- Ideia Cúbica — v1.11 — fotos guardadas separadas (gravação rápida)
--
-- Como aplicar: Supabase → SQL Editor → New query → cole este arquivo → Run.
-- Pode ser executado de novo sem erro.
--
-- Antes, cada gravação enviava o sistema inteiro COM todas as fotos (centenas de
-- KB cada). Agora cada foto é guardada uma única vez nesta tabela (identificada
-- pelo próprio conteúdo) e o documento do sistema guarda só a referência.
-- Enquanto este arquivo não for executado, o sistema continua funcionando do
-- jeito antigo (fotos dentro do documento).
-- ============================================================================

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
-- Fotos não são alteradas nem apagadas pelo app (o mesmo conteúdo = mesma foto).

revoke all on public.app_images from anon;
grant select, insert on public.app_images to authenticated;

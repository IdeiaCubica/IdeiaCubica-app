-- ============================================================================
-- Ideia Cúbica — v1.13 (sistema v1.21) — fim da sobrecarga de CPU do banco
--
-- Como aplicar: Supabase → SQL Editor → New query → cole este arquivo → Run.
-- Pode ser executado de novo sem erro. Nada é apagado dos dados do sistema.
--
-- CAUSA PRINCIPAL: o sistema inteiro ficava num único documento (vários MB) e CADA
-- operação (salvar orçamento, mover peça, receber…) regravava o documento todo. O banco
-- precisava ler, comprimir e gravar MB a cada clique, e o custo crescia com os dados.
--
-- O QUE MUDA:
--   1. app_records: uma linha por registro (cliente, orçamento, pedido, título…). Cada
--      gravação envia só as linhas que mudaram (save_records). Os dados atuais são
--      divididos automaticamente no fim deste arquivo.
--   2. Cópia de segurança completa no máximo 1x por hora (mantém 48 = 2 dias), montada
--      no próprio banco — antes era 1 cópia de vários MB a cada 10 min de uso.
--   3. Permissões (RLS) avaliadas uma vez por consulta, e não uma vez por linha.
--   4. Índice para o registro de visitas do catálogo.
-- ============================================================================

alter table public.app_state add column if not exists storage text not null default 'document'
  check (storage in ('document', 'records'));

create table if not exists public.app_records (
  coll        text not null,
  id          text not null,
  ord         double precision not null default 0,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id),
  primary key (coll, id)
);
alter table public.app_records enable row level security;
revoke all on public.app_records from anon;
-- Leitura e escrita somente pelas funções abaixo (que conferem o membro).
revoke all on public.app_records from authenticated;

-- ---------------------------------------------------------------- documento ⇄ linhas
-- Mesmas regras de src/data/records.ts (toRows): entidades com id → "e:<chave>";
-- listas sem id → blocos de 250 → "c:<chave>"; demais chaves → "d".
create or replace function public.split_app_state(p_doc jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; n integer; total integer;
begin
  for k, v in select * from jsonb_each(p_doc) loop
    if jsonb_typeof(v) = 'array' then
      total := jsonb_array_length(v);
      continue when total = 0;
      if (select bool_and(jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'id') = 'string') and count(distinct e ->> 'id') = count(*)
            from jsonb_array_elements(v) e) then
        insert into public.app_records (coll, id, ord, data)
        select 'e:' || k, e ->> 'id', (i - 1) * 1024, e from jsonb_array_elements(v) with ordinality t(e, i)
        on conflict (coll, id) do update set ord = excluded.ord, data = excluded.data;
      else
        for n in 0 .. ((total - 1) / 250) loop
          insert into public.app_records (coll, id, ord, data)
          select 'c:' || k, 'k' || n, n, coalesce(jsonb_agg(e order by i), '[]'::jsonb)
            from jsonb_array_elements(v) with ordinality t(e, i) where (i - 1) / 250 = n
          on conflict (coll, id) do update set ord = excluded.ord, data = excluded.data;
        end loop;
      end if;
    else
      insert into public.app_records (coll, id, ord, data) values ('d', k, 0, v)
      on conflict (coll, id) do update set data = excluded.data;
    end if;
  end loop;
end $$;
revoke all on function public.split_app_state(jsonb) from public, anon, authenticated;

-- Documento completo a partir das linhas (cópias de segurança e restauração).
create or replace function public.build_app_state_doc()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select id as k, data as v from public.app_records where coll = 'd'
    union all
    select substr(coll, 3), jsonb_agg(data order by ord, id) from public.app_records where coll like 'e:%' group by coll
    union all
    select substr(r.coll, 3), jsonb_agg(x.e order by r.ord, x.n)
      from public.app_records r cross join lateral jsonb_array_elements(r.data) with ordinality x(e, n)
     where r.coll like 'c:%' group by r.coll
  ) t
$$;
revoke all on function public.build_app_state_doc() from public, anon, authenticated;

-- ---------------------------------------------------------------- leitura e gravação do app
create or replace function public.load_state()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_state;
begin
  if not public.is_member() then raise exception 'acesso negado' using errcode = '42501'; end if;
  select * into s from public.app_state where id = 1;
  if not found then return jsonb_build_object('mode', 'records', 'version', 0, 'rows', '[]'::jsonb); end if;
  if s.storage = 'document' then return jsonb_build_object('mode', 'document', 'version', s.version, 'data', s.data); end if;
  return jsonb_build_object('mode', 'records', 'version', s.version, 'rows',
    (select coalesce(jsonb_agg(jsonb_build_object('c', coll, 'i', id, 'o', ord, 'd', data)), '[]'::jsonb) from public.app_records));
end $$;
revoke all on function public.load_state() from public, anon;
grant execute on function public.load_state() to authenticated;

create or replace function public.save_records(p_upserts jsonb, p_deletes jsonb, p_expected_version integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v_current integer; v_new integer;
begin
  if not public.is_member() then raise exception 'acesso negado' using errcode = '42501'; end if;
  select version into v_current from public.app_state where id = 1 for update;
  if v_current is null then
    if p_expected_version <> 0 then raise exception 'conflito de versão' using errcode = 'PT409'; end if;
    v_new := 1;
    insert into public.app_state (id, data, version, storage, updated_at, updated_by) values (1, '{}'::jsonb, v_new, 'records', now(), auth.uid());
  else
    if v_current <> p_expected_version then raise exception 'conflito de versão' using errcode = 'PT409'; end if;
    v_new := v_current + 1;
    update public.app_state set version = v_new, storage = 'records', updated_at = now(), updated_by = auth.uid() where id = 1;
  end if;

  delete from public.app_records r using jsonb_to_recordset(coalesce(p_deletes, '[]'::jsonb)) as x(c text, i text)
   where r.coll = x.c and r.id = x.i;
  insert into public.app_records (coll, id, ord, data, updated_at, updated_by)
  select x.c, x.i, coalesce(x.o, 0), x.d, now(), auth.uid()
    from jsonb_to_recordset(coalesce(p_upserts, '[]'::jsonb)) as x(c text, i text, o double precision, d jsonb)
   where x.c is not null and x.i is not null and x.d is not null
  on conflict (coll, id) do update set ord = excluded.ord, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  -- Cópia de segurança completa: no máximo 1 por hora, mantendo as 48 mais recentes (2 dias de uso).
  if not exists (select 1 from public.app_state_history where saved_at > now() - interval '1 hour') then
    insert into public.app_state_history (version, data, bytes, saved_by)
    select v_new, d, pg_column_size(d), auth.uid() from (select public.build_app_state_doc() as d) s;
    delete from public.app_state_history where id in (select id from public.app_state_history order by id desc offset 48);
  end if;
  return v_new;
end $$;
revoke all on function public.save_records(jsonb, jsonb, integer) from public, anon;
grant execute on function public.save_records(jsonb, jsonb, integer) to authenticated;

-- Abas antigas (sistema antes da v1.21) não podem mais gravar o documento inteiro por cima.
create or replace function public.save_app_state(p_data jsonb, p_expected_version integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v_current integer; v_new integer; v_storage text;
begin
  if not public.is_member() then raise exception 'acesso negado' using errcode = '42501'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or (p_data ->> 'schemaVersion') is null then
    raise exception 'dados inválidos' using errcode = '22023';
  end if;
  select version, storage into v_current, v_storage from public.app_state where id = 1 for update;
  if v_storage = 'records' then
    raise exception 'conflito: o sistema foi atualizado, recarregue a página' using errcode = 'PT409';
  end if;
  if v_current is null then
    if p_expected_version <> 0 then raise exception 'conflito de versão' using errcode = 'PT409'; end if;
    v_new := 1;
    insert into public.app_state (id, data, version, updated_at, updated_by) values (1, p_data, v_new, now(), auth.uid());
  else
    if v_current <> p_expected_version then raise exception 'conflito de versão' using errcode = 'PT409'; end if;
    v_new := v_current + 1;
    update public.app_state set data = p_data, version = v_new, updated_at = now(), updated_by = auth.uid() where id = 1;
  end if;
  if not exists (select 1 from public.app_state_history where saved_at > now() - interval '1 hour') then
    insert into public.app_state_history (version, data, bytes, saved_by) values (v_new, p_data, pg_column_size(p_data), auth.uid());
    delete from public.app_state_history where id in (select id from public.app_state_history order by id desc offset 48);
  end if;
  return v_new;
end $$;
revoke all on function public.save_app_state(jsonb, integer) from public, anon;
grant execute on function public.save_app_state(jsonb, integer) to authenticated;

-- O app passa a ler só por load_state: abas antigas recebem erro em vez de uma tela vazia.
revoke select on public.app_state from authenticated;

-- ---------------------------------------------------------------- permissões: 1 avaliação por consulta
-- "(select public.is_member())" é calculado uma vez; "public.is_member()" era chamado para CADA linha.
drop policy if exists "membro lê o próprio cadastro" on public.app_members;
create policy "membro lê o próprio cadastro" on public.app_members for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "membros leem o histórico" on public.app_state_history;
create policy "membros leem o histórico" on public.app_state_history for select to authenticated using ((select public.is_member()));

drop policy if exists "membros leem fotos" on public.app_images;
create policy "membros leem fotos" on public.app_images for select to authenticated using ((select public.is_member()));
drop policy if exists "membros enviam fotos" on public.app_images;
create policy "membros enviam fotos" on public.app_images for insert to authenticated with check ((select public.is_member()) and octet_length(data) <= 1000000);

do $$ begin
  if to_regclass('public.catalogs') is not null then
    drop policy if exists "membros usam catalogos" on public.catalogs;
    create policy "membros usam catalogos" on public.catalogs for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
    drop policy if exists "membros usam links" on public.catalog_links;
    create policy "membros usam links" on public.catalog_links for all to authenticated using ((select public.is_member())) with check ((select public.is_member()));
    drop policy if exists "membros leem estatisticas" on public.catalog_events;
    create policy "membros leem estatisticas" on public.catalog_events for select to authenticated using ((select public.is_member()));
    -- Registro de visita conta os acessos do último minuto por link: precisa de índice.
    create index if not exists catalog_events_slug_at on public.catalog_events (slug, at);
  end if;
end $$;

-- ---------------------------------------------------------------- divisão dos dados atuais (uma vez)
do $$
declare s public.app_state;
begin
  select * into s from public.app_state where id = 1 for update;
  if found and s.storage = 'document' then
    perform public.split_app_state(s.data);
    -- O documento grande deixa de existir: o banco não precisa mais carregá-lo.
    update public.app_state set storage = 'records', data = '{}'::jsonb, version = s.version + 1, updated_at = now() where id = 1;
  end if;
end $$;

-- Cópias antigas do histórico (cada uma com o sistema inteiro): ficam só as 10 mais recentes.
delete from public.app_state_history where id in (select id from public.app_state_history order by id desc offset 10);

-- Resultado: quantos registros foram criados.
select coll as colecao, count(*) as registros, pg_size_pretty(sum(pg_column_size(data))::bigint) as tamanho
  from public.app_records group by coll order by sum(pg_column_size(data)) desc;

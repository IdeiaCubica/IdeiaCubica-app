-- ============================================================================
-- Ideia Cúbica — v1.14 (sistema v1.21.1) — conflito de versão sem repetição infinita
--
-- Como aplicar: Supabase → SQL Editor → New query → cole este arquivo → Run.
-- Pode ser executado de novo sem erro. Não mexe nos dados.
--
-- CAUSA RAIZ DA CPU NO LIMITE: quando dois aparelhos gravavam quase juntos, a gravação
-- desatualizada era recusada com o código de erro 40001. Esse código significa "conflito
-- entre transações" no Postgres, e a API do Supabase (PostgREST) REPETE automaticamente
-- toda operação que falha com ele. Como o nosso conflito nunca se resolve sozinho, a API
-- repetia sem parar (milhões de vezes), até a CPU do banco esgotar.
--
-- Correção: o conflito passa a usar o código PT409, que a API devolve ao app como
-- "409 Conflict" na hora, sem repetir. O app mostra "recarregue a página" como antes.
-- As repetições que estiverem em andamento param sozinhas na próxima tentativa (já
-- encontram a função nova) e, por garantia, são encerradas no fim deste arquivo.
-- ============================================================================

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

-- Encerra as chamadas da API presas no ciclo de repetição (a API reconecta sozinha em seguida).
select count(*) as chamadas_encerradas from (
  select pg_terminate_backend(pid) from pg_stat_activity
   where application_name like 'PostgREST%' and state = 'active' and query like '%pgrst_call%' and pid <> pg_backend_pid()
) t;

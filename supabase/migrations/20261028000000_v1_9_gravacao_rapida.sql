-- ============================================================================
-- Ideia Cúbica — v1.9 — gravação mais rápida (corrige "canceling statement due
-- to statement timeout")
--
-- Como aplicar: Supabase → SQL Editor → New query → cole este arquivo → Run.
-- Pode ser executado de novo sem erro.
--
-- O que muda:
--   1. Tempo limite das requisições do app: 8 s (padrão do Supabase) → 30 s.
--   2. Histórico automático: no máximo 1 cópia a cada 10 minutos (antes: uma
--      cópia completa a CADA gravação) e retenção das 30 mais recentes (antes 100).
--      Cada cópia é o sistema inteiro; gravar uma a cada clique deixava a
--      gravação lenta e o banco cada vez maior.
--   3. Tamanho da cópia medido sem converter o documento em texto.
-- Nada é apagado dos dados atuais; só cópias antigas do histórico além das 30.
-- ============================================================================

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

  -- Histórico: uma cópia a cada 10 minutos de uso, mantendo as 30 mais recentes.
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

-- Limpeza única das cópias antigas além das 30 mais recentes (libera espaço).
delete from public.app_state_history
 where id in (select id from public.app_state_history order by id desc offset 30);

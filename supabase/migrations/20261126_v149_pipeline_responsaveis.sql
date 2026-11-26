-- v149 — Pipeline: responsável de cada contato (para o filtro por vendedor).
-- Com a regra de privacidade, o atendente não lê as conversas atribuídas a outros; o pipeline
-- precisa saber só QUEM é o responsável de cada contato (sem conteúdo de conversa).
-- Devolve UM objeto json {contato_id: user_id|null} (uma linha só: sem o limite de 1000 linhas da API).
drop function if exists public.crm_pipeline_responsaveis();
create or replace function public.crm_pipeline_responsaveis()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(x.contato_id::text, x.assigned_user_id), '{}'::jsonb)
  from (
    select distinct on (c.contato_id) c.contato_id, c.assigned_user_id
    from public.crm_conversas c
    where c.contato_id is not null
      and auth.uid() is not null
    order by c.contato_id, (c.assigned_user_id is null), c.ultima_hora desc nulls last
  ) x;
$$;
revoke all on function public.crm_pipeline_responsaveis() from public, anon;
grant execute on function public.crm_pipeline_responsaveis() to authenticated;

-- v149 — Pipeline: responsável de cada contato (para o filtro por vendedor).
-- Com a regra de privacidade, o atendente não lê as conversas atribuídas a outros; o pipeline
-- precisa saber só QUEM é o responsável de cada contato (sem conteúdo de conversa).
-- Retorna, por contato, o responsável da conversa mais recente que tem responsável.
create or replace function public.crm_pipeline_responsaveis()
returns table (contato_id bigint, assigned_user_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct on (c.contato_id) c.contato_id, c.assigned_user_id
  from public.crm_conversas c
  where c.contato_id is not null
    and auth.uid() is not null
  order by c.contato_id, (c.assigned_user_id is null), c.ultima_hora desc nulls last;
$$;
revoke all on function public.crm_pipeline_responsaveis() from public, anon;
grant execute on function public.crm_pipeline_responsaveis() to authenticated;

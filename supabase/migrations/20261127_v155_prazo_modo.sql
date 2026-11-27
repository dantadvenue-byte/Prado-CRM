-- v155 (aplicado) — modo do prazo por coluna + situação das conversas no Pipeline
alter table public.crm_etapas add column if not exists prazo_modo text not null default 'coluna';
alter table public.crm_etapas add constraint crm_etapas_prazo_modo_chk check (prazo_modo in ('coluna','resposta','contato'));
create or replace function public.crm_pipeline_status()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with cv as (
    select distinct on (contato_id) id, contato_id
      from public.crm_conversas where contato_id is not null
     order by contato_id, ultima_hora desc nulls last
  )
  select case when auth.uid() is null then '{}'::jsonb else
    coalesce(jsonb_object_agg(cv.contato_id::text, jsonb_build_array(cv.id, pend.ts, la.ts, lr.ts)), '{}'::jsonb) end
  from cv
  left join lateral (select max(m.timestamp_msg) ts from public.crm_mensagens m
                      where m.conversa_id = cv.id and coalesce(m.origem,'') <> 'sistema') la on true
  left join lateral (select max(m.timestamp_msg) ts from public.crm_mensagens m
                      where m.conversa_id = cv.id and m.de_mim and coalesce(m.origem,'humano') = 'humano') lr on true
  left join lateral (select min(m.timestamp_msg) ts from public.crm_mensagens m
                      where m.conversa_id = cv.id and not m.de_mim and (lr.ts is null or m.timestamp_msg > lr.ts)) pend on true;
$$;
revoke all on function public.crm_pipeline_status() from public, anon;
grant execute on function public.crm_pipeline_status() to authenticated;

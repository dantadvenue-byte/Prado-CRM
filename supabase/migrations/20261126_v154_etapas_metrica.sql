-- v154 (aplicado) — colunas ligadas a métricas e visibilidade
alter table public.crm_etapas add column if not exists metrica text;
alter table public.crm_etapas add column if not exists visivel text not null default 'todos';
alter table public.crm_etapas add constraint crm_etapas_metrica_chk check (metrica is null or metrica in ('venda','perdido','visita'));
alter table public.crm_etapas add constraint crm_etapas_visivel_chk check (visivel in ('todos','gestao'));
update public.crm_etapas set metrica = 'venda'   where metrica is null and lower(nome) in ('venda realizada','vendido','ganho','fechado — ganho','fechado - ganho');
update public.crm_etapas set metrica = 'perdido' where metrica is null and lower(nome) in ('perdido','perdida');
update public.crm_etapas set metrica = 'visita'  where metrica is null and (id = 1784397046900 or (lower(nome) like '%visita%' and (lower(nome) like '%agend%' or lower(nome) like '%marc%')));

-- v151 — Painel de desempenho único + gestor comercial vê o mesmo que o admin (leitura).
-- (1) crm_painel_desempenho: UMA definição de cada número para todas as telas.
-- (2) Leitura liberada ao gestor nas funções de painel (as AÇÕES continuam só do admin).

-- ---------------------------------------------------------------------------------------------
-- (1) Painel único
--   atendimentos  = conversas DISTINTAS em que o vendedor mandou ao menos 1 mensagem (humana) no período
--   mensagens     = mensagens humanas enviadas no período
--   leads_novos   = conversas cuja 1ª mensagem do cliente chegou no período (por responsável atual)
--   tempo_1a_resp = média (seg) entre a 1ª mensagem do cliente e a 1ª resposta humana, no período
--   pendentes     = AGORA: conversas abertas do responsável com mensagem não lida ou ainda sem resposta
--   vendas        = AGORA: clientes do responsável nas colunas de venda do pipeline (p_filtros.etapas_ganho)
-- Filtros (p_filtros jsonb): loja, cidade, etiqueta, chip, so_ativas (bool), vendedor (uuid), etapas_ganho (text[])
-- Admin e gestor: equipe toda. Atendente: só os próprios números.
-- ---------------------------------------------------------------------------------------------
create or replace function public.crm_painel_desempenho(p_ini timestamptz, p_fim timestamptz, p_filtros jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_tudo boolean;
  v_loja text; v_cidade text; v_etq bigint; v_chip text; v_ativas boolean; v_vend uuid;
  v_ganho text[];
  v_vendedores jsonb; v_totais jsonb; v_dias jsonb;
begin
  if v_uid is null then raise exception 'nao_autenticado'; end if;
  if p_ini is null or p_fim is null or p_fim <= p_ini or (p_fim - p_ini) > interval '400 days' then
    raise exception 'periodo_invalido';
  end if;
  v_tudo   := public.is_admin() or public._crm_eh_gestor();
  p_filtros := coalesce(p_filtros, '{}'::jsonb);
  v_loja   := nullif(p_filtros->>'loja', '');
  v_cidade := nullif(p_filtros->>'cidade', '');
  v_etq    := nullif(p_filtros->>'etiqueta', '')::bigint;
  v_chip   := nullif(p_filtros->>'chip', '');
  v_ativas := coalesce((p_filtros->>'so_ativas')::boolean, false);
  v_vend   := nullif(p_filtros->>'vendedor', '')::uuid;
  if not v_tudo then v_vend := v_uid; end if;           -- atendente: só ele
  v_ganho  := coalesce(array(select jsonb_array_elements_text(coalesce(p_filtros->'etapas_ganho','[]'::jsonb))), '{}'::text[]);

  drop table if exists pg_temp._pd_c;
  create temporary table pg_temp._pd_c on commit drop as
    select c.id, c.assigned_user_id, c.contato_id, c.nao_lidas, c.encerrada, c.arquivada,
           c.primeira_resposta_humana_em, c.primeira_resposta_user_id,
           coalesce(c.lead_entrada_em,
             (select min(m.timestamp_msg) from public.crm_mensagens m where m.conversa_id = c.id and m.de_mim = false)) as entrada,
           ct.etapa_id
      from public.crm_conversas c
      left join public.crm_contatos ct on ct.id = c.contato_id
     where (v_loja   is null or ct.negocio = v_loja)
       and (v_cidade is null or ct.cidade  = v_cidade)
       and (v_chip   is null or c.instancia = v_chip)
       and (v_etq    is null or exists (select 1 from public.crm_contato_etiquetas e where e.contato_id = c.contato_id and e.etiqueta_id = v_etq))
       and (not v_ativas or (coalesce(c.encerrada,false) = false and coalesce(c.arquivada,false) = false));

  drop table if exists pg_temp._pd_m;
  create temporary table pg_temp._pd_m on commit drop as
    select m.conversa_id, m.autor_user_id, m.timestamp_msg
      from public.crm_mensagens m
      join pg_temp._pd_c c on c.id = m.conversa_id
     where m.de_mim = true and m.origem = 'humano'
       and m.timestamp_msg >= p_ini and m.timestamp_msg < p_fim
       and (v_vend is null or m.autor_user_id = v_vend);

  -- por vendedor
  with us as (
    select u.id, coalesce(u.nome, u.email, u.id::text) nome
      from public.crm_usuarios u
     where (v_vend is null or u.id = v_vend)
       and (u.role in ('atendente','gestor_comercial','admin'))
  ),
  at as (select autor_user_id uid, count(distinct conversa_id) n, count(*) msgs from pg_temp._pd_m group by 1),
  ld as (select assigned_user_id uid, count(*) n from pg_temp._pd_c
          where assigned_user_id is not null and entrada >= p_ini and entrada < p_fim group by 1),
  tp as (select primeira_resposta_user_id uid, avg(extract(epoch from (primeira_resposta_humana_em - entrada))) s
           from pg_temp._pd_c
          where primeira_resposta_user_id is not null and primeira_resposta_humana_em >= p_ini and primeira_resposta_humana_em < p_fim
            and entrada is not null and primeira_resposta_humana_em >= entrada group by 1),
  pe as (select assigned_user_id uid, count(*) n from pg_temp._pd_c
          where assigned_user_id is not null and coalesce(encerrada,false) = false and coalesce(arquivada,false) = false
            and (coalesce(nao_lidas,0) > 0 or primeira_resposta_humana_em is null) group by 1),
  vd as (select assigned_user_id uid, count(distinct contato_id) n from pg_temp._pd_c
          where assigned_user_id is not null and etapa_id::text = any(v_ganho) group by 1)
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', us.id, 'nome', us.nome,
           'atendimentos', coalesce(at.n,0), 'mensagens', coalesce(at.msgs,0),
           'leads_novos', coalesce(ld.n,0), 'tempo_1a_resp_seg', round(tp.s),
           'pendentes', coalesce(pe.n,0), 'vendas', coalesce(vd.n,0)
         ) order by coalesce(at.n,0) desc, coalesce(ld.n,0) desc, us.nome), '[]'::jsonb)
    into v_vendedores
    from us
    left join at on at.uid = us.id
    left join ld on ld.uid = us.id
    left join tp on tp.uid = us.id
    left join pe on pe.uid = us.id
    left join vd on vd.uid = us.id
   where at.n is not null or ld.n is not null or pe.n is not null or vd.n is not null or v_vend is not null
      or exists (select 1 from public.crm_usuarios x where x.id = us.id and x.role = 'atendente');

  -- totais (conversas distintas; leads incluem os sem responsável)
  select jsonb_build_object(
    'atendimentos', (select count(distinct conversa_id) from pg_temp._pd_m),
    'mensagens',    (select count(*) from pg_temp._pd_m),
    'leads_novos',  (select count(*) from pg_temp._pd_c where entrada >= p_ini and entrada < p_fim
                        and (v_vend is null or assigned_user_id = v_vend)),
    'leads_sem_responsavel', (select count(*) from pg_temp._pd_c where entrada >= p_ini and entrada < p_fim and assigned_user_id is null and v_vend is null),
    'tempo_1a_resp_seg', (select round(avg(extract(epoch from (primeira_resposta_humana_em - entrada)))) from pg_temp._pd_c
                            where primeira_resposta_humana_em >= p_ini and primeira_resposta_humana_em < p_fim
                              and entrada is not null and primeira_resposta_humana_em >= entrada
                              and (v_vend is null or primeira_resposta_user_id = v_vend)),
    'pendentes',    (select count(*) from pg_temp._pd_c where coalesce(encerrada,false) = false and coalesce(arquivada,false) = false
                        and (coalesce(nao_lidas,0) > 0 or primeira_resposta_humana_em is null)
                        and (case when v_vend is null then assigned_user_id is not null else assigned_user_id = v_vend end)),
    'vendas',       (select count(distinct contato_id) from pg_temp._pd_c where etapa_id::text = any(v_ganho)
                        and (case when v_vend is null then assigned_user_id is not null else assigned_user_id = v_vend end))
  ) into v_totais;

  -- por dia (horário de Fortaleza): atendimentos (conversas distintas) e mensagens
  select coalesce(jsonb_agg(jsonb_build_object('dia', d, 'atendimentos', n, 'mensagens', q) order by d), '[]'::jsonb)
    into v_dias
    from (select (timestamp_msg at time zone 'America/Fortaleza')::date d, count(distinct conversa_id) n, count(*) q
            from pg_temp._pd_m group by 1) x;

  return jsonb_build_object('totais', v_totais, 'vendedores', v_vendedores, 'por_dia', v_dias, 've_tudo', v_tudo);
end $$;
revoke all on function public.crm_painel_desempenho(timestamptz, timestamptz, jsonb) from public, anon;
grant execute on function public.crm_painel_desempenho(timestamptz, timestamptz, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- (2) Gestor comercial vê o mesmo que o admin nas funções de LEITURA dos painéis.
--     Ações (confirmar/aprovar/pagar, metas, atribuir, usuários, escopo) continuam só do admin.
-- ---------------------------------------------------------------------------------------------
do $$
declare f record; def text; novo text;
begin
  for f in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('crm_metricas_equipe','crm_comissoes_equipe','crm_vendas_equipe','crm_vendas_nao_atribuidas')
  loop
    def := pg_get_functiondef(f.oid);
    novo := replace(def, 'if not public.is_admin() then raise exception ''apenas_admin''; end if;',
                         'if not (public.is_admin() or public._crm_eh_gestor()) then raise exception ''apenas_admin''; end if;');
    if novo = def then raise exception 'v151: trecho não encontrado em %', f.proname; end if;
    execute novo;
  end loop;

  for f in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('crm_produtividade_equipe','crm_comercial_gestor')
  loop
    def := pg_get_functiondef(f.oid);
    -- gestor passa a ter a mesma visão do admin (sem recorte por escopo de loja)
    novo := replace(def, 'v_admin := public.is_admin();', 'v_admin := public.is_admin() or public._crm_eh_gestor();');
    if novo = def then raise exception 'v151: trecho não encontrado em %', f.proname; end if;
    execute novo;
  end loop;
end $$;

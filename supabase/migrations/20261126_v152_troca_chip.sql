-- v152 — Trocar o chip de uma conversa (admin e gestor) e transferência em lote (admin).
-- A conversa é a MESMA (histórico, responsável, etiquetas, vendas, tarefas ficam); muda só o chip
-- (e o número, quando o WhatsApp do cliente usa outro formato, ex.: sem o 9).

create table if not exists public.crm_conversa_trocas (
  id            bigint generated always as identity primary key,
  conversa_id   bigint not null,
  de_instancia  text,
  para_instancia text not null,
  numero_antigo text,
  numero_novo   text,
  user_id       uuid default auth.uid(),
  lote          boolean not null default false,
  criado_em     timestamptz not null default now()
);
create index if not exists crm_conversa_trocas_conv_idx on public.crm_conversa_trocas (conversa_id);
alter table public.crm_conversa_trocas enable row level security;
drop policy if exists trocas_ler on public.crm_conversa_trocas;
create policy trocas_ler on public.crm_conversa_trocas for select to authenticated
  using (public.is_admin() or public._crm_eh_gestor());
-- gravação só pelas funções abaixo (security definer)

-- Registro visível dentro da conversa (mensagem de sistema; não conta como atendimento).
create or replace function public._crm_registrar_troca(p_conv bigint, p_de text, p_para text, p_num_ant text, p_num_novo text, p_lote boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_nome text; v_de text; v_para text; v_txt text;
begin
  insert into public.crm_conversa_trocas(conversa_id, de_instancia, para_instancia, numero_antigo, numero_novo, user_id, lote)
  values (p_conv, p_de, p_para, p_num_ant, p_num_novo, auth.uid(), p_lote);
  select coalesce(nome, email) into v_nome from public.crm_usuarios where id = auth.uid();
  select coalesce(nome_display, instancia) into v_de from public.crm_conexoes where instancia = p_de;
  select coalesce(nome_display, instancia) into v_para from public.crm_conexoes where instancia = p_para;
  v_txt := 'Conversa transferida do chip ' || coalesce(v_de, p_de, '?') || ' para ' || coalesce(v_para, p_para)
           || case when p_lote then ' (transferência em lote)' else '' end
           || ' por ' || coalesce(v_nome, 'sistema')
           || case when p_num_novo is not null and p_num_novo <> coalesce(p_num_ant,'') then '. Número ajustado para +' || p_num_novo else '' end
           || '.';
  insert into public.crm_mensagens(id, conversa_id, instancia, message_id, de_mim, tipo, texto, timestamp_msg, status, origem)
  values ((extract(epoch from clock_timestamp())*1000000)::bigint + (random()*999)::int, p_conv, p_para,
          'troca-' || p_conv || '-' || (extract(epoch from clock_timestamp())*1000)::bigint, true, 'sistema', v_txt, now(), null, 'sistema');
end $$;
revoke all on function public._crm_registrar_troca(bigint, text, text, text, text, boolean) from public, anon, authenticated;

-- Troca uma conversa de chip. Retorna {ok:true} ou {ok:false, motivo, conversa_existente_id}.
create or replace function public.crm_conversa_trocar_chip(p_conversa bigint, p_instancia text, p_numero text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; v_num text; v_outra bigint;
begin
  if auth.uid() is null then raise exception 'nao_autenticado'; end if;
  if not (public.is_admin() or public._crm_eh_gestor()) then raise exception 'sem_permissao'; end if;
  if not exists (select 1 from public.crm_conexoes where instancia = p_instancia) then
    return jsonb_build_object('ok', false, 'motivo', 'chip_inexistente');
  end if;
  select * into c from public.crm_conversas where id = p_conversa for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'conversa_inexistente'); end if;
  if c.instancia = p_instancia then return jsonb_build_object('ok', false, 'motivo', 'mesmo_chip'); end if;
  v_num := coalesce(nullif(regexp_replace(coalesce(p_numero,''), '\D', '', 'g'), ''), c.numero_cliente);
  select id into v_outra from public.crm_conversas where instancia = p_instancia and numero_cliente = v_num and id <> c.id;
  if v_outra is not null then
    return jsonb_build_object('ok', false, 'motivo', 'ja_existe', 'conversa_existente_id', v_outra);
  end if;
  update public.crm_conversas set instancia = p_instancia, numero_cliente = v_num where id = c.id;
  perform public._crm_registrar_troca(c.id, c.instancia, p_instancia, c.numero_cliente, v_num, false);
  return jsonb_build_object('ok', true, 'numero', v_num);
end $$;
revoke all on function public.crm_conversa_trocar_chip(bigint, text, text) from public, anon;
grant execute on function public.crm_conversa_trocar_chip(bigint, text, text) to authenticated;

-- Conversas por chip (para a tela de transferência). Só admin.
create or replace function public.crm_conversas_por_chip()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when not public.is_admin() then null else
    coalesce(jsonb_agg(jsonb_build_object(
      'instancia', x.instancia, 'existe', x.existe, 'status', x.status, 'nome', x.nome,
      'total', x.total, 'recentes_30d', x.recentes, 'ultima', x.ultima) order by x.total desc), '[]'::jsonb) end
  from (
    select v.instancia, (cx.instancia is not null) existe, cx.status, coalesce(cx.nome_display, v.instancia) nome,
           count(*) total, count(*) filter (where v.ultima_hora > now() - interval '30 days') recentes, max(v.ultima_hora) ultima
      from public.crm_conversas v left join public.crm_conexoes cx on cx.instancia = v.instancia
     group by v.instancia, cx.instancia, cx.status, cx.nome_display
  ) x;
$$;
revoke all on function public.crm_conversas_por_chip() from public, anon;
grant execute on function public.crm_conversas_por_chip() to authenticated;

-- Prévia da transferência em lote. Só admin. p_desde null = todas.
create or replace function public.crm_conversas_transferir_previa(p_de text, p_para text, p_desde timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_total int; v_conf int; v_resp int;
begin
  if not public.is_admin() then raise exception 'apenas_admin'; end if;
  select count(*),
         count(*) filter (where exists (select 1 from public.crm_conversas o where o.instancia = p_para and o.numero_cliente = v.numero_cliente)),
         count(*) filter (where v.assigned_user_id is not null)
    into v_total, v_conf, v_resp
    from public.crm_conversas v
   where v.instancia = p_de and (p_desde is null or v.ultima_hora >= p_desde);
  return jsonb_build_object('total', v_total, 'conflitos', v_conf, 'transferiveis', v_total - v_conf, 'com_responsavel', v_resp);
end $$;
revoke all on function public.crm_conversas_transferir_previa(text, text, timestamptz) from public, anon;
grant execute on function public.crm_conversas_transferir_previa(text, text, timestamptz) to authenticated;

-- Transferência em lote (em blocos). Só admin. Pula as que já têm conversa no destino.
create or replace function public.crm_conversas_transferir_lote(p_de text, p_para text, p_desde timestamptz default null, p_limite int default 200)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_ok int := 0; v_rest int;
begin
  if not public.is_admin() then raise exception 'apenas_admin'; end if;
  if p_de = p_para then raise exception 'mesmo_chip'; end if;
  if not exists (select 1 from public.crm_conexoes where instancia = p_para) then raise exception 'chip_inexistente'; end if;
  for r in
    select v.id, v.numero_cliente from public.crm_conversas v
     where v.instancia = p_de and (p_desde is null or v.ultima_hora >= p_desde)
       and not exists (select 1 from public.crm_conversas o where o.instancia = p_para and o.numero_cliente = v.numero_cliente)
     order by v.ultima_hora desc nulls last
     limit greatest(1, least(coalesce(p_limite, 200), 500))
  loop
    update public.crm_conversas set instancia = p_para where id = r.id;
    perform public._crm_registrar_troca(r.id, p_de, p_para, r.numero_cliente, r.numero_cliente, true);
    v_ok := v_ok + 1;
  end loop;
  select count(*) into v_rest from public.crm_conversas v
   where v.instancia = p_de and (p_desde is null or v.ultima_hora >= p_desde)
     and not exists (select 1 from public.crm_conversas o where o.instancia = p_para and o.numero_cliente = v.numero_cliente);
  return jsonb_build_object('transferidas', v_ok, 'restantes', v_rest);
end $$;
revoke all on function public.crm_conversas_transferir_lote(text, text, timestamptz, int) from public, anon;
grant execute on function public.crm_conversas_transferir_lote(text, text, timestamptz, int) to authenticated;

-- v152b/c (aplicado): conflito conta o número com e sem o 9 extra.
-- public._crm_num_variantes(text) + trocar_chip / previa / lote passam a usar "numero_cliente = any(_crm_num_variantes(...))".

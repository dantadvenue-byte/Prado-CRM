-- ============================================================
-- Privacidade — PARTE A (preparação). Só adiciona; não muda quem vê o quê.
--   * crm_push_subscriptions.user_id: notificação ligada ao usuário do aparelho
--   * crm_papel(): papel do usuário logado (usado pelas regras da parte B)
--   * crm_atendimento_hist no tempo real: o app tira da lista do vendedor a conversa que passou a outro
--   * crm_conversa_assumir: "tomar" conversa de outro (forçar) só admin/gestor comercial
-- ============================================================
alter table public.crm_push_subscriptions add column if not exists user_id uuid;
create index if not exists ix_crm_push_subscriptions_user on public.crm_push_subscriptions (user_id);

create or replace function public.crm_papel() returns text
  language sql stable security definer set search_path = public
as $$ select role from public.crm_usuarios where id = auth.uid() $$;
revoke all on function public.crm_papel() from public, anon;
grant execute on function public.crm_papel() to authenticated, service_role;

alter publication supabase_realtime add table public.crm_atendimento_hist;

CREATE OR REPLACE FUNCTION public.crm_conversa_assumir(p_conversa bigint, p_forcar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_uid uuid := auth.uid(); v_antigo uuid;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'erro','nao_autenticado'); end if;
  select assigned_user_id into v_antigo from public.crm_conversas where id = p_conversa for update;
  if not found then return jsonb_build_object('ok',false,'erro','conversa_inexistente'); end if;
  if v_antigo = v_uid then return jsonb_build_object('ok',true,'de',v_antigo,'para',v_uid); end if;
  if v_antigo is not null and not coalesce(p_forcar,false) then
    return jsonb_build_object('ok',false,'conflito',true,'responsavel_atual',v_antigo);
  end if;
  -- privacidade: só admin/gestor comercial tomam conversa que já tem responsável
  if v_antigo is not null and coalesce(public.crm_papel(),'') not in ('admin','gestor_comercial') then
    return jsonb_build_object('ok',false,'erro','so_admin_ou_gestor_toma_conversa');
  end if;
  update public.crm_conversas set assigned_user_id = v_uid where id = p_conversa;
  insert into public.crm_atendimento_hist(id,conversa_id,de_user_id,para_user_id,autor_user_id,motivo,quando)
    values (public._atend_hist_novo_id(), p_conversa, v_antigo, v_uid, v_uid,
            case when v_antigo is null then 'assumiu' else 'assumiu (forçado)' end, now());
  return jsonb_build_object('ok',true,'de',v_antigo,'para',v_uid);
end $function$;

-- ============================================================
-- Privacidade — PARTE B (ATIVA a regra). Conversa com responsável: só o responsável, admin e gestor comercial.
-- Conversa sem responsável (fila): todos os usuários do CRM. Quem não é do CRM: nada.
-- Webhooks/edge functions usam service_role e não são afetados. Para desfazer: 20261121_privacidade_c_desfazer.sql
-- ============================================================
drop policy if exists acesso_total on public.crm_conversas;
drop policy if exists conv_select on public.crm_conversas;
drop policy if exists conv_insert on public.crm_conversas;
drop policy if exists conv_update on public.crm_conversas;
drop policy if exists conv_delete on public.crm_conversas;
create policy conv_select on public.crm_conversas for select to authenticated using (
  (select public.crm_papel()) is not null and (
    assigned_user_id is null or assigned_user_id = (select auth.uid())
    or (select public.crm_papel()) in ('admin','gestor_comercial')));
create policy conv_insert on public.crm_conversas for insert to authenticated
  with check ((select public.crm_papel()) is not null);
create policy conv_update on public.crm_conversas for update to authenticated using (
  (select public.crm_papel()) is not null and (
    assigned_user_id is null or assigned_user_id = (select auth.uid())
    or (select public.crm_papel()) in ('admin','gestor_comercial')))
  with check (
  (select public.crm_papel()) is not null and (
    assigned_user_id is null or assigned_user_id = (select auth.uid())
    or (select public.crm_papel()) in ('admin','gestor_comercial')));
create policy conv_delete on public.crm_conversas for delete to authenticated using (
  (select public.crm_papel()) is not null and (
    assigned_user_id is null or assigned_user_id = (select auth.uid())
    or (select public.crm_papel()) in ('admin','gestor_comercial')));

drop policy if exists acesso_total on public.crm_mensagens;
drop policy if exists msg_select on public.crm_mensagens;
drop policy if exists msg_insert on public.crm_mensagens;
drop policy if exists msg_update on public.crm_mensagens;
drop policy if exists msg_delete on public.crm_mensagens;
-- a subconsulta em crm_conversas já passa pela regra acima: vê a mensagem quem vê a conversa
create policy msg_select on public.crm_mensagens for select to authenticated
  using (exists (select 1 from public.crm_conversas c where c.id = crm_mensagens.conversa_id));
create policy msg_insert on public.crm_mensagens for insert to authenticated
  with check (exists (select 1 from public.crm_conversas c where c.id = crm_mensagens.conversa_id));
create policy msg_update on public.crm_mensagens for update to authenticated
  using (exists (select 1 from public.crm_conversas c where c.id = crm_mensagens.conversa_id))
  with check (exists (select 1 from public.crm_conversas c where c.id = crm_mensagens.conversa_id));
create policy msg_delete on public.crm_mensagens for delete to authenticated
  using (exists (select 1 from public.crm_conversas c where c.id = crm_mensagens.conversa_id));

-- DESFAZ a parte B: volta a regra antiga (todos os logados veem tudo). Rodar se algo der errado.
drop policy if exists conv_select on public.crm_conversas;
drop policy if exists conv_insert on public.crm_conversas;
drop policy if exists conv_update on public.crm_conversas;
drop policy if exists conv_delete on public.crm_conversas;
drop policy if exists acesso_total on public.crm_conversas;
create policy acesso_total on public.crm_conversas for all using (true) with check (true);
drop policy if exists msg_select on public.crm_mensagens;
drop policy if exists msg_insert on public.crm_mensagens;
drop policy if exists msg_update on public.crm_mensagens;
drop policy if exists msg_delete on public.crm_mensagens;
drop policy if exists acesso_total on public.crm_mensagens;
create policy acesso_total on public.crm_mensagens for all using (true) with check (true);

-- ============================================================
-- v140 — Etiquetas do cliente (várias por cliente, com cor)
-- Só ADICIONA duas tabelas. Nada muda em envio/recebimento nem nas regras de acesso existentes.
--   crm_etiquetas          : cadastro (todos do CRM leem; só admin cria/edita/exclui)
--   crm_contato_etiquetas  : quais etiquetas cada cliente tem (qualquer usuário do CRM aplica/remove)
-- ============================================================

create table if not exists public.crm_etiquetas (
  id        bigserial primary key,
  nome      text not null check (length(btrim(nome)) between 1 and 30),
  cor       text not null default '#64748b' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  ordem     integer not null default 0,
  ativa     boolean not null default true,
  criado_em timestamptz not null default now()
);
create unique index if not exists ux_crm_etiquetas_nome on public.crm_etiquetas (lower(btrim(nome)));

create table if not exists public.crm_contato_etiquetas (
  contato_id  bigint not null references public.crm_contatos(id) on delete cascade,
  etiqueta_id bigint not null references public.crm_etiquetas(id) on delete cascade,
  criado_em   timestamptz not null default now(),
  criado_por  uuid default auth.uid(),
  primary key (contato_id, etiqueta_id)
);
create index if not exists ix_crm_contato_etiquetas_etq on public.crm_contato_etiquetas (etiqueta_id);

alter table public.crm_etiquetas enable row level security;
alter table public.crm_contato_etiquetas enable row level security;

-- cadastro
drop policy if exists crm_etiquetas_select on public.crm_etiquetas;
create policy crm_etiquetas_select on public.crm_etiquetas for select to authenticated
  using (exists (select 1 from public.crm_usuarios u where u.id = auth.uid()));
drop policy if exists crm_etiquetas_admin_insert on public.crm_etiquetas;
create policy crm_etiquetas_admin_insert on public.crm_etiquetas for insert to authenticated with check (public.is_admin());
drop policy if exists crm_etiquetas_admin_update on public.crm_etiquetas;
create policy crm_etiquetas_admin_update on public.crm_etiquetas for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists crm_etiquetas_admin_delete on public.crm_etiquetas;
create policy crm_etiquetas_admin_delete on public.crm_etiquetas for delete to authenticated using (public.is_admin());

-- etiquetas aplicadas nos clientes
drop policy if exists crm_contato_etiquetas_select on public.crm_contato_etiquetas;
create policy crm_contato_etiquetas_select on public.crm_contato_etiquetas for select to authenticated
  using (exists (select 1 from public.crm_usuarios u where u.id = auth.uid()));
drop policy if exists crm_contato_etiquetas_insert on public.crm_contato_etiquetas;
create policy crm_contato_etiquetas_insert on public.crm_contato_etiquetas for insert to authenticated
  with check (exists (select 1 from public.crm_usuarios u where u.id = auth.uid()));
drop policy if exists crm_contato_etiquetas_delete on public.crm_contato_etiquetas;
create policy crm_contato_etiquetas_delete on public.crm_contato_etiquetas for delete to authenticated
  using (exists (select 1 from public.crm_usuarios u where u.id = auth.uid()));

revoke all on public.crm_etiquetas, public.crm_contato_etiquetas from anon;
grant select, insert, update, delete on public.crm_etiquetas to authenticated;
grant select, insert, delete on public.crm_contato_etiquetas to authenticated;
grant usage, select on sequence public.crm_etiquetas_id_seq to authenticated;

-- Tempo real: quando um vendedor põe/tira etiqueta, os outros veem na hora.
alter publication supabase_realtime add table public.crm_contato_etiquetas;

-- Algumas etiquetas para começar (o admin edita/exclui em "Etiquetas").
insert into public.crm_etiquetas (nome, cor, ordem) values
  ('Quente',            '#ef4444', 1),
  ('Pediu desconto',    '#f59e0b', 2),
  ('Retornar contato',  '#3b82f6', 3),
  ('Financiamento',     '#a855f7', 4),
  ('Cliente antigo',    '#14b8a6', 5)
on conflict do nothing;

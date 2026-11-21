-- ============================================================
-- v139 — Cidades do cliente com cor (Fase 1)
-- Só ADICIONA: tabela nova crm_cidades + coluna crm_contatos.cidade_fonte.
-- Padroniza os ~20 contatos que já tinham cidade digitada ("Belém - PA" -> "Belém").
-- Nada muda em envio/recebimento de mensagens nem nas regras de acesso existentes.
-- ============================================================

create table if not exists public.crm_cidades (
  id          bigserial primary key,
  nome        text not null unique,
  uf          text not null default 'PA',
  cor         text not null default '#64748b' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  ddds        text[] not null default '{}',   -- DDDs que sugerem esta cidade (DDD em 2+ cidades = sugestão neutra)
  apelidos    text[] not null default '{}',   -- ex.: STM, BLM (reconhecer na conversa)
  negocios    text[] not null default '{}',   -- negócios/lojas desta cidade (ex.: Motos STM)
  instancias  text[] not null default '{}',   -- chips (crm_conexoes.instancia) desta cidade
  lat         double precision,
  lng         double precision,
  ativa       boolean not null default true,
  ordem       integer not null default 0,
  criado_em   timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table public.crm_cidades enable row level security;

drop policy if exists crm_cidades_select on public.crm_cidades;
create policy crm_cidades_select on public.crm_cidades
  for select to authenticated
  using (exists (select 1 from public.crm_usuarios u where u.id = auth.uid()));

drop policy if exists crm_cidades_admin_insert on public.crm_cidades;
create policy crm_cidades_admin_insert on public.crm_cidades
  for insert to authenticated with check (public.is_admin());

drop policy if exists crm_cidades_admin_update on public.crm_cidades;
create policy crm_cidades_admin_update on public.crm_cidades
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists crm_cidades_admin_delete on public.crm_cidades;
create policy crm_cidades_admin_delete on public.crm_cidades
  for delete to authenticated using (public.is_admin());

grant select, insert, update, delete on public.crm_cidades to authenticated;
grant usage, select on sequence public.crm_cidades_id_seq to authenticated;

-- De onde veio a cidade do contato (a cidade gravada é sempre a CONFIRMADA por alguém):
-- manual (escolhida pelo vendedor), localizacao (confirmada a partir da localização enviada),
-- conversa (confirmada a partir de cidade citada), sugestao (confirmada a partir da sugestão DDD/anúncio/chip),
-- migracao (valor antigo padronizado). NULL = valor antigo sem origem registrada.
alter table public.crm_contatos add column if not exists cidade_fonte text;
alter table public.crm_contatos drop constraint if exists ck_contatos_cidade_fonte;
alter table public.crm_contatos add constraint ck_contatos_cidade_fonte
  check (cidade_fonte is null or cidade_fonte in ('manual','localizacao','conversa','sugestao','migracao'));

-- Cidades iniciais (as que aparecem nos dados). O admin ajusta nomes, cores e DDDs na tela "Cidades e cores".
insert into public.crm_cidades (nome, uf, cor, ddds, apelidos, negocios, instancias, lat, lng, ordem) values
  ('Belém',          'PA', '#3b82f6', '{91}', '{BLM,Belem}',     '{"Motos Belém"}',     '{scootersbelm}', -1.4558, -48.4902, 1),
  ('Santarém',       'PA', '#f59e0b', '{93}', '{STM,Santarem}',  '{"Motos STM"}',       '{santarm}',      -2.4385, -54.6996, 2),
  ('Itaituba',       'PA', '#a855f7', '{93}', '{ITB}',           '{"Motos ITB"}',       '{itb}',          -4.2761, -55.9836, 3),
  ('Manaus',         'AM', '#ef4444', '{92}', '{MAO}',           '{"Scooters Manaus"}', '{manaus}',       -3.1190, -60.0217, 4),
  ('Boa Vista',      'RR', '#14b8a6', '{95}', '{BVB}',           '{}',                  '{}',              2.8235, -60.6758, 5),
  ('Marituba',       'PA', '#ec4899', '{}',   '{}',              '{}',                  '{}',             -1.3600, -48.3420, 6),
  ('Alenquer',       'PA', '#84cc16', '{}',   '{}',              '{}',                  '{}',             -1.9420, -54.7380, 7),
  ('Novo Progresso', 'PA', '#f97316', '{}',   '{}',              '{}',                  '{}',             -7.1470, -55.3790, 8)
on conflict (nome) do nothing;

-- Padroniza os valores antigos (eram texto livre). Valores originais, para desfazer se preciso:
--   'Belém - PA'(6) 'Santarém - PA'(5) 'Itaituba - PA'(4) 'Alenquer - PA'(1) 'Novo Progresso - PA'(1) 'Marituba/PA'(1) 'Boa Vista'(2)
update public.crm_contatos set cidade = 'Belém',          cidade_fonte = 'migracao' where cidade = 'Belém - PA';
update public.crm_contatos set cidade = 'Santarém',       cidade_fonte = 'migracao' where cidade = 'Santarém - PA';
update public.crm_contatos set cidade = 'Itaituba',       cidade_fonte = 'migracao' where cidade = 'Itaituba - PA';
update public.crm_contatos set cidade = 'Alenquer',       cidade_fonte = 'migracao' where cidade = 'Alenquer - PA';
update public.crm_contatos set cidade = 'Novo Progresso', cidade_fonte = 'migracao' where cidade = 'Novo Progresso - PA';
update public.crm_contatos set cidade = 'Marituba',       cidade_fonte = 'migracao' where cidade = 'Marituba/PA';
update public.crm_contatos set cidade_fonte = 'migracao' where cidade = 'Boa Vista' and cidade_fonte is null;

-- Visitante sem login não precisa nem do privilégio (a RLS já bloqueava).
revoke all on public.crm_cidades from anon;

-- ============================================================
-- Catálogo com estoque — ETAPA 1: variações (modelo/cor/preço), fotos, estoque por cidade e histórico.
-- Só ADICIONA tabelas/funções/bucket. O catálogo do chat continua funcionando como hoje (etapa 2 troca).
-- Estoque: só muda pela função crm_cat_ajustar_estoque (admin/gestor). Ninguém grava direto na tabela.
-- ============================================================

create table if not exists public.crm_cat_variacoes (
  id            bigserial primary key,
  produto_rowid text not null,                 -- produtos.id (Analytics), igual ao crm_produto_catalogo
  modelo        text,                           -- ex.: "Aro 16", "1000W" (vazio = sem modelo)
  cor_nome      text,                           -- ex.: "Vermelha" (vazio = sem cor)
  cor_hex       text check (cor_hex is null or cor_hex ~ '^#[0-9a-fA-F]{6}$'),
  preco         numeric(12,2) check (preco is null or preco >= 0),  -- vazio = preço do produto
  sku           text,
  ativo         boolean not null default true,
  ordem         integer not null default 0,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists ix_cat_var_prod on public.crm_cat_variacoes (produto_rowid);

create table if not exists public.crm_cat_fotos (
  id            bigserial primary key,
  produto_rowid text not null,
  variacao_id   bigint references public.crm_cat_variacoes(id) on delete cascade,  -- vazio = foto geral do produto
  url           text not null,
  thumb_url     text,
  ordem         integer not null default 0,
  criado_em     timestamptz not null default now()
);
create index if not exists ix_cat_fotos_prod on public.crm_cat_fotos (produto_rowid);

create table if not exists public.crm_cat_estoque (
  variacao_id    bigint not null references public.crm_cat_variacoes(id) on delete cascade,
  cidade_id      bigint not null references public.crm_cidades(id) on delete restrict,
  quantidade     integer not null default 0 check (quantidade >= 0),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid,
  primary key (variacao_id, cidade_id)
);

create table if not exists public.crm_cat_movimentos (
  id          bigserial primary key,
  variacao_id bigint not null,          -- sem FK: o histórico fica mesmo se a variação for apagada
  cidade_id   bigint not null,
  delta       integer not null,
  saldo_apos  integer not null,
  motivo      text not null check (motivo in ('entrada','ajuste','venda','venda_analytics','devolucao','migracao')),
  obs         text,
  venda_ref   text,
  usuario     uuid default auth.uid(),
  quando      timestamptz not null default now()
);
create index if not exists ix_cat_mov_var on public.crm_cat_movimentos (variacao_id, quando desc);

-- ---------- RLS: todos do CRM leem; variações/fotos só admin/gestor editam; estoque só pela função
alter table public.crm_cat_variacoes  enable row level security;
alter table public.crm_cat_fotos      enable row level security;
alter table public.crm_cat_estoque    enable row level security;
alter table public.crm_cat_movimentos enable row level security;

do $$
declare t text;
begin
  foreach t in array array['crm_cat_variacoes','crm_cat_fotos','crm_cat_estoque','crm_cat_movimentos'] loop
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.crm_papel()) is not null)', t||'_select', t);
  end loop;
  foreach t in array array['crm_cat_variacoes','crm_cat_fotos'] loop
    execute format('drop policy if exists %I on public.%I', t||'_ins', t);
    execute format('drop policy if exists %I on public.%I', t||'_upd', t);
    execute format('drop policy if exists %I on public.%I', t||'_del', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.crm_papel()) in (''admin'',''gestor_comercial''))', t||'_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.crm_papel()) in (''admin'',''gestor_comercial'')) with check ((select public.crm_papel()) in (''admin'',''gestor_comercial''))', t||'_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.crm_papel()) in (''admin'',''gestor_comercial''))', t||'_del', t);
  end loop;
end $$;

revoke all on public.crm_cat_variacoes, public.crm_cat_fotos, public.crm_cat_estoque, public.crm_cat_movimentos from anon;
grant select, insert, update, delete on public.crm_cat_variacoes, public.crm_cat_fotos to authenticated;
grant select on public.crm_cat_estoque, public.crm_cat_movimentos to authenticated;
grant usage, select on sequence public.crm_cat_variacoes_id_seq, public.crm_cat_fotos_id_seq to authenticated;

-- ---------- Ajuste de estoque (admin/gestor): define a NOVA quantidade e registra o movimento, tudo junto.
create or replace function public.crm_cat_ajustar_estoque(p_variacao bigint, p_cidade bigint, p_nova integer, p_motivo text default 'ajuste', p_obs text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_antes integer; v_papel text := public.crm_papel();
begin
  if v_papel is null or v_papel not in ('admin','gestor_comercial') then return jsonb_build_object('ok',false,'erro','so_admin_ou_gestor'); end if;
  if p_nova is null or p_nova < 0 then return jsonb_build_object('ok',false,'erro','quantidade_invalida'); end if;
  if coalesce(p_motivo,'') not in ('entrada','ajuste','devolucao') then return jsonb_build_object('ok',false,'erro','motivo_invalido'); end if;
  if not exists (select 1 from public.crm_cat_variacoes where id = p_variacao) then return jsonb_build_object('ok',false,'erro','variacao_inexistente'); end if;
  if not exists (select 1 from public.crm_cidades where id = p_cidade) then return jsonb_build_object('ok',false,'erro','cidade_inexistente'); end if;
  select quantidade into v_antes from public.crm_cat_estoque where variacao_id = p_variacao and cidade_id = p_cidade for update;
  v_antes := coalesce(v_antes, 0);
  insert into public.crm_cat_estoque (variacao_id, cidade_id, quantidade, atualizado_em, atualizado_por)
    values (p_variacao, p_cidade, p_nova, now(), auth.uid())
    on conflict (variacao_id, cidade_id) do update set quantidade = excluded.quantidade, atualizado_em = now(), atualizado_por = auth.uid();
  if p_nova <> v_antes then
    insert into public.crm_cat_movimentos (variacao_id, cidade_id, delta, saldo_apos, motivo, obs)
      values (p_variacao, p_cidade, p_nova - v_antes, p_nova, p_motivo, nullif(btrim(coalesce(p_obs,'')),''));
  end if;
  return jsonb_build_object('ok',true,'antes',v_antes,'depois',p_nova);
end $$;
revoke all on function public.crm_cat_ajustar_estoque(bigint,bigint,integer,text,text) from public, anon;
grant execute on function public.crm_cat_ajustar_estoque(bigint,bigint,integer,text,text) to authenticated;

-- ---------- Bucket de fotos do catálogo (público para leitura; só admin/gestor enviam/apagam)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('crm-catalogo', 'crm-catalogo', true, 5242880, array['image/jpeg','image/png','image/webp'])
  on conflict (id) do nothing;
drop policy if exists "catalogo envio admin gestor" on storage.objects;
create policy "catalogo envio admin gestor" on storage.objects for insert to authenticated
  with check (bucket_id = 'crm-catalogo' and (select public.crm_papel()) in ('admin','gestor_comercial'));
drop policy if exists "catalogo apagar admin gestor" on storage.objects;
create policy "catalogo apagar admin gestor" on storage.objects for delete to authenticated
  using (bucket_id = 'crm-catalogo' and (select public.crm_papel()) in ('admin','gestor_comercial'));

-- ---------- Migração: produtos que já estão no catálogo (habilitados em algum negócio e não arquivados)
-- 1) cada um ganha a variação "Padrão" (sem modelo/cor, preço do produto)
insert into public.crm_cat_variacoes (produto_rowid, ordem)
select p.id::text, 0 from public.produtos p
where jsonb_array_length(coalesce(p.dados->'negociosHabilitados','[]'::jsonb)) > 0
  and not coalesce((p.dados->>'arquivado')::boolean, false)
  and not exists (select 1 from public.crm_cat_variacoes v where v.produto_rowid = p.id::text);

-- 2) fotos que já são arquivo (URL): foto do Analytics e foto própria do catálogo por loja
insert into public.crm_cat_fotos (produto_rowid, url, ordem)
select x.rowid, x.url, row_number() over (partition by x.rowid order by x.ord) - 1
from (
  select p.id::text rowid, p.dados->>'foto' url, 0 ord from public.produtos p
   where p.dados->>'foto' like 'http%'
     and exists (select 1 from public.crm_cat_variacoes v where v.produto_rowid = p.id::text)
  union
  select c.produto_rowid, c.foto_url, 1 from public.crm_produto_catalogo c
   where c.foto_url like 'http%'
     and exists (select 1 from public.crm_cat_variacoes v where v.produto_rowid = c.produto_rowid)
) x
where not exists (select 1 from public.crm_cat_fotos f where f.produto_rowid = x.rowid and f.url = x.url);

-- 3) estoque inicial = quantidade do Analytics, SÓ quando o produto está em UM negócio que pertence a UMA cidade
--    (nos outros casos fica 0 para o admin conferir). Fica registrado como 'migracao'.
with alvo as (
  select v.id variacao_id, c.id cidade_id, greatest(coalesce((p.dados->>'quantidade')::int,0),0) qtd
  from public.produtos p
  join public.crm_cat_variacoes v on v.produto_rowid = p.id::text
  join public.crm_cidades c on (p.dados->'negociosHabilitados'->>0) = any(c.negocios)
  where jsonb_array_length(p.dados->'negociosHabilitados') = 1
), ins as (
  insert into public.crm_cat_estoque (variacao_id, cidade_id, quantidade)
  select variacao_id, cidade_id, qtd from alvo
  on conflict do nothing
  returning variacao_id, cidade_id, quantidade
)
insert into public.crm_cat_movimentos (variacao_id, cidade_id, delta, saldo_apos, motivo, obs, usuario)
select variacao_id, cidade_id, quantidade, quantidade, 'migracao', 'estoque inicial copiado do Analytics', null from ins where quantidade > 0;

-- Leitura no bucket para usuários do CRM (necessária para apagar fotos pelo app)
drop policy if exists "catalogo leitura logados" on storage.objects;
create policy "catalogo leitura logados" on storage.objects for select to authenticated
  using (bucket_id = 'crm-catalogo' and (select public.crm_papel()) is not null);

-- ---------- Configuração do catálogo (v145): limite de "estoque baixo" definido pelo admin
create table if not exists public.crm_cat_config (
  chave text primary key,
  valor jsonb not null,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid default auth.uid()
);
alter table public.crm_cat_config enable row level security;
drop policy if exists crm_cat_config_select on public.crm_cat_config;
create policy crm_cat_config_select on public.crm_cat_config for select to authenticated using ((select public.crm_papel()) is not null);
drop policy if exists crm_cat_config_admin_ins on public.crm_cat_config;
create policy crm_cat_config_admin_ins on public.crm_cat_config for insert to authenticated with check (public.is_admin());
drop policy if exists crm_cat_config_admin_upd on public.crm_cat_config;
create policy crm_cat_config_admin_upd on public.crm_cat_config for update to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.crm_cat_config from anon;
grant select, insert, update on public.crm_cat_config to authenticated;
insert into public.crm_cat_config (chave, valor) values ('estoque_baixo', '2'::jsonb) on conflict (chave) do nothing;

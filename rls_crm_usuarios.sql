-- =====================================================================
-- Prado Chat — RLS + proteção de crm_usuarios  (v4 — produção)
-- Projeto: dantadvenue-byte's Project (PRODUCTION) · tabela public.crm_usuarios
-- Rodar no Supabase > SQL Editor, de cima para baixo. NÃO altera outras tabelas.
--
-- O QUE ESTE SCRIPT FAZ (tudo em UMA transação — ou aplica tudo, ou nada):
--   • Remove a política aberta usuarios_acesso_total (PERMISSIVE/ALL/qual=true),
--     que hoje libera acesso total e anularia qualquer política restritiva (combinação OR).
--   • Cria is_admin() e o trigger de proteção crm_usuarios_guard().
--   • Instala políticas restritivas (SELECT para autenticados; INSERT só da própria linha;
--     UPDATE só admin; sem DELETE para o cliente).
--   • Promove o admin correto, validando que existe exatamente 1 em auth.users e 1 perfil.
--
-- SEGURANÇA TRANSACIONAL: se qualquer passo falhar, o ROLLBACK desfaz TUDO — inclusive o
-- "disable trigger" do seed e a remoção da política antiga — então o banco nunca fica num
-- estado intermediário (sem política = deny-all, ou trigger desabilitado). DDL é transacional
-- no PostgreSQL. Durante a execução, a tabela fica brevemente bloqueada (ACCESS EXCLUSIVE).
--
-- >>> CONFIRME o e-mail do admin (linha v_email) ANTES de rodar. <<<
--
-- PRÉ-VERIFICAÇÃO (somente leitura — rode ISOLADAMENTE ANTES, em outra aba):
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema='public' and table_name='crm_usuarios_bkp_roles'
--    order by ordinal_position;
--   • 0 linhas  => a tabela não existe; o script a cria com o esquema novo. OK.
--   • Existe COM as colunas (backup_batch_id uuid, backup_em timestamptz, id uuid, role text) => OK.
--   • Existe com OUTRO esquema (ex.: sem backup_batch_id) => NÃO rode o script ainda. Este script
--     NÃO faz DROP automático. Renomeie a tabela antiga manualmente para preservá-la, p.ex.:
--       alter table public.crm_usuarios_bkp_roles rename to crm_usuarios_bkp_roles_legado;
--     e então rode o script (ele criará a tabela nova). (Observação: se a tabela existir com
--     esquema incompatível e o script for rodado assim mesmo, o INSERT falha e a transação faz
--     ROLLBACK — nada é aplicado —, mas a pré-verificação evita essa ida e volta.)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0) BACKUP CONFIÁVEL dos papéis — snapshot APPEND-ONLY, com LOTE IDENTIFICADO.
--    A tabela é um LOG: cada execução insere um lote com um backup_batch_id ÚNICO (uuid).
--    NUNCA sobrescreve lotes anteriores. O rollback (seção 6) restaura EXATAMENTE o lote cujo
--    id você informar — nunca inferido por timestamp. O id do lote é impresso via RAISE NOTICE
--    ao rodar: ANOTE-O para um eventual rollback.
--    O snapshot é tirado AGORA, imediatamente antes das alterações, lendo os papéis atuais.
-- ---------------------------------------------------------------------
create table if not exists public.crm_usuarios_bkp_roles (
  backup_batch_id uuid        not null,
  backup_em       timestamptz not null default now(),
  id              uuid        not null,
  role            text
);
do $$
declare
  v_batch uuid := gen_random_uuid();
begin
  insert into public.crm_usuarios_bkp_roles (backup_batch_id, backup_em, id, role)
    select v_batch, now(), id, role from public.crm_usuarios;
  raise notice 'BACKUP batch_id = %  << ANOTE este id para o rollback (seção 6) >>', v_batch;
end;
$$;

-- ---------------------------------------------------------------------
-- 1) HELPER is_admin() — evita RECURSÃO nas políticas.
--    SECURITY DEFINER + search_path fixo: o SELECT interno roda como o dono da função
--    (bypassa o RLS de crm_usuarios, que NÃO usa FORCE RLS), então a política que a chama
--    não dispara a si mesma. Sem parâmetros e sem escrita: não eleva privilégio.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.crm_usuarios
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Privilégio mínimo: is_admin() só é avaliado na política de UPDATE (escopo authenticated).
-- anon não tem política que a chame, então NÃO recebe EXECUTE.
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- 2) TRIGGER de proteção (SECURITY DEFINER; o SELECT interno não recursa).
--    "Confiável" = SOMENTE service_role, pelo claim role do JWT do PostgREST.
--    Ausência de claims NÃO é tratada como confiável.
--    Navegador (anon/authenticated):
--      • INSERT: só a própria linha; papel forçado a 'atendente' (sem auto-admin).
--      • UPDATE de role: só admin; nunca o próprio perfil.
--    Último admin protegido em UPDATE (rebaixamento) e DELETE, em qualquer contexto.
-- ---------------------------------------------------------------------
create or replace function public.crm_usuarios_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  solicitante_role text;
  qtd_admin int;
  req text;
  req_role text;
  confiavel boolean;
begin
  req := current_setting('request.jwt.claims', true);
  if req is not null and req <> '' then
    begin
      req_role := (req::jsonb ->> 'role');
    exception when others then
      req_role := null;
    end;
  end if;
  confiavel := coalesce(req_role = 'service_role', false);

  if auth.uid() is not null then
    select role into solicitante_role from public.crm_usuarios where id = auth.uid();
  end if;

  if (tg_op = 'INSERT') then
    if not confiavel then
      if new.id = auth.uid() then
        new.role := 'atendente';                 -- auto-cadastro no navegador nasce mínimo
      else
        raise exception 'Sem permissao para criar usuarios';
      end if;
    end if;                                       -- service_role => grava como enviado
    return new;
  end if;

  if (tg_op = 'UPDATE') then
    if (new.role is distinct from old.role) then
      if not confiavel then
        if solicitante_role is distinct from 'admin' then
          raise exception 'Apenas administradores podem alterar perfis';
        end if;
        if new.id = auth.uid() then
          raise exception 'Voce nao pode alterar o proprio perfil';
        end if;
      end if;
      -- proteção do último admin (rebaixamento), com serialização anti-concorrência
      if (old.role = 'admin' and new.role <> 'admin') then
        perform pg_advisory_xact_lock(792025001);
        select count(*) into qtd_admin from public.crm_usuarios where role = 'admin';
        if qtd_admin <= 1 then
          raise exception 'Nao e possivel rebaixar o ultimo administrador';
        end if;
      end if;
    end if;
    return new;
  end if;

  if (tg_op = 'DELETE') then
    -- cobre o caminho privilegiado de exclusão (service_role/SQL): não deixa a app sem admin.
    -- O cliente não chega aqui (não há policy de DELETE). Mesmo lock serializa delete+rebaixamento.
    if (old.role = 'admin') then
      perform pg_advisory_xact_lock(792025001);
      select count(*) into qtd_admin from public.crm_usuarios where role = 'admin';
      if qtd_admin <= 1 then
        raise exception 'Nao e possivel excluir o ultimo administrador';
      end if;
    end if;
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_crm_usuarios_guard on public.crm_usuarios;
create trigger trg_crm_usuarios_guard
  before insert or update or delete on public.crm_usuarios
  for each row execute function public.crm_usuarios_guard();

-- ---------------------------------------------------------------------
-- 3) RLS + POLÍTICAS. Remove a política aberta e instala as restritivas.
-- ---------------------------------------------------------------------
alter table public.crm_usuarios enable row level security;

-- >>> CRÍTICO: remove a política permissiva que libera tudo (combinação OR anularia o resto).
drop policy if exists usuarios_acesso_total on public.crm_usuarios;

-- limpa versões anteriores destas políticas (re-execução segura)
drop policy if exists crm_usuarios_select       on public.crm_usuarios;
drop policy if exists crm_usuarios_insert_self   on public.crm_usuarios;
drop policy if exists crm_usuarios_update_admin  on public.crm_usuarios;

-- SELECT: qualquer usuário AUTENTICADO lê a lista de usuários — necessário porque o cliente lê
-- os NOMES de outros usuários para exibir o "responsável" das conversas (usuarioNome: nome||email).
-- anon (sem login) não lê.
--
-- ATENÇÃO (exposição de colunas): o RLS do PostgreSQL é por LINHA, não por COLUNA. Com USING(true)
-- um autenticado lê TODAS as colunas da linha — incluindo `email` (colunas atuais, vistas no app:
-- id, nome, email, role, criado_em). Isso é o MESMO que a política aberta já permitia, e é o que
-- o app espera hoje, pois `_ler('crm_usuarios')` usa SELECT * (boot e recarregarUsuarios).
-- Para esconder `email` dos não-admins seria preciso PRIMEIRO alterar o cliente (fora do escopo
-- desta tarefa, que não altera index.html) para ler colunas explícitas (id, nome, role) e então
-- aplicar UMA destas opções no banco: (a) GRANT por coluna (revoke email de authenticated) ou
-- (b) uma VIEW só com (id, nome, role) para a leitura da lista. Antes de escolher, INSPECIONE no
-- código os 2 pontos que leem a tabela: _ler('crm_usuarios') no boot e em recarregarUsuarios(),
-- e confirme que nada depende de `email`/`criado_em` de OUTROS usuários para não-admins.
create policy crm_usuarios_select on public.crm_usuarios
  for select to authenticated
  using ( true );

-- INSERT: só a própria linha (bootstrap do perfil no 1º login). O trigger força role='atendente'.
create policy crm_usuarios_insert_self on public.crm_usuarios
  for insert to authenticated
  with check ( id = auth.uid() );

-- UPDATE: só admin (o trigger impede autopromoção, auto-rebaixamento e protege o último admin).
create policy crm_usuarios_update_admin on public.crm_usuarios
  for update to authenticated
  using ( public.is_admin() )
  with check ( public.is_admin() );

-- (sem policy de DELETE: cliente anon/authenticated não exclui perfis)

-- ---------------------------------------------------------------------
-- 4) SEED do administrador — valida e promove, com o trigger desabilitado só aqui.
--    Está DENTRO da mesma transação: se validar/promover falhar, o rollback geral
--    reabilita o trigger e restaura a política antiga. Aborta sem alterar papéis se o
--    e-mail não existir, for ambíguo, ou não tiver exatamente 1 perfil.
--    >>> CONFIRME/EDITE o e-mail abaixo. <<<
-- ---------------------------------------------------------------------
alter table public.crm_usuarios disable trigger trg_crm_usuarios_guard;

do $$
declare
  v_email text := lower('dant.advenue@gmail.com');   -- <<< confirme/edite
  v_id uuid;
  n_auth int;
  n_perfil int;
begin
  select count(*) into n_auth from auth.users where lower(email) = v_email;
  if n_auth = 0 then
    raise exception 'Seed abortado: e-mail % nao existe em auth.users (faça login 1x no app antes).', v_email;
  elsif n_auth > 1 then
    raise exception 'Seed abortado: e-mail % ambiguo em auth.users (% ocorrencias).', v_email, n_auth;
  end if;

  select id into v_id from auth.users where lower(email) = v_email;

  select count(*) into n_perfil from public.crm_usuarios where id = v_id;
  if n_perfil <> 1 then
    raise exception 'Seed abortado: usuario % sem registro unico em crm_usuarios (abra o app logado 1x).', v_email;
  end if;

  update public.crm_usuarios set role = 'admin' where id = v_id;
  raise notice 'Seed OK: % promovido a admin.', v_email;
end;
$$;

alter table public.crm_usuarios enable trigger trg_crm_usuarios_guard;

commit;

-- ---------------------------------------------------------------------
-- 5) VALIDAÇÃO (somente leitura — rode DEPOIS, separadamente)
-- ---------------------------------------------------------------------
-- (a) Políticas e trigger:
-- select policyname, cmd, roles, qual, with_check from pg_policies where tablename='crm_usuarios';
--   -> esperado: SEM usuarios_acesso_total; 3 políticas (select/insert/update) para {authenticated}.
-- select id, role from public.crm_usuarios order by role;                 -- admin semeado presente
-- select tgname, tgenabled from pg_trigger where tgrelid='public.crm_usuarios'::regclass and not tgisinternal;
--   -> trg_crm_usuarios_guard com tgenabled='O' (habilitado).
--
-- (b) GRANTs atuais de anon/authenticated na tabela (item 4 — NÃO altere sem necessidade):
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema='public' and table_name='crm_usuarios'
--    and grantee in ('anon','authenticated')
--  order by grantee, privilege_type;
--   -> As políticas assumem o padrão Supabase (authenticated com SELECT/INSERT/UPDATE; o RLS é o
--      portão). Se authenticated NÃO tiver SELECT/INSERT/UPDATE, o app quebra; se tiver DELETE,
--      lembre que não há policy de DELETE (logo o cliente não deleta mesmo). Só ajuste GRANT se
--      esta consulta mostrar algo incompatível — e justifique a mudança.
--
-- (c) Validar a confiança em service_role (item 3):
--     PREFERÊNCIA — validação COMPORTAMENTAL, sem criar função nem usar service_role no cliente:
--       • Contexto authenticated: logado como atendente, a autopromoção do item (d) deve FALHAR.
--         Isso já prova que 'authenticated' NÃO é tratado como confiável.
--       • Contexto service_role: a Edge Function criar_usuario (que roda no servidor e guarda a
--         service_role em secret) cria um usuário com sucesso de ponta a ponta. Isso prova que
--         'service_role' É tratado como confiável. Nenhuma chave sai do servidor.
--     Estes dois testes já cobrem a distinção sem expor segredos.
--
--     OPCIONAL (só se quiser inspecionar o claim diretamente) — faça em AMBIENTE SEGURO, nunca no
--     navegador/código cliente, e com a service_role mantida como variável de ambiente secreta:
--        -- (no SQL Editor, cria a função temporária de leitura)
--        -- create function public.debug_jwt_role() returns text
--        --   language sql stable security definer set search_path=public as $f$
--        --     select coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'),'(sem claim)');
--        --   $f$;
--        -- (num servidor/terminal, com a chave em $SERVICE_KEY — NUNCA colar em cliente/navegador)
--        --   curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/debug_jwt_role" \
--        --        -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
--        -- repita com a chave anon e com um JWT de usuário; espere 'service_role'/'anon'/'authenticated'.
--     REMOVA a função IMEDIATAMENTE após o teste:  drop function public.debug_jwt_role();
--     (Enquanto existir, ela é um RPC público que revela ao chamador apenas o PRÓPRIO papel —
--      ainda assim, não a deixe instalada em produção.)
--
-- (d) Teste de autopromoção (como usuário autenticado NÃO admin — deve FALHAR):
--   update public.crm_usuarios set role='admin' where id = auth.uid();

-- ---------------------------------------------------------------------
-- 6) ROLLBACK — há DUAS opções distintas. Escolha conscientemente.
--    Para escolher o lote, liste primeiro (somente leitura):
--      select backup_batch_id, backup_em, count(*) from public.crm_usuarios_bkp_roles
--        group by backup_batch_id, backup_em order by backup_em desc;
-- ---------------------------------------------------------------------
--
-- 6A) RESTAURAÇÃO SEGURA (recomendada) — desfaz APENAS a promoção de papéis, usando um lote
--     EXPLÍCITO. MANTÉM as proteções (RLS, políticas restritivas, trigger). NÃO reabre acesso.
--     O trigger é desabilitado SÓ dentro desta transação (o SQL Editor NÃO é tratado como
--     service_role, então, sem desabilitar, o trigger bloquearia a restauração que rebaixa papéis).
--     Se qualquer etapa falhar, o ROLLBACK reverte inclusive o disable — o trigger nunca fica off.
-- begin;
--   alter table public.crm_usuarios disable trigger trg_crm_usuarios_guard;
--   do $$
--   declare
--     v_batch uuid := '<COLE_AQUI_O_BATCH_ID>'::uuid;   -- << obrigatório: id explícito do lote
--     n int;
--   begin
--     select count(*) into n from public.crm_usuarios_bkp_roles where backup_batch_id = v_batch;
--     if n = 0 then
--       raise exception 'Rollback 6A abortado: batch_id % nao existe no backup.', v_batch;
--     end if;
--     update public.crm_usuarios u set role = b.role
--       from public.crm_usuarios_bkp_roles b
--      where b.id = u.id and b.backup_batch_id = v_batch;
--     raise notice 'Rollback 6A: papeis restaurados do lote % (% linhas de backup).', v_batch, n;
--   end;
--   $$;
--   alter table public.crm_usuarios enable trigger trg_crm_usuarios_guard;
-- commit;
--
-- 6B) REVERSÃO EMERGENCIAL DAS PROTEÇÕES  ⚠️ REABRE ACESSO IRRESTRITO ⚠️
--     Use SOMENTE se as novas regras travarem o acesso (ex.: lockout do admin) e você precisar
--     recuperar o sistema. Isto RECRIA a política aberta `usuarios_acesso_total` (USING true /
--     WITH CHECK true para `public`) — ou seja, VOLTA a deixar a tabela TOTALMENTE aberta.
--     Trate como medida temporária: investigue e reaplique as proteções o quanto antes.
--     (Observação: só dropar as políticas restritivas com o RLS habilitado deixaria a tabela em
--      deny-all e travaria o app; por isso a reabertura é necessária NESTE caminho de emergência.)
-- begin;
--   drop policy if exists crm_usuarios_update_admin on public.crm_usuarios;
--   drop policy if exists crm_usuarios_insert_self  on public.crm_usuarios;
--   drop policy if exists crm_usuarios_select       on public.crm_usuarios;
--   drop trigger  if exists trg_crm_usuarios_guard  on public.crm_usuarios;
--   drop function if exists public.crm_usuarios_guard();
--   drop function if exists public.is_admin();
--   create policy usuarios_acesso_total on public.crm_usuarios
--     as permissive for all to public using ( true ) with check ( true );  -- ⚠️ ACESSO TOTAL
--   -- (opcional) restaurar papéis de um lote explícito, como em 6A.
-- commit;

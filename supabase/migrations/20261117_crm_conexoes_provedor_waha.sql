-- =====================================================================
-- Prado Chat — aceitar 'waha' como provedor de conexão (Evolution + Z-API + WAHA)
-- Projeto: dantadvenue-byte's Project (PRODUCTION) · tabela public.crm_conexoes
--
-- O QUE FAZ: troca a regra ck_conexoes_provedor de ('evolution','zapi') para
-- ('evolution','zapi','waha'). Só AMPLIA o que é aceito — nenhuma linha é alterada.
--
-- IMPACTO: as 5 conexões atuais (4 'evolution' + 1 'zapi') continuam válidas e intocadas.
-- A tabela tem 5 linhas: o bloqueio dura milissegundos. Nenhuma outra tabela é tocada.
-- Tudo em UMA transação: se algo falhar, nada muda.
-- =====================================================================

begin;

-- Trava curta: falha rápido (em vez de esperar) se alguém estiver mexendo na tabela agora.
set local lock_timeout = '3s';

alter table public.crm_conexoes drop constraint ck_conexoes_provedor;
alter table public.crm_conexoes add constraint ck_conexoes_provedor
  check (provedor = any (array['evolution'::text, 'zapi'::text, 'waha'::text]));

commit;

-- CONFERÊNCIA (somente leitura):
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'ck_conexoes_provedor';
--   select provedor, count(*) from public.crm_conexoes group by 1;

-- ---------------------------------------------------------------------
-- DESFAZER (só funciona se NÃO houver nenhuma conexão 'waha' cadastrada):
--   begin;
--   set local lock_timeout = '3s';
--   alter table public.crm_conexoes drop constraint ck_conexoes_provedor;
--   alter table public.crm_conexoes add constraint ck_conexoes_provedor
--     check (provedor = any (array['evolution'::text, 'zapi'::text]));
--   commit;
-- ---------------------------------------------------------------------

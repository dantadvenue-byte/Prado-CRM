-- v146 — (1) reações com emoji nas mensagens; (2) registro de diagnóstico de falhas de envio.
-- Só ACRESCENTA: nenhuma coluna/tabela existente muda e nenhuma regra de acesso existente é alterada.

-- (1) Reações: {"cliente": "❤️", "eu": "👍"} — gravado pelo waha-webhook (service role).
alter table public.crm_mensagens add column if not exists reacoes jsonb;

-- (2) Diagnóstico: o app grava falhas/lentidão de envio e erros de script (sem texto de cliente).
create table if not exists public.crm_diag_eventos (
  id        bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  user_id   uuid not null default auth.uid(),
  versao    text,
  evento    text not null,
  detalhe   jsonb,
  ua        text
);
create index if not exists crm_diag_eventos_criado_idx on public.crm_diag_eventos (criado_em desc);
alter table public.crm_diag_eventos enable row level security;
-- cada usuário logado só grava registros dele mesmo
drop policy if exists diag_inserir_proprio on public.crm_diag_eventos;
create policy diag_inserir_proprio on public.crm_diag_eventos
  for insert to authenticated with check (user_id = auth.uid() and length(evento) <= 60);
-- só admin lê
drop policy if exists diag_ler_admin on public.crm_diag_eventos;
create policy diag_ler_admin on public.crm_diag_eventos
  for select to authenticated using (public.is_admin());

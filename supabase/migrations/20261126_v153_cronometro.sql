-- v153 (aplicado) — cronômetro por coluna
alter table public.crm_etapas add column if not exists prazo_horas integer;
alter table public.crm_contatos add column if not exists etapa_desde timestamptz;
create table if not exists public.crm_etapa_mov (
  id bigint generated always as identity primary key,
  contato_id bigint not null, de_etapa bigint, para_etapa bigint,
  user_id uuid default auth.uid(), quando timestamptz not null default now()
);
create index if not exists crm_etapa_mov_contato_idx on public.crm_etapa_mov (contato_id, quando desc);
create index if not exists crm_etapa_mov_para_idx on public.crm_etapa_mov (para_etapa, quando desc);
alter table public.crm_etapa_mov enable row level security;
drop policy if exists etapa_mov_ler on public.crm_etapa_mov;
create policy etapa_mov_ler on public.crm_etapa_mov for select to authenticated using (true);
create or replace function public._crm_contato_etapa_desde()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.etapa_desde := now();
    if new.etapa_id is not null then
      insert into public.crm_etapa_mov(contato_id, de_etapa, para_etapa) values (new.id, null, new.etapa_id);
    end if;
  elsif new.etapa_id is distinct from old.etapa_id then
    new.etapa_desde := now();
    insert into public.crm_etapa_mov(contato_id, de_etapa, para_etapa) values (new.id, old.etapa_id, new.etapa_id);
  else
    new.etapa_desde := coalesce(old.etapa_desde, now());
  end if;
  return new;
end $$;
drop trigger if exists trg_crm_contato_etapa_desde on public.crm_contatos;
create trigger trg_crm_contato_etapa_desde before insert or update on public.crm_contatos
  for each row execute function public._crm_contato_etapa_desde();
update public.crm_contatos set etapa_desde = now() where etapa_desde is null;

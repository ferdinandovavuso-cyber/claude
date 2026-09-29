-- Schema Supabase per il Planner Montaggio.
-- Esegui tutto nel SQL Editor del progetto, poi inserisci una chiave in planner_access
-- e condividi il link https://<dominio>/?k=<chiave>.

create table if not exists public.clients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  color         text not null default '#f59e0b',
  -- video pubblicati per giorno della settimana, indice 0 = domenica ... 6 = sabato
  schedule      int[] not null default '{0,1,0,1,0,1,0}',
  -- giorni di anticipo con cui il video deve essere pronto rispetto alla pubblicazione
  lead_days     int not null default 2,
  -- da questa data si inizia a contare la copertura
  start_date    date not null default current_date,
  -- video già montati e non ancora pubblicati alla start_date
  initial_stock int not null default 0,
  -- girato grezzo già consegnato al montatore e non ancora montato alla start_date
  initial_raw   int not null default 0,
  notes         text,
  hidden        boolean not null default false, -- nascosto da scadenze e calendari, i dati restano
  created_at    timestamptz not null default now()
);

create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  kind       text not null check (kind in ('edited', 'raw')),
  qty        int  not null check (qty > 0),
  date       date not null default current_date,
  note       text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists events_client_idx on public.events(client_id);

alter table public.clients enable row level security;
alter table public.events  enable row level security;

-- Accesso con link segreto (niente login): l'app manda la chiave nell'header x-planner-key.
-- Chi apre il sito senza chiave valida non vede e non modifica nulla.
create table if not exists public.planner_access (
  key text primary key,
  label text,
  created_at timestamptz not null default now()
);
alter table public.planner_access enable row level security; -- nessuna policy: solo da dashboard
-- insert into public.planner_access (key, label) values ('<chiave-lunga-casuale>', 'link team');

create or replace function public.has_planner_key()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.planner_access
    where key = coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-planner-key', '')
  );
$$;
revoke all on function public.has_planner_key() from public;
grant execute on function public.has_planner_key() to anon, authenticated;

drop policy if exists planner_clients on public.clients;
create policy planner_clients on public.clients for all to anon, authenticated
  using ((select public.has_planner_key())) with check ((select public.has_planner_key()));

drop policy if exists planner_events on public.events;
create policy planner_events on public.events for all to anon, authenticated
  using ((select public.has_planner_key())) with check ((select public.has_planner_key()));

-- Collegamento al CRM (fvl-core.crm_clienti) e video al mese da contratto.
alter table public.clients add column if not exists crm_id uuid unique;
alter table public.clients add column if not exists videos_per_month int;


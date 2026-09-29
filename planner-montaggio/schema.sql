-- Schema Supabase per il Planner Montaggio.
-- Esegui tutto nel SQL Editor del progetto, poi crea gli utenti (tu + montatore)
-- da Authentication > Users > "Add user" e aggiungi le loro email a team_members.

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
  archived      boolean not null default false,
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

-- Lista delle email autorizzate: anche chi si registra da solo non vede nulla se non è qui.
-- Per aggiungere il montatore: insert into public.team_members (email) values ('sua@email.it');
create table if not exists public.team_members (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table public.team_members enable row level security; -- nessuna policy: solo da dashboard

create or replace function public.is_team_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_team_member() from public, anon;
grant execute on function public.is_team_member() to authenticated;

drop policy if exists team_clients on public.clients;
create policy team_clients on public.clients for all to authenticated
  using ((select public.is_team_member())) with check ((select public.is_team_member()));

drop policy if exists team_events on public.events;
create policy team_events on public.events for all to authenticated
  using ((select public.is_team_member())) with check ((select public.is_team_member()));

-- Aggiornamento in tempo reale tra i due schermi.
alter publication supabase_realtime add table public.clients, public.events;

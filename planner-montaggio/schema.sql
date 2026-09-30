-- Schema Supabase del Planner Montaggio (progetto fvl-montaggio), allineato al database in produzione.
-- Per ricrearlo da zero: esegui tutto nel SQL Editor, inserisci una chiave in planner_access
-- e condividi il link https://<dominio>/?k=<chiave>.

-- ---------- Clienti ----------
create table if not exists public.clients (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  color            text not null default '#f59e0b',
  -- video pubblicati per giorno della settimana, indice 0 = domenica ... 6 = sabato
  schedule         int[] not null default '{0,1,0,1,0,1,0}',
  -- giorni di anticipo con cui il video deve essere pronto rispetto all'uscita
  lead_days        int not null default 2,
  -- da questa data si conta la copertura
  start_date       date not null default current_date,
  -- video già montati e non ancora pubblicati alla start_date
  initial_stock    int not null default 0,
  -- girato grezzo già in mano al montatore alla start_date
  initial_raw      int not null default 0,
  notes            text,
  hidden           boolean not null default false, -- nascosto da scadenze e calendari, i dati restano
  crm_id           uuid unique,                     -- fvl-core.crm_clienti.id
  videos_per_month int,                             -- video al mese da contratto
  pubblie_accounts text[] not null default '{}',   -- nomi esatti degli account su Pubblie
  cycle_start      date,                            -- inizio del giro in corso (lo decide l'utente)
  cycle_edited     int not null default 0,          -- video montati nel giro in corso (li aggiorna il montatore)
  to_shoot         boolean not null default false,  -- video ancora da girare: niente scadenze di montaggio
  to_shoot_since   date,                            -- da quando è da girare (null se non lo è)
  created_at       timestamptz not null default now()
);

-- ---------- Registro: video montati e grezzi consegnati ----------
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

-- ---------- Post di Pubblie (scritti dalla Edge Function sync-pubblie) ----------
create table if not exists public.publications (
  id          uuid primary key default gen_random_uuid(),
  pubblie_id  text unique not null,
  client_id   uuid references public.clients(id) on delete set null,
  channel     text not null,
  date        date not null,
  status      text not null check (status in ('published','scheduled','error','partial','removed')),
  has_video   boolean not null default true,
  excerpt     text,
  synced_at   timestamptz not null default now()
);
create index if not exists publications_date_idx on public.publications(date);

create table if not exists public.sync_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  posts       int,
  unmapped    text[],
  error       text
);

-- ---------- Accesso con link segreto (niente login) ----------
-- L'app manda la chiave nell'header x-planner-key; senza chiave valida non si vede e non si modifica nulla.
create table if not exists public.planner_access (
  key        text primary key,
  label      text,
  created_at timestamptz not null default now()
);
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

-- ---------- Token OAuth di Pubblie (solo Edge Function, con service role) ----------
create table if not exists public.pubblie_oauth (
  id                int primary key default 1 check (id = 1),
  client_id         text,
  client_secret     text,
  redirect_uri      text,
  access_token      text,
  access_expires_at timestamptz,
  refresh_token     text,
  pkce_verifier     text,
  oauth_state       text,
  return_to         text,
  connected_at      timestamptz,
  updated_at        timestamptz not null default now()
);
insert into public.pubblie_oauth (id) values (1) on conflict do nothing;

-- L'app sa solo se Pubblie è collegato, non vede i token.
create or replace function public.pubblie_connected()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_planner_key() and exists (select 1 from public.pubblie_oauth where refresh_token is not null or access_token is not null);
$$;

alter table public.clients        enable row level security;
alter table public.events         enable row level security;
alter table public.publications   enable row level security;
alter table public.sync_runs      enable row level security;
alter table public.planner_access enable row level security; -- nessuna policy: solo da dashboard
alter table public.pubblie_oauth  enable row level security; -- nessuna policy: solo service role

drop policy if exists planner_clients on public.clients;
create policy planner_clients on public.clients for all to anon, authenticated
  using ((select public.has_planner_key())) with check ((select public.has_planner_key()));
drop policy if exists planner_events on public.events;
create policy planner_events on public.events for all to anon, authenticated
  using ((select public.has_planner_key())) with check ((select public.has_planner_key()));
drop policy if exists planner_publications on public.publications;
create policy planner_publications on public.publications for all to anon, authenticated
  using ((select public.has_planner_key())) with check ((select public.has_planner_key()));
drop policy if exists planner_sync_runs_read on public.sync_runs;
create policy planner_sync_runs_read on public.sync_runs for select to anon, authenticated
  using ((select public.has_planner_key()));

-- ---------- Sincronizzazione automatica con Pubblie ogni 2 ore ----------
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'sync-pubblie',
  '0 5-19/2 * * *',
  $$
  select net.http_post(
    url := 'https://zumproecfjycxvymeovo.supabase.co/functions/v1/sync-pubblie',
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-planner-key', (select key from public.planner_access order by created_at limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

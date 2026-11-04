-- =====================================================================================
--  Trade AI accounts: PER-PRODUCT licences (AI Town Planner = product 'townplanner')
--  Run ONCE in the Trade AI Supabase project:  SQL Editor -> New query -> paste all -> Run.
--  Safe to run again (only creates what is missing, replaces the functions).
-- =====================================================================================
--  Needs the Trade AI accounts schema first (ElectricalAI\auth\supabase_schema.sql:
--  profiles, companies, my_company_id()). Nothing in it is changed: ElectricalAI's own
--  'licences' / 'seat_activations' tables keep working exactly as before.
--
--  What this adds
--    product_licences   a paid licence for ONE product, held by a company (shared seats) or
--                       by one person (solo). plan, seats, status, expires_at - like 'licences'.
--    product_trials     the free trial per person per product: starts at the first sign-in
--                       to that product, 15 days.
--    product_seats      which person / computer / phone is using a seat right now
--                       (checks in every 5 minutes; frees itself after 15 minutes).
--    product_access()   the one call the app makes: trial or licence, takes / refreshes a seat.
--    release_product_seat()   gives the seat back on sign-out.
--
--  Security: Row Level Security on; clients can only read their own rows (and company admins
--  their company's). Nothing is written directly by the apps - only through the functions.
--  You (the owner) give licences in Table Editor -> product_licences (see README.md).
-- =====================================================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ licences per product
create table if not exists public.product_licences (
    id          uuid primary key default gen_random_uuid(),
    product     text not null check (product ~ '^[a-z0-9_]{2,32}$'),     -- e.g. 'townplanner'
    company_id  uuid references public.companies(id) on delete cascade,  -- company licence (shared seats) ...
    user_id     uuid references auth.users(id) on delete cascade,        -- ... OR one person's licence
    plan        text not null default 'solo'
                check (plan in ('trial', 'solo', 'team', 'office', 'enterprise')),
    seats       integer not null default 1 check (seats >= 1),           -- people at the same time
    status      text not null default 'active'
                check (status in ('active', 'past_due', 'cancelled', 'expired')),
    starts_at   timestamptz not null default now(),
    expires_at  timestamptz not null default now() + interval '1 year',
    notes       text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    check ((company_id is null) <> (user_id is null))                    -- exactly one holder
);
create unique index if not exists product_licences_company_uq
    on public.product_licences (product, company_id) where company_id is not null;
create unique index if not exists product_licences_user_uq
    on public.product_licences (product, user_id) where user_id is not null;

-- ------------------------------------------------------------------ free trial per person per product
create table if not exists public.product_trials (
    user_id     uuid not null references auth.users(id) on delete cascade,
    product     text not null check (product ~ '^[a-z0-9_]{2,32}$'),
    started_at  timestamptz not null default now(),
    ends_at     timestamptz not null default now() + interval '15 days',
    primary key (user_id, product)
);

-- ------------------------------------------------------------------ seats in use
create table if not exists public.product_seats (
    id            uuid primary key default gen_random_uuid(),
    licence_id    uuid not null references public.product_licences(id) on delete cascade,
    user_id       uuid not null references auth.users(id) on delete cascade,
    device_id     text not null,
    device_name   text,
    app_version   text,
    active        boolean not null default true,
    last_seen_at  timestamptz not null default now(),
    created_at    timestamptz not null default now(),
    unique (licence_id, user_id, device_id)
);
create index if not exists product_seats_live_idx on public.product_seats (licence_id, active, last_seen_at);

-- ------------------------------------------------------------------ Row Level Security
alter table public.product_licences enable row level security;
alter table public.product_trials   enable row level security;
alter table public.product_seats    enable row level security;

revoke insert, update, delete on public.product_licences, public.product_trials, public.product_seats
    from anon, authenticated;

drop policy if exists "read own or company product licences" on public.product_licences;
create policy "read own or company product licences" on public.product_licences for select to authenticated
    using (user_id = auth.uid() or company_id = public.my_company_id());

drop policy if exists "read own trials" on public.product_trials;
create policy "read own trials" on public.product_trials for select to authenticated
    using (user_id = auth.uid());

drop policy if exists "read own or company product seats" on public.product_seats;
create policy "read own or company product seats" on public.product_seats for select to authenticated
    using (user_id = auth.uid() or (public.i_am_company_admin()
           and licence_id in (select id from public.product_licences where company_id = public.my_company_id())));

-- =====================================================================================
--  product_access: trial or paid licence for this product, and a seat for this device.
--  Returns json: { ok, state, product, plan, seats, status, expires_at, in_use }
--    state = 'licensed'  paid licence, seat held             (ok true)
--            'trial'     free trial running (15 days)         (ok true)
--            'expired'   trial over and no active licence     (ok false)
--            'no_seat'   all seats of the licence are in use  (ok false, in_use = who)
--            'disabled'  this account was disabled            (ok false)
-- =====================================================================================
create or replace function public.product_access(
    p_product text, p_device_id text, p_device_name text default null, p_app_version text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
    v_uid   uuid := auth.uid();
    v_lic   public.product_licences%rowtype;
    v_used  int;
    v_who   json;
    v_trial public.product_trials%rowtype;
    v_dev   text := left(coalesce(nullif(trim(p_device_id), ''), 'unknown'), 80);
begin
    if v_uid is null then raise exception 'Not signed in'; end if;
    if p_product is null or p_product !~ '^[a-z0-9_]{2,32}$' then raise exception 'Unknown product'; end if;
    if exists (select 1 from public.profiles where id = v_uid and status = 'disabled') then
        return json_build_object('ok', false, 'state', 'disabled', 'product', p_product);
    end if;

    -- 1) a paid licence: this person's own, or their company's (the one that runs longest)
    select l.* into v_lic from public.product_licences l
     where l.product = p_product
       and (l.user_id = v_uid or (l.company_id is not null and l.company_id = public.my_company_id()))
       and l.status in ('active', 'past_due') and l.expires_at > now()
     order by l.expires_at desc limit 1
     for update;
    if found then
        update public.product_seats set active = false
         where licence_id = v_lic.id and active and last_seen_at < now() - interval '15 minutes';
        update public.product_seats set last_seen_at = now(),
               device_name = coalesce(left(p_device_name, 120), device_name),
               app_version = coalesce(left(p_app_version, 20), app_version)
         where licence_id = v_lic.id and user_id = v_uid and device_id = v_dev and active;
        if not found then
            select count(*) into v_used from public.product_seats where licence_id = v_lic.id and active;
            if v_used >= v_lic.seats then
                select json_agg(json_build_object('name', coalesce(p.full_name, p.email), 'device', s.device_name,
                                                  'since', s.created_at))
                  into v_who
                  from public.product_seats s join public.profiles p on p.id = s.user_id
                 where s.licence_id = v_lic.id and s.active;
                return json_build_object('ok', false, 'state', 'no_seat', 'product', p_product,
                    'plan', v_lic.plan, 'seats', v_lic.seats, 'status', v_lic.status,
                    'expires_at', v_lic.expires_at, 'in_use', coalesce(v_who, '[]'::json));
            end if;
            insert into public.product_seats (licence_id, user_id, device_id, device_name, app_version, active, last_seen_at)
            values (v_lic.id, v_uid, v_dev, left(p_device_name, 120), left(p_app_version, 20), true, now())
            on conflict (licence_id, user_id, device_id)
            do update set active = true, last_seen_at = now(), device_name = excluded.device_name,
                          app_version = excluded.app_version, created_at = now();
        end if;
        return json_build_object('ok', true, 'state', 'licensed', 'product', p_product,
            'plan', v_lic.plan, 'seats', v_lic.seats, 'status', v_lic.status, 'expires_at', v_lic.expires_at);
    end if;

    -- 2) no paid licence: the free trial (starts the first time this person opens the product)
    insert into public.product_trials (user_id, product) values (v_uid, p_product) on conflict do nothing;
    select * into v_trial from public.product_trials where user_id = v_uid and product = p_product;
    return json_build_object('ok', v_trial.ends_at > now(),
        'state', case when v_trial.ends_at > now() then 'trial' else 'expired' end,
        'product', p_product, 'plan', 'trial', 'seats', 1, 'status', 'active',
        'expires_at', v_trial.ends_at, 'trial_started_at', v_trial.started_at);
end $$;

-- give the seat back (sign out)
create or replace function public.release_product_seat(p_product text, p_device_id text) returns void
language sql security definer set search_path = public as $$
    update public.product_seats s set active = false
      from public.product_licences l
     where s.licence_id = l.id and l.product = p_product
       and s.user_id = auth.uid() and s.device_id = p_device_id and s.active;
$$;

revoke execute on function public.product_access(text, text, text, text), public.release_product_seat(text, text)
    from anon, public;
grant execute on function public.product_access(text, text, text, text), public.release_product_seat(text, text)
    to authenticated;

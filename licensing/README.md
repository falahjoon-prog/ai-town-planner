# AI Town Planner – paid licence (Trade AI accounts)

AI Town Planner uses the **same Trade AI sign-in** as ElectricalAI / PaintingAI / TilingAI (Supabase
e-mail + password, same accounts, same `profiles` and `companies`). It is its own product, `townplanner`:
a 15-day free trial per person from the first sign-in, then a paid licence (a person's own, or their
company's with shared seats). An ElectricalAI licence does **not** open the Town Planner.

## Owner: set up once (about 10 minutes)

1. **Database.** Supabase → the Trade AI project → SQL Editor → New query → paste all of
   `licensing/SUPABASE_SETUP.sql` → Run. (It needs ElectricalAI's `auth/supabase_schema.sql` in the same
   project; run that first if this project doesn't have it. Safe to run again.)
2. **Keys for the builds.** GitHub → falahjoon-prog/ai-town-planner → Settings → Secrets and variables →
   Actions → **Variables** tab → New repository variable:
   - `TRADEAI_SUPABASE_URL` = Project URL (Supabase → Project Settings → API), e.g. `https://abcd.supabase.co`
   - `TRADEAI_SUPABASE_ANON_KEY` = the **anon / publishable** key (never the service_role / secret key)

   Then Actions → "Build app" → Run workflow, and "Web app" → Run workflow. Both builds write these two
   values into the program. **Done 2026-11-04:** the Trade AI project is `trade-ai`
   (`https://iqtilarntgenosjrevoz.supabase.co`, Sydney, owner account tradeai.apps@gmail.com); both SQL files
   have been run, Site URL = https://planner.trade-ai.com.au, and the workflows fall back to this URL and
   its public anon key when the variables are not set. Set the variables only to point at a different project.
3. **Optional, web server only:** `SUPABASE_JWT_SECRET` (Project Settings → API → JWT secret, legacy HS256)
   in `/etc/atp/atp.env` on the server lets it reject forged tokens without asking Supabase. Never put the
   JWT secret or service_role key in GitHub variables or the desktop app.
4. **Sign-up e-mails.** Authentication → Sign In / Providers → Email on ("Confirm email" recommended).

## Give someone a paid licence

Table Editor → `product_licences` → Insert row, or SQL Editor:

```sql
-- one person (solo), 1 year
insert into product_licences (product, user_id, plan, seats, expires_at)
select 'townplanner', id, 'solo', 1, now() + interval '1 year' from auth.users where email = 'client@example.com';

-- a whole company, 5 people at the same time
insert into product_licences (product, company_id, plan, seats, expires_at)
select 'townplanner', company_id, 'team', 5, now() + interval '1 year' from profiles where email = 'owner@client.com.au';
```

Cancel: set `status` to `cancelled`. Extend: change `expires_at`. Trials: table `product_trials`
(set `ends_at` to give someone more trial days). Seats in use: `product_seats`.

## How the apps use it

- **Desktop:** sign-in screen on first open. The session (refresh token) is kept in the OS credential store
  (Windows Credential Manager / macOS Keychain), never in a file or log. Every 5 minutes the app calls
  `product_access('townplanner', device)` (keeps the seat; a closed or crashed computer frees its seat after
  15 minutes). No internet: someone who was checked online in the last **7 days** keeps working, as long as
  their trial / licence end date has not passed (the same rule as ElectricalAI's `OFFLINE_GRACE_DAYS`).
  Settings → Account → Sign out gives the seat back.
- **Phone web app:** the same sign-in page. The server checks **every** `/api/*` call: a valid Supabase
  access token (Supabase verifies its signature and expiry; with `SUPABASE_JWT_SECRET` the server also checks
  it itself) and an active trial or seat for `townplanner`, else HTTP 401 (sign in) or 402 (licence needed).
  Answers are cached for 60 seconds per token. Each phone counts as a device (seat).
- Buy / renew: **trade-ai.com.au**.

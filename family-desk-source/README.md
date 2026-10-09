# HERO Family Desk

The staff app for Hero Training Center: families, rosters, ESA invoices, and a window into Stripe. Built and run by Claude for HERO HQ LLC.

## How it fits together

- **This folder** (`family-desk-source/`) is a static React app (Vite + TypeScript). It lives inside the `hero-training-apps` repo, which GitHub Pages serves at app.hero.training. `npm run build:pages` writes the finished app to `../family-desk/`, and pushing that to `main` puts it live at https://app.hero.training/family-desk/ within a minute or two. (Cloudflare Pages from a private repo is the planned long-term home; nothing in the code changes for that move.)
- **Supabase** (project `family-desk`) holds the database, sign-ins with two-step codes, and the server-side code in `supabase/functions/`. Row-level security in `supabase/migrations/` decides what each role can see; the screens never decide that on their own.
- **Stripe** holds the money. The app reads subscriptions and payments and creates ESA invoices through the `stripe-family` and `esa-invoices` functions. It never stores card details.
- **SuperBooks** holds the books. Nothing in this app replaces it.

## Environment

Two public values, set in a local `.env` before `npm run build:pages` (see `.env.example`):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Secrets live only in Supabase (Edge Functions → Secrets): `STRIPE_SECRET_KEY`, a restricted key for the Stripe sandbox. Setting `STRIPE_LIVE_OK=yes` is what later allows a live key.

## Working on it

```
npm install
npm run dev            # against the real Supabase project
VITE_MOCK=1 npm run dev  # built-in made-up families, no sign-in
npm run build:pages    # the live app, into ../family-desk/ (commit and push that folder)
npm run shots          # screenshots of the demo build in shots/
```

Database changes go in a new file under `supabase/migrations/` and are applied through the Supabase connector or CLI. Function changes are deployed the same way.

## Roles

| Role | Sees |
| --- | --- |
| Owner | Everything, including the Staff screen and the audit log |
| Admin | Families, money, messages; can be pinned to one site |
| Site lead | Their site's rosters |
| Coach | Rosters for their assigned programs; care notes on class day only |

Every change to family, child, enrollment, invoice, or staff rows is written to `audit_log` with who did it and, for money changes, why.

## Sign-ins

Family Desk sends no email. An owner adds a person on the Staff screen, taps **Create sign-in**, and hands them the temporary password in person or by phone. At their first sign-in they scan a QR code into an authenticator app (two-step codes are required for everyone, because the app holds children's records) and then change their password under their own name. **Reset password** and **Reset 2-step** on the same screen cover a lost password or a lost phone. The `staff-signin` function does this work; only an owner who has finished two-step sign-in can call it.

The very first owner account can't be created from inside the app (nobody is signed in yet). Create it once in the Supabase dashboard: Authentication → Users → Add user, with an email that is already on the staff list, and tick "Auto confirm user". After that, every other sign-in comes from the Staff screen.

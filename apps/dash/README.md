# @dynobox/dash

Dynobox product dashboard. Local development uses Vite, Supabase Auth, and the local API worker.

## Local Supabase

Start the local Supabase stack from the repo root. For dashboard auth testing, only Auth, its database, Kong, and Mailpit need to run:

```sh
pnpm dlx supabase start -x realtime,storage-api,imgproxy,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
```

If the minimal stack fails after a CLI upgrade, fall back to the full stack with `pnpm dlx supabase start`.

Useful local URLs:

- Mailpit inbox: `http://127.0.0.1:54324`
- API/Auth: `http://127.0.0.1:54321`

Signup confirmation and reset-password emails are captured in Mailpit instead of being sent externally.

## Environment

Create or update `apps/dash/.env` with the local values printed by `supabase start` or `pnpm dlx supabase status`:

```env
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=<local publishable key>
VITE_AUTH_REDIRECT_ORIGIN=http://localhost:5173
API_BASE_URL=http://localhost:8787
```

If testing CLI token creation with the local API worker, also update `apps/api/.dev.vars`:

```env
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_PUBLISHABLE_KEY=<same local publishable key>
```

Apply the API worker's local D1 migrations before testing `/cli-auth`:

```sh
pnpm --filter @dynobox/api db:migrate:local
```

Both files are ignored and should not be committed.

## Auth Redirects

Local redirects are configured in `supabase/config.toml`:

```toml
[auth]
site_url = "http://localhost:5173"
additional_redirect_urls = ["http://localhost:5173", "http://localhost:5173/reset-password"]
```

After changing Supabase config, restart the stack:

```sh
pnpm dlx supabase stop
pnpm dlx supabase start -x realtime,storage-api,imgproxy,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
```

## Run Locally

Start the dashboard:

```sh
pnpm --filter @dynobox/dash dev
```

Start the API worker in another terminal when testing `/cli-auth`:

```sh
pnpm --filter @dynobox/api dev
```

## Auth Testing

1. Open `http://localhost:5173`.
2. Create an account or request a password reset.
3. Open Mailpit at `http://127.0.0.1:54324`.
4. Click the confirmation or reset link.
5. The link should redirect back to `http://localhost:5173`.

If the app was already running when `.env` changed, restart Vite so it picks up the new values.

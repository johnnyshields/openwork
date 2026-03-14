# OpenWork Cloud App (`packages/web`)

Frontend for `app.openwork.software`.

## What it does

- Signs up / signs in users against Pantheon auth service.
- Launches cloud workers via `POST /backend/workers`.
- Uses a Next.js proxy route (`/api/den/*`) to reach the Pantheon API without browser CORS issues.
- Uses a same-origin auth proxy (`/api/auth/*`) for SSH key challenge-response auth flows.

## Local development

1. Install workspace deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @different-ai/openwork-web dev`
3. Open:
   `http://localhost:3005`

### Optional env vars

- `PANTHEON_API_BASE` (server-only): upstream Pantheon API base used by proxy route.
  - default: `https://api.openwork.software`
- `PANTHEON_AUTH_ORIGIN` (server-only): Origin header sent to Pantheon auth endpoints when the browser request does not include one.
  - default: `https://app.openwork.software`
- `NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL` (client): Base URL for "Open in App" links.
  - Example: `https://openwork.software/app`
  - The web panel appends `/connect-remote` and injects worker URL/token params automatically.
- `NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL` (client): Canonical URL used for GitHub auth callback redirects.
  - default: `https://app.openwork.software`
  - this host must serve `/api/auth/*`; the included proxy route does that
- `NEXT_PUBLIC_POSTHOG_KEY` (client): PostHog project key used for Den analytics.
  - optional override; defaults to the same project key used by `packages/landing`
- `NEXT_PUBLIC_POSTHOG_HOST` (client): PostHog ingest host or same-origin proxy path.
  - default: `/ow`
  - set it to `https://us.i.posthog.com` to bypass the local proxy
- `LOOPS_API_KEY` (server-only): Loops API key for signup contact capture.

## Deploy on Vercel

Recommended project settings:

- Root directory: `packages/web`
- Framework preset: Next.js
- Build command: `next build`
- Output directory: `.next`
- Install command: `npm install` (or `pnpm install`)

Then assign custom domain:

- `app.openwork.software`

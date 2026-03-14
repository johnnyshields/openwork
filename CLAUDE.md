# OpenWork

## Architecture

- **All management backends live in Pantheon** (`/mnt/c/workspace/pantheon`). Auth, worker management, admin UI, provider/seat management, conversations API — everything is in Pantheon.
- **No billing integration.** No Polar, no paywalls, no checkout flows.
- **`packages/web` is NOT used.** Pantheon serves all management UI directly (HTML + JS pages at `/app/*`). Do not build on or reference `packages/web`.
- **`packages/app`** is the SolidJS chat UI. It connects to OpenCode engines running on workers provisioned by Pantheon.
- **`packages/server`** is the HTTP API layer between the app and OpenCode. It runs inside worker containers.

## Authentication (OIDC SSO)

- **Pantheon is the OIDC Identity Provider**, OpenWork is the Relying Party.
- Flow: OpenWork redirects to `{PANTHEON}/oauth/authorize` → user logs in at Pantheon → redirected back to `/auth/callback?code=X&state=Y` → code exchanged for tokens via `POST /oauth/token`.
- **PKCE required**: OpenWork generates `code_verifier` + SHA256 `code_challenge`. Pantheon validates on token exchange.
- **Tokens**: `access_token` (HS256, same as Pantheon login JWT) + `id_token` (RS256, OIDC standard claims). Access token stored in `localStorage` under key `"pantheon.jwt"`.
- **OIDC endpoints** (Pantheon): `/.well-known/openid-configuration`, `/oauth/jwks`, `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`.
- **Key files**: `pantheon/auth/oidc.py` (OIDCProvider), `pantheon/api/routes/oidc.py` (endpoints), OpenWork `pantheon-sdk.tsx` (login flow), `pantheon-client.ts` (exchangeCode).
- **Config**: `PANTHEON_OIDC_CLIENT_SECRET` (env), `PANTHEON_OIDC_REDIRECT_URIS` (comma-separated allowed callback URLs).
- **RSA key**: Auto-generated on first boot, persisted to `PANTHEON_OIDC_RSA_KEY_PATH` (default: `oidc_rsa_key.pem`). Used for RS256 ID token signing.
- **`loginLocalhost()`** is kept for backwards compatibility but not used in OIDC flow.

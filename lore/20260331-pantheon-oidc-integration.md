# Pantheon OIDC Login + API Rewiring

**Date**: 2026-03-31
**Status**: Implemented (not yet tested end-to-end)

## Summary

Rewired the OpenWork Tauri desktop app to authenticate via Pantheon OIDC and route all API calls through Pantheon (`localhost:8081`) instead of local OpenCode/OpenWork server processes.

## Key Design Decisions

- **`VITE_PANTHEON_BASE_URL`** env var activates "Pantheon mode" — detected by `isPantheonMode()` utility
- **Pantheon IS the local server** — replaces both OpenCode engine and OpenWork server
- **No new adapter layer** — Pantheon's `/openwork/api/*` endpoints return identical response formats
- **All overrides marked** with `// BEGIN-PANTHEON-OVERRIDE` / `// END-PANTHEON-OVERRIDE` comments for easy discovery and future removal
- **Remote server UI hidden** in Pantheon mode (to be re-enabled later)

## OIDC Flow

1. App mounts → `PantheonAuthGate` checks for existing JWT in `localStorage("pantheon.jwt")`
2. Dev shortcut: if Pantheon URL is localhost, auto-login via `POST /backend/login/localhost`
3. Otherwise: PKCE auth code flow → popup to `/oauth/authorize` → callback → token exchange at `/oauth/token`
4. JWT stored in both `pantheon.jwt` and `openwork.server.token` (existing auth infrastructure reads the latter)

## Files Changed (12 files, 31 override blocks)

### New files
- `apps/app/src/app/context/pantheon-auth.tsx` — OIDC login gate component
- `apps/app/src/app/pages/auth-callback.tsx` — OAuth popup callback route

### Modified files
- `apps/app/src/app/utils/index.ts` — `isPantheonMode()`, `pantheonBaseUrl()`
- `apps/app/src/app/entry.tsx` — Pantheon URL priority, auth gate wrapper
- `apps/app/src/app/context/server.tsx` — Force Pantheon URL, JWT in health checks
- `apps/app/src/app/context/global-sdk.tsx` — JWT token source, always-attach headers
- `apps/app/src/app/connections/openwork-server-store.ts` — Pantheon base URL/auth, skip Tauri polling
- `apps/app/src/index.tsx` — `/auth/callback` route
- `apps/app/src/app/app.tsx` — Skip local service startup, hide remote workspace modals
- `apps/app/src/app/pages/settings.tsx` — Hide startup preference, skip restart handlers
- `apps/app/src/app/shell/settings-shell.tsx` — Hide remote access controls
- `apps/app/src/app/workspace/share-workspace-modal.tsx` — Hide remote access option

### Config
- `packages/app/.env.local` — `VITE_PANTHEON_BASE_URL=http://localhost:8081`
- `CLAUDE.md` — Pantheon override comment convention

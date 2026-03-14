# Workspaces Phase 1 — Local Workspaces via Tauri

Date: 2026-03-14

## Summary

Implemented Phase 1 of the OpenWork Workspaces feature — sandboxed Docker containers
running Claude Code (via PxyCrab fleet mode) per workspace. Tauri desktop app manages
local containers, Pantheon coordinates agents + conversations.

## What Was Built

### 1. Workspace Container Image (`packages/workspace/Dockerfile`)
- Debian trixie-slim with Node.js 22 + Claude Code CLI
- PxyCrab binary built from Go builder stage
- Non-root `workspace` user with sudo (required by Claude CLI)
- ENTRYPOINT: `pxycrab --fleet` (fleet mode by default)
- Runtime env vars: `PXYCRAB_FLEET_PANTHEON_URL`, `PXYCRAB_FLEET_PANTHEON_API_KEY`

### 2. Tauri Rust Backend (`packages/desktop/src-tauri/`)
Three new commands in `commands/orchestrator.rs`:
- `sandbox_create_workspace(workspace_path, pantheon_url, nightshift_api_key, image?)` —
  Generates container name from hashed path, runs `docker run -d` with bind mount + fleet
  env vars, polls container health for 30s, emits progress events
- `sandbox_workspace_status(container_name)` — Wraps `docker_container_state()`
- `sandbox_workspace_logs(container_name, tail)` — Wraps `docker logs --tail`

Also: `SandboxWorkspaceResult` type in `types.rs`, commands registered in `lib.rs`,
workspace containers added to `is_openwork_managed_container()` for cleanup.

### 3. Pantheon Backend (`/mnt/c/workspace/pantheon/`)
- **Workspace model** in `db/models.py` — owner_id, name, mode, status, repo_url,
  local_path, container_id, agent_id, etc. Indexed on (owner_id, status).
- **workspace_id** added to Conversation model — links conversations to workspaces
- **CRUD routes** in `api/routes/workspaces.py`:
  - POST / — Creates dedicated Agent (platform=nightshift) + Workspace, returns nightshift_api_key
  - GET / — List user's workspaces
  - GET /{id}, PATCH /{id}, DELETE /{id} — Standard CRUD with ownership validation
- Routes registered at `/backend/workspaces` in `main.py`
- Workspace added to Beanie init in `db/connection.py`
- ConversationCreate accepts workspace_id, auto-sets agent_id from workspace

### 4. OpenWork Frontend (`packages/app/src/app/`)
- **pantheon-client.ts** — `PantheonWorkspace` type + 5 CRUD methods
- **tauri.ts** — `SandboxWorkspaceResult` type + 3 Tauri bindings
- **context/pantheon.tsx** — workspaces() signal, createWorkspace(), deleteWorkspace(),
  refreshWorkspaces(). Workspaces loaded on login.
- **pantheon-app.tsx** — Sidebar workspace section with status badges (color-coded),
  "New" button → modal (name + directory picker for Tauri / repo URL for browser),
  creation flow: Pantheon API → Tauri sandbox → refresh

### 5. PxyCrab — No Changes Needed
Fleet mode already handles single-agent containers, NightShift registration,
compound tokens, structured part streaming, and working directory.

## End-to-End Flow (Local Mode)

1. User clicks "New" in workspace section
2. Enters name, picks local directory
3. Frontend calls POST /backend/workspaces → gets workspace_id + nightshift_api_key
4. Frontend calls Tauri sandbox_create_workspace → Docker container starts
5. PxyCrab inside container registers with Pantheon via NightShift
6. User creates conversation linked to workspace
7. Messages route through NightShift → PxyCrab → Claude CLI → structured parts back
8. Claude Code works directly on bind-mounted project files

## Files Changed

### OpenWork
- `packages/workspace/Dockerfile` (NEW)
- `packages/desktop/src-tauri/src/commands/orchestrator.rs`
- `packages/desktop/src-tauri/src/types.rs`
- `packages/desktop/src-tauri/src/lib.rs`
- `packages/app/src/app/lib/pantheon-client.ts`
- `packages/app/src/app/lib/tauri.ts`
- `packages/app/src/app/context/pantheon.tsx`
- `packages/app/src/app/pantheon-app.tsx`

### Pantheon
- `src/pantheon/db/models.py`
- `src/pantheon/db/connection.py`
- `src/pantheon/api/routes/workspaces.py` (NEW)
- `src/pantheon/api/routes/conversations.py`
- `src/pantheon/main.py`

## What's Next (Phase 2)
- Remote workspaces (Pantheon manages Docker via aiodocker)
- Mutagen file sync for remote mode
- Browser-only mode (file browser panel)
- Workspace selector in conversation creation UI

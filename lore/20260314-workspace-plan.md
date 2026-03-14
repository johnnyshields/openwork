# OpenWork Workspaces — Claude Cowork Clone (Plan)

**Date**: 2026-03-14
**Status**: Planned (not yet implemented)
**Prerequisite**: Structured streaming (see `lore/20260314-structured-streaming.md`)

## What This Is

A Claude Cowork-like system for OpenWork: sandboxed Docker containers running Claude Code
per workspace, managed by the Tauri desktop app (local) or Pantheon (remote). Three modes
that gracefully degrade:

1. **Tauri + local project** — Docker container on user's machine, bind-mounts project dir
2. **Browser + remote workspace** — Pantheon manages server containers, optional Mutagen sync
3. **Browser + no workspace** — Just chat, no file access (current behavior, like ChatGPT)

## How Claude Cowork Works (Reference)

Analyzed from `C:\Program Files\WindowsApps\Claude_1.1.5749.0_x64__pzs8sxrjxfjjc`:

- `cowork-svc.exe` — Go binary managing Hyper-V lightweight Linux VMs
- `smol-bin.x64.vhdx` — 36MB Linux VM disk image, booted via `LinuxKernelDirect`
- Plan9 filesystem sharing — host dirs mounted in VM bidirectionally
- RPC over Windows named pipes — Electron ↔ cowork-svc ↔ VM daemon (`sdk-daemon`)
- Events: StdoutEvent, StderrEvent, ExitEvent, ErrorEvent, NetworkStatusEvent
- Sessions per VM, persistent across reconnects
- gVisor TCP/IP stack for VM networking
- `.clod` files = personality packs (zip: cursor.png, animation frames, personality.txt)

**Our equivalent**: Docker containers instead of Hyper-V, bind mounts instead of Plan9,
HTTP/SSE instead of named pipes. Same concept, more portable.

## Existing Infrastructure to Build On

### Tauri Desktop App (`packages/desktop/src-tauri/`)

Already has 70% of the container management infrastructure:

**Docker integration** (`commands/orchestrator.rs`):
- `resolve_docker_binary()` — finds docker CLI from env vars + standard paths
- `sandbox_doctor()` → `SandboxDoctorResult` — checks installed, daemon, permissions
- `sandbox_stop(container_name)` — stops containers (validates `openwork-orchestrator-` prefix)
- `sandbox_cleanup_openwork_containers()` — removes all managed containers
- `sandbox_debug_probe()` — full diagnostic: create test container, inspect, cleanup
- `docker_container_state()` — queries container status via `docker inspect`
- Docker commands used: `docker --version`, `docker info`, `docker ps -a`, `docker inspect`,
  `docker stop`, `docker rm -f`, `docker logs`

**Container lifecycle** (`commands/orchestrator.rs:743-1072`):
- `orchestrator_start_detached()` — spawns sidecar with `--sandbox docker`
- Health check loop: 90s timeout for docker, polls `/health` + `docker inspect` every 1.5s
- Progress events emitted to `"openwork://sandbox-create-progress"`
- Returns `OrchestratorDetachedHost` with sandbox metadata

**Workspace metadata** (`types.rs:306-338`):
```rust
pub struct WorkspaceInfo {
    pub sandbox_backend: Option<String>,       // "docker"
    pub sandbox_run_id: Option<String>,
    pub sandbox_container_name: Option<String>,
    // ... plus id, name, path, preset, workspace_type, remote fields
}
```

**Workspace state** (`workspace/state.rs`):
- Persisted to `~/.openwork/openwork-workspaces.json`
- Hash-based stable IDs: `ws-{:x}`
- Load/save/ensure functions

**Frontend bindings** (`lib/tauri.ts`):
- `orchestratorStartDetached()`, `sandboxDoctor()`, `sandboxStop()`, `sandboxDebugProbe()`
- `workspaceCreateRemote()` accepts sandbox metadata
- `SandboxDoctorResult`, `OrchestratorDetachedHost`, `SandboxDebugProbeResult` types

**Sandbox progress UI** (`context/workspace.ts`):
- `SandboxCreatePhase: "idle" | "preflight" | "provisioning" | "finalizing"`
- 5-step progress: docker → workspace → sandbox → health → connect
- Log accumulation, step status tracking, error handling

### PxyCrab Fleet (`/mnt/c/workspace/pxycrab/`)

**Fleet mode activation** (`cmd/pxycrab/main.go:332-358`):
- Env vars: `PXYCRAB_FLEET_MODE=true`, `PXYCRAB_FLEET_PANTHEON_URL`, `PXYCRAB_FLEET_PANTHEON_API_KEY`
- Creates `fleet.NewClient(url, key)` → `fleet.NewManager(client, dataDir)` → `mgr.Start(ctx)`

**Manager reconciliation** (`fleet/manager.go`):
- Polls `GET /api/agents/active` every 30s
- `serviceAccountKey` from response used for compound tokens
- Per-conversation RunningBot: Platform + Provider + EnvVars + Sessions
- NightShift URL derived: `client.baseURL + "/api/nightshift"` if agent's URL is empty
- Compound token: `serviceAccountKey + ":u=" + conv.OwnerID` → `CLAUDE_CODE_OAUTH_TOKEN`
- Working dir: `cmd.Dir = opts.WorkingDir` (defaults to container CWD)

**Data structures** (`fleet/client.go`):
- `AgentConfig`: ID, Name, Platform, NightShiftAPIKey, SystemPrompt, Conversations[]
- `ConvRef`: ID, Provider, Model, ChannelID, OwnerID
- Fleet response: `{service_account_key, agents[]}`

### Pantheon (`/mnt/c/workspace/pantheon/`)

**Agent model** (`models.py:252-285`):
- `owner_id`, `name`, `platform` ("nightshift"|"slack"), `nightshift_api_key` (auto-generated `ns-` prefix),
  `system_prompt`, `status`

**Conversation model** (`models.py:937-956`):
- `owner_id`, `agent_id`, `provider`, `model`, `effort`, `system_prompt`

**ServiceAccount** (`models.py:198-244`):
- `key` (slug), `secret_key` (`sk-tc-agent-XXX`), `budget_usd`, `allowed_models`

**Fleet endpoint** (`agents.py:190-237`):
- `GET /api/agents/active` — returns all active agents with conversations + service_account_key
- Auth: admin API key header

### Structured Streaming (Already Built — see separate lore)

- PxyCrab `PartAssembler` → TextPart, ToolPart, ReasoningPart
- Pantheon `POST /messages/part-event` + typed SSE relay
- OpenWork `MessageList` renders tool use, thinking, text with status indicators
- Per-conversation `runPhase()`: idle → sending → thinking → responding
- Per-conversation effort control (low/medium/high/max)

## Implementation Plan

### Phase 1: Local Workspaces via Tauri (MVP)

**1. Workspace Container Image** — `packages/workspace/Dockerfile` (NEW)
- Debian trixie-slim + Node.js 22 + Claude Code CLI + PxyCrab binary + git
- Non-root user `workspace` with sudo
- `WORKDIR /workspace`, `ENTRYPOINT ["pxycrab", "--fleet"]`

**2. Tauri Rust Backend** — `commands/orchestrator.rs` (EXTEND)
- `sandbox_create_workspace(workspace_path, pantheon_url, nightshift_api_key, image)`:
  Runs `docker run -d -v path:/workspace -e PXYCRAB_FLEET_* --network openwork-net image`
- `sandbox_workspace_status(container_name)`: Wraps `docker_container_state()`
- `sandbox_workspace_logs(container_name, tail)`: Wraps `docker logs`
- Reuse: `resolve_docker_binary()`, `run_docker_command_detailed()`, `emit_sandbox_progress()`

**3. Pantheon Workspace Model + API** — `db/models.py` + `api/routes/workspaces.py` (NEW)
- Workspace document: owner_id, name, mode, status, repo_url, container_id, agent_id
- Add `workspace_id` to Conversation model
- CRUD: POST/GET/PATCH/DELETE `/api/workspaces`
- Creation flow: create dedicated Agent → return workspace_id + nightshift_api_key
- Conversation creation: if workspace_id set, auto-link agent_id

**4. OpenWork Frontend** — `pantheon-client.ts`, `pantheon.tsx`, `pantheon-app.tsx`, `tauri.ts`
- Workspace types + CRUD methods in Pantheon client
- Tauri bindings for new sandbox commands
- Workspace list in sidebar with status badges
- "New workspace" modal: name + directory picker
- Conversation creation with workspace selector
- Artifacts: tool-use parts already show file diffs (existing rendering)

**5. PxyCrab** — No changes needed

### Phase 2: Remote Workspaces + Browser Mode
- Pantheon gets Docker socket mount + `WorkspaceManager` class
- File browser: `GET /api/workspaces/{id}/files` via `docker exec`
- Mutagen sync for local ↔ remote
- Browser-only workspace creation (no Tauri)

### Phase 3: Polish
- Workspace templates, auto-shutdown, multi-conversation workspaces, collaboration

## End-to-End Flow (Phase 1, Local)

```
1. User clicks "New workspace" in Tauri app
2. Picks local directory /home/user/my-project
3. Tauri → POST /api/workspaces {name, mode: "local"} → Pantheon
4. Pantheon creates Agent + Workspace → returns {workspace_id, nightshift_api_key}
5. Tauri → sandbox_create_workspace(path, url, key) → docker run ...
6. Container starts, PxyCrab registers with NightShift
7. User creates conversation with workspace_id
8. Sends: "Add error handling to src/main.ts"
9. PxyCrab in container picks up message via NightShift inbox
10. Claude CLI runs with CWD=/workspace (= user's project via bind mount)
11. Claude reads src/main.ts, edits it, runs tests
12. PartAssembler streams: TextPart → ToolPart(Read) → ToolPart(Edit) → TextPart
13. Pantheon relays via SSE → OpenWork MessageList renders tool use + diffs
14. Files changed on disk instantly (bind mount)
```

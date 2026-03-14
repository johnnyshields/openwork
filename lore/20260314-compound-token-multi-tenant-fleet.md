# Multi-tenant ServiceAccount via Compound Token

**Date:** 2026-03-14

## Problem

PxyCrab fleet runs one ServiceAccount (`sk-tc-agent-*`) for all bots, but needs
per-user seat pinning so each conversation owner gets their own Claude seat.
Claude CLI can't send custom HTTP headers (`X-On-Behalf-Of`), so we need an
alternative mechanism to pass user identity through to Pantheon.

## Solution: Compound Token

PxyCrab constructs a compound token `<service_account_key>:u=<owner_id>` and
sets it as `CLAUDE_CODE_OAUTH_TOKEN` env var for the Claude CLI subprocess.
Pantheon's `ClaudeSeatManager` parses the `:u=` suffix, authenticates the
ServiceAccount with the base key, and resolves the user from the suffix (same
flow as the existing `X-On-Behalf-Of` header, but embedded in the token).

## Changes

### Pantheon

- **`config.py`** — Added `fleet_service_account_key` setting (default: `"pxycrab"`)
- **`seats/claude_seat_manager.py`** — Added `_parse_compound_key()` static method
  that splits `:u=` suffix. Modified `authenticate_and_get_seat()` to parse
  compound keys before DB lookup. Modified `_authenticate_agent()` to accept
  `compound_user_id` kwarg (takes precedence over `X-On-Behalf-Of` header).
- **`api/routes/nightshift.py`** — `get_inbox()` now includes `owner_id` from
  the parent Conversation in each message response.
- **`api/routes/agents.py`** — `list_active_agents()` fleet endpoint wraps
  response in `{"service_account_key": ..., "agents": [...]}`. Each conversation
  ref now includes `owner_id`.

### PxyCrab

- **`fleet/client.go`** — Added `OwnerID` to `ConvRef`, `fleetResponse` wrapper
  struct. `FetchActiveAgents` now returns `(agents, serviceAccountKey, error)`.
- **`fleet/manager.go`** — Manager stores `serviceAccountKey`. `startBotLocked`
  builds compound token env vars (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`)
  when service account key + owner_id are available. `RunningBot` has `EnvVars` field.
- **`fleet/handler.go`** — `handleUpdate` passes `rb.EnvVars` into `provider.Options`.

## Data Flow

```
User msg → Pantheon stores ChatMessage(conv_id, owner_id)
  → PxyCrab polls inbox → gets {content, conversation_id, owner_id}
  → handler creates Claude CLI with CLAUDE_CODE_OAUTH_TOKEN=sk-tc-agent-xxx:u=<owner_id>
  → Claude CLI calls Pantheon /ai/claude/bot with Bearer <compound_token>
  → seat manager splits token → authenticates ServiceAccount → resolves user → pins seat
  → response flows back
```

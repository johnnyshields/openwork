# Structured Streaming: PxyCrab → Pantheon → OpenWork

**Date**: 2026-03-14
**Repos**: openwork, pantheon, pxycrab

## Overview

Stream Claude CLI's full structured output (text deltas, tool use/results, thinking/reasoning)
from PxyCrab through Pantheon to OpenWork's chat UI, rendered with the existing OpenCode
MessageList/PartView components.

## Architecture

```
User (browser) → OpenWork → Pantheon SSE → [polls DB] ← Pantheon API ← PxyCrab ← Claude CLI
```

### Data Flow

1. User sends message via OpenWork
2. Pantheon stores user ChatMessage, returns SSE stream that polls for assistant response
3. PxyCrab polls nightshift inbox, picks up user message, spawns Claude CLI
4. Claude CLI streams `--output-format stream-json` events (assistant text, tool_use, tool_result)
5. PxyCrab's `PartAssembler` maps each event to OpenCode SDK-compatible Part objects (TextPart, ToolPart, ReasoningPart)
6. PxyCrab posts each part to `POST /api/nightshift/messages/part-event`
7. Pantheon upserts parts into ChatMessage.parts array, updates content from text parts
8. Pantheon SSE relay detects new/changed parts, emits typed SSE events to browser
9. OpenWork's Pantheon context accumulates parts into MessageWithParts[], renders via MessageList

### SSE Wire Protocol

```
data: {"type":"part","message_id":"<mongo_id>","part":{<OpenCode Part JSON>}}
data: {"type":"part","message_id":"...","part":{...}}   ← tool state update (running→completed)
data: {"type":"done","message_id":"..."}
data: [DONE]
```

Legacy fallback for old messages: `{"type":"message","id":"...","content":"...","role":"assistant"}`

### Part Type Mapping

| Claude CLI event    | OpenCode Part type | Notes |
|--------------------|--------------------|-------|
| `assistant` (text) | `TextPart`         | Accumulated text, emitted on each update |
| `assistant` (thinking) | `ReasoningPart` | Extracted from Raw JSON content blocks |
| `tool_use`         | `ToolPart` state=running | Tool name, input, callID from ToolUseID |
| `tool_result`      | `ToolPart` state=completed/error | Same part ID, upserted |

## Changes

### Pantheon (`/mnt/c/workspace/pantheon`)

- **`src/pantheon/db/models.py`** — ChatMessage: added `parts: list[dict] | None`, `is_streaming: bool`, `message_key: str | None`; Conversation: added `effort: str | None`
- **`src/pantheon/api/routes/nightshift.py`** — New `POST /messages/part-event` endpoint: find-or-create ChatMessage by message_key, upsert part by id, update content from text parts, set is_streaming; Inbox response includes `effort` field
- **`src/pantheon/api/routes/conversations.py`** — Rewrote `_stream_via_nightshift()`: 300ms poll, typed SSE events (part/message/done), change detection via part hash; CRUD supports `effort` field

### PxyCrab (`/mnt/c/workspace/pxycrab`)

- **`platform/nightshift/parts.go`** (NEW) — `PartAssembler` struct: maps provider.Message events to PartEvent payloads with OpenCode SDK-compatible Part JSON; handles TextPart (accumulated text), ToolPart (running→completed lifecycle), ReasoningPart (thinking blocks from Raw JSON); `buildToolTitle()` generates "Read foo.ts", "Run git status" etc.
- **`platform/nightshift/platform.go`** — Added `SendPartEvent()` HTTP method
- **`platform/nightshift/convert.go`** — Added `Effort` field to apiMessage, exported as `ApiMessage`
- **`fleet/handler.go`** — Integrates PartAssembler in SendStream callback; skips legacy Send/Edit for nightshift; passes conversation effort as `--effort` CLI arg

### OpenWork (`/mnt/c/workspace/openwork`)

- **`packages/app/src/app/lib/pantheon-client.ts`** — Added `parts` to PantheonMessage, `effort` to PantheonConversation, `PantheonStreamEvent` type union, typed SSE event parsing in `sendMessageStreaming()`, `updateConversation()` method
- **`packages/app/src/app/context/pantheon.tsx`** — Changed activeMessages to `MessageWithParts[]`; `toMessageWithParts()` converter (parts or content→TextPart fallback); streaming parts accumulator with upsert; per-conversation `runPhase()` memo ("idle"→"sending"→"thinking"→"responding") via `convPhases` map; `updateConversation()` action
- **`packages/app/src/app/pantheon-app.tsx`** — Replaced plain-text MessageBubble with `MessageList` component; `showThinking={true}`; spinner via `loader` prop inside space-y-4 block; shows "Sending..." or "Thinking..." based on runPhase; `EffortSelector` dropdown per-conversation
- **`packages/app/src/app/components/session/message-list.tsx`** — Added `loader` prop, renders inside `space-y-4` block after messages; removed unused `footer` prop

## Per-Conversation Effort

Thinking effort ("low"/"medium"/"high"/"max") is configurable per conversation:
- Stored on Conversation model in Pantheon
- Exposed via conversations CRUD API
- Included in nightshift inbox response
- PxyCrab passes as `--effort <level>` to Claude CLI
- OpenWork shows a dropdown selector below the input area

## Backward Compatibility

- Old messages (no `parts`): frontend wraps `content` in single TextPart
- Old PxyCrab (no part-events): uses legacy `POST /messages`, creates ChatMessage without parts
- New PxyCrab + old frontend: `content` field still populated from text parts

## Key Commits

### Pantheon
- `5ed562a` feat: structured part streaming for nightshift messages
- `cf7c51c` feat: per-conversation effort setting for thinking control

### PxyCrab
- `e4fafc0` feat: stream structured parts to Pantheon via nightshift
- `be992b7` fix: skip legacy Send/Edit for nightshift when using part events
- `4a17fed` feat: emit ReasoningPart for Claude thinking blocks
- `44256c6` feat: pass conversation effort to Claude CLI --effort flag

### OpenWork
- `50baa072` feat: rich part rendering in Pantheon chat UI
- `456a4aa3` feat: show thinking blocks and spinner in Pantheon chat UI
- `a2990963` feat: effort selector in Pantheon chat UI
- `df6ae963` feat: separate sending/thinking/responding phases in chat UI
- `45db1796` fix: per-conversation run phase tracking
- `6082d9bf` fix: render spinner inside MessageList's space-y-4 block
- `b0b8e0b5` refactor: rename footer prop to loader in MessageList

# Dual-Mode Conversations: Local + Remote with Handover

## Context

OpenWork currently runs in one of two mutually exclusive modes (build-time `VITE_OPENWORK_URL`): Pantheon mode or OpenCode mode. We want **per-conversation** mode switching: each conversation is either local (user's OpenCode engine) or remote (user's personal PxyCrab **Pixie**), with seamless handover.

**User decisions:**
- Local OpenCode proxies API calls through Pantheon (`/ai/opencode/claude/*`) for identity injection + billing
- OpenWork also mirrors structured parts to Pantheon for conversation persistence (proxy + mirror)
- Browser-only = remote only, with nag to install Tauri desktop app
- Tauri = default local, browser = default remote
- Each Pantheon user auto-gets a **Pixie** (personal AI agent backed by PxyCrab)
- Left sidebar shows all conversations flagged as local or remote

**Terminology:** A **Pixie** is a user's personal AI agent. In the DB, the `pixies` collection stores Pixie documents (renamed from `ai_agents`). Each user has exactly one Pixie, auto-provisioned on first login.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ OpenWork UI (SolidJS)                                               │
│                                                                     │
│  ┌──────────────┐   ┌──────────────────────────────────────────┐   │
│  │ Sidebar       │   │ Chat View                                │   │
│  │               │   │                                          │   │
│  │ Conv A [🖥️]   │   │  Mode: Local 🖥️  [Hand to Pixie →]      │   │
│  │ Conv B [☁️]   │   │                                          │   │
│  │ Conv C [🖥️]   │   │  Messages...                             │   │
│  └──────────────┘   └──────────────────────────────────────────┘   │
│                                                                     │
│  PantheonAdapter (routes per-conversation)                          │
│  ├── Local mode:  localOpenCodeClient → Pantheon mirror             │
│  └── Remote mode: pantheonClient.sendMessageStreaming()             │
└─────────────────────────────────────────────────────────────────────┘
         │ local prompt              │ remote prompt
         ▼                           ▼
┌─────────────────┐      ┌──────────────────────────────┐
│ Local OpenCode   │      │ Pantheon                      │
│ Server (Tauri)   │      │                                │
│                  │      │ POST /conversations/{id}/msgs  │
│ ANTHROPIC_BASE_  │      │   mode=remote → nightshift     │
│ URL = Pantheon   │──────│   mode=local  → ack only       │
│ /ai/opencode/    │      │                                │
│ claude/v1        │      │ POST .../local-part-event      │
│                  │      │   ← mirror from adapter        │
└─────────────────┘      │                                │
                          │ /api/pixies/active             │
                          │   filters mode="remote" only   │
                          └──────────┬─────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │ PxyCrab (user's Pixie) │
                          │ polls inbox, responds  │
                          │ via part-events        │
                          └──────────────────────┘
```

Pantheon is the single source of truth for all conversation history. Both modes persist there.

---

## Phase 1: Per-User Pixie

### 1.1 Data model

**File: `pantheon/db/models.py`**

Rename the `Agent` model to `Pixie` and its collection from `ai_agents` to `pixies`:

```python
class Pixie(Document):
    """A user's personal AI agent (Pixie), backed by PxyCrab."""
    owner_id: str
    name: str
    system_prompt: str | None = None
    platform: str = "nightshift"
    nightshift_api_key: str  # ns-<24 base58>, auto-generated
    status: str = "active"   # "active" | "disabled"
    created_at: datetime
    updated_at: datetime

    class Settings:
        name = "pixies"
```

Add to User:
```python
# Add to User class:
pixie_id: str | None = None  # str(Pixie.id) of auto-provisioned Pixie
```

Update Conversation:
```python
# Rename pixie_id → pixie_id on Conversation:
pixie_id: str | None = None  # Route through user's Pixie (PxyCrab)
```

### 1.2 Auto-provisioning helper

**File: `pantheon/api/dependencies.py` or new `pantheon/services/pixie.py`**

```python
async def ensure_pixie(user: User) -> Pixie:
    """Ensure user has a Pixie. Create one if missing."""
    if user.pixie_id:
        pixie = await Pixie.get(PydanticObjectId(user.pixie_id))
        if pixie and pixie.status == "active":
            return pixie

    pixie = Pixie(
        owner_id=str(user.id),
        name=f"{user.display_name}'s Pixie",
        platform="nightshift",
        system_prompt=None,  # inherits per-conversation system_prompt
        status="active",
    )
    await pixie.insert()
    user.pixie_id = str(pixie.id)
    await user.save()
    return pixie
```

### 1.3 Call sites

- **`pantheon/api/routes/oidc.py`** token endpoint: after `oidc.exchange_code()` succeeds, call `ensure_pixie(user)`
- **`pantheon/api/routes/login.py`** localhost login + password login: after JWT creation, call `ensure_pixie(user)`
- **`GET /backend/me`**: include `pixie_id` in response dict
- **`GET /backend/pixies/me`** (new convenience endpoint): returns user's Pixie details + `nightshift_api_key`

### 1.4 DB rename: `ai_agents` → `pixies`

Rename the MongoDB collection. All references to `Agent` in code become `Pixie`:
- `agents.py` routes → `pixies.py` routes (endpoints `/backend/pixies/`)
- Fleet endpoint renamed to `/api/pixies/active` (update PxyCrab's `PXYCRAB_FLEET_PANTHEON_URL` or fleet client endpoint)
- `Conversation.pixie_id` → `Conversation.pixie_id`
- NightShift routes: `Agent.find_one(nightshift_api_key==key)` → `Pixie.find_one(nightshift_api_key==key)`

### 1.5 Existing data migration

For existing `ai_agents` documents: rename collection to `pixies`. For existing users without `pixie_id`: `ensure_pixie()` is idempotent and runs on next login.

---

## Phase 2: Conversation Mode + Routing (Pantheon)

### 2.1 Data model

**File: `pantheon/db/models.py` — Conversation document**
```python
# Add to Conversation class:
mode: str = "remote"  # "local" | "remote"
```

**File: `pantheon/api/routes/conversations.py` — ConversationCreate**
```python
# Add to create schema:
mode: str | None = None  # "local" | "remote", default based on client
```

Include `mode` in `_conv_dict()` output so it appears in all list/get/create/update responses.

### 2.2 Mode-aware message routing

**File: `pantheon/api/routes/conversations.py` — `send_message()`**

Current triple routing:
```python
if conv.pixie_id:    → _stream_via_nightshift()
elif conv.worker_id: → _stream_via_worker()
else:                → _stream_via_provider()
```

New routing (mode check FIRST):
```python
if conv.mode == "local":
    return _stream_local_ack(conv, user_msg)
elif conv.pixie_id:
    return _stream_via_nightshift(conv, user_msg)
elif conv.worker_id:
    return _stream_via_worker(conv, messages, model, user, user_msg)
else:
    return _stream_via_provider(conv, messages, model, user, user_msg)
```

### 2.3 `_stream_local_ack()` — new function

For local-mode conversations, the server just acknowledges the user message. No AI processing.

```python
async def _stream_local_ack(conv, user_msg):
    """Persist user message only. Local engine handles AI."""
    async def generate():
        yield f"data: {json.dumps({
            'type': 'user_message',
            'message_id': str(user_msg.id),
            'content': user_msg.content,
            'created_at': user_msg.created_at.isoformat(),
        })}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream")
```

**Key difference from remote**: No `assistant_message` event. No `done` event. The adapter handles all of that locally.

### 2.4 Local response persistence endpoints

**`POST /backend/conversations/{id}/messages/local-part-event`**

Reuse the exact same upsert logic as `POST /api/nightshift/messages/part-event` but with JWT auth instead of `ns-*` key auth.

```python
@router.post("/{conversation_id}/messages/local-part-event")
async def local_part_event(
    conversation_id: str,
    body: PartEventBody,  # { message_key, part_id, part: dict, is_final: bool }
    user: User = Depends(get_current_user),
):
    conv = await _get_conv_or_404(conversation_id, user)
    # Same upsert logic as nightshift part-event:
    # find-or-create ChatMessage by (conversation_id, message_key)
    # upsert part in parts[] by part.id
    # update content from accumulated text parts
    # set is_streaming = not is_final
```

**Request schema** (identical to nightshift part-event):
```json
{
  "message_key": "local-turn-1710000000000",
  "part_id": "text-0",
  "part": { "type": "text", "id": "text-0", "text": "Hello world" },
  "is_final": false
}
```

**`POST /backend/conversations/{id}/messages/local-response`** (optional, for non-streaming fallback):
```json
{
  "content": "Full response text",
  "parts": [{ "type": "text", "id": "text-0", "text": "Full response text" }],
  "model": "claude-sonnet-4-6",
  "input_tokens": 150,
  "output_tokens": 500
}
```

Creates `ChatMessage(role="assistant", source="local", ...)`.

### 2.5 Handover endpoint

**`POST /backend/conversations/{id}/handover`**

```python
@router.post("/{conversation_id}/handover")
async def handover(
    conversation_id: str,
    body: HandoverBody,  # { mode: "local" | "remote" }
    user: User = Depends(get_current_user),
):
    conv = await _get_conv_or_404(conversation_id, user)

    if body.mode == conv.mode:
        return _conv_dict(conv)  # no-op

    if body.mode == "remote":
        # Ensure Pixie is linked
        pixie = await ensure_pixie(user)
        conv.pixie_id = str(pixie.id)
    # NOTE: when switching to local, keep pixie_id intact
    # so re-handover to remote works without re-provisioning

    conv.mode = body.mode
    conv.updated_at = utcnow()

    # Terminate any in-flight streaming message
    streaming_msg = await ChatMessage.find_one(
        ChatMessage.conversation_id == str(conv.id),
        ChatMessage.is_streaming == True,
    )
    if streaming_msg:
        streaming_msg.is_streaming = False
        await streaming_msg.save()

    await conv.save()
    return _conv_dict(conv)
```

**Response**: Full conversation dict including new `mode`.

### 2.6 Fleet endpoint filter

**File: `pantheon/api/routes/pixies.py` (renamed from agents.py) — `list_active_pixies()`**

Endpoint renamed: `GET /api/pixies/active`

Currently returns ALL conversations for active pixies. Must filter out local-mode conversations so PxyCrab doesn't see them:

```python
# Change from:
convs = await Conversation.find(Conversation.pixie_id == str(pixie.id)).to_list()

# To:
convs = await Conversation.find(
    Conversation.pixie_id == str(pixie.id),
    Conversation.mode == "remote",  # Only remote-mode conversations
).to_list()
```

**Effect**: When user switches to local, conversation disappears from PxyCrab's active set on next poll (≤30s). PxyCrab's reconciliation loop calls `stopBotLocked()` which gracefully stops the bot.

When user switches back to remote, conversation reappears and PxyCrab starts a new `RunningBot` for it.

---

## Phase 3: OpenWork Frontend

### 3.1 PantheonClient new methods

**File: `packages/app/src/app/lib/pantheon-client.ts`**

```typescript
// Add to PantheonConversation interface:
export interface PantheonConversation {
  // ... existing fields ...
  mode: "local" | "remote";
}

// New methods:
async function postLocalPartEvent(
  conversationId: string,
  data: { message_key: string; part_id: string; part: Record<string, any>; is_final: boolean },
): Promise<void> {
  await request(`/backend/conversations/${conversationId}/messages/local-part-event`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

async function handoverConversation(
  conversationId: string,
  mode: "local" | "remote",
): Promise<PantheonConversation> {
  return request<PantheonConversation>(
    `/backend/conversations/${conversationId}/handover`,
    { method: "POST", body: JSON.stringify({ mode }) },
  );
}
```

### 3.2 PantheonAdapter: Mode-aware prompt dispatch

**File: `packages/app/src/app/lib/pantheon-adapter.ts`**

Factory signature changes:
```typescript
export function createPantheonAdapter(
  pantheonClient: PantheonClient,
  localOpenCodeClient?: OpencodeClient | null,  // NEW
)
```

Internal state additions:
```typescript
// Mode cache: populated from session.list/get, updated on handover
const modeCache = new Map<string, "local" | "remote">();
// Local session mapping: pantheonConvId → openCodeSessionId
const localSessionMap = new Map<string, string>();
```

**`session.list()`** — populate modeCache:
```typescript
list: async (_opts?: any) => {
  const convs = await pantheonClient.listConversations();
  for (const c of convs) modeCache.set(c.id, c.mode);
  return wrap(convs.map(convToSession));
},
```

**`session.create()`** — pass mode:
```typescript
create: async (opts?: any) => {
  const mode = opts?.body?.mode ?? (localOpenCodeClient ? "local" : "remote");
  const conv = await pantheonClient.createConversation({
    title: opts?.body?.title ?? "New conversation",
    mode,
  });
  modeCache.set(conv.id, conv.mode);
  return wrap(convToSession(conv));
},
```

**`session.prompt()`** — the core routing change:
```typescript
prompt: async (opts: any) => {
  const sessionID = opts?.path?.id ?? opts?.sessionID;
  const parts = opts?.body?.parts ?? opts?.parts ?? [];
  const textPart = parts.find((p: any) => p.type === "text");
  const text = textPart?.text ?? "";
  const model = opts?.model?.modelID ?? opts?.body?.model?.modelID;

  const mode = modeCache.get(sessionID) ?? "remote";

  if (mode === "local" && localOpenCodeClient) {
    return localPrompt(sessionID, text, model, parts);
  } else {
    return remotePrompt(sessionID, text, model, opts);
  }
},
```

**`localPrompt()` — detailed flow:**
```typescript
async function localPrompt(sessionID: string, text: string, model: string | undefined, parts: any[]) {
  // 1. Push "busy" status
  eventQueue.push({
    type: "session.status",
    properties: { sessionID, status: { type: "busy" } },
  });

  // 2. POST user message to Pantheon for persistence (local ack)
  //    This returns the user_message SSE event with MongoDB ID
  const ackResponse = await pantheonClient.sendMessageStreaming(
    sessionID, text, undefined, { model, onEvent: (evt) => {
      // Forward the user_message event to UI
      if (evt.type === "user_message") {
        eventQueue.push({
          type: "message.updated",
          properties: { info: { id: evt.message_id, sessionID, role: "user", ... } },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: { part: { type: "text", id: `${evt.message_id}-text`, sessionID, messageID: evt.message_id, text } },
        });
      }
    }},
  );

  // 3. Ensure local OpenCode session exists for this conversation
  let localSessionId = localSessionMap.get(sessionID);
  if (!localSessionId) {
    const sess = await localOpenCodeClient.session.create({ directory: "" });
    localSessionId = sess.data.id;
    localSessionMap.set(sessionID, localSessionId);
  }

  // 4. Generate a message_key for Pantheon persistence
  const messageKey = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 5. Create abort controller
  const abortController = new AbortController();
  activeAbort.set(sessionID, abortController);

  // 6. Send prompt to local OpenCode
  await localOpenCodeClient.session.promptAsync({
    path: { id: localSessionId },
    body: { parts: [{ type: "text", text }], model: model ? { modelID: model, providerID: "anthropic" } : undefined },
  });

  // 7. Subscribe to local OpenCode events and mirror to Pantheon
  const { stream } = await localOpenCodeClient.event.subscribe(localSessionId);

  let assistantMsgId: string | null = null;

  for await (const event of stream) {
    if (abortController.signal.aborted) break;

    if (event.type === "message.updated" && event.properties.info.role === "assistant") {
      assistantMsgId = event.properties.info.id;
      // Emit to UI
      eventQueue.push({
        type: "message.updated",
        properties: {
          info: { ...event.properties.info, sessionID },
        },
      });
    }

    if (event.type === "message.part.updated") {
      const part = { ...event.properties.part, sessionID };
      // Emit to UI
      eventQueue.push({ type: "message.part.updated", properties: { part } });
      // Mirror to Pantheon (fire-and-forget)
      pantheonClient.postLocalPartEvent(sessionID, {
        message_key: messageKey,
        part_id: part.id,
        part: { type: part.type, id: part.id, text: part.text ?? "" },
        is_final: false,
      }).catch(() => {}); // best-effort persistence
    }

    if (event.type === "session.idle") {
      activeAbort.delete(sessionID);
      // Mark final in Pantheon
      pantheonClient.postLocalPartEvent(sessionID, {
        message_key: messageKey,
        part_id: "__final__",
        part: { type: "text", id: "__final__", text: "" },
        is_final: true,
      }).catch(() => {});
      // Emit idle to UI
      eventQueue.push({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
      eventQueue.push({ type: "session.idle", properties: { sessionID } });
      break;
    }
  }

  return wrap({});
}
```

**`session.abort()`** — mode-aware:
```typescript
abort: async (opts?: any) => {
  const sessionID = opts?.sessionID ?? opts?.path?.id;
  if (!sessionID) return wrap({});

  // Abort the SSE stream
  const controller = activeAbort.get(sessionID);
  if (controller) {
    controller.abort();
    activeAbort.delete(sessionID);
  }

  // If local mode, also abort the local engine
  const mode = modeCache.get(sessionID);
  if (mode === "local" && localOpenCodeClient) {
    const localSessionId = localSessionMap.get(sessionID);
    if (localSessionId) {
      await localOpenCodeClient.session.abort({ path: { id: localSessionId } }).catch(() => {});
    }
  }

  return wrap({});
},
```

### 3.3 Handover in adapter

```typescript
// New method on adapter (not on the client shape, but exposed separately)
async function handover(sessionID: string, mode: "local" | "remote") {
  // 1. Abort any in-flight stream
  const controller = activeAbort.get(sessionID);
  if (controller) {
    controller.abort();
    activeAbort.delete(sessionID);
  }

  // 2. If switching from local, mirror partial response as final
  if (modeCache.get(sessionID) === "local") {
    // The abort already stopped the local engine
    // The partial response was already being mirrored
    // Just ensure is_final=true was sent (abort handler does this)
  }

  // 3. Call Pantheon handover endpoint
  const updated = await pantheonClient.handoverConversation(sessionID, mode);
  modeCache.set(sessionID, updated.mode);

  // 4. Emit mode change event (custom event for UI)
  eventQueue.push({
    type: "session.updated",
    properties: { sessionID, mode: updated.mode },
  });

  return updated;
}
```

### 3.4 PantheonSDKProvider: Dual client setup

**File: `packages/app/src/app/context/pantheon-sdk.tsx`**

```typescript
// After Pantheon client is created and user is authenticated:

const [localClient, setLocalClient] = createSignal<OpencodeClient | null>(null);
const [localHealthy, setLocalHealthy] = createSignal(false);

// Only attempt local client in Tauri mode
if (isTauriRuntime()) {
  const localUrl = "http://127.0.0.1:4096";
  const lc = createClient(localUrl);

  // Health check loop (every 10s)
  const checkHealth = async () => {
    try {
      const resp = await lc.global.health();
      setLocalHealthy(resp.data.healthy);
      if (resp.data.healthy) setLocalClient(lc);
    } catch {
      setLocalHealthy(false);
      setLocalClient(null);
    }
  };
  checkHealth();
  setInterval(checkHealth, 10_000);
}

// Pass localClient to adapter factory
const adapter = createPantheonAdapter(pantheonClient, localClient());
```

### 3.5 Sidebar: Conversation list with mode flags

**File: `packages/app/src/app/app.tsx`** — wherever the session list is rendered in the sidebar

The `convToSession()` function in the adapter needs to pass `mode` through. Add it as a custom field on the Session object:

**In `pantheon-adapter.ts` — `convToSession()`:**
```typescript
function convToSession(conv: PantheonConversation): any {
  return {
    // ... existing fields ...
    mode: conv.mode,  // "local" | "remote"
  };
}
```

**In sidebar session list rendering:**
```tsx
<For each={sessions()}>
  {(session) => (
    <div class={styles.sessionItem} onClick={() => selectSession(session.id)}>
      <span class={styles.modeIcon}>
        {session.mode === "local" ? "🖥️" : "☁️"}
      </span>
      <span class={styles.sessionTitle}>{session.title}</span>
    </div>
  )}
</For>
```

Use actual SVG icons (laptop for local, cloud for remote), not emoji. Small badge in the corner of each conversation item.

### 3.6 Chat header: Mode indicator + handover button

**In the session/chat header area:**
```tsx
<div class={styles.modeHeader}>
  <span class={styles.modeBadge}>
    {mode() === "local" ? (
      <><LaptopIcon /> Local</>
    ) : (
      <><CloudIcon /> Remote</>
    )}
  </span>

  <Show when={mode() === "local"}>
    <button onClick={() => doHandover("remote")}>
      Hand to Pixie →
    </button>
  </Show>

  <Show when={mode() === "remote" && isTauriRuntime()}>
    <button onClick={() => doHandover("local")}>
      ← Take Local
    </button>
  </Show>
</div>
```

### 3.7 Browser nag banner

```tsx
<Show when={isPantheonMode() && !isTauriRuntime() && !nagDismissed()}>
  <div class={styles.nagBanner}>
    <span>Install the OpenWork desktop app for local AI mode</span>
    <a href="https://openwork.ai/download">Download</a>
    <button onClick={() => { setNagDismissed(true); localStorage.setItem("openwork.nag.dismissed", "1"); }}>×</button>
  </div>
</Show>
```

---

## Phase 4: OpenCode Proxy Configuration

### 4.1 Local OpenCode → Pantheon API proxy

For local OpenCode to route API calls through Pantheon's Claude identity injector:

**Tauri app** configures the local OpenCode server with:
```
ANTHROPIC_BASE_URL={PANTHEON_URL}/ai/opencode/claude/v1
```

**Auth**: The opencode_claude_injector in Pantheon authenticates via `Authorization: Bearer sk-tc-*` (user's secret key) or the Pantheon JWT. Since the user is already OIDC-authenticated, we can pass the JWT.

**Flow:**
1. Local OpenCode sends `POST /ai/opencode/claude/v1/messages` with bearer token
2. Pantheon's `opencode_claude_injector.py` receives it
3. ClaudeProxy resolves seat, injects Claude Code identity headers
4. Forwards to `api.anthropic.com/v1/messages`
5. Streams response back to local OpenCode
6. OpenCode processes response, emits SSE events to OpenWork adapter
7. Adapter mirrors parts to Pantheon via `local-part-event`

**Why this matters:** Billing goes through Pantheon's seat system. Claude Code identity is injected. The user's API key is never exposed to the client.

### 4.2 Auth token injection

The local OpenCode server needs the user's Pantheon bearer token. Two options:

**Option A (simpler):** Configure OpenCode to pass the JWT as `ANTHROPIC_API_KEY`. Pantheon's proxy accepts both JWT and `sk-tc-*` keys.

**Option B (cleaner):** The Tauri app sets `ANTHROPIC_API_KEY` to the user's `sk-tc-*` secret key (fetched from `GET /backend/me`). This is more stable than JWT (no expiry).

**Recommendation:** Option B. Fetch `secret_key` from `/backend/me` response, configure local OpenCode with it.

---

## Phase 5: Edge Cases (Hardened)

### 5.1 Handover during active local stream

**Scenario:** User is in local mode, assistant is mid-response, user clicks "Hand to Pixie".

**Handling:**
1. Adapter calls `localOpenCodeClient.session.abort()` to stop the local engine
2. Adapter sends `is_final=true` to Pantheon's `local-part-event` for the current `message_key`
3. Partial response is preserved in Pantheon (whatever parts were mirrored so far)
4. Mode switches to remote
5. PxyCrab picks up conversation on next poll (≤30s). It sees the full message history including the partial response.
6. UI shows idle status immediately

### 5.2 Handover during active remote stream

**Scenario:** User is in remote mode, PxyCrab is mid-response, user clicks "Take Local".

**Handling:**
1. Adapter aborts the SSE connection to Pantheon (stops receiving events in UI)
2. PxyCrab continues working in background (it doesn't know about the handover)
3. PxyCrab's response is still persisted in Pantheon via `part-event` endpoint
4. On next PxyCrab poll (≤30s), conversation disappears from active set → PxyCrab stops
5. Mode switches to local
6. If PxyCrab finishes before the next poll, the response is complete in Pantheon
7. If PxyCrab is stopped mid-response, partial response is preserved

**UI implication:** The user might see a partial response that completes "in the background" on next page refresh. Acceptable tradeoff.

### 5.3 Local engine unavailable

**Scenario:** Tauri user has local-mode conversation but OpenCode server is down.

**Handling:**
1. Before sending prompt, adapter checks `localHealthy()` signal
2. If unhealthy: show toast "Local engine unavailable"
3. Offer one-click handover: "Switch to remote?" button in the toast
4. If user accepts: call handover("remote"), re-send prompt
5. If user declines: prompt is not sent, no partial state

### 5.4 Context preservation across handovers

**Problem:** Local OpenCode has its own session with internal message history. Messages that happened remotely (via PxyCrab) are NOT in the local engine's context window. After remote→local handover, local engine starts a fresh session and loses context.

**Mitigation (pragmatic):**
1. After handover from remote to local, create a NEW local OpenCode session
2. Before sending the first prompt, inject a system message summarizing recent conversation:
   - Fetch last N messages from Pantheon via `session.messages()`
   - Format as: "Here is the conversation history:\n\n[User]: ...\n[Assistant]: ...\n\nContinue from here."
   - Send as the first "prompt" to the new local session
3. This gives the local engine context without requiring session replay

**Limitation:** Tool call history, file edits, and reasoning traces from the remote session are not fully reconstructable locally. The local engine sees them as text summaries only. This is acceptable because:
- The full history is preserved in Pantheon
- The UI shows all messages from both modes
- The local engine only needs enough context to continue the conversation

### 5.5 Concurrent tabs

**Scenario:** Two tabs have the same conversation open. Tab A switches to remote, Tab B still thinks it's local.

**Handling:**
1. Mode is stored server-side on the Conversation document
2. When Tab B sends a prompt, the adapter sends to Pantheon first (user message persistence)
3. Pantheon returns the current `mode` in responses
4. If stale, adapter updates its `modeCache` and re-routes
5. Alternatively: adapter fetches conversation on each prompt to check mode (adds latency but is safe)

**Recommended approach:** Check mode on each prompt. The latency of a single GET is negligible compared to LLM response time.

### 5.6 Race condition: handover + prompt simultaneously

**Scenario:** User clicks "Hand to Pixie" while a prompt is being sent.

**Handling:**
1. Handover endpoint sets mode atomically on the Conversation document
2. If prompt arrives after mode change: Pantheon routes based on new mode
3. If prompt arrives before mode change: prompt is routed per old mode, handover completes after
4. No data corruption possible because user messages are always persisted regardless of mode

### 5.7 PxyCrab session state on handover

**Problem:** PxyCrab stores session state per-conversation in `~/.pxycrab/bots/{conv_id}/sessions.json`. When conversation goes local then back to remote, PxyCrab's `reconcile()` creates a NEW RunningBot. The old session data may or may not exist.

**Handling:**
- PxyCrab's session persistence is file-based and keyed by conversation_id
- If files still exist from previous remote session: PxyCrab resumes with `Provider.ResumeConversation()`
- If files were cleaned up: PxyCrab starts fresh with `Provider.NewConversation()`
- Both paths are fine because Pantheon has the full message history either way

### 5.8 Part ID collision across modes

**Problem:** Local OpenCode generates part IDs (e.g., `msg_abc-text`). PxyCrab generates different IDs (e.g., `text-0`). When switching modes, the part ID namespaces must not collide.

**Handling:** Part IDs are scoped to their message. Messages have unique MongoDB ObjectIDs. Different messages from different modes have different IDs, so part ID collision is impossible. No action needed.

### 5.9 Model consistency

**Problem:** Local mode may use a different model than remote mode.

**Handling:**
- The `model` field on the Conversation document is the default
- Both local and remote respect `conv.model` when set
- The adapter passes `model` to both local OpenCode and Pantheon
- If user changes model and then hands over, the new mode uses the updated model

### 5.10 Billing consistency

**Problem:** Local mode routes through Pantheon's proxy, so billing is tracked. But the `input_tokens`/`output_tokens` on the assistant message may differ between what the proxy sees and what gets mirrored.

**Handling:**
- Proxy-level billing: Pantheon's `/ai/opencode/claude/*` proxy uses `seat_manager.record_usage()` on each request. This is authoritative for billing.
- Message-level tokens (mirrored): The adapter doesn't know token counts (they're in the proxy response headers, not in the OpenCode SSE events). Set `input_tokens=0, output_tokens=0` on mirrored messages.
- This is acceptable: billing is already tracked at the proxy layer. Message-level tokens are informational only.

---

## Files Modified (Complete List)

### Pantheon (`/mnt/c/workspace/pantheon`)

| File | Changes |
|------|---------|
| `src/pantheon/db/models.py` | Rename `Agent` → `Pixie`, collection `ai_agents` → `pixies`, `agent_id` → `pixie_id`. Add `pixie_id` to User, `mode` to Conversation |
| `src/pantheon/api/routes/conversations.py` | Mode-aware routing (`_stream_local_ack`), `local-part-event` endpoint, `handover` endpoint, include `mode` in all conv responses |
| `src/pantheon/api/routes/agents.py` | Filter `mode="remote"` in `/api/agents/active` fleet endpoint |
| `src/pantheon/api/routes/agents.py` → `pixies.py` | Rename routes `/backend/agents/` → `/backend/pixies/`, fleet `/api/agents/active` → `/api/pixies/active`, update filter |
| `src/pantheon/api/routes/login.py` | Call `ensure_pixie()` on login |
| `src/pantheon/api/routes/oidc.py` | Call `ensure_pixie()` on OIDC token exchange |
| `src/pantheon/api/dependencies.py` | Add `ensure_pixie()` helper |
| `src/pantheon/api/routes/me.py` (or equivalent) | Include `pixie_id` in `/backend/me` response |
| `src/pantheon/api/routes/nightshift.py` | `Agent.find_one()` → `Pixie.find_one()` |
| `src/pantheon/main.py` | Update router imports |

### OpenWork (`/mnt/c/workspace/openwork`)

| File | Changes |
|------|---------|
| `packages/app/src/app/lib/pantheon-client.ts` | Add `mode` to PantheonConversation, add `postLocalPartEvent()`, `handoverConversation()` methods |
| `packages/app/src/app/lib/pantheon-adapter.ts` | Accept `localOpenCodeClient` param, mode cache, `localPrompt()` flow, mode-aware abort, `handover()` method, pass `mode` through `convToSession()` |
| `packages/app/src/app/context/pantheon-sdk.tsx` | Create local OpencodeClient in Tauri mode, health check loop, pass to adapter |
| `packages/app/src/app/app.tsx` | Sidebar mode badges (local/remote icons), chat header mode indicator + handover buttons, browser nag banner |

### PxyCrab (`/mnt/c/workspace/pxycrab`)

| File | Changes |
|------|---------|
| `fleet/client.go` | Update fleet endpoint URL from `/api/agents/active` → `/api/pixies/active` |

---

## Verification Plan

### Unit tests (Pantheon)
1. `test_ensure_pixie` — creates Pixie on first call, returns same on second
2. `test_conversation_mode_default` — new conversations get mode="remote"
3. `test_send_message_local_ack` — local-mode POST returns user_message + [DONE] only
4. `test_local_part_event` — upserts parts correctly, sets is_streaming
5. `test_handover` — switches mode, sets pixie_id, terminates streaming
6. `test_fleet_filter_mode` — `/api/agents/active` excludes local-mode conversations

### Integration tests (E2E)
1. **Tauri local mode**: Create conv (mode=local) → prompt → local OpenCode responds → response in UI → verify message in Pantheon MongoDB
2. **Browser remote mode**: Create conv (mode=remote) → prompt → PxyCrab responds → response in UI
3. **Handover local→remote**: Switch mode → PxyCrab picks up next message
4. **Handover remote→local**: Switch mode → local engine handles next message
5. **Handover mid-stream**: Start local prompt → handover mid-response → partial response preserved
6. **Local engine down**: Health check fails → toast shown → one-click handover works
7. **Sidebar badges**: Verify mode icons appear correctly for each conversation
8. **Browser nag**: Open in browser → banner visible → dismiss persists

### Manual smoke test
1. Open OpenWork in Tauri → create conversation → verify "Local 🖥️" in sidebar
2. Send message → see response from local OpenCode
3. Click "Hand to Pixie →" → see mode change to "Remote ☁️"
4. Send message → verify PxyCrab responds (may take up to 30s on first message)
5. Click "← Take Local" → mode changes back
6. Send message → local OpenCode responds
7. Open in browser → verify all conversations visible → remote-only → nag banner shown

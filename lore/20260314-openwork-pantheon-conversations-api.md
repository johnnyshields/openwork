# OpenWork → Pantheon Conversations API (Phase 1: Core Chat)

## Goal
OpenWork app requires Pantheon login, then uses Pantheon's conversations API for chat instead of OpenCode SDK. Phase 1 = login + send/receive messages. OpenCode SDK features (shell, revert, MCP, LSP, permissions) disabled for now.

## Approach
Create a **Pantheon client layer** alongside the existing OpenCode SDK. The app detects `VITE_OPENWORK_URL` → shows Pantheon login → uses conversations API for chat. OpenCode SDK path preserved for Tauri/local mode.

## Changes

### 1. `packages/app/src/app/lib/pantheon-client.ts` (NEW)
- Pantheon HTTP client: `login()`, `me()`, `listConversations()`, `createConversation()`, `sendMessage()` (returns SSE EventSource), `getMessages()`
- Auto-login via `POST /backend/login/localhost` in dev mode
- Store JWT in localStorage

### 2. `packages/app/src/app/context/pantheon.tsx` (NEW)
- `PantheonProvider` context: wraps pantheon-client, exposes `user()`, `token()`, `isLoggedIn()`, `conversations()`, `activeConversation()`
- On mount: auto-login if `VITE_OPENWORK_URL` is set
- Manages conversation CRUD and message SSE polling

### 3. `packages/app/src/app/entry.tsx`
- Wrap app in `PantheonProvider` when `VITE_OPENWORK_URL` is set
- Gate the app on `isLoggedIn()` — show login spinner until authenticated

### 4. `packages/app/src/app/app.tsx`
- When Pantheon mode: `sendPrompt()` calls `pantheon.sendMessage()` instead of `c.session.promptAsync()`
- Map conversations to session list (conversation.id → sessionID)
- Pantheon SSE responses mapped to the existing message store format

### 5. `packages/app/src/app/pages/session.tsx`
- Remove "Set up your first worker" dialog when Pantheon mode active
- Show "Connecting..." during auto-login, then normal chat UI
- Disable features not yet supported: shell, revert, MCP panel, LSP, permissions

### 6. `packages/app/src/app/context/session.ts`
- Add Pantheon message adapter: convert Pantheon `ChatMessage` → app's `Message` + `Part` format
- SSE polling: poll for new assistant messages (Pantheon's `_stream_via_nightshift` returns SSE)

## Message Format Mapping
```
Pantheon ChatMessage          →  App Message + Part
─────────────────────────────────────────────────
id                            →  part.id
conversation_id               →  message.sessionID
role ("user"/"assistant")     →  message.role
content                       →  part.text (type="text")
model                         →  message.modelID
created_at                    →  message.time.created
```

## Login Flow
```
App loads → VITE_OPENWORK_URL set?
  → POST /backend/login/localhost → JWT
  → Store JWT in localStorage
  → GET /backend/me → user info
  → GET /backend/conversations → conversation list
  → Ready for chat
```

## Verification
```bash
cd packages/app && VITE_OPENWORK_URL=http://localhost:8080 pnpm dev
# Open http://localhost:5174 → auto-login → see conversations → send message → get response
```

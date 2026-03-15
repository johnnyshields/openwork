# Delegation UX: World-Class Experience

**Date:** 2026-03-15
**Status:** Implemented

## Overview

Seven UX improvements transforming delegation from a developer tool into a polished product. The delegation infrastructure (Phases 1-4) was already complete — this focuses entirely on user experience.

## Improvements Implemented

### 1. Multi-Step Delegation Progress Overlay
- Full-screen overlay matching workspace-switch-overlay.tsx visual pattern
- Four steps: Preparing workspace → Starting container → Cloning conversation → Connecting Pixie
- Per-step icons (spinner/check/error/pending), elapsed timer, cancel button
- Error recovery buttons per step (Retry, Continue Anyway, Keep Waiting, View Conversation)
- **Files:** `components/delegation-progress-overlay.tsx` (NEW), `app.tsx`, `session.tsx`, `types.ts`

### 2. "Pixie is connecting..." State
- Extended `ConvPhase` with `delegating` boolean
- New `runPhase` value: `"delegating"` → shows "Pixie is connecting..." spinner
- Auto-clears when first stream part arrives
- **Files:** `context/pantheon.tsx`, `pages/session.tsx`, `pantheon-app.tsx`

### 3. Container Startup Progress Events
- Listens to Tauri `openwork://sandbox-create-progress` events during container step
- Updates step detail in real-time in the progress overlay
- **Files:** `app.tsx` (integrated into onDelegate handler)

### 4. Error Recovery UI
- Docker not installed: pre-flight `sandboxDoctor()` check, "Install Docker" + "Continue Anyway"
- Container start failure: try/catch with "Retry" + "Continue Anyway"
- Pixie timeout (60s): "Keep Waiting" + "View Conversation"
- **Files:** `app.tsx`, `components/delegation-progress-overlay.tsx`

### 5. "What Changed" Summary on Take-Back
- New Tauri command: `git_diff_stat` (Rust + TS wrapper)
- Fixed top-center banner: "Pixie changed X files (+Y/-Z)"
- Expandable diff stat view, auto-dismiss after 30s
- **Files:** `commands/orchestrator.rs`, `lib.rs`, `lib/tauri.ts`, `components/delegation-changes-banner.tsx` (NEW)

### 6. Autonomous Completion Notification
- Browser Notification API + tab title change + in-app toast
- Tracks delegated conversations via `delegatedFromMap` in PantheonProvider
- Desktop notification when tab hidden, tab title change, completion toast with "View" button
- **Files:** `lib/delegation-notifications.ts` (NEW), `components/delegation-completion-toast.tsx` (NEW), `context/pantheon.tsx`, `app.tsx`, `session.tsx`

### 7. Delegation Context Panel + Watch Mode
- Slide-out 400px panel from right with two tabs: Context + Watch
- Context tab: message list with role icons, message/tool call counts
- Watch tab: live read-only polling (2s) of delegate conversation messages
- "Watch Pixie" badge in conversation header when delegated_to exists
- **Files:** `components/delegation-context-panel.tsx` (NEW), `context/pantheon.tsx`, `pages/session.tsx`, `app.tsx`

## Architecture Notes

### SDK Signal Bridge Pattern
Pantheon context values (setConvPhase, completedDelegations, watchedMessages) are bridged to module-level SDK signals via `pantheon-sdk.tsx` so `app.tsx` can access them without direct context access. Pattern: Provider calls `setPantheonXxx(() => fn)` on mount, consumers read `pantheonXxx()`.

### New Files
| File | Purpose |
|------|---------|
| `components/delegation-progress-overlay.tsx` | Multi-step progress overlay |
| `components/delegation-changes-banner.tsx` | Git diff summary on take-back |
| `components/delegation-completion-toast.tsx` | Completion notification toast |
| `components/delegation-context-panel.tsx` | Context + watch mode panel |
| `lib/delegation-notifications.ts` | Browser Notification + tab title utils |

### Color Scheme
| State | Color |
|-------|-------|
| Active step | indigo-11 spinner |
| Done step | emerald-10 check |
| Error step | red-10 XCircle |
| Pending step | gray-6 circle |
| Delegating spinner | violet-6/violet-11 |
| Completion toast | emerald-3/emerald-11 |
| Changes banner | green-11/red-11 |

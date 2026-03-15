/**
 * PantheonApp — Standalone chat UI backed by Pantheon's conversations API.
 *
 * This replaces the full OpenCode-backed App when VITE_OPENWORK_URL is set.
 * It provides a simple, clean chat interface without the OpenCode-specific
 * features (workspaces, tools, MCP, LSP, permissions, etc.).
 */

import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import { usePantheon, isPantheonMode } from "./context/pantheon";
import type { PantheonConversation, PantheonWorkspace } from "./lib/pantheon-client";
import { isTauriRuntime } from "./utils";
import MessageList from "./components/session/message-list";

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

export function PantheonApp() {
  const p = usePantheon();
  const [nagDismissed, setNagDismissed] = createSignal(
    typeof window !== "undefined" && window.localStorage.getItem("openwork.nag.dismissed") === "1"
  );
  const showNag = () => isPantheonMode() && !isTauriRuntime() && !nagDismissed();

  return (
    <div class="h-screen flex flex-col bg-gray-1 text-gray-12">
      <Show when={showNag()}>
        <div class="flex items-center justify-between px-4 py-2 bg-indigo-2 border-b border-indigo-6 text-xs text-indigo-11 shrink-0">
          <span>Install the OpenWork desktop app for local AI mode</span>
          <button
            type="button"
            class="ml-4 text-indigo-9 hover:text-indigo-12 font-medium"
            onClick={() => {
              setNagDismissed(true);
              try { window.localStorage.setItem("openwork.nag.dismissed", "1"); } catch {}
            }}
          >
            ×
          </button>
        </div>
      </Show>
      <div class="flex flex-1 min-h-0">
        <Show when={p.isLoggingIn()}>
          <LoginSpinner />
        </Show>
        <Show when={p.loginError()}>
          <LoginError error={p.loginError()!} />
        </Show>
        <Show when={p.isLoggedIn()}>
          <Sidebar />
          <ChatPane />
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login states
// ---------------------------------------------------------------------------

function LoginSpinner() {
  return (
    <div class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-gray-6 border-t-gray-12" />
        <p class="text-sm text-gray-11">Connecting to Pantheon&hellip;</p>
      </div>
    </div>
  );
}

function LoginError(props: { error: string }) {
  return (
    <div class="flex-1 flex items-center justify-center">
      <div class="text-center max-w-sm">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-red-6 bg-red-2 text-red-11">
          !
        </div>
        <h3 class="text-lg font-semibold text-gray-12">Connection failed</h3>
        <p class="mt-2 text-sm text-gray-10">{props.error}</p>
        <button
          type="button"
          class="mt-4 rounded-lg bg-gray-12 px-4 py-2 text-sm font-medium text-gray-1 hover:bg-gray-11"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Sidebar() {
  const p = usePantheon();
  const [showNewWorkspace, setShowNewWorkspace] = createSignal(false);

  const sortedConversations = createMemo(() =>
    [...p.conversations()].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    ),
  );

  return (
    <div class="w-64 border-r border-gray-6 bg-gray-2 flex flex-col">
      {/* Header */}
      <div class="p-3 border-b border-gray-6 flex items-center justify-between">
        <span class="text-sm font-semibold text-gray-12">OpenWork</span>
        <span class="text-xs text-gray-9">{p.user()?.username}</span>
      </div>

      {/* New conversation */}
      <div class="p-2">
        <button
          type="button"
          class="w-full rounded-lg border border-dashed border-gray-6 px-3 py-2 text-xs font-medium text-gray-11 hover:border-gray-7 hover:bg-gray-3 transition-colors"
          onClick={() => p.createConversation()}
        >
          + New conversation
        </button>
      </div>

      {/* Conversation list */}
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        <For each={sortedConversations()}>
          {(conv) => (
            <button
              type="button"
              class={`w-full text-left rounded-lg px-3 py-2 text-xs transition-colors mb-0.5 ${
                p.activeConversationId() === conv.id
                  ? "bg-gray-4 text-gray-12 font-medium"
                  : "text-gray-11 hover:bg-gray-3"
              } ${conv.conv_status === "delegated" ? "opacity-50" : ""}`}
              onClick={() => p.setActiveConversation(conv.id)}
            >
              <div class="flex items-center gap-1.5 truncate">
                <Show when={conv.mode === "local"}>
                  <span class="shrink-0 text-gray-9" title="Local mode">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M2 20h20" /></svg>
                  </span>
                </Show>
                <Show when={conv.mode === "remote"}>
                  <span class="shrink-0 text-gray-9" title="Remote mode">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
                  </span>
                </Show>
                <span class="truncate">{conv.title}</span>
                <Show when={conv.delegated_to || conv.delegated_from}>
                  <span class="shrink-0 text-gray-8" title={conv.delegated_to ? "Delegated" : "Received delegation"}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                    </svg>
                  </span>
                </Show>
                <Show when={conv.conv_status === "delegated"}>
                  <span class="shrink-0 text-[9px] text-gray-8">(delegated)</span>
                </Show>
              </div>
              <div class="text-[10px] text-gray-8 mt-0.5">
                {new Date(conv.updated_at).toLocaleDateString()}
              </div>
            </button>
          )}
        </For>
      </div>

      {/* Workspaces */}
      <div class="border-t border-gray-6">
        <div class="p-2">
          <div class="flex items-center justify-between mb-1">
            <span class="text-[10px] font-medium text-gray-9 uppercase tracking-wider">Workspaces</span>
            <button
              type="button"
              class="text-[10px] text-gray-9 hover:text-gray-11"
              onClick={() => setShowNewWorkspace(true)}
            >
              + New
            </button>
          </div>
          <Show when={p.workspaces().length === 0}>
            <p class="text-[10px] text-gray-8 px-1">No workspaces yet</p>
          </Show>
          <For each={p.workspaces()}>
            {(ws) => <WorkspaceItem workspace={ws} />}
          </For>
        </div>
      </div>

      {/* Footer */}
      <div class="p-2 border-t border-gray-6">
        <button
          type="button"
          class="text-[10px] text-gray-8 hover:text-gray-11"
          onClick={p.logout}
        >
          Sign out
        </button>
      </div>

      {/* New workspace modal */}
      <Show when={showNewWorkspace()}>
        <NewWorkspaceModal onClose={() => setShowNewWorkspace(false)} />
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat pane
// ---------------------------------------------------------------------------

function ChatPane() {
  const p = usePantheon();
  const [draft, setDraft] = createSignal("");
  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(new Set());
  let inputRef: HTMLTextAreaElement | undefined;
  let messagesEndRef: HTMLDivElement | undefined;
  let scrollContainerRef: HTMLDivElement | undefined;

  const messages = createMemo(() => p.activeMessages());
  const activeConv = createMemo(() =>
    p.conversations().find((c) => c.id === p.activeConversationId()),
  );

  const scrollToBottom = () => {
    messagesEndRef?.scrollIntoView({ behavior: "smooth" });
  };

  const handleSend = async () => {
    const text = draft().trim();
    if (!text || p.isSending()) return;

    setDraft("");

    await p.sendMessage(text, (chunk) => {
      if (chunk.done) {
        scrollToBottom();
      } else {
        scrollToBottom();
      }
    });

    scrollToBottom();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-focus input when conversation changes
  onMount(() => {
    inputRef?.focus();
  });

  return (
    <div class="flex-1 flex flex-col">
      <Show
        when={p.activeConversationId()}
        fallback={<EmptyState />}
      >
        {/* Chat header */}
        <Show when={activeConv()}>
          {(conv) => (
            <div class="flex items-center gap-2 px-6 py-2 border-b border-gray-6 shrink-0">
              <h2 class="text-xs font-medium text-gray-11 truncate">{conv().title}</h2>
              <Show when={conv().mode}>
                <span
                  class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-gray-6 text-gray-10 bg-gray-2"
                  title={conv().mode === "local" ? "Running locally" : "Running on Pixie (remote)"}
                >
                  {conv().mode === "local" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M2 20h20" /></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
                  )}
                  {conv().mode === "local" ? "Local" : "Remote"}
                </span>
                <Show when={conv().mode === "local"}>
                  <button
                    type="button"
                    class="text-[10px] text-gray-9 hover:text-gray-12 transition-colors"
                    onClick={async () => {
                      const id = p.activeConversationId();
                      if (!id) return;
                      try {
                        const result = await p.client.delegateConversation(id, "remote");
                        await p.refreshConversations();
                        const delegateId = result.delegate.id;
                        p.setActiveConversation(delegateId);
                        // Set delegating phase so spinner shows "Pixie is connecting..."
                        p.setConvPhase(delegateId, { sending: false, delegating: true, receivedPart: false, receivedText: false });
                      } catch (e) {
                        console.error("[pantheon-app] delegate failed:", e);
                      }
                    }}
                  >
                    Delegate to Pixie →
                  </button>
                </Show>
                <Show when={conv().mode === "remote" && isTauriRuntime()}>
                  <button
                    type="button"
                    class="text-[10px] text-gray-9 hover:text-gray-12 transition-colors"
                    onClick={async () => {
                      const id = p.activeConversationId();
                      if (!id) return;
                      try {
                        const result = await p.client.delegateConversation(id, "local");
                        await p.refreshConversations();
                        p.setActiveConversation(result.delegate.id);
                      } catch (e) {
                        console.error("[pantheon-app] delegate failed:", e);
                      }
                    }}
                  >
                    ← Take Back Locally
                  </button>
                </Show>
                <Show when={conv().delegated_from}>
                  <button
                    type="button"
                    class="text-[10px] text-gray-9 hover:text-gray-12 transition-colors"
                    onClick={() => {
                      const from = conv().delegated_from;
                      if (from) p.setActiveConversation(from);
                    }}
                  >
                    ← From previous
                  </button>
                </Show>
                <Show when={conv().delegated_to}>
                  <button
                    type="button"
                    class="text-[10px] text-gray-9 hover:text-gray-12 transition-colors"
                    onClick={() => {
                      const to = conv().delegated_to;
                      if (to) p.setActiveConversation(to);
                    }}
                  >
                    Continued →
                  </button>
                </Show>
              </Show>
            </div>
          )}
        </Show>
        {/* Messages */}
        <div ref={scrollContainerRef} class="flex-1 overflow-y-auto px-6 py-8">
          <div class="max-w-[700px] mx-auto">
            <MessageList
              messages={messages()}
              isStreaming={p.isStreaming()}
              developerMode={false}
              showThinking={true}
              expandedStepIds={expandedStepIds()}
              setExpandedStepIds={setExpandedStepIds}
              scrollElement={() => scrollContainerRef}
              loader={
                <Show when={p.runPhase() === "sending" || p.runPhase() === "thinking" || p.runPhase() === "delegating"}>
                  <div class="flex items-center gap-3 py-1">
                    <div class="w-7 h-7 rounded-full bg-violet-3 border border-violet-6 flex items-center justify-center flex-shrink-0">
                      <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-6 border-t-violet-11" />
                    </div>
                    <span class="text-sm text-gray-10">
                      {p.runPhase() === "delegating" ? "Pixie is connecting\u2026" : p.runPhase() === "sending" ? "Sending\u2026" : "Thinking\u2026"}
                    </span>
                  </div>
                </Show>
              }
            />
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div class="border-t border-gray-6 p-4">
          <div class="max-w-[700px] mx-auto">
            <div class="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                class="flex-1 resize-none rounded-xl border border-gray-6 bg-gray-2 px-4 py-3 text-sm text-gray-12 placeholder-gray-8 focus:border-gray-8 focus:outline-none"
                placeholder="Send a message..."
                rows={1}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                disabled={p.isSending()}
              />
              <button
                type="button"
                class="rounded-xl bg-gray-12 px-4 py-3 text-sm font-medium text-gray-1 hover:bg-gray-11 disabled:opacity-50 transition-colors"
                onClick={handleSend}
                disabled={!draft().trim() || p.isSending()}
              >
                Send
              </button>
            </div>
            <EffortSelector />
          </div>
        </div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Effort selector
// ---------------------------------------------------------------------------

const EFFORT_OPTIONS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

function EffortSelector() {
  const p = usePantheon();

  const activeConv = createMemo(() =>
    p.conversations().find((c) => c.id === p.activeConversationId()),
  );

  const currentEffort = createMemo(() => activeConv()?.effort ?? "");

  const handleChange = async (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    const convId = p.activeConversationId();
    if (!convId) return;
    await p.updateConversation(convId, { effort: value || undefined });
  };

  return (
    <div class="flex items-center gap-2 mt-2">
      <label class="text-[10px] text-gray-8">Thinking:</label>
      <select
        class="text-[10px] text-gray-10 bg-gray-2 border border-gray-6 rounded px-1.5 py-0.5 focus:outline-none focus:border-gray-8"
        value={currentEffort()}
        onChange={handleChange}
      >
        <For each={EFFORT_OPTIONS}>
          {(opt) => <option value={opt.value}>{opt.label}</option>}
        </For>
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace components
// ---------------------------------------------------------------------------

const WORKSPACE_STATUS_COLORS: Record<string, string> = {
  running: "bg-green-9",
  creating: "bg-yellow-9",
  ready: "bg-blue-9",
  stopped: "bg-gray-8",
  error: "bg-red-9",
};

function WorkspaceStatusBadge(props: { status: string }) {
  const color = () => WORKSPACE_STATUS_COLORS[props.status] ?? "bg-gray-8";
  return (
    <span
      class={`inline-block h-2 w-2 rounded-full ${color()}`}
      title={props.status}
    />
  );
}

function WorkspaceItem(props: { workspace: PantheonWorkspace }) {
  const p = usePantheon();

  return (
    <div class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-gray-11 hover:bg-gray-3 group">
      <WorkspaceStatusBadge status={props.workspace.status} />
      <span class="truncate flex-1">{props.workspace.name}</span>
      <button
        type="button"
        class="text-[10px] text-gray-8 hover:text-red-10 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => p.deleteWorkspace(props.workspace.id)}
        title="Delete workspace"
      >
        x
      </button>
    </div>
  );
}

function NewWorkspaceModal(props: { onClose: () => void }) {
  const p = usePantheon();
  const [name, setName] = createSignal("");
  const [localPath, setLocalPath] = createSignal("");
  const [repoUrl, setRepoUrl] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const isTauri = isTauriRuntime();

  const handlePickDirectory = async () => {
    try {
      const { pickDirectory } = await import("./lib/tauri");
      const dir = await pickDirectory({ title: "Select project directory" });
      if (typeof dir === "string") setLocalPath(dir);
    } catch (e) {
      console.error("[workspace] directory picker failed:", e);
    }
  };

  const handleCreate = async () => {
    const wsName = name().trim();
    if (!wsName || creating()) return;

    setCreating(true);
    try {
      const mode = isTauri && localPath() ? "local" : "remote";
      const ws = await p.createWorkspace({
        name: wsName,
        mode,
        local_path: localPath() || undefined,
        repo_url: repoUrl() || undefined,
      });

      // If Tauri + local mode, spin up the sandbox container
      if (ws && isTauri && mode === "local" && ws.nightshift_api_key) {
        try {
          const { sandboxCreateWorkspace } = await import("./lib/tauri");
          const pantheonUrl = (import.meta.env?.VITE_OPENWORK_URL as string) ?? "";
          await sandboxCreateWorkspace(localPath(), pantheonUrl, ws.nightshift_api_key);
          // Refresh to get updated status
          await p.refreshWorkspaces();
        } catch (e) {
          console.error("[workspace] sandbox creation failed:", e);
        }
      }

      props.onClose();
    } catch (e) {
      console.error("[workspace] creation failed:", e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div class="w-96 rounded-xl border border-gray-6 bg-gray-2 p-5 shadow-xl">
        <h3 class="text-sm font-semibold text-gray-12 mb-4">New Workspace</h3>

        <label class="block text-xs text-gray-10 mb-1">Name</label>
        <input
          class="w-full rounded-lg border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder-gray-8 focus:border-gray-8 focus:outline-none mb-3"
          placeholder="my-project"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />

        <Show when={isTauri}>
          <label class="block text-xs text-gray-10 mb-1">Project directory</label>
          <div class="flex gap-2 mb-3">
            <input
              class="flex-1 rounded-lg border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder-gray-8 focus:border-gray-8 focus:outline-none"
              placeholder="/path/to/project"
              value={localPath()}
              onInput={(e) => setLocalPath(e.currentTarget.value)}
            />
            <button
              type="button"
              class="rounded-lg border border-gray-6 px-3 py-2 text-xs text-gray-11 hover:bg-gray-3"
              onClick={handlePickDirectory}
            >
              Browse
            </button>
          </div>
        </Show>

        <Show when={!isTauri}>
          <label class="block text-xs text-gray-10 mb-1">Repository URL</label>
          <input
            class="w-full rounded-lg border border-gray-6 bg-gray-3 px-3 py-2 text-sm text-gray-12 placeholder-gray-8 focus:border-gray-8 focus:outline-none mb-3"
            placeholder="https://github.com/user/repo"
            value={repoUrl()}
            onInput={(e) => setRepoUrl(e.currentTarget.value)}
          />
        </Show>

        <div class="flex justify-end gap-2 mt-4">
          <button
            type="button"
            class="rounded-lg px-4 py-2 text-xs text-gray-11 hover:bg-gray-3"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-lg bg-gray-12 px-4 py-2 text-xs font-medium text-gray-1 hover:bg-gray-11 disabled:opacity-50"
            onClick={handleCreate}
            disabled={!name().trim() || creating()}
          >
            {creating() ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state (no conversation selected)
// ---------------------------------------------------------------------------

function EmptyState() {
  const p = usePantheon();
  const [draft, setDraft] = createSignal("");

  const handleSend = async () => {
    const text = draft().trim();
    if (!text) return;
    setDraft("");
    // Create conversation + send message
    await p.sendMessage(text);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div class="flex-1 flex flex-col items-center justify-center px-6">
      <div class="max-w-md text-center mb-8">
        <h2 class="text-2xl font-semibold text-gray-12">OpenWork</h2>
        <p class="mt-2 text-sm text-gray-10">
          Start a conversation or select one from the sidebar.
        </p>
      </div>
      <div class="w-full max-w-[500px]">
        <div class="flex gap-2 items-end">
          <textarea
            class="flex-1 resize-none rounded-xl border border-gray-6 bg-gray-2 px-4 py-3 text-sm text-gray-12 placeholder-gray-8 focus:border-gray-8 focus:outline-none"
            placeholder="Start a new conversation..."
            rows={1}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={p.isSending()}
          />
          <button
            type="button"
            class="rounded-xl bg-gray-12 px-4 py-3 text-sm font-medium text-gray-1 hover:bg-gray-11 disabled:opacity-50 transition-colors"
            onClick={handleSend}
            disabled={!draft().trim() || p.isSending()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

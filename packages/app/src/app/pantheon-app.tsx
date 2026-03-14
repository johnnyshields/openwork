/**
 * PantheonApp — Standalone chat UI backed by Pantheon's conversations API.
 *
 * This replaces the full OpenCode-backed App when VITE_OPENWORK_URL is set.
 * It provides a simple, clean chat interface without the OpenCode-specific
 * features (workspaces, tools, MCP, LSP, permissions, etc.).
 */

import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import { usePantheon } from "./context/pantheon";
import type { PantheonConversation } from "./lib/pantheon-client";
import MessageList from "./components/session/message-list";

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

export function PantheonApp() {
  const p = usePantheon();

  return (
    <div class="h-screen flex bg-gray-1 text-gray-12">
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
              }`}
              onClick={() => p.setActiveConversation(conv.id)}
            >
              <div class="truncate">{conv.title}</div>
              <div class="text-[10px] text-gray-8 mt-0.5">
                {new Date(conv.updated_at).toLocaleDateString()}
              </div>
            </button>
          )}
        </For>
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
                <Show when={p.runPhase() === "sending" || p.runPhase() === "thinking"}>
                  <div class="flex items-center gap-3 py-1">
                    <div class="w-7 h-7 rounded-full bg-violet-3 border border-violet-6 flex items-center justify-center flex-shrink-0">
                      <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-6 border-t-violet-11" />
                    </div>
                    <span class="text-sm text-gray-10">
                      {p.runPhase() === "sending" ? "Sending\u2026" : "Thinking\u2026"}
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

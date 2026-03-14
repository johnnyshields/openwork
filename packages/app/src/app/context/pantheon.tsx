/**
 * PantheonProvider — SolidJS context for Pantheon-backed chat.
 *
 * When VITE_OPENWORK_URL is set, this provider:
 * 1. Auto-logs in via localhost login
 * 2. Loads conversations and agents
 * 3. Exposes send/receive for the chat UI
 */

import {
  createContext,
  createSignal,
  createEffect,
  createMemo,
  useContext,
  onCleanup,
  type JSX,
} from "solid-js";
import {
  createPantheonClient,
  type PantheonClient,
  type PantheonUser,
  type PantheonConversation,
  type PantheonMessage,
  type PantheonAgent,
  type PantheonStreamEvent,
} from "../lib/pantheon-client";
import type { MessageWithParts, PlaceholderAssistantMessage } from "../types";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface PantheonContextValue {
  /** Whether Pantheon mode is active (VITE_OPENWORK_URL set) */
  enabled: boolean;
  /** The Pantheon HTTP client */
  client: PantheonClient;
  /** Reactive signals */
  user: () => PantheonUser | null;
  isLoggedIn: () => boolean;
  isLoggingIn: () => boolean;
  loginError: () => string | null;
  conversations: () => PantheonConversation[];
  agents: () => PantheonAgent[];
  activeConversationId: () => string | null;
  activeMessages: () => MessageWithParts[];
  isSending: () => boolean;
  isStreaming: () => boolean;
  /** "idle" | "sending" | "thinking" | "responding" */
  runPhase: () => "idle" | "sending" | "thinking" | "responding";
  /** Actions */
  setActiveConversation: (id: string | null) => void;
  createConversation: (opts?: {
    title?: string;
    agent_id?: string;
  }) => Promise<PantheonConversation | null>;
  deleteConversation: (id: string) => Promise<void>;
  updateConversation: (id: string, updates: { effort?: string }) => Promise<void>;
  sendMessage: (
    content: string,
    onChunk?: (data: { role: string; content: string; done: boolean }) => void,
  ) => Promise<PantheonMessage | null>;
  refreshConversations: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  logout: () => void;
}

const PantheonContext = createContext<PantheonContextValue>();

// ---------------------------------------------------------------------------
// Detect Pantheon mode
// ---------------------------------------------------------------------------

const PANTHEON_BASE_URL =
  typeof import.meta.env?.VITE_OPENWORK_URL === "string"
    ? import.meta.env.VITE_OPENWORK_URL.trim()
    : "";

export const isPantheonMode = () => PANTHEON_BASE_URL.length > 0;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function PantheonProvider(props: { children: JSX.Element }) {
  const enabled = isPantheonMode();
  const client = createPantheonClient(PANTHEON_BASE_URL);

  const [user, setUser] = createSignal<PantheonUser | null>(null);
  const [isLoggingIn, setIsLoggingIn] = createSignal(false);
  const [loginError, setLoginError] = createSignal<string | null>(null);
  const [conversations, setConversations] = createSignal<PantheonConversation[]>([]);
  const [agents, setAgents] = createSignal<PantheonAgent[]>([]);
  const [activeConversationId, setActiveConversationId] = createSignal<string | null>(null);
  const [activeMessages, setActiveMessages] = createSignal<MessageWithParts[]>([]);
  const [isSending, setIsSending] = createSignal(false);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [hasReceivedPart, setHasReceivedPart] = createSignal(false);
  const [hasReceivedText, setHasReceivedText] = createSignal(false);

  const runPhase = createMemo((): "idle" | "sending" | "thinking" | "responding" => {
    if (!isSending()) return "idle";
    if (hasReceivedText()) return "responding";
    if (hasReceivedPart()) return "thinking";
    return "sending";
  });

  // Tracks accumulated parts for the currently-streaming assistant message.
  // Keyed by message_id, value is the accumulated parts array.
  let streamingParts: Map<string, any[]> = new Map();
  let streamingMessageId: string | null = null;

  const isLoggedIn = () => !!user();

  // ── Auto-login ──────────────────────────────────────────────────────

  if (enabled) {
    // Try to auto-login on mount
    createEffect(() => {
      if (user()) return; // already logged in
      if (isLoggingIn()) return;

      setIsLoggingIn(true);
      setLoginError(null);

      (async () => {
        try {
          // Try existing token first
          if (client.isLoggedIn()) {
            const me = await client.me();
            setUser(me);
            await loadConversationsAndAgents();
            return;
          }
          // Auto-login (localhost mode)
          const result = await client.loginLocalhost();
          setUser(result.user);
          await loadConversationsAndAgents();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[pantheon] login failed:", msg);
          setLoginError(msg);
          client.clearToken();
        } finally {
          setIsLoggingIn(false);
        }
      })();
    });
  }

  // ── Load conversations when active conversation changes ─────────────

  createEffect(() => {
    const id = activeConversationId();
    if (!id || !isLoggedIn()) {
      setActiveMessages([]);
      return;
    }
    loadMessages(id);
  });

  // ── Poll for new messages in active conversation ────────────────────

  let pollTimer: ReturnType<typeof setInterval> | undefined;

  createEffect(() => {
    const id = activeConversationId();
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (!id || !isLoggedIn()) return;

    // Poll every 2s for new messages (catches agent responses)
    pollTimer = setInterval(() => loadMessages(id), 2000);
  });

  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  // ── Helpers ─────────────────────────────────────────────────────────

  function toMessageWithParts(msg: PantheonMessage): MessageWithParts {
    const parts: any[] =
      msg.parts && msg.parts.length > 0
        ? msg.parts
        : [
            {
              type: "text" as const,
              id: `${msg.id}-text`,
              sessionID: msg.conversation_id,
              messageID: msg.id,
              text: msg.content,
            },
          ];

    const info: PlaceholderAssistantMessage = {
      id: msg.id,
      sessionID: msg.conversation_id,
      role: msg.role as "assistant",
      time: {
        created: new Date(msg.created_at).getTime(),
      },
      parentID: "",
      modelID: msg.model ?? "",
      providerID: msg.source ?? "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: {
        input: msg.input_tokens,
        output: msg.output_tokens,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };

    // For user messages, override the role in info
    if (msg.role === "user") {
      (info as any).role = "user";
    }

    return { info, parts };
  }

  function handleStreamEvent(event: PantheonStreamEvent, conversationId: string) {
    if (event.type === "part") {
      const msgId = event.message_id;
      if (!streamingParts.has(msgId)) {
        streamingParts.set(msgId, []);
      }
      const parts = streamingParts.get(msgId)!;

      // Upsert: if a part with same id exists, replace it; otherwise append
      const partId = event.part?.id;
      if (partId) {
        const existingIdx = parts.findIndex((p: any) => p.id === partId);
        if (existingIdx >= 0) {
          parts[existingIdx] = event.part;
        } else {
          parts.push(event.part);
        }
      } else {
        parts.push(event.part);
      }

      streamingMessageId = msgId;

      // Track phase transitions
      setHasReceivedPart(true);
      if (event.part?.type === "text" && event.part?.text) {
        setHasReceivedText(true);
      }

      // Build the streaming assistant message and append/update it in activeMessages
      const streamingMsg: MessageWithParts = {
        info: {
          id: msgId,
          sessionID: conversationId,
          role: "assistant",
          time: { created: Date.now() },
          parentID: "",
          modelID: "",
          providerID: "",
          mode: "",
          agent: "",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [...parts],
      };

      setActiveMessages((prev) => {
        // If there's already a message with this id, replace it
        const idx = prev.findIndex((m) => (m.info as any).id === msgId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = streamingMsg;
          return next;
        }
        // Otherwise append
        return [...prev, streamingMsg];
      });
    }

    if (event.type === "done") {
      streamingParts.delete(event.message_id);
      streamingMessageId = null;
    }
  }

  async function loadConversationsAndAgents() {
    try {
      const [convs, ags] = await Promise.all([
        client.listConversations(),
        client.listAgents(),
      ]);
      setConversations(convs);
      setAgents(ags);
    } catch (e) {
      console.error("[pantheon] failed to load data:", e);
    }
  }

  async function loadMessages(conversationId: string) {
    try {
      const msgs = await client.getMessages(conversationId);
      setActiveMessages(msgs.map(toMessageWithParts));
    } catch (e) {
      console.error("[pantheon] failed to load messages:", e);
    }
  }

  async function refreshConversations() {
    await loadConversationsAndAgents();
  }

  async function refreshMessages() {
    const id = activeConversationId();
    if (id) await loadMessages(id);
  }

  async function createConversation(opts?: {
    title?: string;
    agent_id?: string;
  }): Promise<PantheonConversation | null> {
    try {
      // If there are agents, use the first one by default
      const agentId = opts?.agent_id ?? agents()[0]?.id;
      const conv = await client.createConversation({
        title: opts?.title ?? "New conversation",
        agent_id: agentId,
        provider: "claude",
      });
      setConversations((prev) => [...prev, conv]);
      setActiveConversationId(conv.id);
      return conv;
    } catch (e) {
      console.error("[pantheon] create conversation failed:", e);
      return null;
    }
  }

  async function deleteConversation(id: string) {
    try {
      await client.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConversationId() === id) {
        setActiveConversationId(null);
        setActiveMessages([]);
      }
    } catch (e) {
      console.error("[pantheon] delete conversation failed:", e);
    }
  }

  async function updateConversation(id: string, updates: { effort?: string }) {
    try {
      const updated = await client.updateConversation(id, updates);
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (e) {
      console.error("[pantheon] update conversation failed:", e);
    }
  }

  async function sendMessage(
    content: string,
    onChunk?: (data: { role: string; content: string; done: boolean }) => void,
  ): Promise<PantheonMessage | null> {
    let convId = activeConversationId();

    // Auto-create conversation if none active
    if (!convId) {
      const conv = await createConversation({ title: content.slice(0, 50) });
      if (!conv) return null;
      convId = conv.id;
    }

    setIsSending(true);
    setIsStreaming(true);
    setHasReceivedPart(false);
    setHasReceivedText(false);
    streamingParts = new Map();
    streamingMessageId = null;

    try {
      // Optimistically add user message to the list
      const userMsg = toMessageWithParts({
        id: `temp-${Date.now()}`,
        conversation_id: convId,
        role: "user",
        content,
        model: null,
        source: null,
        input_tokens: 0,
        output_tokens: 0,
        created_at: new Date().toISOString(),
      });
      setActiveMessages((prev) => [...prev, userMsg]);

      const streamConvId = convId;
      // Send and stream response
      const result = await client.sendMessageStreaming(convId, content, onChunk, {
        onEvent: (event) => handleStreamEvent(event, streamConvId),
      });

      // Refresh messages to get the real IDs from DB
      await loadMessages(convId);

      return result;
    } catch (e) {
      console.error("[pantheon] send failed:", e);
      // Refresh to get actual state
      await loadMessages(convId);
      return null;
    } finally {
      setIsSending(false);
      setIsStreaming(false);
      streamingParts = new Map();
      streamingMessageId = null;
    }
  }

  function logout() {
    client.clearToken();
    setUser(null);
    setConversations([]);
    setActiveMessages([]);
    setActiveConversationId(null);
  }

  const value: PantheonContextValue = {
    enabled,
    client,
    user,
    isLoggedIn,
    isLoggingIn,
    loginError,
    conversations,
    agents,
    activeConversationId,
    activeMessages,
    isSending,
    isStreaming,
    runPhase,
    setActiveConversation: setActiveConversationId,
    createConversation,
    deleteConversation,
    updateConversation,
    sendMessage,
    refreshConversations,
    refreshMessages,
    logout,
  };

  return (
    <PantheonContext.Provider value={value}>
      {props.children}
    </PantheonContext.Provider>
  );
}

export function usePantheon(): PantheonContextValue {
  const ctx = useContext(PantheonContext);
  if (!ctx) {
    throw new Error("usePantheon must be used within a PantheonProvider");
  }
  return ctx;
}

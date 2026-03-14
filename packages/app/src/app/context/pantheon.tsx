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
} from "../lib/pantheon-client";

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
  activeMessages: () => PantheonMessage[];
  isSending: () => boolean;
  /** Actions */
  setActiveConversation: (id: string | null) => void;
  createConversation: (opts?: {
    title?: string;
    agent_id?: string;
  }) => Promise<PantheonConversation | null>;
  deleteConversation: (id: string) => Promise<void>;
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
  const [activeMessages, setActiveMessages] = createSignal<PantheonMessage[]>([]);
  const [isSending, setIsSending] = createSignal(false);

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
      setActiveMessages(msgs);
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
    try {
      // Optimistically add user message to the list
      const userMsg: PantheonMessage = {
        id: `temp-${Date.now()}`,
        conversation_id: convId,
        role: "user",
        content,
        model: null,
        source: null,
        input_tokens: 0,
        output_tokens: 0,
        created_at: new Date().toISOString(),
      };
      setActiveMessages((prev) => [...prev, userMsg]);

      // Send and stream response
      const result = await client.sendMessageStreaming(convId, content, onChunk);

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
    setActiveConversation: setActiveConversationId,
    createConversation,
    deleteConversation,
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

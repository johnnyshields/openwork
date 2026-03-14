/**
 * Pantheon HTTP client for the conversations API.
 *
 * Handles auth (localhost auto-login), conversation CRUD, and message
 * send/receive including SSE streaming for agent responses.
 */

const STORAGE_KEY = "pantheon.jwt";

export interface PantheonUser {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: string;
}

export interface PantheonConversation {
  id: string;
  title: string;
  model: string | null;
  agent_id: string | null;
  provider: string;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface PantheonMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  source: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

export interface PantheonAgent {
  id: string;
  name: string;
  system_prompt: string | null;
  platform: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createPantheonClient(baseUrl: string) {
  let token = loadToken();

  function loadToken(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function saveToken(t: string) {
    token = t;
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
  }

  function clearToken() {
    token = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function getToken() {
    return token;
  }

  async function request<T = unknown>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> | undefined),
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const resp = await fetch(url, { ...options, headers });

    if (resp.status === 401 || resp.status === 403) {
      clearToken();
      throw new PantheonAuthError(resp.status, "Authentication failed");
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new PantheonApiError(resp.status, text || resp.statusText);
    }

    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return (await resp.json()) as T;
    }
    return (await resp.text()) as unknown as T;
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  async function loginLocalhost(): Promise<{ token: string; user: PantheonUser }> {
    const data = await request<{
      access_token: string;
      user: PantheonUser;
    }>("/backend/login/localhost", { method: "POST" });
    saveToken(data.access_token);
    return { token: data.access_token, user: data.user };
  }

  async function me(): Promise<PantheonUser> {
    return request<PantheonUser>("/backend/me");
  }

  function isLoggedIn(): boolean {
    return !!token;
  }

  // ── Agents ────────────────────────────────────────────────────────────

  async function listAgents(): Promise<PantheonAgent[]> {
    return request<PantheonAgent[]>("/backend/agents");
  }

  // ── Conversations ─────────────────────────────────────────────────────

  async function listConversations(): Promise<PantheonConversation[]> {
    return request<PantheonConversation[]>("/backend/conversations/");
  }

  async function createConversation(opts: {
    title?: string;
    agent_id?: string;
    provider?: string;
    model?: string;
  }): Promise<PantheonConversation> {
    return request<PantheonConversation>("/backend/conversations/", {
      method: "POST",
      body: JSON.stringify({
        title: opts.title ?? "New conversation",
        agent_id: opts.agent_id,
        provider: opts.provider ?? "claude",
        model: opts.model,
      }),
    });
  }

  async function getConversation(id: string): Promise<PantheonConversation> {
    return request<PantheonConversation>(`/backend/conversations/${id}`);
  }

  async function deleteConversation(id: string): Promise<void> {
    await request(`/backend/conversations/${id}`, { method: "DELETE" });
  }

  // ── Messages ──────────────────────────────────────────────────────────

  async function getMessages(
    conversationId: string,
    limit = 100,
  ): Promise<PantheonMessage[]> {
    return request<PantheonMessage[]>(
      `/backend/conversations/${conversationId}/messages?limit=${limit}`,
    );
  }

  /**
   * Send a message and return an SSE EventSource for the streaming response.
   * The caller should listen for `message` events and parse JSON data.
   */
  function sendMessage(
    conversationId: string,
    content: string,
    opts?: { model?: string },
  ): { eventSource: EventSource; abort: () => void } {
    // We can't use EventSource directly for POST, so use fetch + ReadableStream.
    const controller = new AbortController();

    const url = `${baseUrl}/backend/conversations/${conversationId}/messages`;
    const body = JSON.stringify({ content, model: opts?.model });

    // Return a thin wrapper. The actual streaming is done via fetchSSE().
    return {
      eventSource: null as unknown as EventSource, // placeholder
      abort: () => controller.abort(),
    };
  }

  /**
   * Send a message via fetch and stream SSE response chunks.
   * Returns the final assistant message content.
   */
  async function sendMessageStreaming(
    conversationId: string,
    content: string,
    onChunk?: (data: { role: string; content: string; done: boolean }) => void,
    opts?: { model?: string; signal?: AbortSignal },
  ): Promise<PantheonMessage | null> {
    const url = `${baseUrl}/backend/conversations/${conversationId}/messages`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ content, model: opts?.model }),
      signal: opts?.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new PantheonApiError(resp.status, text || resp.statusText);
    }

    // Parse SSE stream
    const reader = resp.body?.getReader();
    if (!reader) return null;

    const decoder = new TextDecoder();
    let buffer = "";
    let lastMessage: PantheonMessage | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            onChunk?.({ role: "assistant", content: "", done: true });
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              throw new PantheonApiError(0, parsed.error);
            }
            if (parsed.role === "assistant") {
              lastMessage = {
                id: parsed.id ?? "",
                conversation_id: conversationId,
                role: "assistant",
                content: parsed.content ?? "",
                model: parsed.model ?? null,
                source: "nightshift",
                input_tokens: 0,
                output_tokens: 0,
                created_at: new Date().toISOString(),
              };
              onChunk?.({
                role: "assistant",
                content: parsed.content ?? "",
                done: false,
              });
            }
          } catch (e) {
            if (e instanceof PantheonApiError) throw e;
            // Ignore parse errors for SSE ping frames etc.
          }
        }
      }
    }

    return lastMessage;
  }

  return {
    getToken,
    isLoggedIn,
    loginLocalhost,
    me,
    clearToken,
    listAgents,
    listConversations,
    createConversation,
    getConversation,
    deleteConversation,
    getMessages,
    sendMessage,
    sendMessageStreaming,
  };
}

export type PantheonClient = ReturnType<typeof createPantheonClient>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PantheonAuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PantheonAuthError";
  }
}

export class PantheonApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PantheonApiError";
  }
}

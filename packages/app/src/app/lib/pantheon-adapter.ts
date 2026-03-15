/**
 * Adapter that wraps PantheonClient in an OpencodeClient-compatible shape.
 *
 * Runtime-compatible with `Client` (= ReturnType<typeof createClient>) so the
 * session store, SSE loop, and all UI code can consume it without changes.
 */

import type {
  PantheonClient,
  PantheonConversation,
  PantheonMessage,
  PantheonStreamEvent,
} from "./pantheon-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeResponse = () => ({
  request: new Request("pantheon://stub"),
  response: new Response(),
});

const wrap = <T>(data: T) => ({ data, ...fakeResponse() });

const stub = (data: any = {}) =>
  Promise.resolve({ data, ...fakeResponse() });

// ---------------------------------------------------------------------------
// Type converters
// ---------------------------------------------------------------------------

function convToSession(conv: PantheonConversation): any {
  return {
    id: conv.id,
    title: conv.title,
    projectID: "",
    directory: "",
    version: "1",
    slug: conv.id,
    time: {
      created: new Date(conv.created_at).getTime(),
      updated: new Date(conv.updated_at).getTime(),
    },
  };
}

function msgToSdkMessage(msg: PantheonMessage, convId: string): any {
  const base: any = {
    id: msg.id,
    sessionID: convId,
    role: msg.role,
    time: { created: new Date(msg.created_at).getTime() },
  };
  if (msg.role === "assistant") {
    base.parentID = "";
    base.modelID = msg.model || "";
    base.providerID = "";
    base.mode = "";
    base.agent = "";
    base.path = { cwd: "", root: "" };
    base.cost = 0;
    base.tokens = {
      input: msg.input_tokens || 0,
      output: msg.output_tokens || 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
  }
  return base;
}

function msgPartsToSdkParts(msg: PantheonMessage, convId: string): any[] {
  if (msg.parts && msg.parts.length > 0) {
    return msg.parts.map((p: any) => ({
      ...p,
      sessionID: convId,
      messageID: msg.id,
    }));
  }
  if (msg.content) {
    return [
      {
        id: `${msg.id}-text`,
        sessionID: convId,
        messageID: msg.id,
        type: "text",
        text: msg.content,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Event queue — supports async iteration for the SSE consumer
// ---------------------------------------------------------------------------

function createEventQueue() {
  const buffer: any[] = [];
  let resolver: ((value: IteratorResult<any>) => void) | null = null;

  function push(event: any) {
    if (resolver) {
      const r = resolver;
      resolver = null;
      r({ value: event, done: false });
    } else {
      buffer.push(event);
    }
  }

  function subscribe(): { stream: AsyncIterable<any> } {
    const stream: AsyncIterable<any> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<any>> {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift()!, done: false });
            }
            return new Promise((resolve) => {
              resolver = resolve;
            });
          },
        };
      },
    };
    return { stream };
  }

  return { push, subscribe };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createPantheonAdapter(pantheonClient: PantheonClient) {
  const eventQueue = createEventQueue();
  // Active AbortController per session (for cancelling in-flight prompts)
  const activeAbort = new Map<string, AbortController>();

  // ── Live methods ────────────────────────────────────────────────────

  const global = {
    health: () => stub({ healthy: true, version: "pantheon" }),
  };

  const session = {
    list: async (_opts?: any) => {
      const convs = await pantheonClient.listConversations();
      return wrap(convs.map(convToSession));
    },

    create: async (opts?: any) => {
      console.log("[pantheon-adapter] session.create", opts);
      const conv = await pantheonClient.createConversation({
        title: opts?.body?.title ?? opts?.title ?? "New conversation",
      });
      console.log("[pantheon-adapter] session.created", conv.id);
      return wrap(convToSession(conv));
    },

    get: async (opts: any) => {
      const id = opts?.path?.id ?? opts?.sessionID ?? opts?.id;
      const conv = await pantheonClient.getConversation(id);
      return wrap(convToSession(conv));
    },

    update: async (opts: any) => {
      const id = opts?.path?.id ?? opts?.sessionID ?? opts?.id;
      const title = opts?.body?.title ?? opts?.title;
      const conv = await pantheonClient.updateConversation(id, { title });
      return wrap(convToSession(conv));
    },

    delete: async (opts: any) => {
      const id = opts?.path?.id ?? opts?.sessionID ?? opts?.id;
      await pantheonClient.deleteConversation(id);
      return wrap({});
    },

    messages: async (opts: any) => {
      const sessionID = opts?.path?.id ?? opts?.sessionID;
      const limit = opts?.query?.limit ?? opts?.limit ?? 100;
      const msgs = await pantheonClient.getMessages(sessionID, limit);

      const result = msgs.map((msg) => ({
        info: msgToSdkMessage(msg, sessionID),
        parts: msgPartsToSdkParts(msg, sessionID),
      }));
      return wrap(result);
    },

    prompt: async (opts: any) => {
      const sessionID = opts?.path?.id ?? opts?.sessionID;
      const parts = opts?.body?.parts ?? opts?.parts ?? [];
      const textPart = parts.find((p: any) => p.type === "text");
      const text = textPart?.text ?? "";
      const model = opts?.model?.modelID ?? opts?.body?.model?.modelID ?? undefined;

      console.log("[pantheon-adapter] prompt", { sessionID, text, model, optsKeys: Object.keys(opts ?? {}) });

      if (!sessionID) {
        console.error("[pantheon-adapter] prompt: no sessionID!", opts);
        return wrap({});
      }
      if (!text) {
        console.error("[pantheon-adapter] prompt: no text!", { parts });
        return wrap({});
      }

      // Push responding status before streaming begins
      eventQueue.push({
        type: "session.status",
        properties: { sessionID, status: { type: "busy" } },
      });

      // Set up abort controller for this session
      const abortController = new AbortController();
      activeAbort.set(sessionID, abortController);

      // Track IDs from the server (set when user_message / first part arrive)
      let userMsgId: string | null = null;
      let assistantMsgId: string | null = null;
      let assistantInfoEmitted = false;

      pantheonClient
        .sendMessageStreaming(sessionID, text, undefined, {
          model,
          signal: abortController.signal,
          onEvent: (evt: PantheonStreamEvent) => {
            // Server sends user_message with persisted MongoDB ID before streaming
            if (evt.type === "user_message") {
              userMsgId = (evt as any).message_id;
              eventQueue.push({
                type: "message.updated",
                properties: {
                  info: {
                    id: userMsgId,
                    sessionID,
                    role: "user",
                    time: { created: (evt as any).created_at ? new Date((evt as any).created_at).getTime() : Date.now() },
                  },
                },
              });
              eventQueue.push({
                type: "message.part.updated",
                properties: {
                  part: {
                    type: "text",
                    id: `${userMsgId}-text`,
                    sessionID,
                    messageID: userMsgId,
                    text,
                  },
                },
              });
              return;
            }

            if (evt.type === "part") {
              const serverMsgId = (evt as any).message_id;

              // Emit assistant message info on first part
              if (!assistantInfoEmitted) {
                assistantInfoEmitted = true;
                assistantMsgId = serverMsgId;
                eventQueue.push({
                  type: "message.updated",
                  properties: {
                    info: {
                      id: assistantMsgId,
                      sessionID,
                      role: "assistant",
                      parentID: userMsgId ?? "",
                      modelID: model ?? "",
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
                      time: { created: Date.now() },
                    },
                  },
                });
              }

              const part = {
                ...(evt as any).part,
                sessionID,
                messageID: assistantMsgId,
              };
              eventQueue.push({
                type: "message.part.updated",
                properties: { part },
              });
            } else if (evt.type === "done") {
              // Update assistant message ID to the persisted one from the server
              const persistedId = (evt as any).message_id;
              if (persistedId && assistantMsgId && persistedId !== assistantMsgId) {
                // Re-emit with the final persisted ID so it matches on reload
                eventQueue.push({
                  type: "message.updated",
                  properties: {
                    info: {
                      id: persistedId,
                      sessionID,
                      role: "assistant",
                      parentID: userMsgId ?? "",
                      modelID: model ?? "",
                      providerID: "",
                      mode: "",
                      agent: "",
                      path: { cwd: "", root: "" },
                      cost: 0,
                      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                      time: { created: Date.now() },
                    },
                  },
                });
              }
              activeAbort.delete(sessionID);
              eventQueue.push({
                type: "session.status",
                properties: { sessionID, status: { type: "idle" } },
              });
              eventQueue.push({
                type: "session.idle",
                properties: { sessionID },
              });
            } else if (evt.type === "error") {
              eventQueue.push({
                type: "session.error",
                properties: {
                  sessionID,
                  error: {
                    name: "UnknownError" as const,
                    data: { message: (evt as any).error },
                  },
                },
              });
            }
          },
        })
        .catch((err: any) => {
          activeAbort.delete(sessionID);
          // Don't emit error for intentional abort
          if (err?.name !== "AbortError") {
            eventQueue.push({
              type: "session.error",
              properties: {
                sessionID,
                error: {
                  name: "UnknownError" as const,
                  data: { message: err?.message ?? String(err) },
                },
              },
            });
          }
          eventQueue.push({
            type: "session.status",
            properties: { sessionID, status: { type: "idle" } },
          });
          eventQueue.push({
            type: "session.idle",
            properties: { sessionID },
          });
        });

      return wrap({});
    },

    promptAsync: async (opts: any) => {
      // Delegate to prompt — same fire-and-forget behavior
      return session.prompt(opts);
    },

    abort: async (opts?: any) => {
      const sessionID = opts?.sessionID ?? opts?.path?.id;
      if (sessionID) {
        const controller = activeAbort.get(sessionID);
        if (controller) {
          controller.abort();
          activeAbort.delete(sessionID);
        }
      }
      return wrap({});
    },
    todo: async () => wrap([]),
    revert: async () => wrap({}),
    unrevert: async () => wrap({}),
    shell: async () => wrap({}),
    command: async () => wrap({}),
    summarize: async () => wrap({}),
    diff: async () => wrap([]),
    fork: async () => wrap({}),
    share: async () => wrap({}),
    unshare: async () => wrap({}),
    children: async () => wrap([]),
    init: async () => wrap({}),
    status: async () => wrap({}),
    message: async () => wrap({}),
  };

  const event = {
    subscribe: async () => eventQueue.subscribe(),
  };

  // ── Stub namespaces ─────────────────────────────────────────────────

  const config = {
    get: () => stub({}),
    update: () => stub({}),
    providers: () => stub({}),
  };

  // ── Models available through Pantheon proxy ────────────────────────
  const pantheonProviders = [
    {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          release_date: "2025-08-27",
          attachment: true, reasoning: true, temperature: true, tool_call: true,
          cost: { input: 3, output: 15 },
          limit: { context: 1000000, output: 64000 },
        },
        "claude-opus-4-6": {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          release_date: "2025-08-27",
          attachment: true, reasoning: true, temperature: true, tool_call: true,
          cost: { input: 15, output: 75 },
          limit: { context: 1000000, output: 32000 },
        },
        "claude-haiku-4-5": {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          release_date: "2025-10-01",
          attachment: true, reasoning: false, temperature: true, tool_call: true,
          cost: { input: 0.8, output: 4 },
          limit: { context: 200000, output: 8192 },
        },
      },
    },
  ];

  const provider = {
    list: () => stub({
      all: pantheonProviders,
      connected: pantheonProviders.map((p) => p.id),
      default: { anthropic: "claude-sonnet-4-6" },
    }),
    auth: () => stub({}),
    oauth: {
      authorize: () => stub({}),
      callback: () => stub({}),
    },
  };

  const mcp = {
    status: () => stub({}),
    add: () => stub({}),
    connect: () => stub({}),
    disconnect: () => stub({}),
    auth: {
      start: () => stub({}),
      callback: () => stub({}),
      status: () => stub({}),
    },
  };

  const lsp = {
    status: () => stub([]),
  };

  const project = {
    list: () => stub([]),
    current: () => stub(null),
  };

  const vcs = {
    get: () => stub(null),
  };

  const command = {
    list: () => stub([]),
  };

  const permission = {
    list: () => stub([]),
    reply: () => stub({}),
  };

  const question = {
    list: () => stub([]),
    reply: () => stub({}),
    reject: () => stub({}),
  };

  const app = {
    agents: () => stub([]),
    log: () => stub([]),
    skills: () => stub([]),
  };

  const tool = {
    ids: () => stub([]),
    list: () => stub([]),
  };

  const file = {
    list: () => stub([]),
    read: () => stub({}),
    status: () => stub({}),
  };

  const find = {
    text: () => stub([]),
    files: () => stub([]),
    symbols: () => stub([]),
  };

  const instance = {
    dispose: () => stub({}),
  };

  const path = {
    get: () => stub({}),
  };

  const pty = {
    list: () => stub([]),
    create: () => stub({}),
    delete: () => stub({}),
    get: () => stub({}),
    update: () => stub({}),
    resize: () => stub({}),
    input: () => stub({}),
  };

  const formatter = {
    status: () => stub({}),
  };

  const tui = {
    navigate: () => stub({}),
    prompt: () => stub({}),
    toast: () => stub({}),
  };

  const auth = {
    status: () => stub({}),
    login: () => stub({}),
    logout: () => stub({}),
  };

  const part = {
    update: () => stub({}),
  };

  return {
    global,
    session,
    event,
    config,
    provider,
    mcp,
    lsp,
    project,
    vcs,
    command,
    permission,
    question,
    app,
    tool,
    file,
    find,
    instance,
    path,
    pty,
    formatter,
    tui,
    auth,
    part,
  } as any;
}

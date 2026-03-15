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
    mode: conv.mode,
    delegated_from: conv.delegated_from,
    delegated_to: conv.delegated_to,
    conv_status: conv.conv_status,
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

export function createPantheonAdapter(
  pantheonClient: PantheonClient,
  localOpenCodeClient?: any,
) {
  const eventQueue = createEventQueue();
  // Active AbortController per session (for cancelling in-flight prompts)
  const activeAbort = new Map<string, AbortController>();

  // Mode cache: populated from session.list/get, updated on handover
  const modeCache = new Map<string, "local" | "remote">();
  // Local session mapping: pantheonConvId → openCodeSessionId
  const localSessionMap = new Map<string, string>();

  // ── Live methods ────────────────────────────────────────────────────

  const global = {
    health: () => stub({ healthy: true, version: "pantheon" }),
  };

  const session = {
    list: async (_opts?: any) => {
      const convs = await pantheonClient.listConversations();
      for (const c of convs) modeCache.set(c.id, c.mode);
      return wrap(convs.map(convToSession));
    },

    create: async (opts?: any) => {
      console.log("[pantheon-adapter] session.create", opts);
      const mode = localOpenCodeClient ? "local" : "remote";
      const conv = await pantheonClient.createConversation({
        title: opts?.body?.title ?? opts?.title ?? "New conversation",
        mode,
      });
      modeCache.set(conv.id, conv.mode);
      console.log("[pantheon-adapter] session.created", conv.id, "mode:", conv.mode);
      return wrap(convToSession(conv));
    },

    get: async (opts: any) => {
      const id = opts?.path?.id ?? opts?.sessionID ?? opts?.id;
      const conv = await pantheonClient.getConversation(id);
      modeCache.set(conv.id, conv.mode);
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

      const mode = modeCache.get(sessionID) ?? "remote";

      if (mode === "local" && localOpenCodeClient) {
        return localPrompt(sessionID, text, model, parts);
      }

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

      // Track IDs from the server (MongoDB ObjectIDs for both user + assistant)
      let userMsgId: string | null = null;
      let assistantMsgId: string | null = null;

      pantheonClient
        .sendMessageStreaming(sessionID, text, undefined, {
          model,
          signal: abortController.signal,
          onEvent: (evt: PantheonStreamEvent) => {
            // Server sends user_message with persisted MongoDB ID
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

            // Server sends assistant_message with pre-created MongoDB ID
            if ((evt as any).type === "assistant_message") {
              assistantMsgId = (evt as any).message_id;
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
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    time: { created: Date.now() },
                  },
                },
              });
              return;
            }

            if (evt.type === "part") {
              const part = {
                ...(evt as any).part,
                sessionID,
                messageID: assistantMsgId ?? (evt as any).message_id,
              };
              eventQueue.push({
                type: "message.part.updated",
                properties: { part },
              });
            } else if (evt.type === "done") {
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
        // Also abort local OpenCode session if in local mode
        const mode = modeCache.get(sessionID);
        if (mode === "local" && localOpenCodeClient) {
          const localSessionId = localSessionMap.get(sessionID);
          if (localSessionId) {
            await localOpenCodeClient.session.abort({ path: { id: localSessionId } }).catch(() => {});
          }
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

  // ── Local prompt handler ──────────────────────────────────────────

  async function localPrompt(sessionID: string, text: string, model: string | undefined, parts: any[]) {
    // 1. Push busy status
    eventQueue.push({
      type: "session.status",
      properties: { sessionID, status: { type: "busy" } },
    });

    // 2. POST user message to Pantheon for persistence (local ack)
    try {
      await pantheonClient.sendMessageStreaming(sessionID, text, undefined, {
        model,
        onEvent: (evt: any) => {
          if (evt.type === "user_message") {
            eventQueue.push({
              type: "message.updated",
              properties: {
                info: {
                  id: evt.message_id,
                  sessionID,
                  role: "user",
                  time: { created: evt.created_at || new Date().toISOString(), updated: evt.created_at || new Date().toISOString() },
                },
              },
            });
            eventQueue.push({
              type: "message.part.updated",
              properties: {
                part: { type: "text", id: `${evt.message_id}-text`, sessionID, messageID: evt.message_id, text },
              },
            });
          }
        },
      });
    } catch (e) {
      console.error("Failed to persist user message to Pantheon:", e);
    }

    // 3. Ensure local OpenCode session exists
    let localSessionId = localSessionMap.get(sessionID);
    if (!localSessionId) {
      const sess = await localOpenCodeClient!.session.create({ body: { directory: "" } });
      localSessionId = sess.data?.id ?? sess.id;
      localSessionMap.set(sessionID, localSessionId!);
    }

    // 4. Generate message_key for Pantheon persistence
    const messageKey = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 5. Create abort controller
    const abortController = new AbortController();
    activeAbort.set(sessionID, abortController);

    // 6. Send prompt to local OpenCode
    try {
      const promptBody: any = { parts: [{ type: "text", text }] };
      if (model) promptBody.model = { modelID: model, providerID: "anthropic" };

      await localOpenCodeClient!.session.prompt({
        path: { id: localSessionId },
        body: promptBody,
      });
    } catch (_e) {
      // prompt() may return immediately while streaming continues
    }

    // 7. Subscribe to local OpenCode events and mirror to Pantheon
    try {
      const sub = await localOpenCodeClient!.event.subscribe(localSessionId);
      const stream = sub.stream ?? sub.data?.stream ?? sub;

      for await (const event of stream) {
        if (abortController.signal.aborted) break;

        if (event.type === "message.updated" && event.properties?.info?.role === "assistant") {
          eventQueue.push({
            type: "message.updated",
            properties: {
              info: { ...event.properties.info, sessionID },
            },
          });
        }

        if (event.type === "message.part.updated") {
          const part = { ...event.properties.part, sessionID };
          eventQueue.push({ type: "message.part.updated", properties: { part } });
          // Mirror to Pantheon (fire-and-forget)
          pantheonClient.postLocalPartEvent(sessionID, {
            message_key: messageKey,
            part_id: part.id,
            part: { type: part.type, id: part.id, text: part.text ?? "" },
            is_final: false,
          }).catch(() => {});
        }

        if (event.type === "session.idle" || event.type === "session.status") {
          if (event.type === "session.idle" || event.properties?.status?.type === "idle") {
            activeAbort.delete(sessionID);
            // Mark final in Pantheon
            pantheonClient.postLocalPartEvent(sessionID, {
              message_key: messageKey,
              part_id: "__final__",
              part: { type: "text", id: "__final__", text: "" },
              is_final: true,
            }).catch(() => {});
            eventQueue.push({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
            eventQueue.push({ type: "session.idle", properties: { sessionID } });
            break;
          }
        }
      }
    } catch (e) {
      console.error("Local OpenCode event stream error:", e);
      activeAbort.delete(sessionID);
      eventQueue.push({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    }

    return wrap({});
  }

  // ── Handover (switch local ↔ remote) ────────────────────────────

  async function handover(sessionID: string, mode: "local" | "remote") {
    // 1. Abort any in-flight stream
    const controller = activeAbort.get(sessionID);
    if (controller) {
      controller.abort();
      activeAbort.delete(sessionID);
    }

    // 2. Call Pantheon handover endpoint
    const updated = await pantheonClient.handoverConversation(sessionID, mode);
    modeCache.set(sessionID, updated.mode);

    // 3. If switching away from local, clear local session
    if (mode === "remote") {
      localSessionMap.delete(sessionID);
    }

    // 4. Emit mode change event
    eventQueue.push({
      type: "session.updated",
      properties: { sessionID, mode: updated.mode },
    });

    return updated;
  }

  // ── Delegate (fork conversation to another pixie) ───────────────

  async function delegate(sessionID: string, mode: "local" | "remote", pixieId?: string) {
    // 1. Abort any in-flight stream
    const controller = activeAbort.get(sessionID);
    if (controller) {
      controller.abort();
      activeAbort.delete(sessionID);
    }

    // 2. Call delegate endpoint
    const result = await pantheonClient.delegateConversation(sessionID, mode, pixieId);

    // 3. Update mode cache for both conversations
    modeCache.set(sessionID, result.source.mode);
    modeCache.set(result.delegate.id, result.delegate.mode);

    // 4. Clear local session if delegating away
    if (mode === "remote") {
      localSessionMap.delete(sessionID);
    }

    // 5. Emit delegation event
    eventQueue.push({
      type: "session.delegated",
      properties: {
        sourceSessionID: sessionID,
        delegateSessionID: result.delegate.id,
        mode: result.delegate.mode,
      },
    });

    // 6. If taking back locally, try to reconstruct the local session
    if (mode === "local" && localOpenCodeClient && result.delegate.id) {
      resumeDelegatedSession(result.delegate.id).catch((e) =>
        console.warn("[adapter] session reconstruction on take-back failed:", e),
      );
    }

    return result;
  }

  // ── Resume delegated session (local take-back reconstruction) ──────

  async function resumeDelegatedSession(sessionID: string): Promise<boolean> {
    try {
      const ctx = await pantheonClient.getDelegationContext(sessionID);
      if (ctx?.mode === "session_copy" && ctx.session_messages?.length && localOpenCodeClient) {
        // Build a primer from the session messages and send as first prompt
        // to the local OpenCode engine so it has full context.
        const lines: string[] = [];
        for (const msg of ctx.session_messages) {
          const prefix = msg.role === "user" ? "User" : "Assistant";
          const text = msg.content || "";
          lines.push(`${prefix}: ${text.slice(0, 2000)}`);
        }
        const primer =
          "[Delegation — continuing from previous session]\n\n" +
          lines.join("\n\n") +
          "\n\n---\n" +
          "Continue this task. You have full access to the project. " +
          "Work autonomously and complete what was discussed above.";

        // Ensure local OpenCode session exists
        let localSessionId = localSessionMap.get(sessionID);
        if (!localSessionId) {
          const createResult = await localOpenCodeClient.session.create({
            body: {},
          });
          localSessionId = createResult?.data?.id;
          if (localSessionId) localSessionMap.set(sessionID, localSessionId);
        }

        if (localSessionId) {
          await localOpenCodeClient.session.prompt({
            path: { id: localSessionId },
            body: { parts: [{ type: "text", text: primer }] },
          });
          return true;
        }
      }
    } catch (e) {
      console.warn("[adapter] resumeDelegatedSession failed:", e);
    }
    return false;
  }

  const client = {
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

  return { client, handover, delegate };
}

/**
 * PantheonSDKProvider — replaces ServerProvider + GlobalSDKProvider + GlobalSyncProvider
 * when running in Pantheon mode.
 *
 * Provides values into the SAME context objects so that useServer(), useGlobalSDK(),
 * and useGlobalSync() work identically from downstream consumers.
 */

import {
  createEffect,
  createSignal,
  type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { createGlobalEmitter } from "@solid-primitives/event-bus";
import type { Event } from "@opencode-ai/sdk/v2/client";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import {
  createPantheonClient,
} from "../lib/pantheon-client";
import { createPantheonAdapter } from "../lib/pantheon-adapter";

import { ServerContext } from "./server";
import { GlobalSDKContext } from "./global-sdk";
import { GlobalSyncContext, type GlobalState, type WorkspaceState } from "./global-sync";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const PANTHEON_BASE_URL =
  typeof import.meta.env?.VITE_OPENWORK_URL === "string"
    ? import.meta.env.VITE_OPENWORK_URL.trim()
    : "";

export function PantheonSDKProvider(props: ParentProps) {
  const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined);
  const [loginState, setLoginState] = createSignal<"pending" | "ok" | "error">("pending");
  const [loginError, setLoginError] = createSignal("");

  const client = createPantheonClient(PANTHEON_BASE_URL);
  const emitter = createGlobalEmitter<{ [key: string]: Event }>();

  // Adapter client (set after login)
  const [adapterClient, setAdapterClient] = createSignal<ReturnType<typeof createOpencodeClient>>(
    createOpencodeClient({ baseUrl: "about:blank" }),
  );

  // Auto-login on mount
  createEffect(() => {
    if (loginState() !== "pending") return;

    (async () => {
      try {
        if (client.isLoggedIn()) {
          await client.me();
        } else {
          await client.loginLocalhost();
        }

        const adapter = createPantheonAdapter(client);
        setAdapterClient(adapter as any);
        setHealthy(true);
        setLoginState("ok");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[pantheon-sdk] login failed:", msg);
        setLoginError(msg);
        setLoginState("error");
        setHealthy(false);
      }
    })();
  });

  // ── Server context value ────────────────────────────────────────────

  const serverValue = {
    get url() {
      return PANTHEON_BASE_URL;
    },
    get name() {
      return PANTHEON_BASE_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    },
    get list() {
      return [PANTHEON_BASE_URL];
    },
    healthy,
    setActive: () => {},
    add: () => {},
    remove: () => {},
  };

  // ── GlobalSDK context value ─────────────────────────────────────────

  const sdkValue = {
    url: () => PANTHEON_BASE_URL,
    client: adapterClient as () => ReturnType<typeof createOpencodeClient>,
    event: emitter,
  };

  // ── GlobalSync context value ────────────────────────────────────────

  const [globalStore, setGlobalStore] = createStore<GlobalState>({
    ready: false,
    error: undefined,
    serverVersion: "pantheon",
    config: {},
    provider: { all: [], connected: [], default: {} },
    providerAuth: {},
    mcp: {},
    lsp: {},
    project: [],
    projectMeta: {},
    vcs: {},
  });

  const children = new Map<string, ReturnType<typeof createStore<WorkspaceState>>>();

  const child = (directory: string) => {
    const key = directory || "global";
    const existing = children.get(key);
    if (existing) return existing;
    const store = createStore<WorkspaceState>({
      status: "idle",
      session: [],
      session_status: {},
      message: {},
      part: {},
      todo: {},
    });
    children.set(key, store);
    return store;
  };

  const refresh = async () => {
    setGlobalStore("ready", true);
  };

  const refreshDirectory = async (_directory: string) => {};

  // Populate provider data and mark ready once login succeeds
  createEffect(() => {
    if (loginState() === "ok") {
      // Load provider list from adapter to populate model picker
      const c = adapterClient();
      if (c) {
        (c as any).provider.list().then((result: any) => {
          if (result?.data) {
            setGlobalStore("provider", result.data);
          }
        });
      }
      setGlobalStore("ready", true);
    }
  });

  const syncValue = {
    data: globalStore,
    set: setGlobalStore,
    child,
    refresh,
    refreshDirectory,
  };

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <ServerContext.Provider value={serverValue}>
      <GlobalSDKContext.Provider value={sdkValue}>
        <GlobalSyncContext.Provider value={syncValue}>
          {loginState() === "pending" && (
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888">
              Connecting to Pantheon...
            </div>
          )}
          {loginState() === "error" && (
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#f66">
              Login failed: {loginError()}
            </div>
          )}
          {loginState() === "ok" && props.children}
        </GlobalSyncContext.Provider>
      </GlobalSDKContext.Provider>
    </ServerContext.Provider>
  );
}

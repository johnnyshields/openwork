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

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

  // OIDC login flow
  let loginInFlight = false;
  createEffect(() => {
    if (loginState() !== "pending") return;

    (async () => {
      if (loginInFlight) return;
      loginInFlight = true;

      try {
        // Step 1: Check if we're on the auth callback with a code
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        if (code && returnedState && url.pathname === "/auth/callback") {
          // Validate state to prevent CSRF
          const savedState = sessionStorage.getItem("pantheon.oidc.state");
          if (!savedState || savedState !== returnedState) {
            throw new Error("Invalid OIDC state parameter — possible CSRF attack");
          }
          sessionStorage.removeItem("pantheon.oidc.state");

          const redirectUri = `${window.location.origin}/auth/callback`;
          const codeVerifier = sessionStorage.getItem("pantheon.oidc.code_verifier") || "";
          const result = await client.exchangeCode(code, redirectUri, codeVerifier);
          sessionStorage.removeItem("pantheon.oidc.code_verifier");

          // Validate nonce in id_token
          const savedNonce = sessionStorage.getItem("pantheon.oidc.nonce");
          if (savedNonce && result.id_token) {
            const payload = JSON.parse(atob(result.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
            if (payload.nonce !== savedNonce) {
              throw new Error("Invalid nonce in ID token — possible replay attack");
            }
          }
          sessionStorage.removeItem("pantheon.oidc.nonce");

          // Clean the URL
          window.history.replaceState({}, "", "/");
        }

        // Step 2: Check if we have a valid token
        let authenticated = false;
        if (client.isLoggedIn()) {
          try {
            await client.me();
            authenticated = true;
          } catch {
            console.log("[pantheon-sdk] stored token invalid, redirecting to login");
            client.clearToken();
          }
        }

        // Step 3: If not authenticated, redirect to Pantheon authorize endpoint
        if (!authenticated) {
          if (!PANTHEON_BASE_URL) {
            throw new Error("VITE_OPENWORK_URL not configured — cannot redirect to Pantheon login");
          }

          const state = crypto.randomUUID();
          const nonce = crypto.randomUUID();
          sessionStorage.setItem("pantheon.oidc.state", state);
          sessionStorage.setItem("pantheon.oidc.nonce", nonce);

          const codeVerifier = generateCodeVerifier();
          const codeChallenge = await generateCodeChallenge(codeVerifier);
          sessionStorage.setItem("pantheon.oidc.code_verifier", codeVerifier);

          const redirectUri = `${window.location.origin}/auth/callback`;
          const params = new URLSearchParams({
            client_id: "openwork",
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "openid profile email",
            state,
            nonce,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
          });

          window.location.href = `${PANTHEON_BASE_URL}/oauth/authorize?${params}`;
          return; // page will navigate away
        }

        const adapter = createPantheonAdapter(client);
        setAdapterClient(adapter as any);
        setHealthy(true);
        setLoginState("ok");
      } catch (e) {
        loginInFlight = false;
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
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px">
              <div style="color:#f66">Login failed: {loginError()}</div>
              <button
                style="padding:8px 16px;border-radius:6px;background:#333;color:#fff;border:none;cursor:pointer"
                onClick={() => {
                  client.clearToken();
                  setLoginError("");
                  // Re-trigger OIDC redirect
                  setLoginState("pending");
                }}
              >
                Retry login
              </button>
            </div>
          )}
          {loginState() === "ok" && props.children}
        </GlobalSyncContext.Provider>
      </GlobalSDKContext.Provider>
    </ServerContext.Provider>
  );
}

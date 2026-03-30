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
  Show,
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

type HandoverFn = (sessionID: string, mode: "local" | "remote") => Promise<any>;
const [pantheonHandover, setPantheonHandover] = createSignal<HandoverFn | null>(null);
export { pantheonHandover };

type DelegateFn = (sessionID: string, mode: "local" | "remote", pixieId?: string) => Promise<any>;
const [pantheonDelegate, setPantheonDelegate] = createSignal<DelegateFn | null>(null);
export { pantheonDelegate };

// Expose PantheonClient for delegation orchestration (workspace + container lifecycle)
const [pantheonClientRef, setPantheonClientRef] = createSignal<ReturnType<typeof createPantheonClient> | null>(null);
export { pantheonClientRef };

// Expose setConvPhase for delegation progress (set from app.tsx after navigating to delegate conv)
type SetConvPhaseFn = (convId: string, update: Partial<{ sending: boolean; delegating: boolean; receivedPart: boolean; receivedText: boolean }>) => void;
const [pantheonSetConvPhase, setPantheonSetConvPhase] = createSignal<SetConvPhaseFn | null>(null);
export { pantheonSetConvPhase, setPantheonSetConvPhase };

// Expose completedDelegations for notification system (set from PantheonProvider)
type CompletedDelegation = { id: string; title: string };
const [pantheonCompletedDelegations, setPantheonCompletedDelegations] = createSignal<CompletedDelegation[]>([]);
const [pantheonClearCompletedDelegation, setPantheonClearCompletedDelegation] = createSignal<((id: string) => void) | null>(null);
export { pantheonCompletedDelegations, setPantheonCompletedDelegations, pantheonClearCompletedDelegation, setPantheonClearCompletedDelegation };

// Watch mode signals
import type { MessageWithParts } from "../types";
type SetWatchFn = (id: string | null) => void;
const [pantheonSetWatchedConversation, setPantheonSetWatchedConversation] = createSignal<SetWatchFn | null>(null);
const [pantheonWatchedMessages, setPantheonWatchedMessages] = createSignal<MessageWithParts[]>([]);
export { pantheonSetWatchedConversation, setPantheonSetWatchedConversation, pantheonWatchedMessages, setPantheonWatchedMessages };

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

  // ── Handle popup callback (this page is the popup) ──────────────────
  // If we're the popup landing on /auth/callback, exchange code and
  // notify the parent window, then close ourselves.
  const isCallback = (() => {
    const url = new URL(window.location.href);
    return url.pathname === "/auth/callback" && url.searchParams.has("code");
  })();

  if (isCallback) {
    (async () => {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code")!;
        const returnedState = url.searchParams.get("state");

        const savedState = localStorage.getItem("pantheon.oidc.state");
        console.log("[pantheon-oidc] callback", { code: code?.slice(0, 8), returnedState, savedState, match: savedState === returnedState });
        if (!savedState || !returnedState || savedState !== returnedState) {
          throw new Error(`Invalid OIDC state: saved=${savedState?.slice(0,8)} returned=${returnedState?.slice(0,8)}`);
        }
        localStorage.removeItem("pantheon.oidc.state");

        const redirectUri = `${window.location.origin}/auth/callback`;
        const codeVerifier = localStorage.getItem("pantheon.oidc.code_verifier") || "";
        const result = await client.exchangeCode(code, redirectUri, codeVerifier);
        localStorage.removeItem("pantheon.oidc.code_verifier");

        // Validate nonce
        const savedNonce = localStorage.getItem("pantheon.oidc.nonce");
        if (savedNonce && result.id_token) {
          const payload = JSON.parse(atob(result.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          if (payload.nonce !== savedNonce) {
            throw new Error("Invalid nonce in ID token");
          }
        }
        localStorage.removeItem("pantheon.oidc.nonce");

        // Signal success: write a flag that the parent can detect via storage event,
        // then close. window.opener may be null after cross-origin redirects.
        localStorage.setItem("pantheon.oidc.complete", Date.now().toString());
        if (window.opener) {
          window.opener.postMessage({ type: "pantheon-oidc-success" }, window.location.origin);
        }
        window.close();
        // If window.close() is blocked (some browsers), redirect to root
        setTimeout(() => { window.location.replace("/"); }, 500);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        localStorage.setItem("pantheon.oidc.error", msg);
        if (window.opener) {
          window.opener.postMessage({ type: "pantheon-oidc-error", error: msg }, window.location.origin);
        }
        window.close();
        setTimeout(() => { window.location.replace("/"); }, 500);
      }
    })();
    // Render nothing while callback processes
  }

  // ── Main login flow ─────────────────────────────────────────────────

  function completeLogin() {
    const { client: adapter, handover, delegate } = createPantheonAdapter(client);
    setAdapterClient(adapter as any);
    setPantheonHandover(() => handover);
    setPantheonDelegate(() => delegate);
    setPantheonClientRef(client);
    setHealthy(true);
    setLoginState("ok");
  }

  // Check for existing valid token on mount
  let loginInFlight = false;
  createEffect(() => {
    if (loginState() !== "pending") return;
    if (isCallback) return; // popup handles its own flow

    (async () => {
      if (loginInFlight) return;
      loginInFlight = true;

      try {
        if (client.isLoggedIn()) {
          try {
            await client.me();
            completeLogin();
            return;
          } catch {
            console.log("[pantheon-sdk] stored token invalid");
            client.clearToken();
          }
        }
        // Try localhost login first (works when PANTHEON_LOCALHOST_MODE=true)
        try {
          console.warn("[pantheon-sdk] trying localhost login...");
          const result = await client.loginLocalhost();
          console.warn("[pantheon-sdk] localhost login result:", result.token ? "got token" : "no token", "user:", result.user?.username);
          if (result.token) {
            console.warn("[pantheon-sdk] login success, completing login");
            completeLogin();
            return;
          }
        } catch (e) {
          console.warn("[pantheon-sdk] localhost login failed:", e, "— falling through to OIDC");
          // Not in localhost mode — fall through to OIDC
        }
        // No valid token — show login UI (not a redirect)
        console.warn("[pantheon-sdk] no valid token, showing login UI");
        setLoginState("needs-login" as any);
      } catch (e) {
        loginInFlight = false;
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[pantheon-sdk] auth check failed:", msg);
        setLoginError(msg);
        setLoginState("error");
        setHealthy(false);
      }
    })();
  });

  // Listen for popup completion via postMessage or localStorage storage event.
  // storage event fires when another window (the popup) writes to localStorage.
  if (typeof window !== "undefined") {
    const handlePopupDone = () => {
      loginInFlight = false;
      setLoginState("pending"); // re-trigger token check
    };

    window.addEventListener("message", (evt) => {
      if (evt.origin !== window.location.origin) return;
      if (evt.data?.type === "pantheon-oidc-success") handlePopupDone();
      else if (evt.data?.type === "pantheon-oidc-error") {
        setLoginError(evt.data.error || "Login failed");
        setLoginState("error");
      }
    });

    window.addEventListener("storage", (evt) => {
      if (evt.key === "pantheon.oidc.complete" && evt.newValue) {
        localStorage.removeItem("pantheon.oidc.complete");
        handlePopupDone();
      } else if (evt.key === "pantheon.oidc.error" && evt.newValue) {
        const msg = evt.newValue;
        localStorage.removeItem("pantheon.oidc.error");
        setLoginError(msg);
        setLoginState("error");
      }
    });
  }

  // Open OIDC popup
  function openLoginPopup() {
    if (!PANTHEON_BASE_URL) {
      setLoginError("VITE_OPENWORK_URL not configured");
      setLoginState("error");
      return;
    }

    // Open popup immediately (before any async work) to preserve user gesture
    const w = 500, h = 600;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open("about:blank", "pantheon-login", `width=${w},height=${h},left=${left},top=${top}`);

    // Generate PKCE and navigate popup (async, but popup already open)
    (async () => {
      const state = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      localStorage.setItem("pantheon.oidc.state", state);
      localStorage.setItem("pantheon.oidc.nonce", nonce);

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      localStorage.setItem("pantheon.oidc.code_verifier", codeVerifier);

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

      const popupUrl = `${PANTHEON_BASE_URL}/oauth/authorize?${params}`;
      if (popup) {
        popup.location.href = popupUrl;
      } else {
        // Popup was blocked — fall back to redirect
        window.location.href = popupUrl;
      }
    })();

    // Poll for completion — most reliable cross-window detection.
    // The popup's exchangeCode() stores the token in localStorage (pantheon.jwt).
    // We also check pantheon.oidc.complete flag and popup closed state.
    const poll = setInterval(() => {
      // Check if popup wrote the completion flag or token appeared
      const complete = localStorage.getItem("pantheon.oidc.complete");
      const hasToken = client.isLoggedIn();
      const popupClosed = !popup || popup.closed;

      if (complete || (hasToken && popupClosed)) {
        clearInterval(poll);
        localStorage.removeItem("pantheon.oidc.complete");
        loginInFlight = false;
        setLoginState("pending"); // re-trigger token check
      } else if (popupClosed && !hasToken) {
        // Popup closed without completing login
        clearInterval(poll);
      }
    }, 500);
  }

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
          <Show when={loginState() === "pending"}>
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888">
              Connecting to Pantheon...
            </div>
          </Show>
          <Show when={(loginState() as string) === "needs-login"}>
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px">
              <div style="color:#aaa;font-size:14px">Sign in to continue</div>
              <button
                style="padding:10px 24px;border-radius:8px;background:#4f46e5;color:#fff;border:none;cursor:pointer;font-size:15px;font-weight:500"
                onClick={() => openLoginPopup()}
              >
                Sign in with Pantheon
              </button>
            </div>
          </Show>
          <Show when={loginState() === "error"}>
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px">
              <div style="color:#f66">Login failed: {loginError()}</div>
              <button
                style="padding:8px 16px;border-radius:6px;background:#333;color:#fff;border:none;cursor:pointer"
                onClick={() => {
                  client.clearToken();
                  setLoginError("");
                  openLoginPopup();
                }}
              >
                Retry login
              </button>
            </div>
          </Show>
          <Show when={loginState() === "ok"}>
            {props.children}
          </Show>
        </GlobalSyncContext.Provider>
      </GlobalSDKContext.Provider>
    </ServerContext.Provider>
  );
}

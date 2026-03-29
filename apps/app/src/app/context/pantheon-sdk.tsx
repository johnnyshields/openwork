/**
 * PantheonSDKProvider — replaces ServerProvider + GlobalSDKProvider + GlobalSyncProvider
 * when running in Pantheon mode.
 *
 * This commit covers login only: localhost auto-login, OIDC popup with PKCE,
 * and token management. The adapter/conversations layer is added separately.
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

import { createPantheonClient } from "../lib/pantheon-client";

import { ServerContext } from "./server";
import { GlobalSDKContext } from "./global-sdk";
import { GlobalSyncContext, type GlobalState, type WorkspaceState } from "./global-sync";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANTHEON_BASE_URL =
  typeof import.meta.env?.VITE_OPENWORK_URL === "string"
    ? import.meta.env.VITE_OPENWORK_URL.trim()
    : "";

/** Detect Pantheon mode (VITE_OPENWORK_URL is set). */
export const isPantheonMode = () => PANTHEON_BASE_URL.length > 0;

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function PantheonSDKProvider(props: ParentProps) {
  const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined);
  const [loginState, setLoginState] = createSignal<"pending" | "ok" | "error">("pending");
  const [loginError, setLoginError] = createSignal("");

  const client = createPantheonClient(PANTHEON_BASE_URL);
  const emitter = createGlobalEmitter<{ [key: string]: Event }>();

  // Stub client — enough for the app to render after login.
  // The real adapter (conversations, streaming) is added in a later commit.
  const stubClient = createOpencodeClient({ baseUrl: "about:blank" });

  // ── Handle popup callback (this page is the popup) ──────────────────

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

        // Signal success to parent window
        localStorage.setItem("pantheon.oidc.complete", Date.now().toString());
        if (window.opener) {
          window.opener.postMessage({ type: "pantheon-oidc-success" }, window.location.origin);
        }
        window.close();
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
  }

  // ── Login flow ──────────────────────────────────────────────────────

  function completeLogin() {
    setHealthy(true);
    setLoginState("ok");
  }

  let loginInFlight = false;
  createEffect(() => {
    if (loginState() !== "pending") return;
    if (isCallback) return;

    (async () => {
      if (loginInFlight) return;
      loginInFlight = true;

      try {
        // Check existing token
        if (client.isLoggedIn()) {
          try {
            await client.me();
            completeLogin();
            return;
          } catch {
            client.clearToken();
          }
        }
        // Try localhost login (PANTHEON_LOCALHOST_MODE=true)
        try {
          const result = await client.loginLocalhost();
          if (result.token) {
            completeLogin();
            return;
          }
        } catch {
          // Fall through to OIDC
        }
        setLoginState("needs-login" as any);
      } catch (e) {
        loginInFlight = false;
        const msg = e instanceof Error ? e.message : String(e);
        setLoginError(msg);
        setLoginState("error");
        setHealthy(false);
      }
    })();
  });

  // ── Listen for popup completion ─────────────────────────────────────

  if (typeof window !== "undefined") {
    const handlePopupDone = () => {
      loginInFlight = false;
      setLoginState("pending");
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
        localStorage.removeItem("pantheon.oidc.error");
        setLoginError(evt.newValue);
        setLoginState("error");
      }
    });
  }

  // ── OIDC popup ──────────────────────────────────────────────────────

  function openLoginPopup() {
    if (!PANTHEON_BASE_URL) {
      setLoginError("VITE_OPENWORK_URL not configured");
      setLoginState("error");
      return;
    }

    const w = 500, h = 600;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open("about:blank", "pantheon-login", `width=${w},height=${h},left=${left},top=${top}`);

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
        window.location.href = popupUrl;
      }
    })();

    const poll = setInterval(() => {
      const complete = localStorage.getItem("pantheon.oidc.complete");
      const hasToken = client.isLoggedIn();
      const popupClosed = !popup || popup.closed;

      if (complete || (hasToken && popupClosed)) {
        clearInterval(poll);
        localStorage.removeItem("pantheon.oidc.complete");
        loginInFlight = false;
        setLoginState("pending");
      } else if (popupClosed && !hasToken) {
        clearInterval(poll);
      }
    }, 500);
  }

  // ── Context values ──────────────────────────────────────────────────

  const serverValue = {
    get url() { return PANTHEON_BASE_URL; },
    get name() { return PANTHEON_BASE_URL.replace(/^https?:\/\//, "").replace(/\/+$/, ""); },
    get list() { return [PANTHEON_BASE_URL]; },
    healthy,
    setActive: () => {},
    add: () => {},
    remove: () => {},
  };

  const sdkValue = {
    url: () => PANTHEON_BASE_URL,
    client: () => stubClient,
    event: emitter,
  };

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

  createEffect(() => {
    if (loginState() === "ok") {
      setGlobalStore("ready", true);
    }
  });

  const syncValue = {
    data: globalStore,
    set: setGlobalStore,
    child,
    refresh: async () => { setGlobalStore("ready", true); },
    refreshDirectory: async (_directory: string) => {},
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
          {(loginState() as string) === "needs-login" && (
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px">
              <div style="color:#aaa;font-size:14px">Sign in to continue</div>
              <button
                style="padding:10px 24px;border-radius:8px;background:#4f46e5;color:#fff;border:none;cursor:pointer;font-size:15px;font-weight:500"
                onClick={() => openLoginPopup()}
              >
                Sign in with Pantheon
              </button>
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
                  openLoginPopup();
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

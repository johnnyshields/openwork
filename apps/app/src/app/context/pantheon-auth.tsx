// BEGIN-PANTHEON-OVERRIDE — OIDC login gate for Pantheon authentication
import { createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js";
import { pantheonBaseUrl, isTauriRuntime } from "../utils";

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(buffer: Uint8Array): string {
  const str = btoa(String.fromCharCode(...buffer));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Fetch wrapper — use Tauri plugin-http when in Tauri, else globalThis.fetch
// ---------------------------------------------------------------------------

async function authFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const merged = { ...init, signal: controller.signal };
  try {
    if (isTauriRuntime()) {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      return await tauriFetch(input, merged);
    }
    return await globalThis.fetch(input, merged);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// PantheonAuthGate
// ---------------------------------------------------------------------------

export function PantheonAuthGate(props: ParentProps) {
  const [authenticated, setAuthenticated] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  let eventCleanup: (() => void) | undefined;
  onCleanup(() => eventCleanup?.());

  // Try to restore an existing session on mount
  onMount(async () => {
    const base = pantheonBaseUrl();
    console.log("[pantheon-auth] mount, base =", base);

    // Validate existing token against Pantheon before trusting it
    const existing = localStorage.getItem("pantheon.jwt");
    console.log("[pantheon-auth] existing jwt?", !!existing);
    if (existing) {
      try {
        console.log("[pantheon-auth] validating token via /backend/me");
        const res = await authFetch(`${base}/backend/me`, {
          headers: { Authorization: `Bearer ${existing}` },
        });
        console.log("[pantheon-auth] /backend/me status:", res.status);
        if (res.ok) {
          setAuthenticated(true);
          setLoading(false);
          return;
        }
      } catch (err) {
        console.log("[pantheon-auth] validation failed:", err);
      }
      localStorage.removeItem("pantheon.jwt");
      localStorage.removeItem("openwork.server.token");
    }

    console.log("[pantheon-auth] showing login screen");
    setLoading(false);
  });

  // ------------------------------------------------------------------
  // Token exchange (shared by Tauri event and web popup flows)
  // ------------------------------------------------------------------

  async function exchangeCodeForToken(code: string, state: string) {
    const base = pantheonBaseUrl();
    const savedState = sessionStorage.getItem("pantheon.oidc.state");
    if (state !== savedState) {
      console.log("[pantheon-auth] state mismatch:", { received: state, expected: savedState });
      setError("Authentication failed: state mismatch.");
      setLoading(false);
      return;
    }

    const savedVerifier = sessionStorage.getItem("pantheon.oidc.code_verifier")!;
    const redirectUri = `${base}/oauth/callback`;

    try {
      console.log("[pantheon-auth] exchanging code for token");
      const tokenRes = await authFetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: "openwork",
          code_verifier: savedVerifier,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const detail = await tokenRes.text().catch(() => "");
        throw new Error(`Token exchange failed (${tokenRes.status}): ${detail}`);
      }

      const tokenData = (await tokenRes.json()) as { access_token: string };
      localStorage.setItem("pantheon.jwt", tokenData.access_token);
      localStorage.setItem("openwork.server.token", tokenData.access_token);
      console.log("[pantheon-auth] login success");
      setAuthenticated(true);
    } catch (err: any) {
      console.log("[pantheon-auth] token exchange failed:", err);
      setError(err?.message ?? "Token exchange failed");
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------------
  // OIDC PKCE login flow
  // ------------------------------------------------------------------

  async function handleLogin() {
    setError(null);
    setLoading(true);

    try {
      const base = pantheonBaseUrl();
      const codeVerifier = generateRandomString(32);
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateRandomString(16);
      const nonce = generateRandomString(16);

      sessionStorage.setItem("pantheon.oidc.state", state);
      sessionStorage.setItem("pantheon.oidc.nonce", nonce);
      sessionStorage.setItem("pantheon.oidc.code_verifier", codeVerifier);

      const redirectUri = `${base}/oauth/callback`;

      const authUrl =
        `${base}/oauth/authorize?` +
        `client_id=openwork&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `response_type=code&` +
        `scope=${encodeURIComponent("openid profile email")}&` +
        `state=${state}&` +
        `nonce=${nonce}&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256`;

      console.log("[pantheon-auth] starting OIDC flow, redirect_uri =", redirectUri);

      if (isTauriRuntime()) {
        // Listen for the auth callback event from the Tauri command
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<{ code: string; state: string }>(
          "pantheon:auth-callback",
          (event) => {
            console.log("[pantheon-auth] received auth callback event");
            unlisten();
            void exchangeCodeForToken(event.payload.code, event.payload.state);
          },
        );
        eventCleanup = unlisten;

        // Open a Tauri webview window for the login flow.
        // The callback page at /oauth/callback will call invoke('auth_callback', { code, state })
        // which emits the 'pantheon:auth-callback' event we're listening for above.
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        console.log("[pantheon-auth] creating login webview window");

        const loginWindow = new WebviewWindow("pantheon-login", {
          url: authUrl,
          title: "Sign in — OpenWork",
          width: 500,
          height: 700,
          center: true,
          resizable: true,
        });

        loginWindow.once("tauri://created", () => {
          console.log("[pantheon-auth] login window created");
        });

        loginWindow.once("tauri://error", (e) => {
          console.log("[pantheon-auth] login window creation failed:", e);
          setError("Failed to open login window");
          setLoading(false);
        });

        // If the window is closed without completing login, reset loading state
        loginWindow.onCloseRequested(() => {
          if (!authenticated()) {
            console.log("[pantheon-auth] login window closed without completing");
            setLoading(false);
          }
        });
      } else {
        // Web: popup flow with postMessage callback
        const popup = window.open(authUrl, "pantheon-oidc", "width=500,height=700");

        const onMessage = async (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          if (event.data?.type !== "pantheon-oidc-callback") return;
          window.removeEventListener("message", onMessage);
          const { code, state: returnedState } = event.data as { code: string; state: string };
          await exchangeCodeForToken(code, returnedState);
        };

        window.addEventListener("message", onMessage);

        // Detect popup closed without completing
        const pollTimer = setInterval(() => {
          if (popup && popup.closed) {
            clearInterval(pollTimer);
            window.removeEventListener("message", onMessage);
            if (!authenticated()) {
              setLoading(false);
            }
          }
        }, 500);
      }
    } catch (err: any) {
      console.log("[pantheon-auth] login start failed:", err);
      setError(err?.message ?? "Failed to start login");
      setLoading(false);
    }
  }

  return (
    <Show
      when={authenticated()}
      fallback={
        <div class="flex items-center justify-center h-screen bg-gray-1">
          <div class="bg-gray-2 rounded-2xl shadow-sm border border-gray-6 p-8 max-w-sm w-full text-center">
            <h1 class="text-xl font-semibold text-gray-12 mb-2">OpenWork</h1>
            <p class="text-sm text-gray-9 mb-6">Sign in to continue</p>
            <Show when={error()}>
              <p class="text-sm text-red-11 mb-4">{error()}</p>
            </Show>
            <Show
              when={!loading()}
              fallback={
                <p class="text-sm text-gray-9">Signing in…</p>
              }
            >
              <button
                onClick={handleLogin}
                class="w-full rounded-lg bg-gray-12 px-4 py-2.5 text-sm font-medium text-gray-1 hover:bg-gray-11 transition-colors"
              >
                Sign in
              </button>
            </Show>
          </div>
        </div>
      }
    >
      {props.children}
    </Show>
  );
}
// END-PANTHEON-OVERRIDE

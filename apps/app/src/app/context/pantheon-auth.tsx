// BEGIN-PANTHEON-OVERRIDE — OIDC login gate for Pantheon authentication
import { createSignal, onMount, Show, type ParentProps } from "solid-js";
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
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  return globalThis.fetch(input, init);
}

// ---------------------------------------------------------------------------
// PantheonAuthGate
// ---------------------------------------------------------------------------

export function PantheonAuthGate(props: ParentProps) {
  const [authenticated, setAuthenticated] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // Try to restore an existing session on mount
  onMount(async () => {
    const existing = localStorage.getItem("pantheon.jwt");
    if (existing) {
      setAuthenticated(true);
      setLoading(false);
      return;
    }

    // Dev shortcut: auto-login when pointing at localhost
    const base = pantheonBaseUrl();
    if (/localhost|127\.0\.0\.1/.test(base)) {
      try {
        const res = await authFetch(`${base}/backend/login/localhost`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (res.ok) {
          const data = (await res.json()) as { token: string };
          localStorage.setItem("pantheon.jwt", data.token);
          localStorage.setItem("openwork.server.token", data.token);
          setAuthenticated(true);
          setLoading(false);
          return;
        }
      } catch {
        // Fall through to manual login
      }
    }

    setLoading(false);
  });

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

      const redirectUri = `${window.location.origin}/#/auth/callback`;

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

      const popup = window.open(authUrl, "pantheon-oidc", "width=500,height=650");

      // Listen for the callback message from the popup
      const onMessage = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type !== "pantheon-oidc-callback") return;

        window.removeEventListener("message", onMessage);

        const { code, state: returnedState } = event.data as {
          code: string;
          state: string;
        };

        const savedState = sessionStorage.getItem("pantheon.oidc.state");
        if (returnedState !== savedState) {
          setError("Authentication failed: state mismatch.");
          setLoading(false);
          return;
        }

        const savedVerifier = sessionStorage.getItem(
          "pantheon.oidc.code_verifier",
        )!;

        try {
          const tokenRes = await authFetch(`${base}/oauth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: "openwork",
              code_verifier: savedVerifier,
            }).toString(),
          });

          if (!tokenRes.ok) {
            throw new Error(`Token exchange failed (${tokenRes.status})`);
          }

          const tokenData = (await tokenRes.json()) as {
            access_token: string;
          };
          localStorage.setItem("pantheon.jwt", tokenData.access_token);
          localStorage.setItem(
            "openwork.server.token",
            tokenData.access_token,
          );

          setAuthenticated(true);
        } catch (err: any) {
          setError(err?.message ?? "Token exchange failed");
        } finally {
          setLoading(false);
        }
      };

      window.addEventListener("message", onMessage);

      // If the popup was blocked or closed, detect and clean up
      const pollTimer = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(pollTimer);
          window.removeEventListener("message", onMessage);

          // Check localStorage fallback (popup may have written there)
          if (localStorage.getItem("pantheon.oidc.complete") === "1") {
            localStorage.removeItem("pantheon.oidc.complete");
            const code = localStorage.getItem("pantheon.oidc.code") ?? "";
            const fallbackState =
              localStorage.getItem("pantheon.oidc.state") ?? "";
            localStorage.removeItem("pantheon.oidc.code");
            localStorage.removeItem("pantheon.oidc.state");
            // Re-dispatch as message so the same handler fires
            window.postMessage(
              { type: "pantheon-oidc-callback", code, state: fallbackState },
              window.location.origin,
            );
            window.addEventListener("message", onMessage);
          } else if (!authenticated()) {
            setLoading(false);
          }
        }
      }, 500);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start login");
      setLoading(false);
    }
  }

  return (
    <Show
      when={authenticated()}
      fallback={
        <div class="flex items-center justify-center h-screen bg-[#f6f9fc]">
          <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-sm w-full text-center">
            <h1 class="text-xl font-semibold text-gray-900 mb-2">OpenWork</h1>
            <p class="text-sm text-gray-500 mb-6">Sign in to continue</p>
            <Show when={error()}>
              <p class="text-sm text-red-600 mb-4">{error()}</p>
            </Show>
            <Show
              when={!loading()}
              fallback={
                <p class="text-sm text-gray-400">Signing in…</p>
              }
            >
              <button
                onClick={handleLogin}
                class="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 transition-colors"
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

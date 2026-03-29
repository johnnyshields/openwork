/**
 * Pantheon HTTP client — authentication only.
 *
 * Handles localhost auto-login, OIDC code exchange, and token management.
 */

const STORAGE_KEY = "pantheon.jwt";

export interface PantheonUser {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: string;
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

  function isLoggedIn(): boolean {
    return !!token;
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

  async function exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<{ access_token: string; id_token: string; expires_in: number }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: "openwork",
      client_secret: "",
    });
    if (codeVerifier) {
      body.set("code_verifier", codeVerifier);
    }

    const resp = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (resp.status === 401 || resp.status === 403) {
      clearToken();
      throw new PantheonAuthError(resp.status, "Authentication failed");
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new PantheonApiError(resp.status, text || resp.statusText);
    }

    const data = await resp.json();
    saveToken(data.access_token);
    return data;
  }

  return {
    getToken,
    isLoggedIn,
    loginLocalhost,
    exchangeCode,
    me,
    clearToken,
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

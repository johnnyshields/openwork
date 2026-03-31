// BEGIN-PANTHEON-OVERRIDE — OIDC callback page for Pantheon login
import { onMount } from "solid-js";

export default function AuthCallback() {
  onMount(() => {
    // The app uses HashRouter, so the callback URL is:
    //   /#/auth/callback?code=...&state=...
    // Params may appear in the hash fragment after "?" or in window.location.search.
    const hashQuery = window.location.hash.split("?")[1] ?? "";
    const params = new URLSearchParams(hashQuery || window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (window.opener) {
      window.opener.postMessage(
        { type: "pantheon-oidc-callback", code, state },
        window.location.origin,
      );
      window.close();
    } else {
      // Fallback: store in localStorage for parent to pick up
      localStorage.setItem("pantheon.oidc.code", code ?? "");
      localStorage.setItem("pantheon.oidc.state", state ?? "");
      localStorage.setItem("pantheon.oidc.complete", "1");
    }
  });

  return (
    <div class="flex items-center justify-center h-screen bg-[#f6f9fc]">
      <p class="text-sm text-gray-500">Completing sign-in…</p>
    </div>
  );
}
// END-PANTHEON-OVERRIDE

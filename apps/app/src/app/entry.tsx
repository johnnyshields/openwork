import App from "./app";
import { GlobalSDKProvider } from "./context/global-sdk";
import { GlobalSyncProvider } from "./context/global-sync";
import { LocalProvider } from "./context/local";
import { ServerProvider } from "./context/server";
import { isWebDeployment } from "./lib/openwork-deployment";
// BEGIN-PANTHEON-OVERRIDE — import Pantheon auth gate and helpers
import { PantheonAuthGate } from "./context/pantheon-auth";
import { isPantheonMode, pantheonBaseUrl, isTauriRuntime } from "./utils";
// END-PANTHEON-OVERRIDE

export default function AppEntry() {
  const defaultUrl = (() => {
    // BEGIN-PANTHEON-OVERRIDE — Pantheon mode takes priority over all other URL resolution
    if (isPantheonMode()) return `${pantheonBaseUrl()}/opencode`;
    // END-PANTHEON-OVERRIDE

    // Desktop app connects to the local OpenCode engine.
    if (isTauriRuntime()) return "http://127.0.0.1:4096";

    // When running the web UI against an OpenWork server (e.g. Docker dev stack),
    // use the server's `/opencode` proxy instead of loopback.
    const openworkUrl =
      typeof import.meta.env?.VITE_OPENWORK_URL === "string"
        ? import.meta.env.VITE_OPENWORK_URL.trim()
        : "";
    if (openworkUrl) {
      return `${openworkUrl.replace(/\/+$/, "")}/opencode`;
    }

    // When the hosted web deployment is served by the OpenWork server,
    // OpenCode is proxied at same-origin `/opencode`.
    if (isWebDeployment() && import.meta.env.PROD && typeof window !== "undefined") {
      return `${window.location.origin}/opencode`;
    }

    // Dev fallback (Vite) - allow overriding for remote debugging.
    const envUrl =
      typeof import.meta.env?.VITE_OPENCODE_URL === "string"
        ? import.meta.env.VITE_OPENCODE_URL.trim()
        : "";
    return envUrl || "http://127.0.0.1:4096";
  })();

  return (
    <ServerProvider defaultUrl={defaultUrl}>
      <GlobalSDKProvider>
        <GlobalSyncProvider>
          <LocalProvider>
            {/* BEGIN-PANTHEON-OVERRIDE — wrap App with auth gate in Pantheon mode */}
            {isPantheonMode() ? <PantheonAuthGate><App /></PantheonAuthGate> : <App />}
            {/* END-PANTHEON-OVERRIDE */}
          </LocalProvider>
        </GlobalSyncProvider>
      </GlobalSDKProvider>
    </ServerProvider>
  );
}

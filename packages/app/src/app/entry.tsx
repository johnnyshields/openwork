import App from "./app";
import { GlobalSDKProvider } from "./context/global-sdk";
import { GlobalSyncProvider } from "./context/global-sync";
import { LocalProvider } from "./context/local";
import { ServerProvider } from "./context/server";
import { isPantheonMode } from "./context/pantheon";
import { PantheonSDKProvider } from "./context/pantheon-sdk";
import { isTauriRuntime } from "./utils";

export default function AppEntry() {
  // Pantheon mode: full OpenWork UI backed by Pantheon API
  if (isPantheonMode()) {
    return (
      <PantheonSDKProvider>
        <LocalProvider>
          <App />
        </LocalProvider>
      </PantheonSDKProvider>
    );
  }

  // OpenCode mode (Tauri desktop / standalone)
  const defaultUrl = (() => {
    if (isTauriRuntime()) return "http://127.0.0.1:4096";

    if (import.meta.env.PROD && typeof window !== "undefined") {
      return `${window.location.origin}/opencode`;
    }

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
            <App />
          </LocalProvider>
        </GlobalSyncProvider>
      </GlobalSDKProvider>
    </ServerProvider>
  );
}

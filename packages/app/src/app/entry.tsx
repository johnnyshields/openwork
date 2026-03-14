import App from "./app";
import { PantheonApp } from "./pantheon-app";
import { GlobalSDKProvider } from "./context/global-sdk";
import { GlobalSyncProvider } from "./context/global-sync";
import { LocalProvider } from "./context/local";
import { ServerProvider } from "./context/server";
import { PantheonProvider, isPantheonMode } from "./context/pantheon";
import { isTauriRuntime } from "./utils";

export default function AppEntry() {
  // Pantheon mode: skip the OpenCode SDK stack entirely
  if (isPantheonMode()) {
    return (
      <PantheonProvider>
        <PantheonApp />
      </PantheonProvider>
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

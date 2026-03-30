import { lazy } from "solid-js";
import { GlobalSDKProvider } from "./context/global-sdk";
import { GlobalSyncProvider } from "./context/global-sync";
import { LocalProvider } from "./context/local";
import { ServerProvider } from "./context/server";
import { isPantheonMode } from "./context/pantheon";
import { PantheonSDKProvider } from "./context/pantheon-sdk";
import { isTauriRuntime } from "./utils";

const LazyApp = lazy(() => import("./app"));

export default function AppEntry() {
  const pantheon = isPantheonMode();
  const tauri = isTauriRuntime();
  const viteUrl = import.meta.env?.VITE_OPENWORK_URL ?? "(unset)";
  console.warn(`[entry] isPantheonMode=${pantheon} isTauri=${tauri} VITE_OPENWORK_URL=${viteUrl}`);

  // Pantheon mode: Pantheon login gates the normal OpenWork UI
  if (pantheon) {
    console.warn("[entry] → rendering PantheonSDKProvider path");
    return (
      <PantheonSDKProvider>
        <LocalProvider>
          <LazyApp />
        </LocalProvider>
      </PantheonSDKProvider>
    );
  }

  // OpenCode mode (Tauri desktop / standalone)
  console.warn("[entry] → rendering OpenCode/Server path");
  const defaultUrl = (() => {
    if (tauri) return "http://127.0.0.1:4096";

    if (import.meta.env.PROD && typeof window !== "undefined") {
      return `${window.location.origin}/opencode`;
    }

    const envUrl =
      typeof import.meta.env?.VITE_OPENCODE_URL === "string"
        ? import.meta.env.VITE_OPENCODE_URL.trim()
        : "";
    return envUrl || "http://127.0.0.1:4096";
  })();
  console.warn(`[entry] OpenCode defaultUrl=${defaultUrl}`);

  return (
    <ServerProvider defaultUrl={defaultUrl}>
      <GlobalSDKProvider>
        <GlobalSyncProvider>
          <LocalProvider>
            <LazyApp />
          </LocalProvider>
        </GlobalSyncProvider>
      </GlobalSDKProvider>
    </ServerProvider>
  );
}

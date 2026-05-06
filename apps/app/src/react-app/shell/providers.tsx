/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";

import { isWebDeployment } from "../../app/lib/openwork-deployment";
import { hydrateOpenworkServerSettingsFromEnv } from "../../app/lib/openwork-server";
// BEGIN-PANTHEON-OVERRIDE — import Pantheon helpers
import { isDesktopRuntime, isPantheonMode, pantheonBaseUrl } from "../../app/utils";
// END-PANTHEON-OVERRIDE
import { DenAuthProvider } from "../domains/cloud/den-auth-provider";
import { DesktopConfigProvider } from "../domains/cloud/desktop-config-provider";
import { RestrictionNoticeProvider } from "../domains/cloud/restriction-notice-provider";
import { StatusToastsProvider } from "../domains/shell-feedback/status-toasts";
import { LocalProvider } from "../kernel/local-provider";
import { ServerProvider } from "../kernel/server-provider";
import { BootStateProvider } from "./boot-state";
import { DesktopRuntimeBoot } from "./desktop-runtime-boot";
import { startDebugLogger, stopDebugLogger } from "./debug-logger";
import { MigrationPrompt } from "./migration-prompt";
import { resolveOpenworkConnection } from "./openwork-connection";
import { ReloadCoordinatorProvider } from "./reload-coordinator";

function resolveDefaultServerUrl(): string {
  // BEGIN-PANTHEON-OVERRIDE — Pantheon mode takes priority. Use the OpenWork API base URL;
  // workspace activation builds the workspace-scoped /openwork/api/w/{wid}/opencode URL.
  if (isPantheonMode()) {
    const url = `${pantheonBaseUrl()}/openwork/api`;
    console.log("[pantheon] providers: Pantheon mode active, defaultUrl =", url);
    return url;
  }
  // END-PANTHEON-OVERRIDE
  if (isDesktopRuntime()) return "http://127.0.0.1:4096";

  const openworkUrl =
    typeof import.meta.env?.VITE_OPENWORK_URL === "string"
      ? import.meta.env.VITE_OPENWORK_URL.trim()
      : "";
  if (openworkUrl) {
    return `${openworkUrl.replace(/\/+$/, "")}/opencode`;
  }

  if (isWebDeployment() && import.meta.env.PROD && typeof window !== "undefined") {
    return `${window.location.origin}/opencode`;
  }

  const envUrl =
    typeof import.meta.env?.VITE_OPENCODE_URL === "string"
      ? import.meta.env.VITE_OPENCODE_URL.trim()
      : "";
  return envUrl || "http://127.0.0.1:4096";
}

type AppProvidersProps = {
  children: ReactNode;
};

export function AppProviders({ children }: AppProvidersProps) {
  hydrateOpenworkServerSettingsFromEnv();

  useEffect(() => {
    // Start the dev observability forwarder. Reads the current openwork-server
    // URL on every flush so reconnects after port changes still work. In prod
    // builds `startDebugLogger` is a no-op.
    startDebugLogger({
      serverUrl: async () => (await resolveOpenworkConnection()).normalizedBaseUrl,
    });
    return () => {
      stopDebugLogger();
    };
  }, []);

  const defaultUrl = resolveDefaultServerUrl();
  return (
    <BootStateProvider>
      <ServerProvider defaultUrl={defaultUrl}>
        <DesktopRuntimeBoot />
        <DenAuthProvider>
          <DesktopConfigProvider>
            <RestrictionNoticeProvider>
              <LocalProvider>
                <StatusToastsProvider>
                  <ReloadCoordinatorProvider>{children}</ReloadCoordinatorProvider>
                </StatusToastsProvider>
              </LocalProvider>
            </RestrictionNoticeProvider>
          </DesktopConfigProvider>
        </DenAuthProvider>
        <MigrationPrompt />
      </ServerProvider>
    </BootStateProvider>
  );
}

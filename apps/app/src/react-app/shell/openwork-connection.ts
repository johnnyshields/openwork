import {
  isLoopbackOpenworkServerUrl,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
} from "../../app/lib/openwork-server";
import { openworkServerInfo, type OpenworkServerInfo } from "../../app/lib/desktop";
// BEGIN-PANTHEON-OVERRIDE — import Pantheon mode helpers
import { isDesktopRuntime, isPantheonMode, pantheonBaseUrl } from "../../app/utils";
// END-PANTHEON-OVERRIDE

export type OpenworkConnectionSource = "desktop-runtime" | "stored-settings" | "empty";

export type ResolvedOpenworkConnection = {
  normalizedBaseUrl: string;
  resolvedToken: string;
  resolvedHostToken: string;
  hostInfo: OpenworkServerInfo | null;
  source: OpenworkConnectionSource;
};

function hasUsableConnection(url: string, token: string) {
  return url.trim().length > 0 && token.trim().length > 0;
}

/**
 * Resolve the OpenWork server connection for routes that consume the server API.
 *
 * Local desktop-hosted servers expose ephemeral loopback ports and freshly
 * minted tokens on every boot, so live runtime info is the source of truth
 * there. Stored settings remain the fallback for remote/manual server
 * connections and for desktop cases where the runtime bridge is unavailable.
 */
export async function resolveOpenworkConnection(): Promise<ResolvedOpenworkConnection> {
  let staleDesktopRuntimeBaseUrl = "";

  // BEGIN-PANTHEON-OVERRIDE — Pantheon serves the OpenWork API directly; use its URL/JWT
  if (isPantheonMode()) {
    const normalizedBaseUrl = `${pantheonBaseUrl()}/openwork/api`;
    const resolvedToken =
      typeof window !== "undefined"
        ? (window.localStorage.getItem("pantheon.jwt") ?? "").trim()
        : "";
    return {
      normalizedBaseUrl,
      resolvedToken,
      resolvedHostToken: "",
      hostInfo: null,
      source: hasUsableConnection(normalizedBaseUrl, resolvedToken)
        ? "stored-settings"
        : "empty",
    };
  }
  // END-PANTHEON-OVERRIDE

  if (isDesktopRuntime()) {
    try {
      const info = await openworkServerInfo();
      const normalizedBaseUrl =
        normalizeOpenworkServerUrl(info.connectUrl ?? info.baseUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
        "";
      const resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || "";
      if (info.running === true && hasUsableConnection(normalizedBaseUrl, resolvedToken)) {
        return {
          normalizedBaseUrl,
          resolvedToken,
          resolvedHostToken: info.hostToken?.trim() || "",
          hostInfo: info,
          source: "desktop-runtime",
        };
      }
      staleDesktopRuntimeBaseUrl = normalizedBaseUrl;
    } catch {
      // Fall through to stored settings for remote/manual connections.
    }
  }

  const settings = readOpenworkServerSettings();
  const normalizedBaseUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
  const resolvedToken = settings.token?.trim() ?? "";
  const resolvedHostToken =
    normalizedBaseUrl && isLoopbackOpenworkServerUrl(normalizedBaseUrl)
      ? settings.hostToken?.trim() ?? ""
      : "";
  const storedConnectionIsStaleDesktopRuntime = Boolean(
    isDesktopRuntime() &&
      staleDesktopRuntimeBaseUrl &&
      normalizedBaseUrl === staleDesktopRuntimeBaseUrl,
  );
  const source =
    !storedConnectionIsStaleDesktopRuntime && hasUsableConnection(normalizedBaseUrl, resolvedToken)
      ? "stored-settings"
      : "empty";

  return {
    normalizedBaseUrl: source === "empty" ? "" : normalizedBaseUrl,
    resolvedToken: source === "empty" ? "" : resolvedToken,
    resolvedHostToken: source === "empty" ? "" : resolvedHostToken,
    hostInfo: null,
    source,
  };
}

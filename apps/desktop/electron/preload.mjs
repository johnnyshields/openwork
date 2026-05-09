import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.openworkShell = "electron";
    root.classList.add("openwork-electron");
    if (process.platform === "darwin") {
      root.classList.add("openwork-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("openwork-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("openwork-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld("__OPENWORK_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("openwork:desktop", command, ...args);
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("openwork:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("openwork:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("openwork:system:architecture");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("openwork:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("openwork:migration:ack");
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("openwork:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("openwork:updater:setChannel", channel);
    },
    check() {
      return ipcRenderer.invoke("openwork:updater:check");
    },
    download() {
      return ipcRenderer.invoke("openwork:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("openwork:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openwork:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("openwork:updater:download-progress", handler);
      };
    },
  },
  browser: {
    show(bounds) { return ipcRenderer.invoke("openwork:browser:show", bounds); },
    hide() { return ipcRenderer.invoke("openwork:browser:hide"); },
    navigate(url) { return ipcRenderer.invoke("openwork:browser:navigate", url); },
    back() { return ipcRenderer.invoke("openwork:browser:back"); },
    forward() { return ipcRenderer.invoke("openwork:browser:forward"); },
    reload() { return ipcRenderer.invoke("openwork:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("openwork:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("openwork:browser:state"); },
    destroy() { return ipcRenderer.invoke("openwork:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("openwork:browser:state", handler);
      return () => ipcRenderer.removeListener("openwork:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = () => callback();
      ipcRenderer.on("openwork:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("openwork:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = () => callback();
      ipcRenderer.on("openwork:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("openwork:browser:panel-closed", handler);
    },
  },
  // BEGIN-PANTHEON-OVERRIDE — expose OIDC popup + credentials IPC to the renderer
  pantheon: {
    beginAuth(authUrl, redirectUri) {
      return ipcRenderer.invoke("openwork:pantheon:beginAuth", authUrl, redirectUri);
    },
    setCredentials(apiUrl, apiKey) {
      return ipcRenderer.invoke("openwork:pantheon:setCredentials", { apiUrl, apiKey });
    },
  },
  // END-PANTHEON-OVERRIDE
  meta: {
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
  },
});

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

// Re-emit Electron main-process stdout/stderr into the renderer's DevTools
// console, prefixed so they're easy to distinguish from renderer-side logs.
// The embedded openwork-server tags each line with `[ow-server] ` (via
// OPENWORK_SERVER_LOG_PREFIX in apps/server/src/server.ts) so we can demux
// it from sibling main-process writers and label it accordingly.
const OW_SERVER_PREFIX = "[ow-server] ";
ipcRenderer.on("openwork:main-log", (_event, payload) => {
  const stream = payload?.stream === "stderr" ? "stderr" : "stdout";
  const raw = typeof payload?.line === "string" ? payload.line : "";
  if (!raw) return;
  let label;
  let body;
  if (raw.startsWith(OW_SERVER_PREFIX)) {
    label = stream === "stderr" ? "[ow-server:err]" : "[ow-server]";
    body = raw.slice(OW_SERVER_PREFIX.length);
  } else {
    label = stream === "stderr" ? "[main:err]" : "[main]";
    body = raw;
  }
  // stderr → console.error (DevTools "Error" level).
  // stdout → console.debug (DevTools "Verbose" level — hidden by default;
  // toggle the "Verbose" checkbox in the DevTools console level filter to
  // see them).
  if (stream === "stderr") {
    console.error(label, body);
  } else {
    console.debug(label, body);
  }
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

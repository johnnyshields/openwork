/**
 * Node.js HTTP adapter for the OpenWork server.
 *
 * Provides a `serve()` function with the same interface as Bun.serve()
 * but backed by `node:http`. This allows the server to run in any Node.js
 * environment (including Electron's main process) without Bun.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type ServeOptions = {
  hostname: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
  idleTimeout?: number;
};

export type ServeResult = {
  port: number;
  stop: () => void;
};

/**
 * Convert a Node.js IncomingMessage into a Web API Request.
 */
function toWebRequest(nodeReq: IncomingMessage, hostname: string, port: number): Request {
  const url = `http://${hostname}:${port}${nodeReq.url ?? "/"}`;
  const method = nodeReq.method ?? "GET";
  const headers = new Headers();

  // Node headers can be string | string[] | undefined
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";

  // Readable.toWeb() returns a Node stream/web ReadableStream which is structurally
  // compatible with the global ReadableStream but TypeScript treats them as distinct.
  const body = hasBody
    ? (Readable.toWeb(nodeReq) as unknown as ReadableStream<Uint8Array>)
    : null;

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error duplex is required for streaming request bodies in Node
    duplex: hasBody ? "half" : undefined,
  });
}

/**
 * Write a Web API Response to a Node.js ServerResponse.
 *
 * All writes/ends are guarded against `writableEnded` / `destroyed` so a
 * mid-flight response surviving past `server.closeAllConnections()` (e.g. on
 * shutdown) doesn't throw ERR_STREAM_WRITE_AFTER_END and crash the host
 * process — the fetch handler can resolve well after the socket is gone.
 */
function isResponseDone(nodeRes: ServerResponse): boolean {
  return nodeRes.writableEnded || nodeRes.destroyed;
}

async function writeWebResponse(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  if (isResponseDone(nodeRes)) return;

  const headersObj: Record<string, string | string[]> = {};
  webRes.headers.forEach((value, key) => {
    const existing = headersObj[key];
    if (existing) {
      headersObj[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      headersObj[key] = value;
    }
  });

  if (!nodeRes.headersSent) {
    try {
      nodeRes.writeHead(webRes.status, headersObj);
    } catch {
      return;
    }
  }

  if (!webRes.body) {
    if (!isResponseDone(nodeRes)) {
      try { nodeRes.end(); } catch { /* socket gone */ }
    }
    return;
  }

  const reader = webRes.body.getReader();
  try {
    while (true) {
      if (isResponseDone(nodeRes)) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (isResponseDone(nodeRes)) return;
      try {
        if (!nodeRes.write(value)) {
          await new Promise<void>((resolve) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onClose = () => { cleanup(); resolve(); };
            const cleanup = () => {
              nodeRes.off("drain", onDrain);
              nodeRes.off("close", onClose);
            };
            nodeRes.once("drain", onDrain);
            nodeRes.once("close", onClose);
          });
        }
      } catch {
        return;
      }
    }
  } finally {
    reader.releaseLock();
    if (!isResponseDone(nodeRes)) {
      try { nodeRes.end(); } catch { /* socket gone */ }
    }
  }
}

/**
 * Start an HTTP server with a Web-standard fetch handler.
 *
 * Interface mirrors Bun.serve() so the caller doesn't need to change.
 */
export function serve(options: ServeOptions): Promise<ServeResult> {
  const { hostname, port, fetch: fetchHandler } = options;

  const server = createServer(async (nodeReq, nodeRes) => {
    try {
      const webReq = toWebRequest(nodeReq, hostname, boundPort);
      const webRes = await fetchHandler(webReq);
      await writeWebResponse(webRes, nodeRes);
    } catch (error) {
      console.error("[serve-node] Unhandled error:", error);
      if (isResponseDone(nodeRes)) return;
      try {
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(500, { "Content-Type": "application/json" });
        }
        nodeRes.end(JSON.stringify({ error: "internal_error" }));
      } catch {
        // Connection was torn down between the fetch error and our write —
        // there's nothing left to report on. Swallow rather than re-throwing
        // into the createServer handler (Node would then crash the process).
      }
    }
  });

  // Set keep-alive timeout to match Bun's idleTimeout
  if (options.idleTimeout) {
    server.keepAliveTimeout = options.idleTimeout * 1000;
  }

  let boundPort = port;

  return new Promise<ServeResult>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, hostname, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      resolve({
        port: boundPort,
        stop: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

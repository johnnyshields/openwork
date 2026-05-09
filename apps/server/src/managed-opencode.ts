import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  close: () => void;
};

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function findFreePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

export async function createManagedOpencodeServer(options: {
  bin?: string;
  cwd: string;
  hostname?: string;
  port?: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname);
  const username = randomSecret();
  const password = randomSecret();
  const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const child: ChildProcess = spawn(options.bin?.trim() || "opencode", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Resolve once we see the "listening on …" line. Any stdio data — before
  // and after — is forwarded to our parent process so it surfaces in the
  // [ow-server] log stream (and a managed-opencode crash post-startup is
  // visible instead of silent).
  let urlResolved = false;
  // Set when our own close() initiates the shutdown — used to suppress the
  // "managed opencode exited" stderr line for kills we triggered ourselves
  // (engineRestart, app shutdown). Unexpected exits (no caller-initiated kill)
  // still print so a real opencode crash is visible.
  let closingIntentionally = false;
  let startupBuffer = "";
  const STARTUP_BUFFER_CAP = 16_384;
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[opencode] ${chunk}`);
    if (!urlResolved && startupBuffer.length < STARTUP_BUFFER_CAP) {
      startupBuffer = (startupBuffer + chunk.toString()).slice(-STARTUP_BUFFER_CAP);
    }
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[opencode] ${chunk}`);
    if (!urlResolved && startupBuffer.length < STARTUP_BUFFER_CAP) {
      startupBuffer = (startupBuffer + chunk.toString()).slice(-STARTUP_BUFFER_CAP);
    }
  });
  child.once("exit", (code, signal) => {
    if (urlResolved && !closingIntentionally) {
      process.stderr.write(`[opencode] managed opencode exited code=${code} signal=${signal}\n`);
    }
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for OpenCode server after ${options.timeoutMs ?? 15000}ms`)),
      options.timeoutMs ?? 15000,
    );
    const done = (value: string) => {
      urlResolved = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) return fail(new Error(`Failed to parse OpenCode server URL from: ${line}`));
        done(match[1]);
        return;
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`OpenCode server exited with code ${code}${startupBuffer.trim() ? `\n${startupBuffer}` : ""}`)),
    );
  });

  return {
    url,
    username,
    password,
    pid: child.pid ?? null,
    close() {
      closingIntentionally = true;
      if (!child.killed) {
        // Debug-level (stdout → DevTools verbose) so the intentional-stop is
        // visible when a developer is watching engineRestart / shutdown flows
        // without polluting the error stream.
        process.stdout.write(`[opencode] stopping managed opencode (pid=${child.pid ?? "?"})\n`);
        child.kill();
      }
    },
  };
}

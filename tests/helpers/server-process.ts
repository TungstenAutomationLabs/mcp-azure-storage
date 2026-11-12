/**
 * Test helper: run the real server (src/server.ts) as a child process.
 *
 * server.ts starts listening when imported, so tests that need the real
 * middleware order, the real startup banner or real stdout/stderr run it in
 * its own process. Storage is never contacted: these tests only exercise
 * /mcp authentication, rate limiting and startup output.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX_CLI = resolve(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** A running server and everything it has written so far. */
export interface ServerProcess {
  port: number;
  baseUrl: string;
  output: () => string;
  stop: () => Promise<void>;
}

/** Find a free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

/** Minimal environment so the server can start without real Azure Storage. */
const BASE_ENV: Record<string, string> = {
  AZURE_STORAGE_ACCOUNT_NAME: "devstoreaccount1",
  // Synthetic placeholder, not an Azure key.
  AZURE_STORAGE_ACCOUNT_KEY: "dGVzdC1vbmx5LWFjY291bnQta2V5",
  OTEL_SDK_DISABLED: "true",
  NODE_ENV: "test",
};

/**
 * Start the server with the given environment (merged over a minimal base;
 * the parent's environment is NOT inherited apart from PATH, so a
 * developer's .env cannot change the result). Resolves once it listens.
 */
export async function startServerProcess(
  env: Record<string, string | undefined>,
  opts: { protocol?: "http" | "https"; timeoutMs?: number } = {},
): Promise<ServerProcess> {
  const port = await freePort();
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", ...BASE_ENV, PORT: String(port) };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }

  let out = "";
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  child.stderr?.on("data", (d: Buffer) => { out += d.toString("utf8"); });

  const stop = (): Promise<void> =>
    new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once("exit", () => done());
      child.kill("SIGKILL");
    });

  const timeoutMs = opts.timeoutMs ?? 20_000;
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`server did not start in ${timeoutMs} ms:\n${out}`)), timeoutMs);
    const check = () => {
      // The banner's last fixed line is printed once the server listens.
      if (out.includes("Upload limit :")) {
        clearTimeout(timer);
        child.stdout?.off("data", check);
        // Let the rest of the banner and the DISABLED_TOOLS check flush.
        setTimeout(ready, 300);
      }
    };
    child.stdout?.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`server exited early (code ${code}):\n${out}`));
    });
  });

  const protocol = opts.protocol ?? "http";
  return { port, baseUrl: `${protocol}://127.0.0.1:${port}`, output: () => out, stop };
}

/** POST an empty JSON-RPC body to /mcp with optional headers; returns the status. */
export async function postMcp(baseUrl: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await res.arrayBuffer();
  return res.status;
}

/** Run the server until it exits on its own (for invalid configuration). */
export async function runServerToExit(
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
): Promise<{ code: number | null; output: string; exited: boolean }> {
  const port = await freePort();
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", ...BASE_ENV, PORT: String(port) };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  let out = "";
  const child = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
    cwd: REPO_ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  child.stderr?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  return new Promise((done) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ code: null, output: out, exited: false }); }, timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); done({ code, output: out, exited: true }); });
  });
}

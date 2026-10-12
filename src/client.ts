import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ActionRequest, ActionResult } from "./browser/actions";
import { DEFAULT_PORT, readDaemonInfo, readToken } from "./state";

export const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.ts", import.meta.url));
export const MCP_ENTRY = fileURLToPath(new URL("./mcp.ts", import.meta.url));

export interface Health {
  ok: boolean;
  mode: string;
  browser: string;
  error?: string;
  port: number;
  jev: string;
  extension?: { connected: boolean; allowedTabs: number };
}

export interface DaemonHandle {
  port: number;
  token: string;
}

export async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // Our own daemon's health payload; only `ok` is load-bearing here.
    return body && typeof body === "object" && "ok" in body && body.ok === true ? (body as Health) : null;
  } catch {
    return null;
  }
}

/** The running daemon (from daemon.json, else the default port), or null. */
export async function runningDaemon(): Promise<DaemonHandle | null> {
  const port = readDaemonInfo()?.port ?? DEFAULT_PORT;
  const token = readToken();
  if (!token || !(await health(port))) return null;
  return { port, token };
}

/** Returns the running daemon, starting it detached (surviving this process) when needed. */
export async function ensureDaemon(): Promise<DaemonHandle> {
  const running = await runningDaemon();
  if (running) return running;
  const child = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await Bun.sleep(150);
    const handle = await runningDaemon();
    if (handle) return handle;
  }
  throw new Error("BrowseForMe daemon did not start within 15s. Check ~/.browseforme/log.txt.");
}

export async function api(handle: DaemonHandle, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json", ...init.headers },
  });
}

export async function action(handle: DaemonHandle, request: ActionRequest): Promise<ActionResult> {
  const res = await api(handle, "/api/action", { method: "POST", body: JSON.stringify(request) });
  if (!res.ok) return { ok: false, error: `Daemon returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, ms: 0 };
  // The daemon's /api/action contract is ActionResult (src/browser/actions.ts).
  return (await res.json()) as ActionResult;
}

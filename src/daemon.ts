#!/usr/bin/env bun
import type { Server, ServerWebSocket } from "bun";
import { mkdirSync } from "node:fs";
import * as z from "zod/v4";
import { configureActions, engineCheck, runAction } from "./browser/actions";
import { OwnedTransport } from "./browser/cdp";
import { ExtensionTransport } from "./browser/ext";
import { health } from "./client";
import { jevStatus, warmJev } from "./jev";
import {
  type Config,
  DEFAULT_PORT,
  ensureStateDir,
  ensureToken,
  LAST_PORT,
  loadConfig,
  log,
  pidAlive,
  PROFILE_DIR,
  readDaemonInfo,
  saveConfig,
  writeDaemonInfo,
} from "./state";

const FIXTURES: Record<string, URL> = {
  "/fixtures/composer.html": new URL("../fixtures/composer.html", import.meta.url),
  "/fixtures/many.html": new URL("../fixtures/many.html", import.meta.url),
};

ensureStateDir();
const token = ensureToken();
const config = loadConfig();

const previous = readDaemonInfo();
if (previous && previous.pid !== process.pid && pidAlive(previous.pid) && (await health(previous.port))) {
  console.error(`BrowseForMe daemon already running (pid ${previous.pid}, port ${previous.port}).`);
  process.exit(0);
}

const transport: OwnedTransport | ExtensionTransport = config.mode === "owned" ? new OwnedTransport() : new ExtensionTransport();
const owned = transport instanceof OwnedTransport ? transport : null;
const extension = transport instanceof ExtensionTransport ? transport : null;

// ---------------------------------------------------------------------------- HTTP helpers

const json = (body: unknown, status = 200) => Response.json(body, { status });

function forbidden(reason: string): Response {
  return new Response(reason, { status: 403 });
}

function publicConfig(current: Config): Record<string, unknown> {
  return { ...current, typesafeApiKey: "", hasTypesafeKey: Boolean(current.typesafeApiKey) };
}

const ConfigPatch = z.object({
  mode: z.enum(["extension", "owned"]).optional(),
  typesafeApiKey: z.string().optional(),
  jevModel: z.string().optional(),
  jevEnabled: z.boolean().optional(),
  clearTypesafeKey: z.boolean().optional(),
});

function applyConfigPatch(raw: unknown): Config {
  const patch = ConfigPatch.parse(raw);
  const next: Config = { ...loadConfig() };
  if (patch.mode) next.mode = patch.mode;
  if (typeof patch.jevEnabled === "boolean") next.jevEnabled = patch.jevEnabled;
  if (patch.jevModel !== undefined) next.jevModel = patch.jevModel.trim() || "jev-latest";
  // An empty string never clears the key; only clearTypesafeKey does.
  const key = patch.typesafeApiKey?.trim();
  if (key) next.typesafeApiKey = key;
  if (patch.clearTypesafeKey) delete next.typesafeApiKey;
  return saveConfig(next);
}

function healthBody(port: number): Record<string, unknown> {
  const status = transport.status();
  return { ok: true, mode: transport.mode, browser: status.browser, error: status.error, port, jev: jevStatus(), extension: status.extension };
}

// ---------------------------------------------------------------------------- request handling

async function handle(req: Request, server: Server<undefined>, port: number): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname;
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return forbidden("Bad Host header.");
  // Clients are the CLI, MCP servers (no Origin), and the extension. No web page may call this API.
  const origin = req.headers.get("origin");
  const extensionPath = path === "/api/health" || path === "/api/token" || path === "/ext";
  if (origin && !(extensionPath && origin.startsWith("chrome-extension://"))) return forbidden("Bad Origin header.");

  if (path === "/api/health") return json(healthBody(port));
  // POST, because Chrome attaches `Origin: chrome-extension://…` to non-GET requests only (an extension GET carries no Origin).
  if (path === "/api/token") {
    return req.method === "POST" && origin?.startsWith("chrome-extension://") ? json({ token }) : forbidden("Extensions only (POST).");
  }
  if (path === "/ext") {
    if (url.searchParams.get("token") !== token) return new Response("Bad token.", { status: 401 });
    if (server.upgrade(req, { data: undefined })) return undefined;
    return new Response("WebSocket upgrade failed.", { status: 400 });
  }
  const fixture = FIXTURES[path];
  if (req.method === "GET" && fixture) return new Response(Bun.file(fixture), { headers: { "Content-Type": "text/html; charset=utf-8" } });

  if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized.", { status: 401 });

  switch (`${req.method} ${path}`) {
    case "POST /api/action": {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "Body must be JSON.", ms: 0 }, 400);
      }
      return json(await runAction(body));
    }
    case "GET /api/config":
      return json(publicConfig(loadConfig()));
    case "PUT /api/config": {
      const before = loadConfig();
      let next: Config;
      try {
        next = applyConfigPatch(await req.json());
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
      if (next.typesafeApiKey !== before.typesafeApiKey || next.jevEnabled !== before.jevEnabled || next.jevModel !== before.jevModel) warmJev();
      return json(publicConfig(next));
    }
    case "POST /api/shutdown":
      setTimeout(() => void shutdown(0), 50);
      return json({ ok: true });
  }
  return new Response("Not found.", { status: 404 });
}

// ---------------------------------------------------------------------------- server

function listen(): Server<undefined> {
  for (let port = DEFAULT_PORT; port <= LAST_PORT; port++) {
    try {
      return Bun.serve<undefined>({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        fetch: (req, server) => handle(req, server, port),
        websocket: {
          open(ws: ServerWebSocket<undefined>) {
            if (extension) extension.socketOpen(ws);
            else ws.close(4001, "Daemon is in owned mode.");
          },
          message(ws: ServerWebSocket<undefined>, data) {
            extension?.socketMessage(ws, data);
          },
          close(ws: ServerWebSocket<undefined>) {
            extension?.socketClose(ws);
          },
        },
      });
    } catch (err) {
      if (port === LAST_PORT) throw err;
    }
  }
  throw new Error("No free port between 47821 and 47830.");
}

const server = listen();
const port = server.port ?? DEFAULT_PORT;
writeDaemonInfo({ pid: process.pid, port, mode: config.mode, startedAt: new Date().toISOString() });
configureActions(transport);
log(`daemon started pid=${process.pid} port=${port} mode=${config.mode}`);
warmJev();

let engineLogged = false;
let engineRunning = false;
async function runEngineCheck(): Promise<void> {
  if (engineLogged || engineRunning) return;
  engineRunning = true;
  engineLogged = await engineCheck();
  engineRunning = false;
}

if (owned) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  void owned.start().then(async () => {
    writeDaemonInfo({ pid: process.pid, port, mode: config.mode, startedAt: new Date().toISOString(), cdpPort: owned.cdpPort, profile: PROFILE_DIR });
    const status = owned.status();
    if (status.browser !== "ready") {
      log(`chrome down: ${status.error ?? "unknown"}`);
      return;
    }
    await runEngineCheck();
    const first = await runAction({ action: "navigate", url: "https://x.com/home" });
    if (!first.ok) log(`startup navigate failed: ${first.error}`);
  });
} else if (extension) {
  extension.onTabsChanged = () => void runEngineCheck();
}

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`daemon stopping pid=${process.pid}`);
  await transport.shutdown().catch(() => {});
  server.stop(true);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

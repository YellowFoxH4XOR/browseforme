#!/usr/bin/env bun
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Server, ServerWebSocket } from "bun";
import { mkdirSync } from "node:fs";
import * as z from "zod/v4";
import { handleChat } from "./agent/chat";
import {
  configureActions,
  engineCheck,
  handoffState,
  latestFrameBytes,
  refreshFrame,
  resumeHandoff,
  runAction,
} from "./browser/actions";
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
import { buildMcpServer } from "./tools";

type SocketData = { kind: "ext" | "ui" };

const INDEX_FILE = Bun.file(new URL("./web/index.html", import.meta.url));
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

const mcpHandler = createMcpHandler(() => buildMcpServer((request) => runAction(request)), { responseMode: "json" });

// ---------------------------------------------------------------------------- HTTP helpers

const json = (body: unknown, status = 200) => Response.json(body, { status });

function forbidden(reason: string): Response {
  return new Response(reason, { status: 403 });
}

function publicConfig(current: Config): Record<string, unknown> {
  return {
    ...current,
    anthropicApiKey: "",
    openaiApiKey: "",
    typesafeApiKey: "",
    hasAnthropicKey: Boolean(current.anthropicApiKey),
    hasOpenaiKey: Boolean(current.openaiApiKey),
    hasTypesafeKey: Boolean(current.typesafeApiKey),
  };
}

const ConfigPatch = z.object({
  provider: z.enum(["auto", "claude-cli", "anthropic", "openai"]).optional(),
  mode: z.enum(["extension", "owned"]).optional(),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  typesafeApiKey: z.string().optional(),
  openaiBaseUrl: z.string().optional(),
  anthropicModel: z.string().optional(),
  openaiModel: z.string().optional(),
  jevModel: z.string().optional(),
  jevEnabled: z.boolean().optional(),
  clearAnthropicKey: z.boolean().optional(),
  clearOpenaiKey: z.boolean().optional(),
  clearTypesafeKey: z.boolean().optional(),
});

function applyConfigPatch(raw: unknown): Config {
  const patch = ConfigPatch.parse(raw);
  const next: Config = { ...loadConfig() };
  if (patch.provider) next.provider = patch.provider;
  if (patch.mode) next.mode = patch.mode;
  if (typeof patch.jevEnabled === "boolean") next.jevEnabled = patch.jevEnabled;
  // Secrets: an empty string never clears a key; only the explicit clear flags do.
  for (const [field, clear] of [
    ["anthropicApiKey", "clearAnthropicKey"],
    ["openaiApiKey", "clearOpenaiKey"],
    ["typesafeApiKey", "clearTypesafeKey"],
  ] as const) {
    const value = patch[field]?.trim();
    if (value) next[field] = value;
    if (patch[clear]) delete next[field];
  }
  // Plain settings: an empty string resets to the default.
  for (const field of ["openaiBaseUrl", "anthropicModel", "openaiModel"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value.trim()) next[field] = value.trim();
    else delete next[field];
  }
  if (patch.jevModel !== undefined) next.jevModel = patch.jevModel.trim() || "jev-latest";
  return saveConfig(next);
}

async function currentPage(): Promise<{ url: string; title: string } | null> {
  if (extension) return extension.currentTab();
  try {
    const tab = (await transport.list()).find((entry) => entry.current);
    return tab ? { url: tab.url, title: tab.title } : null;
  } catch {
    return null;
  }
}

function healthBody(port: number): Record<string, unknown> {
  const status = transport.status();
  return { ok: true, mode: transport.mode, browser: status.browser, error: status.error, port, jev: jevStatus(), extension: status.extension };
}

// ---------------------------------------------------------------------------- request handling

async function handle(req: Request, server: Server<SocketData>, port: number): Promise<Response | undefined> {
  const url = new URL(req.url);
  const path = url.pathname;
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return forbidden("Bad Host header.");
  const origin = req.headers.get("origin");
  const extensionPath = path === "/api/health" || path === "/api/token" || path === "/ext";
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}` && !(extensionPath && origin.startsWith("chrome-extension://"))) {
    return forbidden("Bad Origin header.");
  }

  if (path === "/api/health") return json(healthBody(port));
  // POST, because Chrome attaches `Origin: chrome-extension://…` to non-GET requests only (an extension GET carries no Origin).
  if (path === "/api/token") {
    return req.method === "POST" && origin?.startsWith("chrome-extension://") ? json({ token }) : forbidden("Extensions only (POST).");
  }
  if (path === "/ext" || path === "/ws") {
    if (url.searchParams.get("token") !== token) return new Response("Bad token.", { status: 401 });
    if (server.upgrade(req, { data: { kind: path === "/ext" ? "ext" : "ui" } })) return undefined;
    return new Response("WebSocket upgrade failed.", { status: 400 });
  }
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    if (!(await INDEX_FILE.exists())) return new Response("Web UI missing (src/web/index.html).", { status: 404 });
    const html = (await INDEX_FILE.text()).replaceAll("<!--TOKEN-->", token);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const fixture = FIXTURES[path];
  if (req.method === "GET" && fixture) return new Response(Bun.file(fixture), { headers: { "Content-Type": "text/html; charset=utf-8" } });

  if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized.", { status: 401 });

  if (path === "/mcp") return mcpHandler.fetch(req, { authInfo: { clientId: "local", scopes: [], token } });

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
    case "GET /api/frame": {
      const frame = latestFrameBytes();
      return frame ? new Response(frame, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } }) : new Response(null, { status: 204 });
    }
    case "POST /api/frame/refresh":
      await refreshFrame();
      return new Response(null, { status: 204 });
    case "GET /api/state": {
      const page = await currentPage();
      return json({ url: page?.url ?? null, title: page?.title ?? null, handoff: handoffState(), browser: transport.status().browser, jev: jevStatus() });
    }
    case "POST /api/handoff/resume":
      resumeHandoff();
      return new Response(null, { status: 204 });
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
    case "POST /api/chat": {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "Body must be JSON." }, 400);
      }
      return handleChat(body, { port, token });
    }
    case "POST /api/shutdown":
      setTimeout(() => void shutdown(0), 50);
      return json({ ok: true });
  }
  return new Response("Not found.", { status: 404 });
}

// ---------------------------------------------------------------------------- server

function listen(): Server<SocketData> {
  for (let port = DEFAULT_PORT; port <= LAST_PORT; port++) {
    try {
      return Bun.serve<SocketData>({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        fetch: (req, server) => handle(req, server, port),
        websocket: {
          open(ws: ServerWebSocket<SocketData>) {
            if (ws.data.kind === "ui") ws.subscribe("ui");
            else if (extension) extension.socketOpen(ws);
            else ws.close(4001, "Daemon is in owned mode.");
          },
          message(ws: ServerWebSocket<SocketData>, data) {
            if (ws.data.kind === "ext") extension?.socketMessage(ws, data);
          },
          close(ws: ServerWebSocket<SocketData>) {
            if (ws.data.kind === "ext") extension?.socketClose(ws);
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
configureActions(transport, (message) => server.publish("ui", JSON.stringify(message)));
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
  await mcpHandler.close().catch(() => {});
  server.stop(true);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

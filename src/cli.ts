#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ActionRequest, ActionResult } from "./browser/actions";
import { action, api, ensureDaemon, MCP_ENTRY, runningDaemon } from "./client";
import { serveMcp } from "./mcp";
import { pidAlive, readDaemonInfo, readToken } from "./state";

const USAGE = `usage: bfm <command>
  up | down | status                     start, stop, or inspect the daemon
  connect <claude|codex|opencode|cursor|omp>  register the MCP server with a coding agent
  mcp                                    run the stdio MCP server (what agents launch)
  config [key=value ...]                 show or set: mode=extension|owned, typesafeApiKey=…, jevEnabled=true|false, jevModel=…, clear=typesafeApiKey
  nav <url> | snap [--full] | click <ref|target...> | type <ref|target> <text...>
  find <target...> | check <question...> | press <key> | shot <file>`;

const REF = /^@?e\d+$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function statusLine(result: ActionResult): string {
  const parts = [result.ok ? "ok" : "fail", `${result.ms}ms`];
  const resolved = result.resolved;
  if (resolved && resolved.by !== "ref") {
    parts.push(resolved.by === "jev" ? `jev p=${(resolved.p ?? 0).toFixed(2)}` : resolved.by);
  }
  if (resolved?.jevMs) parts.push(`jev=${resolved.jevMs}ms`);
  return `[${parts.join(" ")}]`;
}

async function runAndPrint(request: ActionRequest): Promise<ActionResult> {
  const handle = await ensureDaemon();
  const result = await action(handle, request);
  if (result.ok) console.log(result.text ?? "");
  else console.error(result.error ?? "Action failed.");
  console.error(statusLine(result));
  if (!result.ok) process.exit(1);
  return result;
}

async function down(): Promise<void> {
  const info = readDaemonInfo();
  if (!info || !pidAlive(info.pid)) {
    console.log("BrowseForMe is not running.");
    return;
  }
  const token = readToken();
  let asked = false;
  if (token) {
    try {
      const res = await api({ port: info.port, token }, "/api/shutdown", { method: "POST" });
      asked = res.ok;
    } catch {
      asked = false;
    }
  }
  const waitExit = async (ms: number) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
      if (!pidAlive(info.pid)) return true;
      await Bun.sleep(100);
    }
    return !pidAlive(info.pid);
  };
  if (asked && (await waitExit(5000))) {
    console.log("BrowseForMe stopped.");
    return;
  }
  process.kill(info.pid, "SIGTERM");
  if (!(await waitExit(3000))) process.kill(info.pid, "SIGKILL");
  console.log("BrowseForMe stopped.");
}

/** `bfm config` prints the config (key masked); `bfm config k=v ...` updates it through the daemon. */
async function configure(pairs: string[]): Promise<void> {
  const handle = await ensureDaemon();
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) fail(`Expected key=value, got "${pair}".\n${USAGE}`);
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (key === "clear" && value === "typesafeApiKey") patch.clearTypesafeKey = true;
    else if (key === "jevEnabled") patch.jevEnabled = value === "true";
    else if (["mode", "typesafeApiKey", "jevModel"].includes(key)) patch[key] = value;
    else fail(`Unknown config key "${key}".\n${USAGE}`);
  }
  const res = pairs.length
    ? await api(handle, "/api/config", { method: "PUT", body: JSON.stringify(patch) })
    : await api(handle, "/api/config");
  const body: unknown = await res.json();
  if (!res.ok) fail(JSON.stringify(body));
  console.log(JSON.stringify(body, null, 2));
  if ("mode" in patch) console.log("Mode changes apply after: bfm down && bfm up");
}

function sh(command: string[], allowFailure = false): { ok: boolean; output: string } {
  console.log(`$ ${command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const ok = result.status === 0;
  if (!ok && !allowFailure) fail(output || `${command[0]} exited with ${result.status}`);
  return { ok, output };
}

/** Sets mcpServers.browseforme in a JSON config file that uses the common `mcpServers` shape, keeping everything else. */
function mergeMcpJson(path: string, entry: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = { ...parsed };
  }
  const servers = config.mcpServers && typeof config.mcpServers === "object" ? { ...config.mcpServers } : {};
  config.mcpServers = { ...servers, browseforme: entry };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  console.log(`Updated ${path}: mcpServers.browseforme = ${JSON.stringify(entry)}`);
}

async function connect(agent: string | undefined): Promise<void> {
  if (!agent || !["claude", "codex", "opencode", "cursor", "omp"].includes(agent)) fail("usage: bfm connect <claude|codex|opencode|cursor|omp>");
  const handle = await ensureDaemon();
  // Absolute bun path: agents launched from GUIs often lack ~/.bun/bin on PATH.
  const server = [process.execPath, MCP_ENTRY];
  switch (agent) {
    case "claude":
      sh(["claude", "mcp", "remove", "browseforme", "--scope", "user"], true);
      sh(["claude", "mcp", "add", "--scope", "user", "browseforme", "--", ...server]);
      break;
    case "codex":
      sh(["codex", "mcp", "remove", "browseforme"], true);
      sh(["codex", "mcp", "add", "browseforme", "--", ...server]);
      break;
    case "opencode": {
      const added = sh(["opencode", "mcp", "add", "--global", "browseforme", "--", ...server], true);
      if (!added.ok) {
        if (!/exist/i.test(added.output)) fail(added.output);
        const listed = sh(["opencode", "mcp", "list"], true).output;
        console.log(listed.split("\n").filter((line) => line.includes("browseforme")).join("\n") || listed);
      }
      break;
    }
    case "cursor":
      mergeMcpJson(join(homedir(), ".cursor", "mcp.json"), { command: server[0], args: [server[1]] });
      break;
    case "omp":
      mergeMcpJson(join(homedir(), ".omp", "agent", "mcp.json"), { type: "stdio", command: server[0], args: [server[1]] });
      console.log("Start a new omp session to load it.");
      break;
  }
  console.log(`Daemon: http://127.0.0.1:${handle.port}/ (no UI; agents use the browser_* MCP tools)`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "up": {
    const handle = await ensureDaemon();
    console.log(`BrowseForMe running on port ${handle.port}.`);
    break;
  }
  case "down":
    await down();
    break;
  case "status": {
    const running = await runningDaemon();
    if (!running) fail("BrowseForMe is not running. Start it with: bfm up");
    const res = await fetch(`http://127.0.0.1:${running.port}/api/health`);
    console.log(JSON.stringify(await res.json(), null, 2));
    break;
  }
  case "config":
    await configure(rest);
    break;
  case "nav":
    if (!rest[0]) fail("usage: bfm nav <url>");
    await runAndPrint({ action: "navigate", url: rest[0] });
    break;
  case "snap":
    await runAndPrint({ action: "snapshot", full: rest.includes("--full") });
    break;
  case "click": {
    if (rest.length === 0) fail("usage: bfm click <ref|target...>");
    const single = rest.length === 1 && REF.test(rest[0]);
    await runAndPrint(single ? { action: "click", ref: rest[0] } : { action: "click", target: rest.join(" ") });
    break;
  }
  case "type": {
    const [where, ...words] = rest;
    if (!where || words.length === 0) fail('usage: bfm type <ref|"target words"> <text...>');
    const text = words.join(" ");
    await runAndPrint(REF.test(where) ? { action: "type", ref: where, text } : { action: "type", target: where, text });
    break;
  }
  case "find":
    if (rest.length === 0) fail("usage: bfm find <target...>");
    await runAndPrint({ action: "find", target: rest.join(" ") });
    break;
  case "check":
    if (rest.length === 0) fail("usage: bfm check <question...>");
    await runAndPrint({ action: "check", question: rest.join(" ") });
    break;
  case "press":
    if (!rest[0]) fail("usage: bfm press <key>");
    await runAndPrint({ action: "press", key: rest[0] });
    break;
  case "shot": {
    if (!rest[0]) fail("usage: bfm shot <file>");
    const result = await runAndPrint({ action: "screenshot" });
    const file = resolve(rest[0]);
    writeFileSync(file, Buffer.from(result.imageBase64 ?? "", "base64"));
    console.log(`saved ${file}`);
    break;
  }
  case "mcp":
    await serveMcp();
    break;
  case "connect":
    await connect(rest[0]);
    break;
  default:
    console.log(USAGE);
    if (command) process.exit(1);
}

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { MCP_ENTRY } from "../client";
import { log, STATE_DIR } from "../state";
import { TOOLS } from "../tools";
import { type DaemonInfo, type Emit, SYSTEM_PROMPT, type Thread } from "./shared";

const PREFIX = "mcp__browseforme__";
const ALLOWED = TOOLS.map((tool) => PREFIX + tool.name).join(",");
const DISALLOWED = "Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Grep,Glob,WebFetch,WebSearch";

type RunEnd = "ok" | "mcp-failed" | "no-session" | "failed";

/** The `claude -p --output-format stream-json` events this runner reads; anything else is ignored. */
const ClaudeEvent = z.union([
  z.object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
  }),
  z.object({
    type: z.literal("stream_event"),
    event: z.object({ type: z.literal("content_block_delta"), delta: z.object({ type: z.literal("text_delta"), text: z.string() }) }),
  }),
  z.object({
    type: z.enum(["assistant", "user"]),
    message: z.object({
      content: z.array(
        z.union([
          z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string() }),
          z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.boolean().optional() }),
          z.looseObject({ type: z.string() }),
        ]),
      ),
    }),
  }),
  z.object({ type: z.literal("result"), session_id: z.string().optional(), is_error: z.boolean().optional(), result: z.string().optional() }),
]);

/** One `claude -p` run streaming JSON events; returns how it ended. */
async function runOnce(thread: Thread, prompt: string, emit: Emit, save: () => void, configPath: string): Promise<RunEnd> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
    "--append-system-prompt",
    SYSTEM_PROMPT,
    "--allowedTools",
    ALLOWED,
    "--disallowedTools",
    DISALLOWED,
  ];
  if (thread.claudeSessionId) args.push("--resume", thread.claudeSessionId);
  // The prompt goes on stdin: --allowedTools/--disallowedTools are variadic and would swallow a trailing positional.
  // ENABLE_TOOL_SEARCH=false loads our 12 small tools upfront instead of spending a model turn on ToolSearch.
  const proc = Bun.spawn(["claude", ...args], {
    cwd: STATE_DIR,
    env: { ...process.env, ENABLE_TOOL_SEARCH: "false" },
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const toolNames = new Map<string, string>();
  // Mutated from the event handler: an object keeps TypeScript from narrowing these to their initial values.
  const seen: { token: boolean; mcpFailed: boolean; error: string | null } = { token: false, mcpFailed: false, error: null };

  const handle = (raw: unknown) => {
    const parsed = ClaudeEvent.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    switch (event.type) {
      case "system": {
        const ours = event.mcp_servers?.find((server) => server.name === "browseforme");
        if (ours?.status !== "connected") {
          log(`claude-cli mcp status=${ours?.status ?? "missing"}`);
          seen.mcpFailed = true;
          proc.kill();
        }
        return;
      }
      case "stream_event":
        seen.token = true;
        emit("token", { text: event.event.delta.text });
        return;
      case "assistant":
        for (const block of event.message.content) {
          if (block.type === "tool_use" && "id" in block && "name" in block && typeof block.id === "string" && typeof block.name === "string") {
            toolNames.set(block.id, block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : block.name);
          }
        }
        return;
      case "user":
        for (const block of event.message.content) {
          if (block.type === "tool_result" && "tool_use_id" in block && typeof block.tool_use_id === "string") {
            emit("tool", { name: toolNames.get(block.tool_use_id) ?? "tool", ok: !("is_error" in block && block.is_error === true) });
          }
        }
        return;
      case "result":
        if (event.session_id) {
          thread.claudeSessionId = event.session_id;
          save();
        }
        if (event.is_error && event.result) seen.error = event.result;
        return;
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // not JSON: ignore
      }
    }
  }
  const code = await proc.exited;
  const errText = await stderr;
  if (seen.mcpFailed) return "mcp-failed";
  if (code !== 0 && /No conversation found/i.test(errText + (seen.error ?? ""))) return "no-session";
  if (seen.error && !seen.token) {
    emit("error", { error: seen.error.slice(-500) });
    return "failed";
  }
  if (code !== 0 && !seen.token) {
    emit("error", { error: (errText.trim() || `claude exited with code ${code}`).slice(-500) });
    return "failed";
  }
  return "ok";
}

/** Runs one chat turn through the `claude` CLI with the daemon's browser tools. */
export async function runClaudeCli(thread: Thread, prompt: string, emit: Emit, save: () => void, daemon: DaemonInfo): Promise<void> {
  const configPath = join(tmpdir(), `bfm-mcp-${crypto.randomUUID()}.json`);
  const writeConfig = (server: Record<string, unknown>) =>
    writeFileSync(configPath, JSON.stringify({ mcpServers: { browseforme: server } }), { mode: 0o600 });
  // HTTP to the running daemon: no MCP process is spawned per message.
  writeConfig({ type: "http", url: `http://127.0.0.1:${daemon.port}/mcp`, headers: { Authorization: `Bearer ${daemon.token}` } });
  try {
    let end = await runOnce(thread, prompt, emit, save, configPath);
    if (end === "no-session") {
      delete thread.claudeSessionId;
      end = await runOnce(thread, prompt, emit, save, configPath);
    }
    if (end === "mcp-failed") {
      writeConfig({ command: process.execPath, args: [MCP_ENTRY] });
      end = await runOnce(thread, prompt, emit, save, configPath);
      if (end === "mcp-failed") emit("error", { error: "Claude could not connect to the BrowseForMe MCP server." });
    }
  } finally {
    rmSync(configPath, { force: true });
  }
}

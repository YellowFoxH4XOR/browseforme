import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { CHATS_DIR, loadConfig, log } from "../state";
import { runClaudeCli } from "./claude-cli";
import { tryFastPath } from "./fast";
import { runAnthropic, runOpenAI } from "./loop";
import type { DaemonInfo, Emit, Thread } from "./shared";

const ChatBody = z.object({ threadId: z.string().optional(), message: z.string().min(1) });
const THREAD_ID = /^[A-Za-z0-9-]{1,64}$/;

function loadThread(requested: string | undefined): Thread {
  const id = requested && THREAD_ID.test(requested) ? requested : crypto.randomUUID();
  const path = join(CHATS_DIR, `${id}.json`);
  if (existsSync(path)) {
    try {
      // Written only by saveThread below.
      const stored = JSON.parse(readFileSync(path, "utf8")) as Thread;
      return { ...stored, id, fastLog: stored.fastLog ?? [], messages: stored.messages ?? [] };
    } catch {
      // unreadable thread file: start over under the same id
    }
  }
  return { id, messages: [], fastLog: [] };
}

export function saveThread(thread: Thread): void {
  writeFileSync(join(CHATS_DIR, `${thread.id}.json`), JSON.stringify(thread, null, 2), { mode: 0o600 });
}

type ProviderChoice =
  | { kind: "anthropic"; apiKey: string; model: string }
  | { kind: "openai"; apiKey: string; baseUrl: string; model: string }
  | { kind: "claude-cli" }
  | { kind: "none" };

function chooseProvider(): ProviderChoice {
  const config = loadConfig();
  const anthropicKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  const anthropic = (apiKey: string): ProviderChoice => ({ kind: "anthropic", apiKey, model: config.anthropicModel || "claude-sonnet-4-5" });
  const openai = (apiKey: string, baseUrl: string): ProviderChoice => ({ kind: "openai", apiKey, baseUrl, model: config.openaiModel || "gpt-4.1" });
  const claudeOnPath = Boolean(Bun.which("claude"));
  switch (config.provider) {
    case "anthropic":
      return anthropicKey ? anthropic(anthropicKey) : { kind: "none" };
    case "openai":
      return openaiKey ? openai(openaiKey, config.openaiBaseUrl || "https://api.openai.com/v1") : { kind: "none" };
    case "claude-cli":
      return claudeOnPath ? { kind: "claude-cli" } : { kind: "none" };
  }
  if (anthropicKey) return anthropic(anthropicKey);
  if (openaiKey) return openai(openaiKey, config.openaiBaseUrl || "https://api.openai.com/v1");
  if (process.env.OPENROUTER_API_KEY) return openai(process.env.OPENROUTER_API_KEY, "https://openrouter.ai/api/v1");
  if (claudeOnPath) return { kind: "claude-cli" };
  return { kind: "none" };
}

async function converse(thread: Thread, message: string, emit: Emit, daemon: DaemonInfo): Promise<void> {
  const save = () => saveThread(thread);
  thread.messages.push({ role: "user", content: message });
  save();

  const fastStarted = performance.now();
  const fast = await tryFastPath(message);
  if (fast) {
    emit("tool", { name: fast.tool, ok: fast.ok });
    emit("token", { text: fast.reply });
    thread.messages.push({ role: "tool", content: fast.tool, ok: fast.ok }, { role: "assistant", content: fast.reply });
    thread.fastLog.push(fast.reply);
    save();
    log(`chat provider=fast ms=${Math.round(performance.now() - fastStarted)} ok=${fast.ok}`);
    return;
  }

  const provider = chooseProvider();
  if (provider.kind === "none") {
    emit("error", { error: "No model configured. Set an API key in Settings or install the claude CLI." });
    return;
  }
  const prompt = thread.fastLog.length > 0 ? `(Since your last turn: ${thread.fastLog.join("; ")})\n\n${message}` : message;
  thread.fastLog = [];
  const started = performance.now();
  let ok = true;
  const tracked: Emit = (event, data) => {
    if (event === "error") ok = false;
    if (event === "token") {
      const last = thread.messages.at(-1);
      if (last?.role === "assistant") last.content += String(data.text ?? "");
      else thread.messages.push({ role: "assistant", content: String(data.text ?? "") });
    }
    if (event === "tool") thread.messages.push({ role: "tool", content: String(data.name ?? ""), ok: data.ok === true });
    emit(event, data);
  };
  try {
    if (provider.kind === "anthropic") await runAnthropic(thread, prompt, tracked, save, provider);
    else if (provider.kind === "openai") await runOpenAI(thread, prompt, tracked, save, provider);
    else await runClaudeCli(thread, prompt, tracked, save, daemon);
  } catch (err) {
    tracked("error", { error: err instanceof Error ? err.message : String(err) });
  }
  save();
  log(`chat provider=${provider.kind} ms=${Math.round(performance.now() - started)} ok=${ok}`);
}

/** POST /api/chat: streams `token`/`tool`/`done`/`error` server-sent events. */
export function handleChat(raw: unknown, daemon: DaemonInfo): Response {
  const parsed = ChatBody.safeParse(raw);
  if (!parsed.success) return Response.json({ ok: false, error: "Body must be { threadId?: string, message: string }." }, { status: 400 });
  const thread = loadThread(parsed.data.threadId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit: Emit = (event, data) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false;
        }
      };
      await converse(thread, parsed.data.message, emit, daemon);
      emit("done", { threadId: thread.id });
      if (open) controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

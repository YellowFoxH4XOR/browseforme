import * as z from "zod/v4";
import { type ActionResult, runAction } from "../browser/actions";
import { jsonSchema, TOOL_BY_NAME, TOOLS, toolText } from "../tools";
import { type Emit, SYSTEM_PROMPT, type Thread } from "./shared";

const MAX_ROUNDS = 12;
const CAP_MESSAGE = "Stopped after 12 browser actions. Say continue.";

// ---------------------------------------------------------------------------- shared tool execution

interface ToolRun {
  text: string;
  ok: boolean;
  result: ActionResult | null;
}

async function executeTool(name: string, input: unknown, emit: Emit): Promise<ToolRun> {
  const tool = TOOL_BY_NAME[name];
  if (!tool) {
    emit("tool", { name, ok: false });
    return { text: `Unknown tool ${name}.`, ok: false, result: null };
  }
  let result: ActionResult;
  try {
    result = await runAction(tool.build(input));
  } catch (err) {
    emit("tool", { name, ok: false });
    return { text: `Invalid arguments: ${err instanceof Error ? err.message : String(err)}`, ok: false, result: null };
  }
  emit("tool", { name, ok: result.ok });
  return { text: toolText(name, result), ok: result.ok, result };
}

// ---------------------------------------------------------------------------- Anthropic

export type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      is_error?: boolean;
      content: ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } })[];
    };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

const AnthropicResponse = z.object({
  stop_reason: z.string().nullable(),
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
      z.looseObject({ type: z.string() }),
    ]),
  ),
});

export async function runAnthropic(thread: Thread, prompt: string, emit: Emit, save: () => void, provider: { apiKey: string; model: string }): Promise<void> {
  const messages = (thread.anthropic ??= []);
  messages.push({ role: "user", content: prompt });
  const tools = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: jsonSchema(tool) }));
  for (let round = 0; ; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: provider.model, max_tokens: 4096, system: SYSTEM_PROMPT, tools, messages }),
    });
    if (res.status !== 200) {
      messages.pop();
      emit("error", { error: `Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 500)}` });
      return;
    }
    const reply = AnthropicResponse.parse(await res.json());
    const blocks: AnthropicBlock[] = [];
    const calls: { id: string; name: string; input: unknown }[] = [];
    for (const block of reply.content) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        blocks.push({ type: "text", text: block.text });
        emit("token", { text: block.text });
      } else if (block.type === "tool_use" && "id" in block && "name" in block && typeof block.id === "string" && typeof block.name === "string") {
        const call = { id: block.id, name: block.name, input: "input" in block ? block.input : {} };
        blocks.push({ type: "tool_use", ...call });
        calls.push(call);
      }
    }
    messages.push({ role: "assistant", content: blocks });
    save();
    if (reply.stop_reason !== "tool_use" || calls.length === 0) return;
    if (round >= MAX_ROUNDS - 1) {
      // Close the open tool_use blocks so the next turn is a valid conversation.
      messages.push({ role: "user", content: calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, is_error: true, content: [{ type: "text", text: CAP_MESSAGE }] })) });
      save();
      emit("error", { error: CAP_MESSAGE });
      return;
    }
    const results: AnthropicBlock[] = [];
    for (const call of calls) {
      const run = await executeTool(call.name, call.input, emit);
      const image = run.result?.imageBase64;
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        is_error: !run.ok,
        content: image
          ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }, { type: "text", text: run.text }]
          : [{ type: "text", text: run.text }],
      });
    }
    messages.push({ role: "user", content: results });
    save();
  }
}

// ---------------------------------------------------------------------------- OpenAI-compatible

export type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

const OpenAIResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .optional(),
        }),
      }),
    )
    .min(1),
});

export async function runOpenAI(
  thread: Thread,
  prompt: string,
  emit: Emit,
  save: () => void,
  provider: { apiKey: string; baseUrl: string; model: string },
): Promise<void> {
  const messages = (thread.openai ??= [{ role: "system", content: SYSTEM_PROMPT }]);
  messages.push({ role: "user", content: prompt });
  const tools = TOOLS.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: jsonSchema(tool) } }));
  for (let round = 0; ; round++) {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: provider.model, messages, tools }),
    });
    if (res.status !== 200) {
      messages.pop();
      emit("error", { error: `OpenAI-compatible HTTP ${res.status}: ${(await res.text()).slice(0, 500)}` });
      return;
    }
    const message = OpenAIResponse.parse(await res.json()).choices[0].message;
    const calls = message.tool_calls ?? [];
    messages.push({ role: "assistant", content: message.content ?? null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    if (message.content) emit("token", { text: message.content });
    save();
    if (calls.length === 0) return;
    if (round >= MAX_ROUNDS - 1) {
      for (const call of calls) messages.push({ role: "tool", tool_call_id: call.id, content: CAP_MESSAGE });
      save();
      emit("error", { error: CAP_MESSAGE });
      return;
    }
    for (const call of calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        // executeTool reports the schema error
      }
      const run = await executeTool(call.function.name, input, emit);
      // Chat-completions tool messages carry text only; screenshots are summarized.
      const text = run.result?.imageBase64 ? `${run.text}\n(screenshot captured; images are not passed to this model)` : run.text;
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
      save();
    }
  }
}

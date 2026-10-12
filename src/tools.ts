import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ActionRequest, ActionResult } from "./browser/actions";

/** One browser tool as exposed to MCP clients and LLM tool loops. */
export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject;
  /** Validates tool arguments and maps them to the /api/action request body. */
  build(args: unknown): ActionRequest;
}

function defineTool<S extends z.ZodObject>(name: string, description: string, schema: S, map: (args: z.infer<S>) => ActionRequest): ToolDef {
  return { name, description, schema, build: (args) => map(schema.parse(args ?? {})) };
}

export const TOOLS: ToolDef[] = [
  defineTool(
    "browser_navigate",
    "Open url in the current tab. Returns compact @e refs and page flags.",
    z.object({ url: z.string() }),
    ({ url }) => ({ action: "navigate", url }),
  ),
  defineTool(
    "browser_snapshot",
    "List interactive elements as @e refs, viewport first, max 200. full adds the accessibility tree (slower). Refs die after navigation.",
    z.object({ full: z.boolean().optional() }),
    ({ full }) => ({ action: "snapshot", full }),
  ),
  defineTool(
    "browser_click",
    "Click by target words like 'Post button' (fast, preferred) or by @e ref. Pass exactly one.",
    z.object({ ref: z.string().optional(), target: z.string().optional() }),
    ({ ref, target }) => ({ action: "click", ref, target }),
  ),
  defineTool(
    "browser_type",
    "Type into a field by target words like 'Post text box' or by @e ref. Real key events, works in contenteditable editors like X's composer. submit presses Enter.",
    z.object({ ref: z.string().optional(), target: z.string().optional(), text: z.string(), submit: z.boolean().optional() }),
    ({ ref, target, text, submit }) => ({ action: "type", ref, target, text, submit }),
  ),
  defineTool(
    "browser_find",
    "Resolve target words to an @e ref without acting.",
    z.object({ target: z.string() }),
    ({ target }) => ({ action: "find", target }),
  ),
  defineTool(
    "browser_check",
    "Yes/no question about the current page, answered fast by Jev, e.g. 'Was the post published?'.",
    z.object({ question: z.string() }),
    ({ question }) => ({ action: "check", question }),
  ),
  defineTool(
    "browser_press",
    "Press a key: Enter, Backspace, Escape, Tab, arrows, Meta+A/C/V.",
    z.object({ key: z.string() }),
    ({ key }) => ({ action: "press", key }),
  ),
  defineTool(
    "browser_scroll",
    "Scroll the page.",
    z.object({ direction: z.enum(["up", "down"]), amount: z.number().int().optional() }),
    ({ direction, amount }) => ({ action: "scroll", direction, amount }),
  ),
  defineTool("browser_screenshot", "JPEG of the current viewport.", z.object({}), () => ({ action: "screenshot" })),
  defineTool(
    "browser_tabs",
    "List allowed tabs, or open/select/close them. New tabs start unallowed; ask the user to toggle them.",
    z.object({ action: z.enum(["list", "new", "select", "close"]), index: z.number().int().optional(), url: z.string().optional() }),
    ({ action, index, url }) => ({ action: "tabs", tab: action, index, url }),
  ),
  defineTool(
    "browser_wait",
    "Wait for milliseconds or for text to appear.",
    z.object({ ms: z.number().int().max(15000).optional(), text: z.string().optional() }),
    ({ ms, text }) => ({ action: "wait", ms, text }),
  ),
  defineTool(
    "browser_handoff",
    "Pause until the user finishes login, 2FA, or a captcha in Chrome and clicks Resume.",
    z.object({ reason: z.string() }),
    ({ reason }) => ({ action: "handoff", reason }),
  ),
];

export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));

/** The text an MCP client or LLM sees for a tool result. */
export function toolText(name: string, result: ActionResult): string {
  if (!result.ok) return result.error ?? "Action failed.";
  const text = result.text ?? "";
  const resolved = result.resolved;
  if (!resolved || resolved.by === "ref" || name === "browser_find") return text;
  const how = resolved.by === "jev" ? `jev p=${(resolved.p ?? 0).toFixed(2)}` : resolved.by;
  return `resolved: @${resolved.ref} (${how})\n${text}`;
}

/** JSON Schema for LLM tool APIs (Anthropic input_schema / OpenAI function.parameters). */
export function jsonSchema(tool: ToolDef): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema);
  return schema;
}

type CallAction = (request: ActionRequest) => Promise<ActionResult>;

interface ToolCallResult {
  [key: string]: unknown;
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

async function callTool(tool: ToolDef, args: unknown, call: CallAction): Promise<ToolCallResult> {
  let request: ActionRequest;
  try {
    request = tool.build(args);
  } catch (err) {
    return { content: [{ type: "text", text: `Invalid arguments: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
  const result = await call(request);
  if (!result.ok) return { content: [{ type: "text", text: toolText(tool.name, result) }], isError: true };
  if (result.imageBase64) {
    return {
      content: [
        { type: "image", data: result.imageBase64, mimeType: "image/jpeg" },
        { type: "text", text: toolText(tool.name, result) },
      ],
    };
  }
  return { content: [{ type: "text", text: toolText(tool.name, result) }] };
}

/** An MCP server exposing all browser tools; `call` runs the action (in-process or over HTTP). */
export function buildMcpServer(call: CallAction): McpServer {
  const server = new McpServer({ name: "browseforme", version: "0.1.0" });
  for (const tool of TOOLS) {
    if (Object.keys(tool.schema.shape).length === 0) {
      server.registerTool(tool.name, { description: tool.description }, () => callTool(tool, {}, call));
    } else {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, (args: unknown) => callTool(tool, args, call));
    }
  }
  return server;
}

import { type ActionRequest, runAction } from "../browser/actions";

/** A chat turn answered without an LLM. */
export interface FastReply {
  tool: string;
  ok: boolean;
  reply: string;
}

const COMPOUND = /\b(and|then)\b|[,;]/i;
const NAVIGATE = /^\s*(?:please\s+)?(?:open|go to|visit)\s+((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)\s*[.!]?\s*$/i;
const SCROLL = /^\s*(?:please\s+)?scroll\s+(up|down)\s*[.!]?\s*$/i;
const PRESS = /^\s*(?:please\s+)?press\s+(enter|escape|tab|backspace)\s*[.!]?\s*$/i;
const TYPE = /^\s*(?:please\s+)?type\s+"([^"]+)"\s+(?:in|into)\s+(.+?)\s*[.!]?\s*$/i;
const CLICK = /^\s*(?:please\s+)?(?:click|tap|press|hit|select|open)\s+(?:on\s+)?(.+?)\s*[.!]?\s*$/i;

/** Resolution misses fall through to the LLM, which can look around the page. */
const FALL_THROUGH = /^(Ambiguous target|No element matches)/;

function firstLine(text: string | undefined, prefix: string): string | undefined {
  return text?.split("\n").find((line) => line.startsWith(prefix));
}

async function run(tool: string, request: ActionRequest, reply: (text: string) => string): Promise<FastReply | null> {
  const result = await runAction(request);
  if (!result.ok) {
    const error = result.error ?? "Action failed.";
    return FALL_THROUGH.test(error) ? null : { tool, ok: false, reply: error };
  }
  const text = result.text ?? "";
  const flags = firstLine(text, "flags:");
  return { tool, ok: true, reply: flags ? `${reply(text)}\n${flags}` : reply(text) };
}

/** Handles single, unambiguous commands ("click the Post button", "scroll down") without an LLM; null means use the LLM. */
export async function tryFastPath(message: string): Promise<FastReply | null> {
  const text = message.trim();
  if (text.length > 120 || COMPOUND.test(text)) return null;

  let match = NAVIGATE.exec(text);
  if (match) {
    const url = match[1];
    return run("browser_navigate", { action: "navigate", url }, (out) => `Opened ${firstLine(out, "url: ")?.slice(5) ?? url}.`);
  }
  match = SCROLL.exec(text);
  if (match) {
    const direction = match[1].toLowerCase() === "up" ? "up" : "down";
    return run("browser_scroll", { action: "scroll", direction }, () => `Scrolled ${direction}.`);
  }
  match = PRESS.exec(text);
  if (match) {
    const key = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    return run("browser_press", { action: "press", key }, () => `Pressed ${key}.`);
  }
  match = TYPE.exec(text);
  if (match) {
    const [, typed, target] = match;
    return run("browser_type", { action: "type", target, text: typed }, (out) => `Typed into ${firstLine(out, "typed into: ")?.slice(12) ?? target}.`);
  }
  match = CLICK.exec(text);
  if (match) {
    const target = match[1];
    return run("browser_click", { action: "click", target }, (out) => `Clicked ${firstLine(out, "clicked: ")?.slice(9) ?? target}.`);
  }
  return null;
}

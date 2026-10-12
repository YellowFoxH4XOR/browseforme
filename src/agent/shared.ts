import type { AnthropicMessage, OpenAIMessage } from "./loop";

export const SYSTEM_PROMPT = `You control the user's real Chrome tabs through browser tools. Prefer target words: browser_click and browser_type accept \`target\`, for example "Post button" or "Post text box". Use @e refs only when a target is reported ambiguous, and only refs from the latest tool result; refs die after navigation.
If a result has a \`flags:\` line naming login_wall, captcha, or two_factor, call browser_handoff and stop.
To post on X: browser_navigate to https://x.com/compose/post, browser_type the user's exact text into target "Post text box", then browser_click target "Post button". Never post text the user did not give you. Then call browser_check with "Was the post published?" and report the answer; if browser_check is unavailable, call browser_snapshot and describe what is on screen.
If an action fails, call browser_snapshot once and retry with a ref.`;

export type Emit = (event: "token" | "tool" | "done" | "error", data: Record<string, unknown>) => void;

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  ok?: boolean;
}

export interface Thread {
  id: string;
  messages: TranscriptEntry[];
  claudeSessionId?: string;
  fastLog: string[];
  anthropic?: AnthropicMessage[];
  openai?: OpenAIMessage[];
}

export interface DaemonInfo {
  port: number;
  token: string;
}

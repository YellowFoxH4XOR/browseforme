import * as z from "zod/v4";
import { describe, type ElementRecord } from "./browser/snapshot";
import { loadConfig, log } from "./state";

/** Thresholds from TypeSafe's line-search cookbook: present answers read >= 0.9, absent <= 0.05. */
export const EXISTS_MIN = 0.7;
export const EXISTS_ABSENT = 0.35;
export const PICK_MIN = 0.6;
const FLAG_MIN = 0.7;

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export class JevUnavailable extends Error {
  constructor(readonly reason: "disabled" | "no-key") {
    super(`Jev unavailable: ${reason}`);
  }
}

export class JevError extends Error {
  constructor(readonly status: number | "network", detail: string) {
    super(`Jev ${status}: ${detail}`);
  }
}

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number() }),
  z.object({ type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), z.number()), confidence: z.number() }),
]);
const SystemOneResponse = z.object({ model: z.string(), answers: z.record(z.string(), Answer) });

type JevAnswer = z.infer<typeof Answer>;

export interface SystemOneResult {
  answers: Record<string, JevAnswer>;
  model: string;
  ms: number;
}

let lastError: string | null = null;
let warmed = false;

export function jevStatus(): string {
  const config = loadConfig();
  if (config.jevEnabled === false) return "disabled";
  if (!(config.typesafeApiKey || process.env.TYPESAFE_API_KEY)) return "no-key";
  if (lastError) return `error: ${lastError}`;
  return warmed ? "ready" : "warming";
}

function post(key: string, body: string, timeoutMs: number, keepalive: boolean): Promise<Response> {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body,
    keepalive,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** One System One request with the interactive retry policy; throws JevUnavailable or JevError. */
export async function systemOne(state: unknown, questions: Record<string, JevQuestion>, timeoutMs = 4000): Promise<SystemOneResult> {
  const config = loadConfig();
  if (config.jevEnabled === false) throw new JevUnavailable("disabled");
  const key = config.typesafeApiKey || process.env.TYPESAFE_API_KEY;
  if (!key) throw new JevUnavailable("no-key");

  const body = JSON.stringify({ state, model: config.jevModel || "jev-latest", questions });
  const started = performance.now();
  let status = "err";
  let model = "-";
  try {
    let res: Response;
    try {
      res = await post(key, body, timeoutMs, true);
    } catch {
      // Bun pools keep-alive sockets without a liveness check (oven-sh/bun#31894): retry once on a fresh connection.
      res = await post(key, body, 3000, false);
    }
    if (res.status === 429 || res.status === 529) {
      const header = res.headers.get("retry-after");
      const seconds = header === null ? 0 : Number(header);
      if (Number.isFinite(seconds) && seconds <= 1) {
        await Bun.sleep(Math.max(250, seconds * 1000));
        res = await post(key, body, timeoutMs, true);
      }
    }
    status = String(res.status);
    if (res.status === 401) {
      lastError = "invalid TypeSafe key";
      throw new JevError(401, "invalid TypeSafe key");
    }
    if (!res.ok) throw new JevError(res.status, (await res.text()).slice(0, 300));
    const parsed = SystemOneResponse.parse(await res.json());
    model = parsed.model;
    lastError = null;
    warmed = true;
    return { answers: parsed.answers, model, ms: Math.round(performance.now() - started) };
  } catch (err) {
    if (err instanceof JevError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    lastError = message.slice(0, 120);
    throw new JevError("network", message);
  } finally {
    log(`jev ms=${Math.round(performance.now() - started)} model=${model} q=${Object.keys(questions).join(",")} status=${status}`);
  }
}

/** Fire-and-forget request that opens the TLS connection before the first real decision. */
export function warmJev(): void {
  warmed = false;
  lastError = null;
  systemOne("ok", { warm: { type: "noul", instructions: "Is the state the word ok?" } }).catch(() => {});
}

function noul(result: SystemOneResult, key: string): number {
  const answer = result.answers[key];
  if (answer?.type !== "noul") throw new JevError("network", `missing noul answer ${key}`);
  return answer.noul;
}

function choice(result: SystemOneResult, key: string): Extract<JevAnswer, { type: "choice" }> {
  const answer = result.answers[key];
  if (answer?.type !== "choice") throw new JevError("network", `missing choice answer ${key}`);
  return answer;
}

export type PickOutcome =
  | { kind: "pick"; ref: string; p: number; ms: number }
  | { kind: "notfound"; ms: number }
  | { kind: "ambiguous"; ranked: { ref: string; p: number }[]; ms: number };

export interface PickInput {
  url: string;
  title: string;
  action: "click" | "type" | "find";
  request: string;
  elements: ElementRecord[];
}

const PICK_INSTRUCTIONS = "Which element in `elements` is the one the user's `request` refers to, for the `action`?";

/**
 * Asks Jev which element the request means. Both option orders ride in one request because
 * jev-1.13 leans toward the first-listed option; an answer counts only when both orders agree.
 */
export async function pickElement(input: PickInput): Promise<PickOutcome> {
  if (input.elements.length === 0) return { kind: "notfound", ms: 0 };
  const refs = input.elements.map((element) => element.ref);
  const state = {
    page: { url: input.url, title: input.title },
    action: input.action,
    request: input.request,
    elements: input.elements.map((element) => `${element.ref}| ${describe(element)}`).join("\n"),
  };
  const exists: JevQuestion = {
    type: "noul",
    instructions: "Does any element in `elements` match the user's `request`?",
    criteria: {
      true: "At least one listed element is clearly what the request refers to",
      false: "None of the listed elements is what the request refers to",
    },
  };
  const questions: Record<string, JevQuestion> =
    refs.length >= 2
      ? {
          pick: { type: "choice", instructions: PICK_INSTRUCTIONS, criteria: Object.fromEntries(refs.map((ref) => [ref, null])) },
          pick_rev: { type: "choice", instructions: PICK_INSTRUCTIONS, criteria: Object.fromEntries([...refs].reverse().map((ref) => [ref, null])) },
          exists,
        }
      : { exists };
  const result = await systemOne(state, questions);
  const existsP = noul(result, "exists");
  if (existsP < EXISTS_ABSENT) return { kind: "notfound", ms: result.ms };
  if (refs.length === 1) {
    return existsP >= EXISTS_MIN ? { kind: "pick", ref: refs[0], p: existsP, ms: result.ms } : { kind: "ambiguous", ranked: [{ ref: refs[0], p: existsP }], ms: result.ms };
  }
  const forward = choice(result, "pick");
  const reverse = choice(result, "pick_rev");
  const ranked = refs
    .map((ref) => ({ ref, p: ((forward.probabilities[ref] ?? 0) + (reverse.probabilities[ref] ?? 0)) / 2 }))
    .sort((a, b) => b.p - a.p);
  const top = ranked[0];
  if (existsP >= EXISTS_MIN && forward.choice === reverse.choice && top.ref === forward.choice && top.p >= PICK_MIN) {
    return { kind: "pick", ref: top.ref, p: top.p, ms: result.ms };
  }
  return { kind: "ambiguous", ranked: ranked.slice(0, 3), ms: result.ms };
}

/** State shared by page flags and checks. */
export interface PageFacts {
  page: { url: string; title: string };
  visibleText: string;
  elements: string;
}

const FLAG_QUESTIONS: Record<string, JevQuestion> = {
  login_wall: {
    type: "noul",
    instructions: "Is this page asking the user to sign in or log in before they can continue?",
    criteria: {
      true: "A sign-in form or a prompt that blocks the page until the user signs in",
      false: "The user is signed in, or the page works without signing in",
    },
  },
  captcha: {
    type: "noul",
    instructions: "Is this page showing a CAPTCHA, a bot check, or a 'verify you are human' challenge?",
    criteria: { true: "A challenge the user must solve before continuing", false: "No such challenge is shown" },
  },
  two_factor: {
    type: "noul",
    instructions: "Is this page asking for a verification code, a two-factor code, or a one-time password?",
    criteria: { true: "A field or prompt for a code sent by text, email, or an authenticator app", false: "No code is being requested" },
  },
  error_page: {
    type: "noul",
    instructions: "Is this page showing an error instead of its normal content, such as 'page not found', 'something went wrong', or 'access denied'?",
    criteria: { true: "The main content is an error message", false: "The page shows its normal content" },
  },
};

/** Returns the `flags: ...` line (flags >= 0.7, descending) or null when nothing is flagged. */
export async function pageFlags(facts: PageFacts): Promise<string | null> {
  const result = await systemOne(facts, FLAG_QUESTIONS);
  const raised = Object.keys(FLAG_QUESTIONS)
    .map((key) => ({ key, p: noul(result, key) }))
    .filter((flag) => flag.p >= FLAG_MIN)
    .sort((a, b) => b.p - a.p);
  return raised.length ? `flags: ${raised.map((flag) => `${flag.key} ${flag.p.toFixed(2)}`).join(", ")}` : null;
}

export async function checkPage(facts: PageFacts, question: string): Promise<number> {
  const result = await systemOne(facts, { answer: { type: "noul", instructions: question } });
  return noul(result, "answer");
}

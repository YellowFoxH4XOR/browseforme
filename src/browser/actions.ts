import * as z from "zod/v4";
import { checkPage, JevUnavailable, jevStatus, pageFlags, type PageFacts } from "../jev";
import { log } from "../state";
import { resolveTarget, type ResolvedBy } from "./resolve";
import { accessibilityTree, describe, render, type ScanResult } from "./snapshot";
import { ActionError, type Target, type Transport } from "./transport";
import { dropWorld, evalIn, evalJson, navMark, pageState, settle, waitForState, type NavMark } from "./world";

export const ActionRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string().min(1) }),
  z.object({ action: z.literal("snapshot"), full: z.boolean().optional() }),
  z.object({ action: z.literal("click"), ref: z.string().optional(), target: z.string().optional() }),
  z.object({ action: z.literal("type"), ref: z.string().optional(), target: z.string().optional(), text: z.string(), submit: z.boolean().optional() }),
  z.object({ action: z.literal("find"), target: z.string().min(1) }),
  z.object({ action: z.literal("check"), question: z.string().min(1) }),
  z.object({ action: z.literal("press"), key: z.string().min(1) }),
  z.object({ action: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.number().int().positive().optional() }),
  z.object({ action: z.literal("screenshot") }),
  z.object({
    action: z.literal("tabs"),
    tab: z.enum(["list", "new", "select", "close"]),
    index: z.number().int().nonnegative().optional(),
    url: z.string().optional(),
  }),
  z.object({ action: z.literal("wait"), ms: z.number().int().nonnegative().optional(), text: z.string().optional() }),
  z.object({ action: z.literal("handoff"), reason: z.string().min(1) }),
]);
export type ActionRequest = z.infer<typeof ActionRequest>;

export interface ResolvedInfo {
  ref: string;
  by: ResolvedBy;
  p?: number;
  jevMs?: number;
  rebound?: string;
}

export interface ActionResult {
  ok: boolean;
  text?: string;
  error?: string;
  ms: number;
  imageBase64?: string;
  resolved?: ResolvedInfo;
}

type Outcome = Omit<ActionResult, "ms">;

interface Located {
  x: number;
  y: number;
  role: string;
  name: string;
  disabled: boolean;
  ref: string;
  rebound: string | null;
  url: string;
}

interface KeySpec {
  vk: number;
  code: string;
  key: string;
  text?: string;
  modifiers?: number;
  commands?: string[];
}

const KEYS: Record<string, KeySpec> = {
  Enter: { vk: 13, code: "Enter", key: "Enter", text: "\r" },
  Backspace: { vk: 8, code: "Backspace", key: "Backspace" },
  Escape: { vk: 27, code: "Escape", key: "Escape" },
  Tab: { vk: 9, code: "Tab", key: "Tab" },
  ArrowUp: { vk: 38, code: "ArrowUp", key: "ArrowUp" },
  ArrowDown: { vk: 40, code: "ArrowDown", key: "ArrowDown" },
  ArrowLeft: { vk: 37, code: "ArrowLeft", key: "ArrowLeft" },
  ArrowRight: { vk: 39, code: "ArrowRight", key: "ArrowRight" },
  // `commands` makes the editing shortcuts work on macOS, where Chrome routes Cmd shortcuts through the menu.
  "Meta+A": { vk: 65, code: "KeyA", key: "a", modifiers: 4, commands: ["selectAll"] },
  "Meta+C": { vk: 67, code: "KeyC", key: "c", modifiers: 4, commands: ["copy"] },
  "Meta+V": { vk: 86, code: "KeyV", key: "v", modifiers: 4, commands: ["paste"] },
};

let transport: Transport | null = null;

/** Daemon wiring: the transport chosen at boot. */
export function configureActions(next: Transport): void {
  transport = next;
}

// ---------------------------------------------------------------------------- mutex

let locked = false;
const queue: (() => void)[] = [];

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (locked) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const grant = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const index = queue.indexOf(grant);
      if (index >= 0) queue.splice(index, 1);
      reject(new ActionError("Browser busy"));
    }, 60_000);
    queue.push(grant);
    await promise;
  } else {
    locked = true;
  }
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else locked = false;
  }
}

// ---------------------------------------------------------------------------- entry point

export async function runAction(raw: unknown): Promise<ActionResult> {
  const started = performance.now();
  const parsed = ActionRequest.safeParse(raw);
  let outcome: Outcome;
  let name = "invalid";
  if (!parsed.success) {
    outcome = { ok: false, error: `Invalid action request: ${z.prettifyError(parsed.error)}` };
  } else {
    const request = parsed.data;
    name = request.action;
    try {
      outcome = request.action === "handoff" ? handoff(request.reason) : await withLock(() => dispatch(request));
    } catch (err) {
      outcome = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        text: err instanceof ActionError ? err.text : undefined,
      };
    }
  }
  const ms = Math.round(performance.now() - started);
  log(`action=${name} ms=${ms} by=${outcome.resolved?.by ?? "-"} jevMs=${outcome.resolved?.jevMs ?? "-"} ok=${outcome.ok}`);
  return { ...outcome, ms };
}

function dispatch(request: Exclude<ActionRequest, { action: "handoff" }>): Promise<Outcome> {
  switch (request.action) {
    case "navigate":
      return navigate(request.url);
    case "snapshot":
      return snapshot(request.full === true);
    case "click":
      return click(request);
    case "type":
      return typeInto(request);
    case "find":
      return find(request.target);
    case "check":
      return check(request.question);
    case "press":
      return press(request.key);
    case "scroll":
      return scroll(request.direction, request.amount ?? 600);
    case "screenshot":
      return screenshot();
    case "tabs":
      return tabs(request);
    case "wait":
      return waitFor(request.ms, request.text);
  }
}

// ---------------------------------------------------------------------------- helpers

function requireTarget(): Target {
  if (!transport) throw new ActionError("Daemon is still starting.");
  const target = transport.current();
  if (typeof target === "string") throw new ActionError(target);
  pageState(target);
  return target;
}

function scanCompact(target: Target): Promise<ScanResult> {
  return evalJson<ScanResult>(target, "__bfm.scan(60)");
}

/** Settles after input; if the input started a cross-document navigation, waits for DOMContentLoaded and settles the new page. */
async function settleAfter(target: Target, mark: NavMark): Promise<void> {
  await settle(target, 120, 1000);
  if (pageState(target).navStarts === mark.navStarts) return;
  await waitForState(target, (s) => s.dcl > mark.dcl || s.navStops > mark.navStops, 10_000);
  dropWorld(target);
  await settle(target, 150, 2000);
}

async function factsFor(target: Target, scan: ScanResult): Promise<PageFacts> {
  return {
    page: { url: scan.url, title: scan.title },
    visibleText: String(await evalIn(target, "__bfm.text(1500)")),
    elements: scan.elements
      .slice(0, 40)
      .map((element) => `${element.ref}| ${describe(element)}`)
      .join("\n"),
  };
}

/** Jev page flags, given at most 800 ms after the snapshot is ready; late or failed answers are dropped. */
async function flagsAfter(target: Target, scan: ScanResult): Promise<string | null> {
  const status = jevStatus();
  if (status === "no-key" || status === "disabled") return null;
  const flags = factsFor(target, scan)
    .then(pageFlags)
    .catch(() => null);
  return Promise.race([flags, Bun.sleep(800).then(() => null)]);
}

async function resolveRef(
  target: Target,
  request: { ref?: string; target?: string },
  action: "click" | "type",
): Promise<ResolvedInfo> {
  const ref = request.ref?.trim();
  const words = request.target?.trim();
  if (ref && !words) return { ref: ref.replace(/^@/, ""), by: "ref" };
  if (!words || ref) throw new ActionError("Pass exactly one of ref or target.");
  const result = await resolveTarget(target, words, action);
  if ("error" in result) throw new ActionError(result.error);
  return { ref: result.ref, by: result.by, p: result.p, jevMs: result.jevMs };
}

async function locate(target: Target, ref: string): Promise<Located> {
  const located = await evalJson<Located | null>(target, `__bfm.locate(${JSON.stringify(ref)})`);
  if (!located) throw new ActionError(`Unknown ref @${ref}. Call browser_snapshot.`);
  const shownRef = located.rebound ?? located.ref;
  if (located.disabled) throw new ActionError(`Element @${shownRef} ${located.role} "${located.name}" is disabled.`);
  return located;
}

async function mouseClick(target: Target, x: number, y: number): Promise<void> {
  await target.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await target.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  await target.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
}

async function sendKey(target: Target, spec: KeySpec): Promise<void> {
  await target.send("Input.dispatchKeyEvent", {
    type: spec.text ? "keyDown" : "rawKeyDown",
    modifiers: spec.modifiers ?? 0,
    windowsVirtualKeyCode: spec.vk,
    code: spec.code,
    key: spec.key,
    ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
    ...(spec.commands ? { commands: spec.commands } : {}),
  });
  await target.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, windowsVirtualKeyCode: spec.vk, code: spec.code, key: spec.key });
}

async function typeChar(target: Target, ch: string): Promise<void> {
  if (ch === "\n" || ch === "\r") return sendKey(target, KEYS.Enter);
  const upper = ch.toUpperCase();
  const letter = /^[a-z]$/i.test(ch);
  const digit = /^[0-9]$/.test(ch);
  const vk = letter ? upper.charCodeAt(0) : digit ? ch.charCodeAt(0) : ch === " " ? 32 : 0;
  const code = letter ? `Key${upper}` : digit ? `Digit${ch}` : ch === " " ? "Space" : "";
  await target.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: vk, code, key: ch, text: ch, unmodifiedText: ch });
  await target.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, code, key: ch });
}

async function clearField(target: Target): Promise<void> {
  await sendKey(target, KEYS["Meta+A"]);
  await sendKey(target, KEYS.Backspace);
}

/** Whitespace-insensitive check that the focused field now holds `text`. */
async function focusedHolds(target: Target, text: string): Promise<boolean> {
  const value = await evalIn(
    target,
    `(() => { const el = document.activeElement; if (!el) return ""; return "value" in el && typeof el.value === "string" ? el.value : el.textContent ?? ""; })()`,
  );
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  return squash(String(value)).includes(squash(text));
}

// ---------------------------------------------------------------------------- actions

async function navigate(url: string): Promise<Outcome> {
  const target = requireTarget();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|javascript|blob|file|chrome):/i.test(url);
  const full = hasScheme ? url : `https://${url}`;
  const mark = navMark(target);
  const result = await target.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url: full });
  if (result.errorText) throw new ActionError(result.errorText);
  if (result.loaderId) {
    await waitForState(target, (s) => s.dcl > mark.dcl || s.navStops > mark.navStops, 15_000);
    dropWorld(target);
  }
  await settle(target, 150, 2000);
  const scan = await scanCompact(target);
  const flags = await flagsAfter(target, scan);
  return { ok: true, text: [flags, render(scan)].filter(Boolean).join("\n") };
}

async function snapshot(full: boolean): Promise<Outcome> {
  const target = requireTarget();
  const scan = await evalJson<ScanResult>(target, "__bfm.scan(200)");
  let text = render(scan);
  if (full) text += `\naccessibility:\n${await accessibilityTree(target)}`;
  return { ok: true, text };
}

async function click(request: { ref?: string; target?: string }): Promise<Outcome> {
  const target = requireTarget();
  const resolved = await resolveRef(target, request, "click");
  const located = await locate(target, resolved.ref);
  const mark = navMark(target);
  await mouseClick(target, located.x, located.y);
  await settleAfter(target, mark);
  const scan = await scanCompact(target);
  const urlChanged = pageState(target).urlChanges > mark.urlChanges || scan.url !== located.url;
  const flags = urlChanged ? await flagsAfter(target, scan) : null;
  const rebound = located.rebound ?? undefined;
  const head = `clicked: @${located.ref} ${located.role} "${located.name}"${rebound ? ` (rebound to @${rebound})` : ""}`;
  return { ok: true, text: [flags, head, render(scan)].filter(Boolean).join("\n"), resolved: { ...resolved, rebound } };
}

async function typeInto(request: { ref?: string; target?: string; text: string; submit?: boolean }): Promise<Outcome> {
  const target = requireTarget();
  const resolved = await resolveRef(target, request, "type");
  const located = await locate(target, resolved.ref);
  const state = pageState(target);
  const mark = navMark(target);
  await mouseClick(target, located.x, located.y);
  if (state.typingMode === "insertText") {
    await clearField(target);
    await target.send("Input.insertText", { text: request.text });
  } else {
    try {
      await clearField(target);
      for (const ch of request.text) {
        await typeChar(target, ch);
        await Bun.sleep(2 + Math.random() * 6);
      }
    } catch {
      await clearField(target);
      await target.send("Input.insertText", { text: request.text });
    }
    // Some editors ignore synthetic key events; insertText reaches them through the IME path.
    if (request.text.trim() && !(await focusedHolds(target, request.text))) {
      await clearField(target);
      await target.send("Input.insertText", { text: request.text });
      state.typingMode = "insertText";
    }
  }
  if (request.submit) await sendKey(target, KEYS.Enter);
  await settleAfter(target, mark);
  const scan = await scanCompact(target);
  const rebound = located.rebound ?? undefined;
  const head = `typed into: @${located.ref} ${located.role} "${located.name}"${rebound ? ` (rebound to @${rebound})` : ""}`;
  return { ok: true, text: `${head}\n${render(scan)}`, resolved: { ...resolved, rebound } };
}

async function find(words: string): Promise<Outcome> {
  const target = requireTarget();
  const result = await resolveTarget(target, words, "find");
  if ("error" in result) throw new ActionError(result.error);
  const how = result.by === "jev" ? `jev p=${(result.p ?? 0).toFixed(2)}` : result.by;
  const element = result.element ? ` ${describe(result.element)}` : "";
  return {
    ok: true,
    text: `found: @${result.ref}${element} (${how})`,
    resolved: { ref: result.ref, by: result.by, p: result.p, jevMs: result.jevMs },
  };
}

async function check(question: string): Promise<Outcome> {
  const target = requireTarget();
  const scan = await evalJson<ScanResult>(target, "__bfm.scan(40)");
  let p: number;
  try {
    p = await checkPage(await factsFor(target, scan), question);
  } catch (err) {
    if (err instanceof JevUnavailable && err.reason === "disabled") throw new ActionError("browser_check needs Jev, which is disabled in Settings.");
    if (err instanceof JevUnavailable) throw new ActionError("browser_check needs a TypeSafe API key: set it in Settings or export TYPESAFE_API_KEY.");
    throw new ActionError(`browser_check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, text: `check: ${p >= 0.5 ? "yes" : "no"} (${p.toFixed(2)})\nurl: ${scan.url}` };
}

async function press(key: string): Promise<Outcome> {
  const spec = KEYS[key];
  if (!spec) throw new ActionError(`Unsupported key ${key}. Supported: ${Object.keys(KEYS).join(", ")}.`);
  const target = requireTarget();
  const mark = navMark(target);
  await sendKey(target, spec);
  await settleAfter(target, mark);
  return { ok: true, text: `pressed: ${key}\n${render(await scanCompact(target))}` };
}

async function scroll(direction: "up" | "down", amount: number): Promise<Outcome> {
  const target = requireTarget();
  const { cssLayoutViewport } = await target.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics");
  const x = Math.round(cssLayoutViewport.clientWidth / 2);
  const y = Math.round(cssLayoutViewport.clientHeight / 2);
  const mark = navMark(target);
  const before = Number(await evalIn(target, "scrollY"));
  await target.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: direction === "up" ? -amount : amount, buttons: 0, modifiers: 0 });
  // Wheel scrolling animates without DOM mutations: wait until scrollY holds still (max 1s).
  // If nothing moved after 200 ms the page cannot scroll further.
  let last = before;
  for (let waited = 50; waited <= 1000; waited += 50) {
    await Bun.sleep(50);
    const now = Number(await evalIn(target, "scrollY"));
    if (now === last && (now !== before || waited >= 200)) break;
    last = now;
  }
  await settleAfter(target, mark);
  return { ok: true, text: `scrolled: ${direction} ${amount}\n${render(await scanCompact(target))}` };
}

async function screenshot(): Promise<Outcome> {
  const target = requireTarget();
  let data: string;
  try {
    ({ data } = await target.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60 }, 5000));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("CDP timeout")) throw new ActionError("Screenshot timed out; the tab may be in the background.");
    throw err;
  }
  return { ok: true, text: `url: ${String(await evalIn(target, "location.href"))}`, imageBase64: data };
}

async function tabs(request: { tab: "list" | "new" | "select" | "close"; index?: number; url?: string }): Promise<Outcome> {
  if (!transport) throw new ActionError("Daemon is still starting.");
  if (request.tab === "new") return { ok: true, text: await transport.newTab(request.url) };
  if (request.tab === "select" || request.tab === "close") {
    if (request.index === undefined) throw new ActionError(`index is required for tabs ${request.tab}.`);
    const text = request.tab === "select" ? await transport.select(request.index) : await transport.close(request.index);
    return { ok: true, text };
  }
  const list = await transport.list();
  if (list.length === 0) {
    const empty = transport.mode === "extension" ? "No allowed tabs. Toggle the BrowseForMe extension on a tab to grant it." : "No tabs.";
    return { ok: true, text: empty };
  }
  return { ok: true, text: list.map((tab, index) => `${tab.current ? "*" : " "}${index} ${tab.url} ${tab.title}`).join("\n") };
}

async function waitFor(ms: number | undefined, text: string | undefined): Promise<Outcome> {
  const target = requireTarget();
  if (text) {
    const deadline = Date.now() + 10_000;
    while (!(await evalIn(target, `__bfm.has(${JSON.stringify(text)})`))) {
      if (Date.now() > deadline) throw new ActionError(`Text not found within 10s: ${text}`);
      await Bun.sleep(100);
    }
  } else {
    await Bun.sleep(Math.min(ms ?? 1000, 15_000));
  }
  return { ok: true, text: render(await scanCompact(target)) };
}

/**
 * Hands control to the user (login, 2FA, captcha). Returns at once: MCP clients cap tool calls
 * (Codex at 60 s), and the agent's own conversation is where the user says they are done.
 */
function handoff(reason: string): Outcome {
  return {
    ok: true,
    text: `Paused for the user: ${reason}\nAsk the user to do this in the allowed Chrome tab and to tell you when it is done. Do not use browser tools until they confirm; then call browser_snapshot.`,
  };
}

// ---------------------------------------------------------------------------- daemon helpers

/** Logs `engine <userAgent> | webdriver=<bool>` once a target is available. */
export async function engineCheck(): Promise<boolean> {
  try {
    const value = await withLock(async () => String(await evalIn(requireTarget(), `navigator.userAgent + " | webdriver=" + navigator.webdriver`)));
    log(`engine ${value}`);
    return true;
  } catch {
    return false;
  }
}

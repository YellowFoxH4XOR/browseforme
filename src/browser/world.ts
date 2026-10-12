import { DETACHED_EVENT } from "./ext";
import type { CdpParams, Target } from "./transport";

const scannerSource = (await Bun.file(new URL("./scanner.js", import.meta.url)).text()).trim();
const INSTALL = `globalThis.__bfm ??= ${scannerSource};\ntrue`;

/** Per-target page bookkeeping driven by Page domain events. */
export interface PageState {
  contextId?: number;
  creating?: Promise<number>;
  mainFrameId?: string;
  /** Main-frame loads started (cross-document navigations, including ones later cancelled). */
  navStarts: number;
  /** Main-frame loads stopped (fires for cancelled navigations too). */
  navStops: number;
  /** URL changes: cross-document commits plus same-document (pushState/fragment) navigations. */
  urlChanges: number;
  dcl: number;
  typingMode: "keys" | "insertText";
  waiters: Set<() => void>;
}

export type NavMark = Pick<PageState, "navStarts" | "navStops" | "urlChanges" | "dcl">;

interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * Keyed by the Target object, not its id: a re-attached session or a re-granted tab gets a new
 * Target, and its state must subscribe to that Target's events rather than a dead listener set.
 */
const states = new WeakMap<Target, PageState>();

export function pageState(target: Target): PageState {
  let state = states.get(target);
  if (state) return state;
  const fresh: PageState = { navStarts: 0, navStops: 0, urlChanges: 0, dcl: 0, typingMode: "keys", waiters: new Set() };
  states.set(target, fresh);
  target.onEvent((method, params) => onPageEvent(fresh, method, params));
  return fresh;
}

function onPageEvent(state: PageState, method: string, params: CdpParams): void {
  const isMain = (frameId: unknown) => state.mainFrameId === undefined || frameId === state.mainFrameId;
  switch (method) {
    case "Page.frameStartedLoading":
      if (isMain(params.frameId)) state.navStarts++;
      break;
    case "Page.frameStoppedLoading":
      if (isMain(params.frameId)) state.navStops++;
      break;
    case "Page.frameNavigated": {
      const frame = params.frame;
      if (!frame || typeof frame !== "object" || ("parentId" in frame && frame.parentId)) return;
      state.contextId = undefined;
      if ("id" in frame && typeof frame.id === "string") state.mainFrameId = frame.id;
      state.urlChanges++;
      break;
    }
    case "Page.navigatedWithinDocument":
      if (isMain(params.frameId)) state.urlChanges++;
      break;
    case "Page.domContentEventFired":
      state.dcl++;
      break;
    case DETACHED_EVENT:
      state.contextId = undefined;
      break;
    default:
      return;
  }
  for (const wake of [...state.waiters]) wake();
}

export function navMark(target: Target): NavMark {
  const { navStarts, navStops, urlChanges, dcl } = pageState(target);
  return { navStarts, navStops, urlChanges, dcl };
}

/** Resolves true once `done(state)` holds, false after `timeoutMs`. */
export async function waitForState(target: Target, done: (state: PageState) => boolean, timeoutMs: number): Promise<boolean> {
  const state = pageState(target);
  if (done(state)) return true;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const wake = () => {
    if (!done(state)) return;
    finish(true);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  const finish = (value: boolean) => {
    clearTimeout(timer);
    state.waiters.delete(wake);
    resolve(value);
  };
  state.waiters.add(wake);
  return promise;
}

export function dropWorld(target: Target): void {
  pageState(target).contextId = undefined;
}

async function createWorld(target: Target, state: PageState): Promise<number> {
  const { frameTree } = await target.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  state.mainFrameId = frameTree.frame.id;
  const { executionContextId } = await target.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "bfm",
  });
  await runIn(target, executionContextId, INSTALL);
  state.contextId = executionContextId;
  return executionContextId;
}

async function world(target: Target): Promise<number> {
  const state = pageState(target);
  if (state.contextId !== undefined) return state.contextId;
  state.creating ??= createWorld(target, state).finally(() => {
    state.creating = undefined;
  });
  return state.creating;
}

async function runIn(target: Target, contextId: number, expression: string, awaitPromise = false): Promise<unknown> {
  const reply = await target.send<EvaluateResult>("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise });
  if (reply.exceptionDetails) {
    throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "Evaluation failed");
  }
  return reply.result?.value;
}

const CONTEXT_GONE = /Cannot find context|Execution context was destroyed|Inspected target navigated or closed/;

/** Evaluates in the target's isolated world; recreates the world once if the document changed. */
export async function evalIn(target: Target, expression: string, awaitPromise = false): Promise<unknown> {
  try {
    return await runIn(target, await world(target), expression, awaitPromise);
  } catch (err) {
    if (!(err instanceof Error) || !CONTEXT_GONE.test(err.message)) throw err;
    dropWorld(target);
    return runIn(target, await world(target), expression, awaitPromise);
  }
}

/** Evaluates a scanner call that returns a JSON string and parses it. */
export async function evalJson<T>(target: Target, expression: string): Promise<T> {
  const value = await evalIn(target, expression);
  // The scanner (our own code) produced this JSON; its shape is the declared T.
  return JSON.parse(String(value)) as T;
}

/** Waits until the page has had no DOM mutations for `quietMs`, or `maxMs` passed. Polls from the daemon so background-tab timer throttling cannot stretch it. */
export async function settle(target: Target, quietMs: number, maxMs: number): Promise<number> {
  const start = performance.now();
  for (;;) {
    const idle = Number(await evalIn(target, "__bfm.idle()"));
    const elapsed = performance.now() - start;
    if (idle >= quietMs || elapsed >= maxMs) return Math.round(elapsed);
    await Bun.sleep(Math.max(5, Math.min(quietMs - idle, maxMs - elapsed, 50)));
  }
}

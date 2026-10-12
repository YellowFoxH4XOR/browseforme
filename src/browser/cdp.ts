import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_DIR, pidAlive } from "../state";
import { ActionError, type CdpParams, type TabInfo, type Target, type Transport, type TransportStatus } from "./transport";

const CHROME_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
];

const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

type Listener = (method: string, params: CdpParams) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

/** Browser-level CDP WebSocket with flattened session routing. */
class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessionListeners = new Map<string, Set<Listener>>();
  private readonly browserListeners = new Set<Listener>();
  closed = false;

  private constructor(private readonly ws: WebSocket, onClose: () => void) {
    ws.addEventListener("message", (event) => this.dispatch(JSON.parse(String(event.data))));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
      onClose();
    });
  }

  static open(url: string, onClose: () => void): Promise<CdpConnection> {
    const { promise, resolve, reject } = Promise.withResolvers<CdpConnection>();
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(new CdpConnection(ws, onClose)), { once: true });
    ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    return promise;
  }

  send<T>(method: string, params: CdpParams = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const limit = timeoutMs ?? (method === "Page.navigate" ? 45_000 : 30_000);
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, limit);
    // The caller names the result shape it reads (see Target.send); CDP results are not validated further.
    this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return promise;
  }

  onSession(sessionId: string, fn: Listener): () => void {
    let set = this.sessionListeners.get(sessionId);
    if (!set) this.sessionListeners.set(sessionId, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  onBrowser(fn: Listener): () => void {
    this.browserListeners.add(fn);
    return () => this.browserListeners.delete(fn);
  }

  close(): void {
    this.ws.close();
  }

  /** Routes one message from Chrome: responses by id, events by sessionId. */
  private dispatch(message: unknown): void {
    if (!message || typeof message !== "object") return;
    if ("id" in message && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = "error" in message ? message.error : undefined;
      if (error && typeof error === "object" && "message" in error) pending.reject(new Error(String(error.message)));
      else pending.resolve("result" in message ? message.result : {});
      return;
    }
    if (!("method" in message) || typeof message.method !== "string") return;
    const sessionId = "sessionId" in message && typeof message.sessionId === "string" ? message.sessionId : undefined;
    const params = "params" in message && message.params && typeof message.params === "object" ? (message.params as CdpParams) : {};
    const listeners = sessionId ? this.sessionListeners.get(sessionId) : this.browserListeners;
    for (const fn of listeners ?? []) fn(message.method, params);
  }
}

async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** Polls /json/version until Chrome serves it; returns the browser WebSocket URL or null. */
async function waitForCdp(port: number, timeoutMs: number, chrome: Subprocess): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        const body: unknown = await res.json();
        if (body && typeof body === "object" && "webSocketDebuggerUrl" in body && typeof body.webSocketDebuggerUrl === "string") {
          return body.webSocketDebuggerUrl;
        }
      }
    } catch {
      // not listening yet
    }
    if (chrome.exitCode !== null) return null; // handed off to another Chrome or crashed
    await Bun.sleep(100);
  }
  return null;
}

function lockPid(): number | null {
  try {
    const match = /-(\d+)$/.exec(readlinkSync(join(PROFILE_DIR, "SingletonLock")));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export class OwnedTransport implements Transport {
  readonly mode = "owned" as const;
  cdpPort?: number;
  private state: TransportStatus = { browser: "starting" };
  private conn?: CdpConnection;
  private chrome?: Subprocess;
  private readonly targets = new Map<string, Target>();
  private activeId?: string;
  private stopping = false;

  status(): TransportStatus {
    return this.state;
  }

  async start(): Promise<void> {
    const bin = CHROME_BINARIES.find((path) => existsSync(path));
    if (!bin) {
      this.state = { browser: "down", error: "No Chrome, Brave, or Arc binary found" };
      return;
    }
    mkdirSync(PROFILE_DIR, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await freePort();
      const chrome = Bun.spawn(
        [
          bin,
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${PROFILE_DIR}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,900",
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      const wsUrl = await waitForCdp(port, 8000, chrome);
      if (wsUrl) {
        this.chrome = chrome;
        this.cdpPort = port;
        await this.connect(wsUrl);
        return;
      }
      chrome.kill();
      const pid = lockPid();
      if (pid !== null && pidAlive(pid)) {
        this.state = { browser: "down", error: `Profile is locked by pid ${pid}. Quit that Chrome or run bfm down.` };
        return;
      }
      if (attempt === 0 && pid !== null) {
        for (const name of LOCK_FILES) rmSync(join(PROFILE_DIR, name), { force: true });
        continue;
      }
      break;
    }
    this.state = { browser: "down", error: "Chrome did not open its DevTools port within 8s." };
  }

  private async connect(wsUrl: string): Promise<void> {
    this.conn = await CdpConnection.open(wsUrl, () => {
      if (!this.stopping) this.state = { browser: "down", error: "Chrome exited. Run bfm down, then bfm up." };
      this.targets.clear();
      this.activeId = undefined;
    });
    this.conn.onBrowser((method, params) => {
      if (method === "Target.targetDestroyed") void this.forget(String(params.targetId));
      if (method === "Target.detachedFromTarget" && typeof params.targetId === "string") void this.forget(params.targetId);
    });
    await this.conn.send("Target.setDiscoverTargets", { discover: true });
    const page = (await this.pages())[0];
    this.activeId = page ? page.targetId : await this.create("about:blank");
    await this.attach(this.activeId);
    this.state = { browser: "ready" };
  }

  private async pages(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.conn!.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    return targetInfos.filter((info) => info.type === "page");
  }

  private async create(url: string): Promise<string> {
    const { targetId } = await this.conn!.send<{ targetId: string }>("Target.createTarget", { url });
    return targetId;
  }

  private async attach(targetId: string): Promise<Target> {
    const known = this.targets.get(targetId);
    if (known) return known;
    const conn = this.conn!;
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const target: Target = {
      id: targetId,
      send: (method, params, timeoutMs) => conn.send(method, params, sessionId, timeoutMs),
      onEvent: (fn) => conn.onSession(sessionId, fn),
    };
    this.targets.set(targetId, target);
    await target.send("Page.enable");
    return target;
  }

  /** Drops a dead target; if it was active, promote the next page or a blank one. */
  private async forget(targetId: string): Promise<void> {
    this.targets.delete(targetId);
    if (this.activeId !== targetId || this.stopping || this.conn?.closed) return;
    this.activeId = undefined;
    try {
      const next = (await this.pages()).find((info) => info.targetId !== targetId);
      const id = next ? next.targetId : await this.create("about:blank");
      await this.attach(id);
      this.activeId = id;
    } catch {
      // browser is going away; status flips via the connection close handler
    }
  }

  current(): Target | string {
    if (this.state.browser !== "ready") return this.state.error ?? "Chrome is still starting.";
    const target = this.activeId ? this.targets.get(this.activeId) : undefined;
    return target ?? "No page is open. Call browser_tabs with action new.";
  }

  async list(): Promise<TabInfo[]> {
    if (!this.conn || this.conn.closed) return [];
    return (await this.pages()).map((info) => ({
      key: info.targetId,
      url: info.url,
      title: info.title,
      current: info.targetId === this.activeId,
    }));
  }

  private async pick(index: number): Promise<TabInfo> {
    const tabs = await this.list();
    const tab = tabs[index];
    if (!tab) throw new ActionError(`No tab at index ${index}. Call browser_tabs with action list.`);
    return tab;
  }

  async newTab(url?: string): Promise<string> {
    if (!this.conn || this.conn.closed) throw new ActionError(this.state.error ?? "Chrome is not running.");
    const id = await this.create(url ?? "about:blank");
    await this.attach(id);
    this.activeId = id;
    return `Opened and selected a new tab: ${url ?? "about:blank"}`;
  }

  async select(index: number): Promise<string> {
    const tab = await this.pick(index);
    await this.attach(tab.key);
    await this.conn!.send("Target.activateTarget", { targetId: tab.key });
    this.activeId = tab.key;
    return `Selected tab ${index}: ${tab.url}`;
  }

  async close(index: number): Promise<string> {
    const tab = await this.pick(index);
    await this.conn!.send("Target.closeTarget", { targetId: tab.key });
    await this.forget(tab.key);
    return `Closed tab ${index}: ${tab.url}`;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.conn?.close();
    const chrome = this.chrome;
    if (!chrome || chrome.exitCode !== null) return;
    chrome.kill("SIGTERM");
    const exited = await Promise.race([chrome.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) chrome.kill("SIGKILL");
  }
}

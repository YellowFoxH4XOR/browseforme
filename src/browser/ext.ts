import type { ServerWebSocket } from "bun";
import * as z from "zod/v4";
import { ActionError, type CdpParams, type TabInfo, type Target, type Transport, type TransportStatus } from "./transport";

/** Synthetic event delivered to a tab's listeners when Chrome's debugger detaches from it. */
export const DETACHED_EVENT = "BrowseForMe.detached";

const NOT_CONNECTED = "Extension not connected yet. Load the unpacked extension from extension/ via chrome://extensions.";
const DISCONNECTED = "Extension disconnected.";
const NO_ALLOWED_TAB = "No allowed tab. Toggle the BrowseForMe extension on the tab you want to work on.";

const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.string().optional() }),
  z.object({
    type: z.literal("tabState"),
    tabs: z.array(z.object({ tabId: z.number(), url: z.string(), title: z.string(), active: z.boolean() })),
  }),
  z.object({ type: z.literal("event"), tabId: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("detached"), tabId: z.number(), reason: z.string().optional() }),
  z.object({ type: z.literal("res"), id: z.number(), result: z.unknown().optional(), error: z.string().optional() }),
]);

type Listener = (method: string, params: CdpParams) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

interface AllowedTab {
  url: string;
  title: string;
  active: boolean;
  allowedAt: number;
}

export class ExtensionTransport implements Transport {
  readonly mode = "extension" as const;
  private socket: ServerWebSocket<unknown> | null = null;
  private everConnected = false;
  private readonly tabs = new Map<number, AllowedTab>();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<number, Set<Listener>>();
  private readonly ready = new Map<number, Promise<void>>();
  private readonly targets = new Map<number, Target>();
  private selected?: number;
  private nextId = 1;
  private allowSeq = 0;
  /** Called after every tabState push (the daemon runs its one-time engine check from here). */
  onTabsChanged?: () => void;

  socketOpen(ws: ServerWebSocket<unknown>): void {
    this.socket?.close(4000, "replaced by a newer extension connection");
    this.socket = ws;
    this.everConnected = true;
  }

  socketMessage(ws: ServerWebSocket<unknown>, data: string | Buffer): void {
    if (ws !== this.socket) return;
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const parsed = Frame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "hello":
        ws.send(JSON.stringify({ type: "hello-ack" }));
        return;
      case "tabState":
        this.applyTabState(frame.tabs);
        return;
      case "event":
        for (const fn of this.listeners.get(frame.tabId) ?? []) fn(frame.method, frame.params ?? {});
        return;
      case "detached":
        this.ready.delete(frame.tabId);
        for (const fn of this.listeners.get(frame.tabId) ?? []) fn(DETACHED_EVENT, { reason: frame.reason ?? "" });
        return;
      case "res": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.error !== undefined) pending.reject(new Error(frame.error));
        else pending.resolve(frame.result ?? {});
        return;
      }
    }
  }

  socketClose(ws: ServerWebSocket<unknown>): void {
    if (ws !== this.socket) return;
    this.socket = null;
    this.ready.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(DISCONNECTED));
    }
    this.pending.clear();
  }

  private applyTabState(tabs: { tabId: number; url: string; title: string; active: boolean }[]): void {
    const seen = new Set<number>();
    for (const tab of tabs) {
      seen.add(tab.tabId);
      const known = this.tabs.get(tab.tabId);
      this.tabs.set(tab.tabId, { url: tab.url, title: tab.title, active: tab.active, allowedAt: known?.allowedAt ?? ++this.allowSeq });
    }
    for (const tabId of [...this.tabs.keys()]) {
      if (seen.has(tabId)) continue;
      this.tabs.delete(tabId);
      this.ready.delete(tabId);
      this.targets.delete(tabId);
      for (const fn of this.listeners.get(tabId) ?? []) fn(DETACHED_EVENT, { reason: "revoked" });
      this.listeners.delete(tabId);
    }
    if (this.selected !== undefined && !this.tabs.has(this.selected)) this.selected = undefined;
    this.onTabsChanged?.();
  }

  /** Sends one frame that expects a `res` reply. */
  private request<T>(frame: Record<string, unknown>, label: string, timeoutMs = 30_000): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new ActionError(this.everConnected ? DISCONNECTED : NOT_CONNECTED));
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`CDP timeout: ${label}`));
    }, timeoutMs);
    // The caller names the result shape it reads (see Target.send); results are not validated further.
    this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    socket.send(JSON.stringify({ ...frame, id }));
    return promise;
  }

  /** Enables the Page domain once per attach before the tab's first real command. */
  private ensureReady(tabId: number): Promise<void> {
    let ready = this.ready.get(tabId);
    if (!ready) {
      ready = this.request<unknown>({ type: "cmd", tabId, method: "Page.enable", params: {} }, "Page.enable").then(() => undefined);
      ready.catch(() => this.ready.delete(tabId));
      this.ready.set(tabId, ready);
    }
    return ready;
  }

  private target(tabId: number): Target {
    let target = this.targets.get(tabId);
    if (target) return target;
    target = {
      id: `tab:${tabId}`,
      send: async <T>(method: string, params: CdpParams = {}, timeoutMs?: number) => {
        await this.ensureReady(tabId);
        return this.request<T>({ type: "cmd", tabId, method, params }, method, timeoutMs);
      },
      onEvent: (fn) => {
        let set = this.listeners.get(tabId);
        if (!set) this.listeners.set(tabId, (set = new Set()));
        set.add(fn);
        return () => set.delete(fn);
      },
    };
    this.targets.set(tabId, target);
    return target;
  }

  /** Allowed tabs in grant order, oldest first. */
  private ordered(): [number, AllowedTab][] {
    return [...this.tabs.entries()].sort((a, b) => a[1].allowedAt - b[1].allowedAt);
  }

  private defaultTabId(): number | undefined {
    if (this.selected !== undefined && this.tabs.has(this.selected)) return this.selected;
    const ordered = this.ordered();
    const active = ordered.filter(([, tab]) => tab.active);
    const pool = active.length > 0 ? active : ordered;
    return pool.at(-1)?.[0];
  }

  status(): TransportStatus {
    if (!this.socket) {
      return { browser: "down", error: this.everConnected ? DISCONNECTED : NOT_CONNECTED, extension: { connected: false, allowedTabs: 0 } };
    }
    return { browser: "extension", extension: { connected: true, allowedTabs: this.tabs.size } };
  }

  current(): Target | string {
    if (!this.socket) return this.everConnected ? DISCONNECTED : NOT_CONNECTED;
    const tabId = this.defaultTabId();
    return tabId === undefined ? NO_ALLOWED_TAB : this.target(tabId);
  }

  currentTab(): { url: string; title: string } | null {
    const tabId = this.socket ? this.defaultTabId() : undefined;
    const tab = tabId === undefined ? undefined : this.tabs.get(tabId);
    return tab ? { url: tab.url, title: tab.title } : null;
  }

  async list(): Promise<TabInfo[]> {
    const current = this.defaultTabId();
    return this.ordered().map(([tabId, tab]) => ({ key: `tab:${tabId}`, url: tab.url, title: tab.title, current: tabId === current }));
  }

  async newTab(url?: string): Promise<string> {
    const { tabId } = await this.request<{ tabId: number }>({ type: "createTab", url: url ?? "about:blank" }, "createTab");
    return `Created tab ${tabId}. Ask the user to toggle the extension on it.`;
  }

  private async pick(index: number): Promise<number> {
    if (this.tabs.size === 0) throw new ActionError(NO_ALLOWED_TAB);
    const entry = this.ordered()[index];
    if (!entry) throw new ActionError(`No tab at index ${index}. Call browser_tabs with action list.`);
    return entry[0];
  }

  async select(index: number): Promise<string> {
    const tabId = await this.pick(index);
    this.selected = tabId;
    return `Selected tab ${index}: ${this.tabs.get(tabId)?.url ?? ""}`;
  }

  async close(index: number): Promise<string> {
    const tabId = await this.pick(index);
    const url = this.tabs.get(tabId)?.url ?? "";
    await this.request<unknown>({ type: "closeTab", tabId }, "closeTab");
    return `Closed tab ${index}: ${url}`;
  }

  async shutdown(): Promise<void> {
    this.socket?.close(1001, "daemon shutting down");
  }
}

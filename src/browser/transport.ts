export type CdpParams = Record<string, unknown>;

/** One CDP-addressable page: an owned-mode flattened session or an extension-mode tab. */
export interface Target {
  /** Stable key for per-target state (owned: targetId, extension: `tab:<tabId>`). */
  readonly id: string;
  /** Callers name the result shape they read; CDP results are not validated further. */
  send<T = unknown>(method: string, params?: CdpParams, timeoutMs?: number): Promise<T>;
  /** Subscribe to this target's CDP events; returns an unsubscribe function. */
  onEvent(fn: (method: string, params: CdpParams) => void): () => void;
}

export interface TabInfo {
  key: string;
  url: string;
  title: string;
  current: boolean;
}

export interface TransportStatus {
  browser: "ready" | "starting" | "down" | "extension";
  error?: string;
  extension?: { connected: boolean; allowedTabs: number };
}

export interface Transport {
  readonly mode: "owned" | "extension";
  status(): TransportStatus;
  /** The default target for actions, or a user-facing error string. */
  current(): Target | string;
  list(): Promise<TabInfo[]>;
  newTab(url?: string): Promise<string>;
  select(index: number): Promise<string>;
  close(index: number): Promise<string>;
  shutdown(): Promise<void>;
}

/** Thrown for expected, user-facing action failures. */
export class ActionError extends Error {
  constructor(message: string, readonly text?: string) {
    super(message);
  }
}

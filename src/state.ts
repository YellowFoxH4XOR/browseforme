import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

export const STATE_DIR = join(homedir(), ".browseforme");
export const TOKEN_PATH = join(STATE_DIR, "token");
export const DAEMON_PATH = join(STATE_DIR, "daemon.json");
export const CONFIG_PATH = join(STATE_DIR, "config.json");
export const PROFILE_DIR = join(STATE_DIR, "profiles", "default");
export const LOG_PATH = join(STATE_DIR, "log.txt");

export const DEFAULT_PORT = 47821;
export const LAST_PORT = 47830;

export type Mode = "extension" | "owned";

/** ~/.browseforme/config.json. Unknown keys are dropped on load. */
const ConfigFile = z.object({
  mode: z.enum(["extension", "owned"]).default("extension"),
  typesafeApiKey: z.string().optional(),
  jevModel: z.string().default("jev-latest"),
  jevEnabled: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigFile>;

export interface DaemonInfo {
  pid: number;
  port: number;
  mode: Mode;
  startedAt: string;
  cdpPort?: number;
  profile?: string;
}

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export function readToken(): string | null {
  try {
    return readFileSync(TOKEN_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function ensureToken(): string {
  const existing = readToken();
  if (existing) return existing;
  ensureStateDir();
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  return token;
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  let raw: unknown = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(`Invalid ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${CONFIG_PATH}: ${z.prettifyError(parsed.error)}`);
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function saveConfig(next: Config): Config {
  ensureStateDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
  cachedConfig = next;
  return next;
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(DAEMON_PATH, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  ensureStateDir();
  writeFileSync(DAEMON_PATH, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
}

/** Appends `<ISO> <line>` to log.txt. Never throws: logging must not break actions. */
export function log(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // state dir missing or unwritable; drop the line
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

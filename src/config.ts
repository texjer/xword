/**
 * Where `xword login` puts the key.
 *
 * `env-paths` in about twenty lines, so the package stays dependency-free: the
 * OS config directory per platform, `xword/config.json` inside it, mode
 * 0600 on the file and 0700 on the directory. The key is never echoed, never
 * logged and never passed on a command line.
 *
 * `CROSSWORD_API_KEY` always wins over the stored key — that is what makes CI
 * and `docker run -e` work without a login step, and it is also the escape
 * hatch when a stored key goes stale.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
}

/** The OS config directory, matching what `env-paths` would pick. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Preferences", "xword");
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "xword", "Config");
  }
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(xdg, "xword");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): StoredConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as StoredConfig;
  } catch {
    // A hand-edited or truncated config should not make every command fail —
    // treat it as "not logged in" and let `xword login` overwrite it.
  }
  return {};
}

export function writeConfig(
  config: StoredConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  // Write, then chmod: `mode` on writeFileSync only applies when the file is
  // created, so an existing world-readable file would keep its mode.
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function clearConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = configPath(env);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** The key to use: environment first, then the stored one. */
export function resolveApiKey(
  env: NodeJS.ProcessEnv = process.env
): { key?: string; source: "env" | "config" | "none" } {
  const fromEnv = env.CROSSWORD_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const stored = readConfig(env).apiKey?.trim();
  if (stored) return { key: stored, source: "config" };
  return { source: "none" };
}

/** The base URL to use: `CROSSWORD_API_BASE`, then the stored one, then prod. */
export function resolveBaseUrl(
  fallback: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.CROSSWORD_API_BASE?.trim() || readConfig(env).baseUrl?.trim() || fallback;
}

/**
 * A key rendered for display: the `cw_live_` prefix, four characters, then
 * dots. Enough to tell two keys apart, not enough to use one.
 */
export function maskApiKey(key: string): string {
  const prefixMatch = /^(cw_[a-z]+_)(.*)$/.exec(key);
  const prefix = prefixMatch ? prefixMatch[1] : "";
  const rest = prefixMatch ? prefixMatch[2] : key;
  return `${prefix}${rest.slice(0, 4)}${"•".repeat(Math.min(8, Math.max(0, rest.length - 4)))}`;
}

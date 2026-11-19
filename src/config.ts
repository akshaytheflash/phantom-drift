import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export interface ServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface DiscoveredServer {
  readonly name: string;
  readonly configPath: string;
  readonly format: ConfigFormat;
  readonly spec: ServerSpec;
}

export type ConfigFormat = "opencode" | "claude" | "vscode" | "mcpServers";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Files phantom looks at, in priority order, when asked to auto-discover. */
export function defaultConfigCandidates(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const home = homedir();
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config");
  return [
    join(cwd, "opencode.json"),
    join(cwd, "opencode.jsonc"),
    join(cwd, ".mcp.json"),
    join(cwd, ".vscode", "mcp.json"),
    join(xdg, "opencode", "opencode.json"),
    join(home, ".claude.json"),
    join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
  ];
}

/**
 * Removes // and /* *\/ comments plus trailing commas from JSONC without
 * touching string contents. Required because opencode and VS Code ship
 * commented config files. A comma is only dropped when the next non-space
 * character closes an object or array outside a string, so "x,}" inside a
 * string survives unchanged.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (char === '"') {
      const end = findStringEnd(text, index);
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === ",") {
      const following = text[skipSpaces(text, index + 1)];
      if (following === "}" || following === "]") {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Index of the closing quote of the string that starts at `start`. */
function findStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') {
      return index;
    }
    index += 1;
  }
  return text.length;
}

function skipSpaces(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index] as string)) {
    index += 1;
  }
  return index;
}

function detectFormat(path: string): ConfigFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith("opencode.json") || lower.endsWith("opencode.jsonc")) {
    return "opencode";
  }
  if (lower.endsWith("claude.json") || lower.endsWith("claude_desktop_config.json")) {
    return "claude";
  }
  if (lower.includes(`${join("vscode", "mcp.json")}`)) {
    return "vscode";
  }
  return "mcpServers";
}

interface RawEntry {
  readonly name: string;
  readonly value: unknown;
}

function collectEntries(doc: Record<string, unknown>, format: ConfigFormat): RawEntry[] {
  const containers: Array<Record<string, unknown>> = [];
  if (isRecord(doc["mcpServers"])) {
    containers.push(doc["mcpServers"] as Record<string, unknown>);
  }
  if (isRecord(doc["mcp"])) {
    const mcp = doc["mcp"] as Record<string, unknown>;
    if (isRecord(mcp["servers"])) {
      containers.push(mcp["servers"] as Record<string, unknown>);
    }
  }
  if (isRecord(doc["servers"])) {
    containers.push(doc["servers"] as Record<string, unknown>);
  }
  if (isRecord(doc["mcp"])) {
    containers.push(filterServers(doc["mcp"] as Record<string, unknown>));
  }
  if (format === "opencode" && isRecord(doc["mcp"])) {
    containers.push(doc["mcp"] as Record<string, unknown>);
  }
  const seen = new Set<string>();
  const out: RawEntry[] = [];
  for (const container of containers) {
    for (const [name, value] of Object.entries(container)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      out.push({ name, value });
    }
  }
  return out;
}

function filterServers(container: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(container)) {
    if (isRecord(value) && (typeof value["command"] === "string" || typeof value["url"] === "string")) {
      out[name] = value;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves a configured working directory against the config file that
 * declared it, not against phantom's own working directory. A relative `cwd`
 * in an agent config means "relative to the config", and copying phantom into
 * another directory must not change which files a server sees.
 */
function resolveCwd(cwd: string, configDir: string): string {
  return isAbsolute(cwd) ? normalize(cwd) : resolve(configDir, cwd);
}

function normaliseSpec(name: string, value: unknown, env: NodeJS.ProcessEnv, configDir: string): ServerSpec {
  if (!isRecord(value)) {
    throw new ConfigError(`server ${name} is not an object`);
  }
  if (typeof value["url"] === "string" && typeof value["command"] !== "string") {
    throw new ConfigError(`server ${name} is a remote server (${String(value["url"])}); phantom v0 observes stdio servers only`);
  }
  const commandValue = value["command"];
  let command: string;
  let args: readonly string[] = [];
  if (typeof commandValue === "string") {
    command = commandValue;
    const rawArgs = value["args"];
    if (rawArgs !== undefined) {
      if (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string")) {
        throw new ConfigError(`server ${name} has a non-string args entry`);
      }
      args = rawArgs as string[];
    }
  } else if (Array.isArray(commandValue) && commandValue.length > 0) {
    const parts = commandValue.map((part) => String(part));
    command = parts[0] as string;
    args = parts.slice(1);
  } else {
    throw new ConfigError(`server ${name} has no command`);
  }
  const envValue = value["environment"] ?? value["env"];
  const serverEnv: Record<string, string> = {};
  if (isRecord(envValue)) {
    for (const [key, raw] of Object.entries(envValue)) {
      if (typeof raw === "string") {
        serverEnv[key] = expandEnv(raw, env);
      }
    }
  }
  const cwdValue = value["cwd"];
  const cwd = typeof cwdValue === "string" ? resolveCwd(expandEnv(cwdValue, env), configDir) : undefined;
  return cwd === undefined ? { command, args, env: serverEnv } : { command, args, env: serverEnv, cwd };
}

/** Expands ${VAR} and $VAR using the supplied environment, leaving unknowns empty. */
export function expandEnv(text: string, env: NodeJS.ProcessEnv): string {
  return text
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => env[name] ?? "");
}

export function parseConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): DiscoveredServer[] {
  if (!existsSync(path)) {
    throw new ConfigError(`config not found: ${path}`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new ConfigError(`config is not a regular file: ${path}`);
  }
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const cleaned = stripJsonComments(raw);
  let doc: unknown;
  try {
    doc = JSON.parse(cleaned);
  } catch (error) {
    throw new ConfigError(`config is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(doc)) {
    throw new ConfigError(`config root must be an object: ${path}`);
  }
  const format = detectFormat(path);
  const out: DiscoveredServer[] = [];
  for (const entry of collectEntries(doc, format)) {
    out.push({
      name: entry.name,
      configPath: resolve(path),
      format,
      spec: normaliseSpec(entry.name, entry.value, env, dirname(resolve(path)))
    });
  }
  return out;
}

export function discoverServers(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): DiscoveredServer[] {
  const out: DiscoveredServer[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    for (const server of parseConfig(path, env)) {
      if (seen.has(server.name)) {
        continue;
      }
      seen.add(server.name);
      out.push(server);
    }
  }
  return out;
}

export function findServer(servers: readonly DiscoveredServer[], name: string): DiscoveredServer {
  const match = servers.find((server) => server.name === name);
  if (match === undefined) {
    const known = servers.map((server) => server.name).join(", ");
    throw new ConfigError(`server ${name} not found in config (found: ${known.length > 0 ? known : "none"})`);
  }
  return match;
}

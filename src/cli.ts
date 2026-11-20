#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConfigError,
  defaultConfigCandidates,
  discoverServers,
  findServer,
  parseConfig,
  type DiscoveredServer
} from "./config.js";
import { classifyChanges, type DriftReport } from "./drift.js";
import { formatProxyEvent } from "./proxy-log.js";
import { formatReport } from "./report.js";
import { errorMessage } from "./session.js";
import {
  baselineBeforeTaint,
  captureServer,
  createService,
  ledgerFor,
  markTaint,
  observeServer,
  summariseServer,
  verifyLedger,
  type ServiceOptions
} from "./service.js";
import type { Observation } from "./snapshot.js";

/**
 * The version comes from package.json itself so the CLI, the npm page and the
 * tarball can never disagree after a release.
 */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();

const USAGE = `phantom ${VERSION} - MCP prompt ledger and runtime supervisor

Usage:
  phantom observe <server> [--config <path>] [--json] [--quiet]
      Snapshot every prompt surface of a server, append it to the signed
      ledger, and report drift against the previous observation.

  phantom status [server ...] [--json]
      Ledger health, observation counts and taint state.

  phantom verify <server> [--json]
      Recompute the hash chain of a server ledger. Exit 1 when tampered.

  phantom taint <server> [--seq <n>] [--note <text>]
  phantom untaint <server> [--seq <n>] [--note <text>]
      Mark the latest (or a specific) observation as attacker-influenced, or
      clear the mark. Taint survives sessions on purpose.

  phantom diff <server> [--config <path>] [--json]
      Capture the server again and diff it against the ledger without writing.

  phantom proxy <server> [--config <path>] [--json]
      Run the MCP server behind a transparent stdio bridge and record a fresh
      signed observation when the agent session starts.

  phantom inspect <server> [--config <path>] [--json]
      Read-only view of the current prompt surface; writes nothing.

  phantom init [--config <path>]
      Print agent config snippets that route servers through phantom proxy.

Global options:
  --config <path>   Config file holding the server (default: auto-discover)
  --home <dir>      Override the phantom home directory
  --json            Machine readable output
  -h, --help        Show this help
  -v, --version     Show the version

Exit codes: 0 clean/ok, 1 failure or tamper, 2 usage or configuration error.

Environment:
  PHANTOM_HOME      Ledger, key and runtime location (default: ~/.phantom)
  PHANTOM_KEY       Ledger key as text, bypasses the key file
  PHANTOM_CONFIG    Config file to use when --config is absent
`;

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface ParsedArgs {
  readonly command: string | null;
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["config", "home", "seq", "note"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let command: string | null = null;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] as string;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (VALUE_FLAGS.has(body)) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new UsageError(`--${body} requires a value`);
        }
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      if (short === "h") {
        flags.set("help", true);
      } else if (short === "v") {
        flags.set("version", true);
      } else {
        throw new UsageError(`unknown option -${short}`);
      }
    } else if (command === null) {
      command = arg;
    } else {
      positional.push(arg);
    }
    index += 1;
  }
  return { command, positional, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) {
    throw new UsageError(`--${name} requires a value`);
  }
  return value;
}

function configPaths(flags: Map<string, string | true>, env: NodeJS.ProcessEnv): string[] {
  const explicit = stringFlag(flags, "config");
  if (explicit !== undefined) {
    return [explicit];
  }
  const fromEnv = env.PHANTOM_CONFIG;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return [fromEnv];
  }
  return defaultConfigCandidates(env);
}

function loadServers(flags: Map<string, string | true>, env: NodeJS.ProcessEnv): DiscoveredServer[] {
  const paths = configPaths(flags, env);
  if (stringFlag(flags, "config") !== undefined) {
    return parseConfig(paths[0] as string, env);
  }
  return discoverServers(paths, env);
}

function resolveServer(servers: readonly DiscoveredServer[], name: string): DiscoveredServer {
  return findServer(servers, name);
}

function requireName(command: string, positional: readonly string[]): string {
  const name = positional[0];
  if (name === undefined || name.length === 0) {
    throw new UsageError(`${command} requires a server name`);
  }
  return name;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ledgerNames(service: ServiceOptions): string[] {
  if (!existsSync(service.paths.ledgerDir)) {
    return [];
  }
  return readdirSync(service.paths.ledgerDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.slice(0, -".jsonl".length))
    .sort();
}

interface Output {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Snapshot of everything written so far, safe to call at any point. */
  readonly result: (code: number) => RunResult;
}

function createOutput(): Output {
  let stdout = "";
  let stderr = "";
  const append = (to: "stdout" | "stderr", text: string): void => {
    const line = text.endsWith("\n") ? text : `${text}\n`;
    if (to === "stdout") {
      stdout += line;
    } else {
      stderr += line;
    }
  };
  return {
    out: (text) => append("stdout", text),
    err: (text) => append("stderr", text),
    result: (code) => ({ code, stdout, stderr })
  };
}

export async function run(argv: readonly string[], baseEnv: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  const output = createOutput();
  try {
    const args = parseArgs(argv);
    if (args.flags.has("version")) {
      output.out(VERSION);
      return output.result(0);
    }
    if (args.command === null) {
      output.err(USAGE);
      return output.result(2);
    }
    if (args.flags.has("help")) {
      output.out(USAGE);
      return output.result(0);
    }
    const home = stringFlag(args.flags, "home");
    const env: NodeJS.ProcessEnv = home === undefined ? baseEnv : { ...baseEnv, PHANTOM_HOME: home };
    const asJson = args.flags.has("json");
    return await dispatch(args, env, asJson, output);
  } catch (error) {
    if (error instanceof UsageError) {
      output.err(`phantom: ${error.message}`);
      output.err("run phantom --help for usage");
      return output.result(2);
    }
    if (error instanceof ConfigError) {
      output.err(`phantom: ${error.message}`);
      return output.result(2);
    }
    output.err(`phantom: ${errorMessage(error)}`);
    return output.result(1);
  }
}

async function dispatch(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  asJson: boolean,
  output: Output
): Promise<RunResult> {
  const { out, err } = output;
  const command = args.command as string;
  const servers = (): DiscoveredServer[] => loadServers(args.flags, env);

  switch (command) {
    case "help": {
      out(USAGE);
      return output.result(0);
    }
    case "observe": {
      const name = requireName(command, args.positional);
      const server = resolveServer(servers(), name);
      const service = createService(env);
      const result = await observeServer(service, server);
      if (asJson) {
        out(
          json({
            server: name,
            fingerprint: result.observation.fingerprint,
            meridian: result.meridian,
            ledger: result.ledgerPath,
            verdict: result.verdict,
            tainted: result.tainted,
            changeClass: result.drift?.changeClass ?? null,
            drift: result.drift,
            skipped: result.skipped
          })
        );
      } else if (!args.flags.has("quiet")) {
        out(result.report);
      }
      return output.result(result.verdict.level === "fail" ? 1 : 0);
    }
    case "status": {
      const service = createService(env);
      const names = args.positional.length > 0 ? args.positional : ledgerNames(service);
      if (names.length === 0) {
        out("no ledgers yet; run phantom observe <server> first");
        return output.result(0);
      }
      const summaries = names.map((name) => summariseServer(service, name));
      if (asJson) {
        out(json(summaries));
      } else {
        out(
          formatTable(
            summaries.map((summary) => ({
              server: summary.server,
              observations: String(summary.observations),
              tainted: String(summary.tainted),
              chain: summary.ok ? "ok" : "BROKEN",
              severity: summary.latestSeverity ?? "-",
              last: summary.lastAt ?? "-"
            }))
          )
        );
      }
      return output.result(summaries.some((summary) => !summary.ok) ? 1 : 0);
    }
    case "verify": {
      const name = requireName(command, args.positional);
      const result = verifyLedger(createService(env), name);
      if (asJson) {
        out(json(result));
      } else if (result.ok) {
        out(`ok: ${result.entries} entr${result.entries === 1 ? "y" : "ies"} verified in ${result.ledgerPath}`);
      } else if (result.brokenAt === null) {
        err(`tampered: ${result.reason ?? "unknown"} in ${result.ledgerPath}`);
      } else {
        err(`tampered: seq ${result.brokenAt}: ${result.reason ?? "unknown"} in ${result.ledgerPath}`);
      }
      return output.result(result.ok ? 0 : 1);
    }
    case "taint":
    case "untaint": {
      const name = requireName(command, args.positional);
      const seqFlag = stringFlag(args.flags, "seq");
      let seq: number | undefined;
      if (seqFlag !== undefined) {
        const parsed = Number(seqFlag);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new UsageError("--seq must be a non-negative integer");
        }
        seq = parsed;
      }
      const note = stringFlag(args.flags, "note");
      const result = markTaint(createService(env), name, command, {
        ...(seq !== undefined ? { seq } : {}),
        ...(note !== undefined ? { note } : {})
      });
      if (asJson) {
        out(json(result));
      } else {
        const verb = result.event === "taint" ? "tainted" : "untainted";
        out(`${verb} ${name} at ${result.fingerprint.slice(0, 16)} (${result.meridian})`);
      }
      return output.result(0);
    }
    case "diff": {
      const name = requireName(command, args.positional);
      const server = resolveServer(servers(), name);
      const ledger = ledgerFor(createService(env), name);
      const latest = ledger.latest();
      if (latest === null) {
        throw new UsageError(`no observations recorded for ${name}; run phantom observe ${name} first`);
      }
      const captured = await captureServer(server.spec);
      const current: Observation = { ...captured.observation, server: name };
      const drift = classifyChanges(latest.body.observation, current, {
        tainted: ledger.taintedObservations(),
        baseline: baselineBeforeTaint(ledger)
      });
      if (asJson) {
        out(json({ server: name, drift, skipped: captured.skipped }));
      } else {
        out(formatDiff(drift));
      }
      return output.result(0);
    }
    case "inspect": {
      const name = requireName(command, args.positional);
      const server = resolveServer(servers(), name);
      const captured = await captureServer(server.spec, { collect: { readResourceBodies: true } });
      const observation: Observation = { ...captured.observation, server: name };
      if (asJson) {
        out(json({ server: name, observation, skipped: captured.skipped }));
      } else {
        out(formatInspect(name, observation, captured.skipped));
      }
      return output.result(0);
    }
    case "proxy": {
      const name = requireName(command, args.positional);
      const server = resolveServer(servers(), name);
      const service = createService(env);
      // Imported lazily so `phantom verify` on a machine without a server
      // config never loads child process code.
      const { runProxy } = await import("./proxy.js");
      if (!asJson && args.flags.has("quiet") === false) {
        process.stderr.write(`[phantom] supervising ${name} (ledger ${ledgerFor(service, name).path})\n`);
      }
      const handle = runProxy({
        command: server.spec.command,
        args: server.spec.args,
        env: server.spec.env,
        ...(server.spec.cwd !== undefined ? { cwd: server.spec.cwd } : {}),
        input: process.stdin,
        output: process.stdout,
        hooks: {
          onEvent: (event) => {
            const line = formatProxyEvent(event);
            if (line !== null) {
              process.stderr.write(`${line}\n`);
            }
          },
          // The child is already running the agent's session, so the ledger
          // observation is taken from a separate short lived process. Never
          // inside the live one, which would interleave requests.
          onSessionStart: () => {
            if (server.spec.env["PHANTOM_DISABLE_OBSERVE"] === "1") {
              return;
            }
            void observeInBackground(service, server, asJson);
          }
        }
      });
      const result = await handle.exited;
      return output.result(result.code ?? (result.signal === null ? 1 : 0));
    }
    case "init": {
      const list = servers();
      const lines = ["Route your agent's MCP servers through phantom:", ""];
      for (const server of list) {
        lines.push(`  ${server.name}:`);
        lines.push(`    command: phantom`);
        lines.push(`    args: ["proxy", "${server.name}", "--config", ${JSON.stringify(server.configPath)}]`);
        lines.push("");
      }
      if (list.length === 0) {
        lines.push("  no servers found; pass --config <path>");
      }
      out(lines.join("\n"));
      return output.result(0);
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

/**
 * Starts a detached observation of the same server. Kept out of the proxy
 * process on purpose: see the comment at the call site.
 */
async function observeInBackground(
  service: ServiceOptions,
  server: DiscoveredServer,
  asJson: boolean
): Promise<void> {
  try {
    const result = await observeServer(service, server);
    if (asJson) {
      return;
    }
    const line =
      result.drift === null
        ? `[phantom] recorded ${result.meridian}`
        : `[phantom] recorded ${result.meridian} change=${result.drift.changeClass} severity=${result.drift.severity}`;
    process.stderr.write(`${line}\n`);
    if (result.verdict.reasons.length > 0) {
      for (const reason of result.verdict.reasons) {
        process.stderr.write(`[phantom] ${reason}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`[phantom] observation failed: ${errorMessage(error)}\n`);
  }
}

function formatDiff(drift: DriftReport): string {
  const lines: string[] = [];
  lines.push(`drift: ${drift.changeClass} (${drift.severity})`);
  lines.push(`  ${drift.summary}`);
  for (const change of drift.sources) {
    const sign = change.change === "added" ? "+" : change.change === "removed" ? "-" : "~";
    lines.push(`  ${sign} ${change.kind}:${change.id} (${change.severity}) ${change.note}`);
  }
  for (const item of drift.reintroduced) {
    lines.push(`  ! continuation from tainted text in ${item.kind}:${item.id}`);
  }
  return lines.join("\n");
}

function formatInspect(name: string, observation: Observation, skipped: readonly string[]): string {
  const lines: string[] = [`${name} ${observation.fingerprint.slice(0, 16)}`];
  for (const source of observation.sources) {
    const binary = source.binary ? " (binary)" : "";
    lines.push(`  ${source.kind}:${source.id} [${source.digest.slice(0, 12)}]${binary}`);
  }
  if (skipped.length > 0) {
    lines.push(`  not observed: ${skipped.join("; ")}`);
  }
  return lines.join("\n");
}

function formatTable(rows: ReadonlyArray<Record<string, string>>): string {
  const first = rows[0];
  if (first === undefined) {
    return "no rows";
  }
  const header = Object.keys(first);
  const widths = header.map((key) => Math.max(key.length, ...rows.map((row) => (row[key] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] as number)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map((row) => line(header.map((key) => row[key] ?? "")))].join("\n");
}

const invokedDirectly = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const result = await run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

export { VERSION, formatReport };

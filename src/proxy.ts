import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Writable, type Readable } from "node:stream";

import { canonicalJson } from "./canonical.js";
import { serverId } from "./home.js";
import { LedgerError } from "./store.js";

export type SessionHook = "initialize" | "tools/list" | "prompts/list" | "resources/list" | "resources/templates/list";

export interface ProxyEvent {
  readonly type: "session-open" | "session-close" | "request" | "response" | "ledger-error" | "write-error";
  readonly session?: string;
  readonly method?: string;
  readonly id?: string | number | null;
  readonly ok?: boolean;
  readonly error?: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProxyHooks {
  /** Called for every message flowing each way. Must never throw. */
  readonly onEvent: (event: ProxyEvent) => void;
  /** Called after a response that completes a session-starting request. */
  readonly onSessionStart?: () => void;
}

export interface ProxyOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly hooks: ProxyHooks;
  /** Spawns the child; overridable in tests. */
  readonly spawn?: typeof spawn;
}

export interface ProxyHandle {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  shutdown(): void;
}

const SESSION_METHODS = new Set<SessionHook>([
  "initialize",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list"
]);

type JsonRpcMessage = Record<string, unknown>;

interface ParsedMessage {
  readonly raw: string;
  readonly value: JsonRpcMessage;
}

/**
 * Splits a byte stream into newline delimited JSON-RPC messages. Buffers
 * partial lines across chunks and caps a single message so a hostile server
 * cannot exhaust memory through an unbounded line.
 */
export class LineDecoder {
  private buffer = "";

  constructor(private readonly maxLineBytes = 32 * 1024 * 1024) {}

  push(chunk: string): ParsedMessage[] {
    this.buffer += chunk;
    const out: ParsedMessage[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        out.push(this.decode(line));
      }
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxLineBytes) {
      throw new Error(`message exceeds ${this.maxLineBytes} bytes without a newline`);
    }
    return out;
  }

  flush(): ParsedMessage[] {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim().length === 0) {
      return [];
    }
    return [this.decode(rest)];
  }

  private decode(line: string): ParsedMessage {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`received a line that is not JSON: ${line.slice(0, 120)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("received a JSON-RPC message that is not an object");
    }
    return { raw: line, value: parsed as JsonRpcMessage };
  }
}

function isRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && message.id !== undefined && message.id !== null;
}

function isResponse(message: JsonRpcMessage): boolean {
  return typeof message.method !== "string" && message.id !== undefined && message.id !== null;
}

function idKey(id: unknown): string {
  return canonicalJson(id === undefined ? null : id);
}

/**
 * Runs an MCP server behind a transparent stdio bridge. Bytes written by the
 * agent reach the server unchanged and responses reach the agent unchanged;
 * the proxy only inspects copies to build the session ledger.
 */
export function runProxy(options: ProxyOptions): ProxyHandle {
  const spawnFn = options.spawn ?? spawn;
  const child: ChildProcessByStdio<Writable, Readable, null> = spawnFn(options.command, [...options.args], {
    env: { ...process.env, ...filterEnv(options.env ?? {}) } as NodeJS.ProcessEnv,
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "inherit"]
  });

  const childDecoder = new LineDecoder();
  const parentDecoder = new LineDecoder();
  const pending = new Map<string, string>();
  const hooks = options.hooks;
  let exiting = false;

  const emit = (event: ProxyEvent): void => {
    try {
      hooks.onEvent(event);
    } catch {
      // Hooks are observability only; a hook failure never breaks the pipe.
    }
  };

  const fail = (event: ProxyEvent): void => {
    emit(event);
  };

  const writeToChild = (data: string | Buffer): void => {
    if (child.stdin.destroyed) {
      return;
    }
    child.stdin.write(data);
  };

  const writeToParent = (data: string | Buffer): void => {
    if (options.output instanceof Writable && options.output.destroyed) {
      return;
    }
    options.output.write(data);
  };

  const startSession = (): void => {
    emit({ type: "session-open" });
    try {
      hooks.onSessionStart?.();
    } catch (error) {
      fail({ type: "ledger-error", error: describe(error) });
    }
  };

  options.input.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let messages: ParsedMessage[];
    try {
      messages = parentDecoder.push(text);
    } catch (error) {
      fail({ type: "write-error", error: describe(error) });
      try {
        writeToParent(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "phantom: invalid JSON from client" } })}\n`
        );
      } catch {
        // Nothing else can be done for a broken client stream.
      }
      return;
    }
    for (const message of messages) {
      if (isRequest(message.value)) {
        const method = String(message.value.method);
        pending.set(idKey(message.value.id), method);
        // A write can be answered synchronously by an injected transport, so
        // the request is recorded (and the session opened) before the bytes
        // reach the child. Otherwise a fast response would arrive before the
        // request it belongs to is known.
        emit({ type: "request", method });
        if (method === "initialize") {
          startSession();
        }
      }
    }
    writeToChild(text);
  });

  options.input.on("end", () => {
    const leftovers = parentDecoder.flush();
    if (leftovers.length > 0) {
      writeToChild(leftovers.map((message) => `${message.raw}\n`).join(""));
    }
    child.stdin.end();
  });

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    let messages: ParsedMessage[];
    try {
      messages = childDecoder.push(text);
    } catch (error) {
      fail({ type: "ledger-error", error: `server stream: ${describe(error)}` });
      return;
    }
    writeToParent(chunk);
    for (const message of messages) {
      if (!isResponse(message.value)) {
        continue;
      }
      const key = idKey(message.value.id);
      const method = pending.get(key);
      pending.delete(key);
      const failed = message.value.error !== undefined;
      emit({ type: "response", method: method ?? "unknown", ok: !failed });
    }
  });

  child.on("error", (error) => {
    fail({ type: "write-error", error: describe(error) });
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      const leftovers = childDecoder.flush();
      if (leftovers.length > 0) {
        writeToParent(leftovers.map((message) => `${message.raw}\n`).join(""));
      }
      emit({ type: "session-close", detail: { code: code ?? -1, signal: signal ?? "" } });
      resolve({ code, signal });
    });
  });

  const shutdown = (): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  const uninstallSignals = installSignalHandlers(shutdown);

  return {
    exited: exited.finally(() => {
      uninstallSignals();
    }),
    shutdown
  };
}

/**
 * Forwards termination signals to the child instead of dying first, so the
 * server gets a chance to flush and close cleanly. Listeners are removed once
 * the child exits so repeated proxies in one process do not leak handlers.
 */
function installSignalHandlers(shutdown: () => void): () => void {
  const handler = (): void => shutdown();
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("SIGHUP", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
    process.off("SIGHUP", handler);
  };
}

function filterEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function describe(error: unknown): string {
  if (error instanceof LedgerError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export { SESSION_METHODS, serverId };

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { LineDecoder, runProxy, type ProxyEvent } from "../src/proxy.js";

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * A fake MCP server. It records every request it receives, optionally answers
 * it, and can be configured to answer synchronously inside write() the way an
 * injected transport might.
 */
class FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly responseDelayByMethod = new Map<string, "sync" | "async" | "none">();
  onExit: (() => void) | undefined;
  private exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter((entry) => entry.length > 0)) {
        const request = JSON.parse(line) as Record<string, unknown>;
        this.requests.push(request);
        const mode = this.responseDelayByMethod.get(String(request["method"])) ?? "sync";
        if (mode === "sync") {
          this.respond(request);
        } else if (mode === "async") {
          setTimeout(() => this.respond(request), 5);
        }
      }
    });
  }

  respond(request: Record<string, unknown>): void {
    const result =
      request["method"] === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } }
        : { tools: [] };
    this.stdout.write(frame({ jsonrpc: "2.0", id: request["id"], result }));
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitHandler?.(null, signal);
    this.onExit?.();
    return true;
  }

  on(eventName: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    if (eventName === "exit") {
      this.exitHandler = handler;
    }
    return this;
  }
}

function start(child: FakeChild): {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly events: ProxyEvent[];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly shutdown: () => void;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: ProxyEvent[] = [];
  const handle = runProxy({
    command: "fake",
    args: [],
    input,
    output,
    hooks: { onEvent: (event) => events.push(event) },
    spawn: (() => child) as unknown as typeof import("node:child_process").spawn
  });
  return { input, output, events, exited: handle.exited, shutdown: handle.shutdown };
}

function collect(stream: PassThrough): string[] {
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LineDecoder", () => {
  it("reassembles messages split across chunks", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    const messages = decoder.push("1}\n");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.value).toEqual({ a: 1 });
    expect(messages[0]?.raw).toBe('{"a":1}');
  });

  it("returns several messages from one chunk in order", () => {
    const decoder = new LineDecoder();
    const messages = decoder.push(`${frame({ id: 1 })}\n${frame({ id: 2 })}\n`);
    expect(messages.map((message) => message.value["id"])).toEqual([1, 2]);
  });

  it("skips blank lines", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('\n\n{"a":1}\n\n')).toHaveLength(1);
  });

  it("rejects a line that is not JSON", () => {
    const decoder = new LineDecoder();
    expect(() => decoder.push("not json\n")).toThrow(/not JSON/);
  });

  it("rejects a JSON value that is not an object", () => {
    const decoder = new LineDecoder();
    expect(() => decoder.push("[1]\n")).toThrow(/not an object/);
  });

  it("caps an unterminated line instead of buffering without bound", () => {
    const decoder = new LineDecoder(16);
    expect(() => decoder.push("x".repeat(32))).toThrow(/exceeds 16 bytes/);
  });

  it("flushes a trailing message without a newline", () => {
    const decoder = new LineDecoder();
    decoder.push('{"a":1}');
    expect(decoder.flush()).toHaveLength(1);
    expect(decoder.flush()).toHaveLength(0);
  });
});

describe("runProxy", () => {
  it("passes client bytes to the child unchanged", () => {
    const child = new FakeChild();
    const h = start(child);
    const raw = frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    h.input.write(raw);
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0]).toEqual(JSON.parse(raw));
  });

  it("passes the server reply to the agent unchanged", () => {
    const child = new FakeChild();
    const h = start(child);
    const out = collect(h.output);
    h.input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(out.join("")).toContain('"serverInfo":{"name":"fake","version":"1"}');
  });

  it("records request, response and session-open events", async () => {
    const child = new FakeChild();
    const h = start(child);
    h.input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    await delay(1);
    const types = h.events.map((event) => event.type);
    expect(types).toEqual(["request", "session-open", "response"]);
    expect(h.events[2]).toMatchObject({ type: "response", method: "initialize", ok: true });
  });

  it("correlates responses that arrive asynchronously", async () => {
    const child = new FakeChild();
    child.responseDelayByMethod.set("initialize", "async");
    const h = start(child);
    h.input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    await delay(20);
    expect(h.events.filter((event) => event.type === "response")).toEqual([
      { type: "response", method: "initialize", ok: true }
    ]);
  });

  it("opens the session only once per initialize", async () => {
    const child = new FakeChild();
    const h = start(child);
    h.input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    h.input.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    await delay(5);
    expect(h.events.filter((event) => event.type === "session-open")).toHaveLength(1);
  });

  it("marks a JSON-RPC error reply as not ok", async () => {
    const child = new FakeChild();
    const h = start(child);
    child.stdout.write(frame({ jsonrpc: "2.0", id: 99, error: { code: -32601, message: "nope" } }));
    await delay(5);
    expect(h.events.find((event) => event.type === "response")).toMatchObject({ ok: false, method: "unknown" });
  });

  it("answers malformed client JSON with a parse error and never forwards it", () => {
    const child = new FakeChild();
    const h = start(child);
    const out = collect(h.output);
    h.input.write("this is not json\n");
    expect(child.requests).toHaveLength(0);
    const reply = JSON.parse(out.join("").trim()) as { error: { code: number } };
    expect(reply.error.code).toBe(-32700);
    expect(h.events.some((event) => event.type === "write-error")).toBe(true);
  });

  it("does not treat a JSON array as a request", () => {
    const child = new FakeChild();
    const h = start(child);
    const out = collect(h.output);
    h.input.write("[1,2]\n");
    expect(child.requests).toHaveLength(0);
    expect(out.join("")).toContain("-32700");
  });

  it("resolves exited when the child is shut down", async () => {
    const child = new FakeChild();
    const h = start(child);
    h.shutdown();
    await expect(h.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(child.killed).toBe(true);
  });

  it("does not crash when a hook throws", () => {
    const child = new FakeChild();
    const input = new PassThrough();
    const output = new PassThrough();
    expect(() =>
      runProxy({
        command: "fake",
        args: [],
        input,
        output,
        hooks: {
          onEvent: () => {
            throw new Error("hook failure");
          }
        },
        spawn: (() => child) as unknown as typeof import("node:child_process").spawn
      })
    ).not.toThrow();
    expect(() => input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))).not.toThrow();
  });
});

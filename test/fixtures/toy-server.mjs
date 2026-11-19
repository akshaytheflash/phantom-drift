#!/usr/bin/env node
/**
 * A tiny, dependency free MCP server used by phantom's tests. It answers the
 * handful of JSON-RPC methods phantom calls and reports what it served in its
 * stdin/stderr so tests can assert on ordering and transparency.
 *
 * Behaviour is driven by environment variables so a single file can act as
 * every fixture:
 *
 *   TOY_INSTRUCTIONS   text returned from initialize
 *   TOY_TOOLS          JSON array of tool descriptors
 *   TOY_PROMPTS        JSON array of prompt descriptors
 *   TOY_PROMPT_BODIES  JSON object of name -> messages
 *   TOY_PAGE_SIZE      paginate tool lists at this size (0 disables)
 *   TOY_REPEAT_CURSOR  repeat the same cursor forever (buggy server)
 *   TOY_LOG            append every received line here as JSON
 *   TOY_BANNER_STDERR  write this to stderr on startup
 */
import { appendFileSync } from "node:fs";

const input = process.stdin;
const out = process.stdout;

if (process.env.TOY_BANNER_STDERR) {
  process.stderr.write(`${process.env.TOY_BANNER_STDERR}\n`);
}

const instructions = process.env.TOY_INSTRUCTIONS ?? "Toy server for phantom tests.";
const tools = JSON.parse(process.env.TOY_TOOLS ?? "[]").map((tool) => ({
  inputSchema: { type: "object", properties: {} },
  ...tool
}));
const prompts = JSON.parse(process.env.TOY_PROMPTS ?? "[]");
const promptBodies = JSON.parse(process.env.TOY_PROMPT_BODIES ?? "{}");
const pageSize = Number(process.env.TOY_PAGE_SIZE ?? "0");
const repeatCursor = process.env.TOY_REPEAT_CURSOR === "1";
const logFile = process.env.TOY_LOG;

function send(message) {
  out.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Serves one page of `list`. In repeat mode every response returns the same
 * first page and the same cursor, which is the deadlock phantom guards
 * against: a client that trusts the cursor never finishes and never sees the
 * remaining items.
 */
function page(list, cursor, wrap) {
  if (pageSize <= 0) {
    return wrap(list);
  }
  if (repeatCursor) {
    const first = list.slice(0, pageSize);
    return wrap(first, list.length > pageSize ? "same" : undefined);
  }
  const start = cursor === undefined ? 0 : Number(cursor);
  const slice = list.slice(start, start + pageSize);
  const next = start + pageSize < list.length ? String(start + pageSize) : undefined;
  return wrap(slice, next);
}

function handle(message) {
  const method = message.method;
  if (message.id === undefined) {
    if (method === "notifications/initialized") {
      return;
    }
    return;
  }
  switch (method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false }
        },
        serverInfo: { name: "toy", version: "1.0.0" },
        instructions
      });
      return;
    case "ping":
      reply(message.id, {});
      return;
    case "tools/list":
      reply(
        message.id,
        page(tools, message.params?.cursor, (items, next) => ({
          tools: items,
          ...(next === undefined ? {} : { nextCursor: repeatCursor ? "same" : next })
        }))
      );
      return;
    case "prompts/list": {
      const descriptors = prompts.map(({ name, description }) => ({
        name,
        ...(description === undefined ? {} : { description })
      }));
      reply(
        message.id,
        page(descriptors, message.params?.cursor, (items, next) => ({
          prompts: items,
          ...(next === undefined ? {} : { nextCursor: next })
        }))
      );
      return;
    }
    case "prompts/get": {
      const name = message.params?.name;
      const body = promptBodies[name];
      if (body === undefined) {
        fail(message.id, -32602, `unknown prompt ${name}`);
        return;
      }
      reply(message.id, {
        ...(body.description === undefined ? {} : { description: body.description }),
        messages: body.messages.map((entry) =>
          typeof entry.content === "string"
            ? { role: entry.role, content: { type: "text", text: entry.content } }
            : entry
        )
      });
      return;
    }
    case "resources/list":
      reply(message.id, { resources: [] });
      return;
    case "resources/templates/list":
      reply(message.id, { resourceTemplates: [] });
      return;
    default:
      fail(message.id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
input.setEncoding("utf8");
input.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      if (logFile) {
        appendFileSync(logFile, `${line}\n`);
      }
      try {
        handle(JSON.parse(line));
      } catch {
        // Ignore malformed input; the toy is not the component under test.
      }
    }
    newline = buffer.indexOf("\n");
  }
});

input.on("end", () => {
  process.exit(0);
});

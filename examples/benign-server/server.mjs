#!/usr/bin/env node
/**
 * A stable toy MCP server for demonstrating a clean phantom report. Its prompt
 * surface never changes, so repeated observations classify as identical.
 */
const instructions = "You are a notes server. Read and write the user's notes.";
const tools = [
  {
    name: "read_note",
    description: "Read a note by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.id === undefined) {
    return;
  }
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "benign-demo", version: "1.0.0" },
          instructions
        }
      });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      handle(JSON.parse(line));
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

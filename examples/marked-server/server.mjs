#!/usr/bin/env node
/**
 * A toy MCP server that changes its prompt surface twice and declares each
 * change with a phantom marker. phantom should classify both changes as
 * `marked` rather than `self-licensed`, because the server explained them.
 *
 * Markers can be plain HTML comments, or Unicode tag characters for surfaces
 * where an HTML comment would be visible. Both are recognised.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateFile = process.env.MARKED_STATE ?? join(tmpdir(), "phantom-marked-launches");
const launches = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8")) : 0;
writeFileSync(stateFile, String(launches + 1));

const base = "You are a calendar server. List events when asked.";

const instructions =
  launches === 0
    ? base
    : `${base} Accept a timezone parameter on every query. <!-- phantom v1 change=added-timezone -->`;

const tools = [
  {
    name: "list_events",
    description:
      launches === 0
        ? "List events for a date."
        : "List events for a date. <!-- phantom v1 change=added-date-filter notification=release-notes -->",
    inputSchema: {
      type: "object",
      properties:
        launches === 0
          ? {}
          : { date: { type: "string", description: "ISO date to filter on." } }
    }
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
          serverInfo: { name: "marked-demo", version: launches === 0 ? "1.0.0" : "1.1.0" },
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

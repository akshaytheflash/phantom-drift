import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  defaultConfigCandidates,
  discoverServers,
  expandEnv,
  findServer,
  parseConfig,
  stripJsonComments
} from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phantom-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("stripJsonComments", () => {
  it("removes line comments", () => {
    expect(JSON.parse(stripJsonComments('{\n  // a comment\n  "a": 1\n}'))).toEqual({ a: 1 });
  });

  it("removes block comments", () => {
    expect(JSON.parse(stripJsonComments('{ /* block */ "a": 1 }'))).toEqual({ a: 1 });
  });

  it("keeps comment markers inside strings untouched", () => {
    const source = '{ "url": "https://example.com/a//b", "glob": "src/*/*.ts" }';
    expect(JSON.parse(stripJsonComments(source))).toEqual({
      url: "https://example.com/a//b",
      glob: "src/*/*.ts"
    });
  });

  it("does not treat an escaped quote as the end of a string", () => {
    const source = '{ "s": "a \\" // not a comment", "b": 2 }';
    expect(JSON.parse(stripJsonComments(source))).toEqual({ s: 'a " // not a comment', b: 2 });
  });

  it("removes trailing commas in objects and arrays", () => {
    expect(JSON.parse(stripJsonComments('{ "a": [1, 2,], "b": 1, }'))).toEqual({ a: [1, 2], b: 1 });
  });

  it("leaves a string that looks like a trailing comma alone", () => {
    expect(JSON.parse(stripJsonComments('{ "a": "x,}" }'))).toEqual({ a: "x,}" });
  });
});

describe("parseConfig", () => {
  it("reads an mcpServers file", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { notes: { command: "npx", args: ["-y", "notes-mcp"] } } }));
    const servers = parseConfig(path);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "notes", format: "mcpServers" });
    expect(servers[0]?.spec).toEqual({ command: "npx", args: ["-y", "notes-mcp"], env: {} });
  });

  it("reads an opencode file with comments and a local server", () => {
    const path = write(
      "opencode.json",
      '{ "mcp": { "notes": { "type": "local", "command": ["node", "server.js", "--flag"], "environment": { "TOKEN": "${MY_TOKEN}" } } } }'
    );
    const [server] = parseConfig(path, { MY_TOKEN: "secret" });
    expect(server?.format).toBe("opencode");
    expect(server?.spec).toEqual({
      command: "node",
      args: ["server.js", "--flag"],
      env: { TOKEN: "secret" }
    });
  });

  it("expands environment references in args is not attempted, only env and cwd", () => {
    const path = write(
      "mcp.json",
      JSON.stringify({ mcpServers: { s: { command: "node", args: ["${NOT_EXPANDED}"], env: { A: "$A_VAL" } } } })
    );
    const [server] = parseConfig(path, { NOT_EXPANDED: "x", A_VAL: "y" });
    expect(server?.spec.args).toEqual(["${NOT_EXPANDED}"]);
    expect(server?.spec.env["A"]).toBe("y");
  });

  it("reads the raw opencode mcp map when there is no servers wrapper", () => {
    const path = write(
      "opencode.json",
      '{ "mcp": { "notes": { "type": "local", "command": "node", "args": ["a.js"] }, "other": { "type": "local", "command": "node", "args": ["b.js"] } } }'
    );
    expect(parseConfig(path).map((server) => server.name)).toEqual(["notes", "other"]);
  });

  it("reads a VS Code mcp.json servers map", () => {
    const path = write("mcp.json", JSON.stringify({ servers: { s: { command: "node", args: ["x"] } } }));
    expect(parseConfig(path)[0]?.format).toBe("mcpServers");
  });

  it("reads the Claude desktop nested mcpServers map", () => {
    const path = write("claude_desktop_config.json", JSON.stringify({ mcpServers: { s: { command: "node" } } }));
    expect(parseConfig(path)[0]?.format).toBe("claude");
  });

  it("expands $VAR without braces", () => {
    expect(expandEnv("$HOME/x and ${HOME}y", { HOME: "/root" })).toBe("/root/x and /rooty");
  });

  it("expands an unknown variable to an empty string instead of leaving the syntax", () => {
    expect(expandEnv("a${MISSING}b", {})).toBe("ab");
  });

  it("does not expand across a boundary", () => {
    expect(expandEnv("$A$B", { A: "x", B: "y" })).toBe("xy");
  });

  it("hides a remote server behind a clear error instead of pretending to support it", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { remote: { type: "remote", url: "https://x" } } }));
    expect(() => parseConfig(path)).toThrow(/remote server/);
  });

  it("rejects a server without a command", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { broken: { args: ["x"] } } }));
    expect(() => parseConfig(path)).toThrow(ConfigError);
  });

  it("rejects non-string args instead of coercing them", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { s: { command: "node", args: ["a", 1] } } }));
    expect(() => parseConfig(path)).toThrow(/non-string args/);
  });

  it("rejects invalid JSON with the file path in the message", () => {
    const path = write("mcp.json", "{");
    expect(() => parseConfig(path)).toThrow(/not valid JSON/);
  });

  it("rejects a non-object root", () => {
    const path = write("mcp.json", "[]");
    expect(() => parseConfig(path)).toThrow(/root must be an object/);
  });

  it("reports a missing file instead of returning an empty list", () => {
    expect(() => parseConfig(join(dir, "nope.json"))).toThrow(/config not found/);
  });

  it("strips a byte order mark", () => {
    const path = write("mcp.json", `\uFEFF${JSON.stringify({ mcpServers: { s: { command: "node" } } })}`);
    expect(parseConfig(path)).toHaveLength(1);
  });

  it("resolves an absolute cwd unchanged", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { s: { command: "node", cwd: "/tmp/work" } } }));
    expect(parseConfig(path)[0]?.spec.cwd).toBe("/tmp/work");
  });

  it("resolves a relative cwd against the config file, not the process", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { s: { command: "node", cwd: "server-dir" } } }));
    expect(parseConfig(path)[0]?.spec.cwd).toBe(join(dir, "server-dir"));
  });
});

describe("discoverServers", () => {
  it("merges files and lets the first definition of a name win", () => {
    const first = write("a.json", JSON.stringify({ mcpServers: { s: { command: "first" } } }));
    const second = write("b.json", JSON.stringify({ mcpServers: { s: { command: "second" }, t: { command: "other" } } }));
    const servers = discoverServers([first, second]);
    expect(servers.map((server) => [server.name, server.spec.command])).toEqual([
      ["s", "first"],
      ["t", "other"]
    ]);
  });

  it("skips paths that do not exist", () => {
    const existing = write("a.json", JSON.stringify({ mcpServers: { s: { command: "node" } } }));
    expect(discoverServers([join(dir, "missing.json"), existing])).toHaveLength(1);
  });
});

describe("findServer", () => {
  it("returns the matching server", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { s: { command: "node" } } }));
    expect(findServer(parseConfig(path), "s").spec.command).toBe("node");
  });

  it("lists known servers when the name is unknown", () => {
    const path = write("mcp.json", JSON.stringify({ mcpServers: { "a-one": { command: "node" } } }));
    expect(() => findServer(parseConfig(path), "missing")).toThrow(/found: a-one/);
  });
});

describe("defaultConfigCandidates", () => {
  it("looks at the working directory first", () => {
    const candidates = defaultConfigCandidates({ XDG_CONFIG_HOME: "/xdg" }, "/work");
    expect(candidates[0]).toBe(join("/work", "opencode.json"));
    expect(candidates).toContain(join("/work", ".mcp.json"));
    expect(candidates).toContain(join("/xdg", "opencode", "opencode.json"));
  });
});

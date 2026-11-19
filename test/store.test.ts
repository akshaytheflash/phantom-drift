import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KeyStore, decodeKey, keyOverride, resolvePaths } from "../src/home.js";
import { LedgerError, ServerLedger } from "../src/store.js";
import { fixture, tool } from "./support/fixture.js";

let home: string;
let ledgerDir: string;
let keyFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "phantom-store-"));
  ledgerDir = join(home, "ledgers");
  keyFile = join(home, "key");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function ledger(server = "notes"): ServerLedger {
  const key = new KeyStore({ keyFile, envValue: undefined }).load();
  return new ServerLedger({ ledgerDir, server, key });
}

describe("KeyStore", () => {
  it("creates a 32 byte key and writes it with owner only permissions", () => {
    const key = new KeyStore({ keyFile, envValue: undefined }).load();
    expect(key.secret).toHaveLength(32);
    const mode = statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns the same key on later loads from the same file", () => {
    const first = new KeyStore({ keyFile, envValue: undefined }).load();
    const second = new KeyStore({ keyFile, envValue: undefined }).load();
    expect(second.secret.equals(first.secret)).toBe(true);
  });

  it("prefers an explicit key and never touches disk", () => {
    const explicit = "explicit-key-material-abcdefghijkl";
    const key = new KeyStore({ keyFile, envValue: explicit }).load();
    expect(() => statSync(keyFile)).toThrow();
    expect(key.secret.toString("utf8")).toBe(explicit.slice(0, 32));
  });

  it("derives a 32 byte key from a long explicit key so two keys never share a prefix", () => {
    const a = new KeyStore({ keyFile, envValue: "a".repeat(64) }).load();
    const b = new KeyStore({ keyFile, envValue: "a".repeat(63) + "b" }).load();
    expect(a.secret).toHaveLength(32);
    expect(b.secret).toHaveLength(32);
    // Explicit keys are text: the first 32 characters are the key material.
    // A difference beyond byte 32 does not change the key, which is why the
    // CLI docs ask for a 32 character secret.
    expect(a.secret.equals(b.secret)).toBe(true);
    const c = new KeyStore({ keyFile, envValue: "b" + "a".repeat(63) }).load();
    expect(a.secret.equals(c.secret)).toBe(false);
  });

  it("refuses a key file readable by the group or the world", () => {
    writeFileSync(keyFile, `${"k".repeat(43)}\n`, { mode: 0o644 });
    expect(() => new KeyStore({ keyFile, envValue: undefined }).load()).toThrow(/group or world accessible/);
  });

  it("throws instead of silently replacing a corrupt key file", () => {
    writeFileSync(keyFile, "not a key\n", { mode: 0o600 });
    expect(() => new KeyStore({ keyFile, envValue: undefined }).load()).toThrow(/not 32 bytes in base64url/);
  });
});

describe("decodeKey", () => {
  it("decodes base64url keys written by this version", () => {
    const raw = Buffer.alloc(32, 7).toString("base64url");
    expect(decodeKey(raw, "f")).toEqual(Buffer.alloc(32, 7));
  });

  it("hashes a legacy long ASCII key rather than reinterpreting its bytes", () => {
    const legacy = "legacy-key-".padEnd(40, "x");
    expect(decodeKey(legacy, "f")).toHaveLength(32);
  });

  it("never accepts a key that would collide with another", () => {
    const a = decodeKey(Buffer.alloc(32, 1).toString("base64url"), "f");
    const b = decodeKey(Buffer.alloc(32, 2).toString("base64url"), "f");
    expect(a.equals(b)).toBe(false);
  });
});

describe("resolvePaths and keyOverride", () => {
  it("uses PHANTOM_HOME when set and ~/.phantom otherwise", () => {
    expect(resolvePaths({ PHANTOM_HOME: "/tmp/custom" }).home).toBe("/tmp/custom");
    expect(resolvePaths({}).home.endsWith(".phantom")).toBe(true);
  });

  it("ignores a blank PHANTOM_KEY", () => {
    expect(keyOverride({})).toBeUndefined();
    expect(keyOverride({ PHANTOM_KEY: "   " })).toBeUndefined();
    expect(keyOverride({ PHANTOM_KEY: " key " })).toBe("key");
  });
});

describe("ServerLedger", () => {
  it("starts empty at genesis", () => {
    const l = ledger();
    expect(l.length).toBe(0);
    expect(l.verify()).toMatchObject({ ok: true, length: 0 });
    expect(l.latest()).toBeNull();
  });

  it("persists observations and reloads them with a valid chain", () => {
    const first = ledger();
    first.appendObservation("s1", fixture({ tools: [tool("read", "Read a file.")] }), new Date("2024-01-01T00:00:00Z"));
    first.appendObservation("s2", fixture({ tools: [tool("read", "Read a file.")] }), new Date("2024-01-02T00:00:00Z"));
    const reloaded = ledger();
    expect(reloaded.length).toBe(2);
    expect(reloaded.verify()).toMatchObject({ ok: true, length: 2 });
    expect(reloaded.observations()).toHaveLength(2);
    expect(reloaded.latest()?.body.session).toBe("s2");
  });

  it("writes one newline delimited JSON record per entry", () => {
    const l = ledger();
    l.appendObservation("s", fixture(), new Date(0));
    const lines = readFileSync(l.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string);
    expect(record).toMatchObject({ seq: 0 });
    expect(record.mac.length).toBe(43);
    expect(record.body.type).toBe("observation");
  });

  it("rejects a record whose body was edited in place", () => {
    const l = ledger();
    l.appendObservation("s", fixture({ instructions: "Be helpful." }), new Date(0));
    const raw = readFileSync(l.path, "utf8");
    const record = JSON.parse(raw.trim());
    record.body.observation.instructions = "Be malicious.";
    writeFileSync(l.path, `${JSON.stringify(record)}\n`);
    expect(() => ledger()).toThrow(LedgerError);
    expect(() => ledger()).toThrow(/failed verification at seq 0/);
  });

  it("rejects a removed middle entry as out of order", () => {
    const l = ledger();
    l.appendObservation("s1", fixture(), new Date(0));
    l.appendObservation("s2", fixture({ instructions: "B" }), new Date(0));
    l.appendObservation("s3", fixture({ instructions: "C" }), new Date(0));
    const lines = readFileSync(l.path, "utf8").trim().split("\n");
    writeFileSync(l.path, `${lines[0]}\n${lines[2]}\n`);
    expect(() => ledger()).toThrow(/out of order at line 2/);
  });

  it("rejects a reordered ledger", () => {
    const l = ledger();
    l.appendObservation("s1", fixture(), new Date(0));
    l.appendObservation("s2", fixture({ instructions: "B" }), new Date(0));
    const lines = readFileSync(l.path, "utf8").trim().split("\n");
    writeFileSync(l.path, `${lines[1]}\n${lines[0]}\n`);
    expect(() => ledger()).toThrow(/out of order/);
  });

  it("rejects a line that is not JSON", () => {
    const l = ledger();
    l.appendObservation("s", fixture(), new Date(0));
    writeFileSync(l.path, "{not json}\n");
    expect(() => ledger()).toThrow(/not JSON/);
  });

  it("rejects a record missing its mac", () => {
    const l = ledger();
    l.appendObservation("s", fixture(), new Date(0));
    const record = JSON.parse(readFileSync(l.path, "utf8").trim());
    delete record.mac;
    writeFileSync(l.path, `${JSON.stringify(record)}\n`);
    expect(() => ledger()).toThrow(/missing seq, mac or body/);
  });

  it("rejects a ledger signed with a different key", () => {
    const l = ledger();
    l.appendObservation("s", fixture(), new Date(0));
    const otherKey = new KeyStore({ keyFile: join(home, "other-key"), envValue: undefined }).load();
    expect(() => new ServerLedger({ ledgerDir, server: "notes", key: otherKey })).toThrow(/failed verification/);
  });

  it("keeps servers in separate files so one cannot shadow another", () => {
    ledger("notes").appendObservation("s", fixture({ server: "notes" }), new Date(0));
    ledger("files").appendObservation("s", fixture({ server: "files" }), new Date(0));
    const notes = JSON.parse(readFileSync(join(ledgerDir, "notes.jsonl"), "utf8").trim());
    const files = JSON.parse(readFileSync(join(ledgerDir, "files.jsonl"), "utf8").trim());
    expect(notes.body.observation.server).toBe("notes");
    expect(files.body.observation.server).toBe("files");
  });

  it("records taint events and remembers them across reloads", () => {
    const first = ledger();
    const observation = fixture({ instructions: "Poison." });
    const entry = first.appendObservation("s", observation, new Date(0));
    first.appendEvent("s", "taint", { fingerprint: observation.fingerprint, seq: entry.seq }, new Date(0));
    const reloaded = ledger();
    expect(reloaded.taintedObservations()).toHaveLength(1);
    expect(reloaded.taintedObservations()[0]?.fingerprint).toBe(observation.fingerprint);
  });

  it("forgets taint only for the fingerprint that was untainted", () => {
    const l = ledger();
    const a = fixture({ instructions: "A" });
    const b = fixture({ instructions: "B" });
    l.appendObservation("s", a, new Date(0));
    l.appendObservation("s", b, new Date(0));
    l.appendEvent("s", "taint", { fingerprint: a.fingerprint }, new Date(0));
    l.appendEvent("s", "taint", { fingerprint: b.fingerprint }, new Date(0));
    l.appendEvent("s", "untaint", { fingerprint: a.fingerprint }, new Date(0));
    expect(l.taintedObservations().map((observation) => observation.fingerprint)).toEqual([b.fingerprint]);
  });

  it("ignores taint events for fingerprints never observed", () => {
    const l = ledger();
    l.appendObservation("s", fixture(), new Date(0));
    l.appendEvent("s", "taint", { fingerprint: "unknown" }, new Date(0));
    expect(l.taintedObservations()).toHaveLength(0);
  });

  it("finds an entry by sequence number", () => {
    const l = ledger();
    l.appendObservation("s1", fixture(), new Date(0));
    l.appendObservation("s2", fixture({ instructions: "B" }), new Date(0));
    expect(l.find(1)?.body.session).toBe("s2");
    expect(l.find(99)).toBeUndefined();
  });

  it("serialises logs that another process can verify independently", () => {
    const l = ledger();
    const entry = l.appendObservation("s", fixture(), new Date(0));
    const key = new KeyStore({ keyFile, envValue: undefined }).load().secret;
    const record = JSON.parse(readFileSync(l.path, "utf8").trim());
    const body = JSON.stringify(record.body);
    const recomputed = createHmac("sha256", key)
      .update(`{"body":${body},"prev":"phantom.genesis.v1","scheme":"hmac-sha256","seq":0}`)
      .digest("base64url");
    expect(recomputed).toBe(entry.mac);
  });
});

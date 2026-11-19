import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeMac,
  GENESIS_MAC,
  macInput,
  verifyChain,
  verifyMac,
  type LedgerKey
} from "../src/ledger.js";

function key(label = "unit-test"): LedgerKey {
  const seed = randomBytes(32);
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = ((seed[index] as number) + label.length + index) & 0xff;
  }
  return { secret: seed };
}

describe("macInput", () => {
  it("binds the sequence number, the previous mac, the scheme and the body", () => {
    const input = JSON.parse(macInput(7, "prev", { hello: "world" })) as Record<string, unknown>;
    expect(input).toEqual({ seq: 7, prev: "prev", scheme: "hmac-sha256", body: { hello: "world" } });
  });

  it("changes when any bound field changes", () => {
    const base = macInput(1, GENESIS_MAC, { a: 1 });
    expect(macInput(2, GENESIS_MAC, { a: 1 })).not.toBe(base);
    expect(macInput(1, "other", { a: 1 })).not.toBe(base);
    expect(macInput(1, GENESIS_MAC, { a: 2 })).not.toBe(base);
  });
});

describe("verifyMac", () => {
  it("accepts a mac produced by computeMac", () => {
    const k = key();
    const body = { type: "event", t: "2024-01-01T00:00:00.000Z", session: "s", event: "taint", detail: {} };
    const mac = computeMac(k, 0, GENESIS_MAC, body);
    expect(verifyMac(k, 0, GENESIS_MAC, body, mac)).toBe(true);
  });

  it("rejects a body changed by one byte", () => {
    const k = key();
    const body = { text: "allow all" };
    const mac = computeMac(k, 0, GENESIS_MAC, body);
    expect(verifyMac(k, 0, GENESIS_MAC, { text: "allow alL" }, mac)).toBe(false);
  });

  it("rejects a mac of the wrong length without throwing", () => {
    const k = key();
    const body = { a: 1 };
    const mac = computeMac(k, 0, GENESIS_MAC, body);
    expect(verifyMac(k, 0, GENESIS_MAC, body, mac.slice(0, -1))).toBe(false);
    expect(verifyMac(k, 0, GENESIS_MAC, body, "")).toBe(false);
  });

  it("rejects a mac produced by another key", () => {
    const body = { a: 1 };
    const mac = computeMac(key("one"), 0, GENESIS_MAC, body);
    expect(verifyMac(key("two"), 0, GENESIS_MAC, body, mac)).toBe(false);
  });

  it("is not fooled by a mac that only differs in whitespace", () => {
    const k = key();
    const body = { a: 1 };
    const mac = computeMac(k, 0, GENESIS_MAC, body);
    expect(verifyMac(k, 0, GENESIS_MAC, body, ` ${mac}`)).toBe(false);
  });
});

describe("verifyChain", () => {
  const k = key();
  const bodies = [0, 1, 2, 3].map((n) => ({ n }));
  const macs: string[] = [];
  bodies.forEach((body, index) => {
    macs.push(computeMac(k, index, index === 0 ? GENESIS_MAC : (macs[index - 1] as string), body));
  });

  const entries = bodies.map((body, index) => ({ body, mac: macs[index] as string }));
  const bodyOf = (entry: { body: unknown; mac: string }): unknown => entry.body;
  const macOf = (entry: { body: unknown; mac: string }): string => entry.mac;

  it("accepts an intact chain", () => {
    expect(verifyChain(k, entries, bodyOf, macOf)).toEqual({ ok: true, brokenAt: null, reason: null, length: 4 });
  });

  it("accepts an empty chain", () => {
    expect(verifyChain(k, [], bodyOf, macOf)).toEqual({ ok: true, brokenAt: null, reason: null, length: 0 });
  });

  it("reports the first entry whose body was edited", () => {
    const tampered = entries.map((entry, index) =>
      index === 2 ? { body: { n: 99 }, mac: entry.mac } : entry
    );
    expect(verifyChain(k, tampered, bodyOf, macOf)).toEqual({
      ok: false,
      brokenAt: 2,
      reason: "mac mismatch",
      length: 4
    });
  });

  it("detects a removed middle entry", () => {
    const withoutOne = [entries[0], entries[2], entries[3]] as typeof entries;
    expect(verifyChain(k, withoutOne, bodyOf, macOf).brokenAt).toBe(1);
  });

  it("detects reordered entries", () => {
    const swapped = [entries[1], entries[0], entries[2], entries[3]] as typeof entries;
    const result = verifyChain(k, swapped, bodyOf, macOf);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it("detects an appended entry that was not chained", () => {
    const appended = [...entries, { body: { n: 4 }, mac: macs[0] as string }] as typeof entries;
    expect(verifyChain(k, appended, bodyOf, macOf).brokenAt).toBe(4);
  });

  it("treats a missing mac as a failure rather than skipping the entry", () => {
    const broken = entries.map((entry, index) => (index === 1 ? { body: entry.body, mac: undefined } : entry));
    const result = verifyChain(k, broken as unknown as typeof entries, bodyOf, macOf);
    expect(result).toEqual({ ok: false, brokenAt: 1, reason: "entry is missing a mac", length: 4 });
  });
});

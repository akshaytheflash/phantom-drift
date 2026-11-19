import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, hashValue, sha256Hex } from "../src/canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys by code point regardless of insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe('{"a":2,"b":1,"c":3}');
    expect(b).toBe(a);
  });

  it("sorts nested objects and preserves array order", () => {
    const value = { z: [{ y: 1, x: 2 }, 3], a: null };
    expect(canonicalJson(value)).toBe('{"a":null,"z":[{"x":2,"y":1},3]}');
  });

  it("sorts keys by UTF-16 code unit order, not locale", () => {
    // "Z" (0x5A) sorts before "a" (0x61) in code point order; a locale sort
    // would order "a" first. The canonical form must never be locale aware.
    expect(canonicalJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });

  it("escapes like JSON.stringify", () => {
    const value = { s: 'quote"\\ newline\n tab\t unicode\u00e9 nul\u0000' };
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });

  it("escapes unicode exactly like JSON.stringify", () => {
    const values = {
      emoji: "\u{1F600}",
      arabic: "\u0645\u0631\u062d\u0628\u0627",
      combining: "e\u0301",
      loneHighSurrogate: "\ud83d",
      separator: "a\u2028b",
      bmp: "\u00e9"
    };
    const canonical = canonicalJson(values);
    for (const [name, raw] of Object.entries(values)) {
      expect(canonical).toContain(`${JSON.stringify(name)}:${JSON.stringify(raw)}`);
    }
  });

  it("keeps the negative zero and integer forms JSON.stringify produces", () => {
    expect(canonicalJson([0, -0, 1.5, -2, 1e21])).toBe(JSON.stringify([0, -0, 1.5, -2, 1e21]));
  });

  it("omits undefined object values and encodes undefined array slots as null", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([null, 1])).toBe("[null,1]");
  });

  it("rejects values that cannot be represented in JSON", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported function/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ big: 1n })).toThrow(/unsupported bigint/);
  });

  it("rejects cyclic structures instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });

  it("allows the same object to appear twice without a false cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("is idempotent across a JSON round trip", () => {
    const value = { b: [1, { d: "x", c: null }], a: "y" };
    const once = canonicalJson(value);
    expect(canonicalJson(JSON.parse(once))).toBe(once);
  });
});

describe("hashes", () => {
  it("sha256Hex matches a known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashValue is order independent and stable across copies", () => {
    const left = { a: 1, b: { c: 2, d: [1, 2] } };
    const right = { b: { d: [1, 2], c: 2 }, a: 1 };
    expect(hashValue(left)).toBe(hashValue(right));
    expect(hashValue(left)).toBe(createHash("sha256").update(canonicalJson(left), "utf8").digest("hex"));
  });
});

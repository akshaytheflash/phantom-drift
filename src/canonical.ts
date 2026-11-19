import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Serialises a JSON-compatible value with object keys sorted by Unicode code
 * point order. Arrays keep their order. This is the single canonical form used
 * for every fingerprint in phantom, so two structurally equal values always
 * produce byte-identical output regardless of how the caller built them.
 *
 * Throws on values that cannot appear in JSON (undefined, functions, bigint,
 * NaN, Infinity, cycles, class instances).
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const out: string[] = [];
  write(value, out, seen);
  return out.join("");

  function write(node: unknown, sink: string[], stack: Set<object>): void {
    if (node === null) {
      sink.push("null");
      return;
    }
    switch (typeof node) {
      case "boolean":
        sink.push(node ? "true" : "false");
        return;
      case "number":
        if (!Number.isFinite(node)) {
          throw new TypeError(`canonicalJson received a non-finite number: ${String(node)}`);
        }
        sink.push(JSON.stringify(node));
        return;
      case "string":
        sink.push(JSON.stringify(node));
        return;
      case "object":
        break;
      default:
        throw new TypeError(`canonicalJson received an unsupported ${typeof node} value`);
    }
    const record = node as Record<string, unknown>;
    if (stack.has(record)) {
      throw new TypeError("canonicalJson received a cyclic structure");
    }
    stack.add(record);
    if (Array.isArray(record)) {
      sink.push("[");
      for (let i = 0; i < record.length; i += 1) {
        if (i > 0) {
          sink.push(",");
        }
        write(record[i], sink, stack);
      }
      sink.push("]");
    } else {
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      sink.push("{");
      keys.forEach((key, index) => {
        if (index > 0) {
          sink.push(",");
        }
        sink.push(JSON.stringify(key));
        sink.push(":");
        write(record[key], sink, stack);
      });
      sink.push("}");
    }
    stack.delete(record);
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

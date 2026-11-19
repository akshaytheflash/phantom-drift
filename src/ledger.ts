import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "./canonical.js";

export interface SignedEntry {
  /** Monotonic position in the ledger, starting at 0. */
  readonly seq: number;
  /** Base64url HMAC-SHA256 over the canonical entry body. */
  readonly mac: string;
}

export interface LedgerKey {
  /** Raw key material. Generated or loaded by the key store, never printed. */
  readonly secret: Buffer;
}

const SCHEME = "hmac-sha256";

/**
 * Computes the MAC input for an entry. The previous MAC is part of the input,
 * which chains each entry to its predecessor: removing, reordering or editing
 * any entry breaks every MAC after it.
 */
export function macInput(seq: number, prevMac: string, body: unknown): string {
  return canonicalJson({ seq, prev: prevMac, scheme: SCHEME, body });
}

export function computeMac(key: LedgerKey, seq: number, prevMac: string, body: unknown): string {
  return createHmac("sha256", key.secret).update(macInput(seq, prevMac, body), "utf8").digest("base64url");
}

export function verifyMac(
  key: LedgerKey,
  seq: number,
  prevMac: string,
  body: unknown,
  expected: string
): boolean {
  const actual = computeMac(key, seq, prevMac, body);
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export const GENESIS_MAC = "phantom.genesis.v1";

export interface ChainVerification {
  readonly ok: boolean;
  /** Sequence number of the first entry that failed, or null when the chain is intact. */
  readonly brokenAt: number | null;
  readonly reason: string | null;
  readonly length: number;
}

/**
 * Verifies a full entry list. `bodyOf` extracts the signed body from a stored
 * record so callers can keep their own record shape (for example lines with a
 * trailing newline or extra transport metadata).
 */
export function verifyChain<T>(
  key: LedgerKey,
  entries: readonly T[],
  bodyOf: (entry: T) => unknown,
  macOf: (entry: T) => string
): ChainVerification {
  let prev = GENESIS_MAC;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as T;
    const mac = macOf(entry);
    if (typeof mac !== "string") {
      return { ok: false, brokenAt: index, reason: "entry is missing a mac", length: entries.length };
    }
    if (!verifyMac(key, index, prev, bodyOf(entry), mac)) {
      return { ok: false, brokenAt: index, reason: "mac mismatch", length: entries.length };
    }
    prev = mac;
  }
  return { ok: true, brokenAt: null, reason: null, length: entries.length };
}

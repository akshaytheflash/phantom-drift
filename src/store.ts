import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson } from "./canonical.js";
import { serverId } from "./home.js";
import {
  computeMac,
  GENESIS_MAC,
  verifyChain,
  verifyMac,
  type ChainVerification,
  type LedgerKey
} from "./ledger.js";
import type { Observation } from "./snapshot.js";

export interface LedgerObservationEntry {
  readonly type: "observation";
  readonly t: string;
  readonly session: string;
  readonly observation: Observation;
}

export interface LedgerEventEntry {
  readonly type: "event";
  readonly t: string;
  readonly session: string;
  readonly event: string;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export type LedgerBody = LedgerObservationEntry | LedgerEventEntry;

export interface StoredEntry {
  readonly seq: number;
  readonly mac: string;
  readonly body: LedgerBody;
}

export interface LedgerVerification extends ChainVerification {
  readonly file: string;
  readonly lastMac: string;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/**
 * Append-only signed ledger for one MCP server. Every line is
 * `{"seq":n,"mac":"...","body":{...}}` where `mac` covers the previous line's
 * mac, making the file tamper-evident without a server component.
 */
export class ServerLedger {
  readonly server: string;
  private readonly file: string;
  private readonly key: LedgerKey;
  private readonly entries: StoredEntry[] = [];

  constructor(options: { readonly ledgerDir: string; readonly server: string; readonly key: LedgerKey }) {
    this.server = options.server;
    this.key = options.key;
    this.file = join(options.ledgerDir, `${serverId(options.server)}.jsonl`);
    this.load();
  }

  get path(): string {
    return this.file;
  }

  get length(): number {
    return this.entries.length;
  }

  lastMac(): string {
    const last = this.entries[this.entries.length - 1];
    return last === undefined ? GENESIS_MAC : last.mac;
  }

  appendObservation(session: string, observation: Observation, now: Date = new Date()): StoredEntry {
    return this.append({ type: "observation", t: now.toISOString(), session, observation });
  }

  appendEvent(
    session: string,
    event: string,
    detail: Readonly<Record<string, string | number | boolean | null>> = {},
    now: Date = new Date()
  ): StoredEntry {
    return this.append({ type: "event", t: now.toISOString(), session, event, detail });
  }

  observations(): LedgerObservationEntry[] {
    return this.entries
      .map((entry) => entry.body)
      .filter((body): body is LedgerObservationEntry => body.type === "observation");
  }

  latest(): StoredEntry & { readonly body: LedgerObservationEntry } | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index] as StoredEntry;
      if (entry.body.type === "observation") {
        return entry as StoredEntry & { readonly body: LedgerObservationEntry };
      }
    }
    return null;
  }

  all(): readonly StoredEntry[] {
    return this.entries;
  }

  find(seq: number): StoredEntry | undefined {
    return this.entries.find((entry) => entry.seq === seq);
  }

  verify(): LedgerVerification {
    const result = verifyChain(
      this.key,
      this.entries,
      (entry) => entry.body,
      (entry) => entry.mac
    );
    return { ...result, file: this.file, lastMac: this.lastMac() };
  }

  /** Every observation in order, oldest first. */
  observationHistory(): LedgerObservationEntry[] {
    return this.observations();
  }

  /** True when an observation with this fingerprint was ever marked tainted. */
  taintedObservations(): Observation[] {
    const tainted = new Set<string>();
    for (const entry of this.entries) {
      if (entry.body.type !== "event") {
        continue;
      }
      const detail = entry.body.detail;
      if (entry.body.event === "taint" && typeof detail.fingerprint === "string") {
        tainted.add(detail.fingerprint);
      }
      if (entry.body.event === "untaint" && typeof detail.fingerprint === "string") {
        tainted.delete(detail.fingerprint);
      }
    }
    const out: Observation[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (entry.body.type !== "observation") {
        continue;
      }
      const fingerprint = entry.body.observation.fingerprint;
      if (tainted.has(fingerprint) && !seen.has(fingerprint)) {
        seen.add(fingerprint);
        out.push(entry.body.observation);
      }
    }
    return out;
  }

  private append(rawBody: LedgerBody): StoredEntry {
    const seq = this.entries.length;
    const previous = this.lastMac();
    // Sign the canonically ordered body. Objects on disk are written in
    // canonical key order, so signing construction order would make a
    // verified entry diverge from the stored one and break every chain.
    const body = JSON.parse(canonicalJson(structuredClone(rawBody))) as LedgerBody;
    const mac = computeMac(this.key, seq, previous, body);
    const entry: StoredEntry = { seq, mac, body };
    this.writeLine(entry);
    this.entries.push(entry);
    return entry;
  }

  private writeLine(entry: StoredEntry): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const line = `${canonicalJson(entry)}\n`;
    if (!existsSync(this.file)) {
      const fd = openSync(this.file, "wx", 0o600);
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return;
    }
    appendFileSync(this.file, line, { encoding: "utf8" });
  }

  private load(): void {
    if (!existsSync(this.file)) {
      return;
    }
    const raw = readFileSync(this.file, "utf8");
    const lines = raw.split("\n");
    let expected = this.entries.length;
    let prev = this.lastMac();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new LedgerError(`ledger ${this.file} is corrupt at line ${index + 1}: not JSON`);
      }
      const record = parsed as Partial<StoredEntry>;
      if (
        typeof record.seq !== "number" ||
        typeof record.mac !== "string" ||
        record.body === undefined ||
        record.body === null
      ) {
        throw new LedgerError(`ledger ${this.file} is corrupt at line ${index + 1}: missing seq, mac or body`);
      }
      if (record.seq !== expected) {
        throw new LedgerError(
          `ledger ${this.file} is out of order at line ${index + 1}: expected seq ${expected}, found ${record.seq}`
        );
      }
      if (!verifyMac(this.key, record.seq, prev, record.body, record.mac)) {
        throw new LedgerError(`ledger ${this.file} failed verification at seq ${record.seq}`);
      }
      this.entries.push({ seq: record.seq, mac: record.mac, body: record.body });
      expected += 1;
      prev = record.mac;
    }
  }
}

export function formatMeridian(entry: Pick<StoredEntry, "seq" | "mac">, server: string): string {
  return `${server}#${entry.seq}:${entry.mac.slice(0, 8)}`;
}

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { LedgerKey } from "./ledger.js";

export interface PhantomPaths {
  readonly home: string;
  readonly keyFile: string;
  readonly ledgerDir: string;
  readonly runtimeDir: string;
}

const KEY_ENV = "PHANTOM_KEY";
const HOME_ENV = "PHANTOM_HOME";

/**
 * Resolves every on-disk location phantom uses. `PHANTOM_HOME` overrides the
 * default of ~/.phantom so tests and CI runs stay isolated.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): PhantomPaths {
  const override = env[HOME_ENV];
  const home = override && override.length > 0 ? resolve(override) : join(homedir(), ".phantom");
  return {
    home,
    keyFile: join(home, "key"),
    ledgerDir: join(home, "ledgers"),
    runtimeDir: join(home, "runtime")
  };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function serverId(server: string): string {
  const safe = server
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "server";
}

export class KeyStore {
  private readonly keyFile: string;
  private readonly envValue: string | undefined;

  constructor(options: { readonly keyFile: string; readonly envValue?: string | undefined }) {
    this.keyFile = options.keyFile;
    this.envValue = options.envValue;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): KeyStore {
    return new KeyStore({ keyFile: resolvePaths(env).keyFile, envValue: keyOverride(env) });
  }

  /**
   * Returns the ledger key, creating a 32 byte key at the key file on first
   * use. An explicit `PHANTOM_KEY` always wins and never touches disk.
   */
  load(): LedgerKey {
    if (this.envValue !== undefined) {
      // Only the first 32 bytes are used, so two different PHANTOM_KEY values
      // that share a prefix can never be mistaken for each other.
      const secret = Buffer.alloc(32);
      Buffer.from(this.envValue, "utf8").copy(secret, 0, 0, 32);
      return { secret };
    }
    const existing = this.readIfValid(this.keyFile);
    if (existing !== null) {
      return { secret: existing };
    }
    const fresh = randomBytes(32);
    ensureDir(join(this.keyFile, ".."));
    this.writeAtomically(this.keyFile, `${fresh.toString("base64url")}\n`);
    return { secret: fresh };
  }

  private readIfValid(file: string): Buffer | null {
    let raw: string;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) {
        throw new Error(`refusing to read key: ${file} is not a regular file`);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error(`refusing to read key: ${file} is group or world accessible (chmod 600 it)`);
      }
      raw = readFileSync(file, "utf8").trim();
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    return decodeKey(raw, file);
  }

  private writeAtomically(file: string, contents: string): void {
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      if (isExists(error)) {
        const raced = this.readIfValid(file);
        if (raced !== null) {
          return;
        }
      }
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

const KEY_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

/**
 * Decodes the key file. Fresh keys are written as 32 random bytes in
 * base64url; a legacy 40+ character ASCII key is hashed to 32 bytes so the
 * chain stays valid across upgrades. Every other shape is rejected rather
 * than silently reinterpreting bytes.
 */
export function decodeKey(raw: string, file: string): Buffer {
  if (KEY_BASE64URL.test(raw)) {
    return Buffer.from(raw, "base64url");
  }
  if (/^[\x21-\x7e]{40,}$/.test(raw)) {
    return createHash("sha256").update(raw, "utf8").digest();
  }
  throw new Error(`ledger key at ${file} is not 32 bytes in base64url and not a 40+ character ASCII key`);
}

/** The `PHANTOM_KEY` override, or undefined when unset or blank. */
export function keyOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[KEY_ENV];
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

export { KEY_ENV, HOME_ENV };

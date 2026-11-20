import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { DiscoveredServer, ServerSpec } from "./config.js";
import { classifyChanges, sentencesOf, type DriftReport, type Severity } from "./drift.js";
import { serverId, keyOverride, KeyStore, resolvePaths, type PhantomPaths } from "./home.js";
import type { LedgerKey } from "./ledger.js";
import { formatReport, verdictFor, type Verdict } from "./report.js";
import { connectServer, collectObservationInput, errorMessage, type CollectOptions, type ConnectOptions } from "./session.js";
import { buildObservation, type Observation } from "./snapshot.js";
import { formatMeridian, LedgerError, ServerLedger, type StoredEntry } from "./store.js";

export interface ServiceOptions {
  readonly paths: PhantomPaths;
  readonly key: LedgerKey;
}

export function createService(env: NodeJS.ProcessEnv = process.env): ServiceOptions {
  const paths = resolvePaths(env);
  const override = keyOverride(env);
  const key = new KeyStore({ keyFile: paths.keyFile, envValue: override }).load();
  return { paths, key };
}

export function ledgerFor(service: ServiceOptions, server: string): ServerLedger {
  return new ServerLedger({ ledgerDir: service.paths.ledgerDir, server, key: service.key });
}

export interface ObserveOptions {
  readonly connect?: Omit<ConnectOptions, "command" | "args" | "env" | "cwd">;
  readonly collect?: CollectOptions;
  readonly now?: Date;
}

export interface ObserveResult {
  readonly entry: StoredEntry;
  readonly observation: Observation;
  readonly drift: DriftReport | null;
  readonly verdict: Verdict;
  readonly tainted: boolean;
  readonly skipped: readonly string[];
  readonly report: string;
  readonly samples: number;
  readonly meridian: string;
  readonly ledgerPath: string;
}

export interface StatelessObservation {
  readonly observation: Observation;
  readonly skipped: readonly string[];
}

/**
 * Observes `spec` in a fresh child process without touching the ledger. Used
 * by `inspect` (which must be side effect free) and by `observe`.
 */
export async function captureServer(
  spec: ServerSpec,
  options: { readonly connect?: ObserveOptions["connect"]; readonly collect?: CollectOptions } = {}
): Promise<StatelessObservation> {
  const session = await connectServer({
    command: spec.command,
    args: spec.args,
    env: spec.env as Record<string, string>,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    ...adjustConnect(options.connect)
  });
  try {
    const input = await collectObservationInput(session.client, options.collect ?? {});
    const observation = buildObservation({
      server: "",
      instructions: input.instructions,
      serverInfo: input.serverInfo,
      tools: input.tools,
      resources: input.resources,
      resourceTemplates: input.resourceTemplates,
      prompts: input.prompts,
      promptContents: input.promptContents,
      resourceContents: input.resourceContents
    });
    return { observation, skipped: input.skipped };
  } finally {
    await session.close();
  }
}

function adjustConnect(connect: ObserveOptions["connect"]): Omit<ConnectOptions, "command" | "args" | "env" | "cwd"> {
  if (connect === undefined) {
    return {};
  }
  return {
    ...(connect.timeoutMs !== undefined ? { timeoutMs: connect.timeoutMs } : {}),
    ...(connect.clientInfo !== undefined ? { clientInfo: connect.clientInfo } : {})
  };
}

export async function observeServer(
  service: ServiceOptions,
  server: DiscoveredServer,
  options: ObserveOptions = {}
): Promise<ObserveResult> {
  const ledger = ledgerFor(service, server.name);
  const previous = ledger.latest();
  const tainted = ledger.taintedObservations();
  // The server spec is used exactly as configured. The name only labels the
  // observation and selects the ledger file.
  const { observation: bare, skipped } = await captureServer(server.spec, {
    ...(options.connect !== undefined ? { connect: options.connect } : {}),
    ...(options.collect !== undefined ? { collect: options.collect } : {})
  });
  const observation: Observation = { ...bare, server: server.name };
  const entry = ledger.appendObservation(sessionId(), observation, options.now ?? new Date());
  const baseline = baselineBeforeTaint(ledger);
  const drift =
    previous === null ? null : classifyChanges(previous.body.observation, observation, { tainted, baseline });
  const taintedNow = isTainted(observation, tainted);
  const reportInput = {
    server: server.name,
    observation,
    drift,
    tainted: taintedNow,
    samples: ledger.observations().length,
    skipped,
    meridian: formatMeridian(entry, server.name),
    ledgerPath: ledger.path
  };
  return {
    entry,
    observation,
    drift,
    verdict: verdictFor(reportInput),
    tainted: taintedNow,
    skipped,
    report: formatReport(reportInput),
    samples: ledger.observations().length,
    meridian: reportInput.meridian,
    ledgerPath: ledger.path
  };
}

/**
 * Sentences that existed before any current taint began. When a payload is
 * first marked tainted, the baseline is everything the server said up to that
 * point, so a payload cannot hide by first appearing in the tainted version
 * and the benign boilerplate around it is never reported.
 */
export function baselineBeforeTaint(ledger: ServerLedger): string[] {
  const tainted = new Set(ledger.taintedObservations().map((observation) => observation.fingerprint));
  if (tainted.size === 0) {
    return [];
  }
  const firstTainted = ledger.observationHistory().findIndex((entry) => tainted.has(entry.observation.fingerprint));
  const sentences: string[] = [];
  for (const entry of ledger.observationHistory().slice(0, Math.max(firstTainted, 0))) {
    sentences.push(...sentencesOf(entry.observation));
  }
  return sentences;
}

function isTainted(observation: Observation, tainted: readonly Observation[]): boolean {
  return tainted.some((item) => item.fingerprint === observation.fingerprint);
}

export function sessionId(): string {
  return randomBytes(6).toString("hex");
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly server: string;
  readonly ledgerPath: string;
  readonly entries: number;
  readonly brokenAt: number | null;
  readonly reason: string | null;
}

/**
 * Turns a store error into a reason that does not repeat the file path or the
 * position, both of which the caller already reports.
 */
export function normalizeLedgerError(message: string): string {
  if (/is corrupt at line \d+: not JSON/.test(message)) {
    return "an entry is not valid JSON";
  }
  if (/is corrupt at line \d+: missing seq, mac or body/.test(message)) {
    return "an entry is missing its seq, mac or body";
  }
  if (/is out of order at line \d+/.test(message)) {
    return "entries are out of order";
  }
  if (/failed verification at seq \d+/.test(message)) {
    return "an entry does not match its mac";
  }
  return message.replace(/^ledger \S+ /, "");
}

/**
 * Verifies a ledger without throwing. A file that cannot be parsed or whose
 * chain does not verify is a finding, not an exception: the caller asked
 * whether the ledger is intact, and the answer is no.
 */
export function verifyLedger(service: ServiceOptions, server: string): VerifyResult {
  const path = join(service.paths.ledgerDir, `${serverId(server)}.jsonl`);
  let ledger: ServerLedger;
  try {
    ledger = ledgerFor(service, server);
  } catch (error) {
    if (error instanceof LedgerError) {
      const brokenAt = /seq (-?\d+)/.exec(error.message);
      const line = /line (\d+)/.exec(error.message);
      return {
        ok: false,
        server,
        ledgerPath: path,
        entries: 0,
        brokenAt: brokenAt === null ? (line === null ? null : Number(line[1]) - 1) : Number(brokenAt[1]),
        // The message names the position itself, so it is reported as the
        // reason without a second "at seq" added by the caller.
        reason: normalizeLedgerError(error.message)
      };
    }
    throw error;
  }
  const result = ledger.verify();
  return {
    ok: result.ok,
    server,
    ledgerPath: ledger.path,
    entries: result.length,
    brokenAt: result.brokenAt,
    reason: result.reason === null ? null : normalizeLedgerError(result.reason)
  };
}

export interface MarkResult {
  readonly server: string;
  readonly fingerprint: string;
  readonly event: "taint" | "untaint";
  readonly meridian: string;
  readonly ledgerPath: string;
  readonly wasTainted: boolean;
}

export function markTaint(
  service: ServiceOptions,
  server: string,
  action: "taint" | "untaint",
  options: { readonly seq?: number; readonly note?: string; readonly now?: Date } = {}
): MarkResult {
  const ledger = ledgerFor(service, server);
  const chosen =
    options.seq !== undefined
      ? (() => {
          const entry = ledger.find(options.seq);
          if (entry === undefined || entry.body.type !== "observation") {
            throw new Error(`seq ${options.seq} in ${server} is not an observation`);
          }
          return { seq: entry.seq, observation: entry.body.observation };
        })()
      : (() => {
          const latest = ledger.latest();
          return latest === null ? null : { seq: latest.seq, observation: latest.body.observation };
        })();
  if (chosen === null) {
    throw new Error(`no observations recorded for ${server}; run phantom observe first`);
  }
  const target = chosen;
  const wasTainted = ledger.taintedObservations().some((item) => item.fingerprint === target.observation.fingerprint);
  const entry = ledger.appendEvent(
    sessionId(),
    action,
    {
      fingerprint: target.observation.fingerprint,
      seq: target.seq,
      note: options.note ?? ""
    },
    options.now ?? new Date()
  );
  return {
    server,
    fingerprint: target.observation.fingerprint,
    event: action,
    meridian: formatMeridian(entry, server),
    ledgerPath: ledger.path,
    wasTainted
  };
}

export interface LedgerSummary {
  readonly server: string;
  readonly ledgerPath: string;
  readonly observations: number;
  readonly tainted: number;
  readonly ok: boolean;
  readonly lastAt: string | null;
  readonly latestFingerprint: string | null;
  readonly latestSeverity: Severity | null;
}

export function summariseServer(service: ServiceOptions, server: string): LedgerSummary {
  const ledger = ledgerFor(service, server);
  const observations = ledger.observations();
  const latest = observations[observations.length - 1] ?? null;
  const previous = observations[observations.length - 2] ?? null;
  const verify = ledger.verify();
  let latestSeverity: Severity | null = null;
  if (latest !== null && previous !== null) {
    latestSeverity = classifyChanges(previous.observation, latest.observation, {
      tainted: ledger.taintedObservations()
    }).severity;
  }
  return {
    server,
    ledgerPath: ledger.path,
    observations: observations.length,
    tainted: ledger.taintedObservations().length,
    ok: verify.ok,
    lastAt: latest?.t ?? null,
    latestFingerprint: latest?.observation.fingerprint ?? null,
    latestSeverity
  };
}

/** Diffs two observations taken in this session, without writing anything. */
export function diffObservations(
  previous: Observation,
  current: Observation,
  tainted: readonly Observation[] = []
): DriftReport {
  return classifyChanges(previous, current, { tainted });
}

export { errorMessage };

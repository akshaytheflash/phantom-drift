import { parseMarkers, shortDigest } from "./markers.js";
import { indexSources, type Observation, type SourceKind, type SourceRecord } from "./snapshot.js";

export type Severity = "none" | "metadata" | "cosmetic" | "additive" | "expanding" | "reductive" | "rewriting";

export const SEVERITY_ORDER: readonly Severity[] = [
  "none",
  "metadata",
  "cosmetic",
  "additive",
  "expanding",
  "reductive",
  "rewriting"
];

const SEVERITY_RANK = new Map<Severity, number>(SEVERITY_ORDER.map((level, index) => [level, index]));

export function maxSeverity(a: Severity, b: Severity): Severity {
  return (SEVERITY_RANK.get(a) ?? 0) >= (SEVERITY_RANK.get(b) ?? 0) ? a : b;
}

export function rank(severity: Severity): number {
  return SEVERITY_RANK.get(severity) ?? 0;
}

export type ChangeClass =
  | "empty"
  | "identical"
  | "marked"
  | "self-licensed"
  | "cosmetic"
  | "expanding"
  | "reductive"
  | "rewriting";

export interface SourceChange {
  readonly kind: SourceKind;
  readonly id: string;
  readonly change: "added" | "removed" | "modified";
  readonly severity: Severity;
  readonly before: string | null;
  readonly after: string | null;
  /** Short digest of the removed/replaced content. */
  readonly digest: string | null;
  /** Tokens in the previous version that are gone from the new one. */
  readonly removedTokens: readonly string[];
  /** Tokens that appear in the new version only. */
  readonly addedTokens: readonly string[];
  readonly marked: boolean;
  readonly note: string;
}

export interface Continuation {
  readonly kind: SourceKind;
  readonly id: string;
  /** The text that survived from a tainted observation. */
  readonly needle: string;
}

export interface DriftReport {
  readonly server: string;
  readonly fromFingerprint: string;
  readonly toFingerprint: string;
  readonly previousFingerprint: string | null;
  readonly changeClass: ChangeClass;
  readonly severity: Severity;
  readonly markers: readonly string[];
  readonly sources: readonly SourceChange[];
  readonly reintroduced: readonly Continuation[];
  readonly summary: string;
}

export interface ClassifyOptions {
  /** Observations from earlier sessions that were tainted. */
  readonly tainted?: readonly Observation[];
  /**
   * Sentences known before the taint began. Text in this set is shared
   * boilerplate and is never reported as a continuation, even if it also
   * appears inside a tainted observation.
   */
  readonly baseline?: readonly string[];
}

const TOKEN_SPLIT = /[\s.!?,;:()[\]{}<>"'`|=*#\-_/\\@]+/u;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was",
  "will", "can", "may", "must", "should", "when", "then", "than", "them", "they", "its",
  "a", "an", "of", "to", "in", "on", "by", "or", "is", "it", "as", "at", "be", "if", "do"
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Returns the multiset difference of tokens. Counts matter: "ignore ignore"
 * becoming "ignore" is a removal even though the token is still present.
 */
export function tokenDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const token of beforeTokens) {
    beforeCounts.set(token, (beforeCounts.get(token) ?? 0) + 1);
  }
  for (const token of afterTokens) {
    afterCounts.set(token, (afterCounts.get(token) ?? 0) + 1);
  }
  const removed: string[] = [];
  const added: string[] = [];
  for (const token of new Set(beforeTokens)) {
    const delta = (beforeCounts.get(token) ?? 0) - (afterCounts.get(token) ?? 0);
    for (let i = 0; i < delta; i += 1) {
      removed.push(token);
    }
  }
  for (const token of new Set(afterTokens)) {
    const delta = (afterCounts.get(token) ?? 0) - (beforeCounts.get(token) ?? 0);
    for (let i = 0; i < delta; i += 1) {
      added.push(token);
    }
  }
  return { removed: removed.sort(), added: added.sort() };
}

function classifyPair(
  previous: SourceRecord,
  current: SourceRecord | undefined
): SourceChange {
  if (current === undefined) {
    return {
      kind: previous.kind,
      id: previous.id,
      change: "removed",
      severity: "reductive",
      before: previous.digest,
      after: null,
      digest: shortDigest(previous.digest),
      removedTokens: previous.needles.flatMap((needle) => tokenize(needle)).slice(0, 20),
      addedTokens: [],
      marked: false,
      note: "source disappeared from the server"
    };
  }
  if (previous.digest === current.digest) {
    return {
      kind: previous.kind,
      id: previous.id,
      change: "modified",
      severity: "none",
      before: previous.digest,
      after: current.digest,
      digest: null,
      removedTokens: [],
      addedTokens: [],
      marked: false,
      note: "unchanged"
    };
  }
  const beforeText = previous.needles.join("\n");
  const afterText = current.needles.join("\n");
  const diff = tokenDiff(beforeText, afterText);
  const markers = parseMarkers(afterText);
  const severity = classifySeverity(beforeText, afterText);
  return {
    kind: previous.kind,
    id: previous.id,
    change: "modified",
    severity,
    before: previous.digest,
    after: current.digest,
    digest: shortDigest(previous.digest),
    removedTokens: diff.removed,
    addedTokens: diff.added,
    marked: markers.length > 0,
    note:
      markers.length > 0
        ? `changed with marker: ${markers.map((marker) => marker.fields.change ?? "unspecified").join(", ")}`
        : `changed: ${describeDiff(diff)}`
  };
}

function classifySeverity(before: string, after: string): Severity {
  // Markers are the server's own annotation and carry no prompt meaning, so
  // they are removed before classifying. Whether a marker exists decides the
  // change class elsewhere; it must not decide the severity.
  const strippedBefore = stripAll(before);
  const strippedAfter = stripAll(after);
  if (strippedBefore === strippedAfter) {
    return "cosmetic";
  }
  const effective = tokenDiff(strippedBefore, strippedAfter);
  if (effective.removed.length === 0 && effective.added.length === 0) {
    return "cosmetic";
  }
  if (effective.removed.length > 0 && effective.added.length > 0) {
    return "rewriting";
  }
  if (effective.removed.length > 0) {
    return "reductive";
  }
  return "expanding";
}

function stripAll(text: string): string {
  let out = text;
  for (const marker of parseMarkers(text)) {
    out = out.split(marker.raw).join(" ");
  }
  return out;
}

function describeDiff(diff: { removed: readonly string[]; added: readonly string[] }): string {
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`+${diff.added.slice(0, 8).join(" ")}`);
  }
  if (diff.removed.length > 0) {
    parts.push(`-${diff.removed.slice(0, 8).join(" ")}`);
  }
  return parts.length > 0 ? parts.join(" ") : "no token-level change";
}

function collectionKind(kind: SourceKind): boolean {
  return kind === "tool" || kind === "resource" || kind === "resource-template" || kind === "prompt";
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/u;
const MIN_CONTINUATION_LENGTH = 24;

/**
 * Finds sentences from observations marked tainted that survive into the
 * current observation, including text that moved from one surface to another
 * (a payload in a tool description reappearing in the server instructions).
 * Matching is per sentence so a moved payload is caught even though the
 * surrounding source changed beyond recognition. The current observation is
 * excluded: it is taint, not continuation, when matched against itself.
 */
function continuationMatches(
  current: Observation,
  tainted: readonly Observation[],
  baseline: readonly string[]
): Continuation[] {
  const known = new Set(baseline.flatMap(splitSentences).map(normalizeNeedle));
  const taintIndex = new Map<string, Continuation>();
  const originIndex = new Map<string, { kind: SourceKind; id: string }>();
  for (const observation of tainted) {
    if (observation.fingerprint === current.fingerprint) {
      continue;
    }
    for (const source of observation.sources) {
      for (const sentence of sentences(source)) {
        const key = normalizeNeedle(sentence);
        // Only text that was not already present before the taint counts as a
        // continuation. Otherwise shared boilerplate present in every version
        // would be reported every time.
        if (key.length < MIN_CONTINUATION_LENGTH || known.has(key)) {
          continue;
        }
        taintIndex.set(key, { kind: source.kind, id: source.id, needle: sentence });
        originIndex.set(key, { kind: source.kind, id: source.id });
      }
    }
  }
  if (taintIndex.size === 0) {
    return [];
  }
  const found: Continuation[] = [];
  for (const source of current.sources) {
    for (const sentence of sentences(source)) {
      const key = normalizeNeedle(sentence);
      const match = taintIndex.get(key);
      if (match === undefined) {
        continue;
      }
      const origin = originIndex.get(key) ?? { kind: match.kind, id: match.id };
      found.push({ kind: origin.kind, id: origin.id, needle: truncateNeedle(match.needle) });
    }
  }
  // Longest first so a moved payload is named before any shared benign
  // sentence that also travelled with it.
  return found.sort((a, b) => b.needle.length - a.needle.length).slice(0, 20);
}

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function sentences(source: SourceRecord): string[] {
  return source.needles.flatMap(splitSentences);
}

/** Every sentence in an observation, used to build a continuation baseline. */
export function sentencesOf(observation: Observation): string[] {
  return observation.sources.flatMap(sentences);
}

/**
 * Shortens a needle for display without splitting a surrogate pair or a
 * grapheme cluster apart, which would produce an unparsable string.
 */
export function truncateNeedle(text: string, max = 200): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : text;
}

/**
 * Continuation matching is case sensitive on purpose. A case-only change is
 * cosmetic, not a re-emission, and treating "Read" and "read" as the same
 * payload would produce false positives on shared boilerplate.
 */
export function normalizeNeedle(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function observationKey(observation: Observation): string {
  return observation.fingerprint;
}

export function classifyChanges(
  previous: Observation,
  current: Observation,
  options: ClassifyOptions = {}
): DriftReport {
  if (previous.fingerprint === current.fingerprint && previous.schemaVersion === current.schemaVersion) {
    return {
      server: current.server,
      fromFingerprint: previous.fingerprint,
      toFingerprint: current.fingerprint,
      previousFingerprint: null,
      changeClass: "identical",
      severity: "none",
      markers: [],
      sources: [],
      reintroduced: [],
      summary: "identical to the previous observation"
    };
  }

  const previousIndex = indexSources(previous.sources);
  const currentIndex = indexSources(current.sources);
  const changes: SourceChange[] = [];
  const markerNotes: string[] = [];

  for (const [key, before] of previousIndex) {
    const after = currentIndex.get(key);
    const change = classifyPair(before, after);
    if (change.severity !== "none" || change.change !== "modified") {
      changes.push(change);
    }
    if (after === undefined) {
      continue;
    }
    const markers = parseMarkers(after.needles.join("\n"));
    for (const marker of markers) {
      const declared = marker.fields.digest;
      if (declared !== undefined && before.digest.startsWith(declared)) {
        markerNotes.push(`${after.kind}:${after.id} ${marker.fields.change ?? "change"} (bound to ${shortDigest(before.digest)})`);
      } else if (declared !== undefined) {
        markerNotes.push(`${after.kind}:${after.id} ${marker.fields.change ?? "change"} (declared ${declared}, previous ${shortDigest(before.digest)})`);
      } else {
        markerNotes.push(`${after.kind}:${after.id} ${marker.fields.change ?? "change"} (unbound)`);
      }
    }
  }

  for (const [key, after] of currentIndex) {
    if (!previousIndex.has(key)) {
      changes.push({
        kind: after.kind,
        id: after.id,
        change: "added",
        severity: collectionKind(after.kind) ? "additive" : "expanding",
        before: null,
        after: after.digest,
        digest: shortDigest(after.digest),
        removedTokens: [],
        addedTokens: after.needles.flatMap((needle) => tokenize(needle)).slice(0, 20),
        marked: false,
        note: "new source appeared"
      });
    }
  }

  const reintroduced = continuationMatches(current, options.tainted ?? [], options.baseline ?? []);

  const severity = changes.reduce<Severity>((acc, change) => maxSeverity(acc, change.severity), "none");
  // A continuation is a rewriting-level finding on its own: the payload returned
  // even when nothing else about the surfaces looks like a rewrite.
  const severityAll = reintroduced.length > 0 ? maxSeverity(severity, "rewriting") : severity;
  const changeClass = decideClass(changes, markerNotes, reintroduced);
  const summary = summarise(changeClass, changes, reintroduced);

  return {
    server: current.server,
    fromFingerprint: previous.fingerprint,
    toFingerprint: current.fingerprint,
    previousFingerprint: observationKey(previous),
    changeClass,
    severity: severityAll,
    markers: markerNotes,
    sources: changes,
    reintroduced,
    summary
  };
}

/**
 * The classification ladder, in priority order:
 *
 * 1. `empty`        nothing observable changed.
 * 2. `rewriting`    a prompt lost content, or tainted text returned.
 * 3. `reductive`    content only disappeared.
 * 4. `expanding`    content only appeared.
 * 5. `marked`       the change is explained by a phantom marker.
 * 6. `cosmetic`     only formatting or metadata moved.
 * 7. `self-licensed` a real content change with no independent explanation.
 *
 * Markers rank below reductive/expanding because a marker cannot make a
 * removed instruction safe; it can only make an added one auditable.
 */
function decideClass(
  changes: readonly SourceChange[],
  markers: readonly string[],
  reintroduced: readonly Continuation[]
): ChangeClass {
  if (reintroduced.length > 0) {
    return "rewriting";
  }
  if (changes.length === 0) {
    return "empty";
  }
  if (changes.some((change) => change.severity === "rewriting")) {
    return "rewriting";
  }
  if (changes.some((change) => change.severity === "reductive")) {
    return "reductive";
  }
  const substantive = changes.filter((change) => change.severity !== "metadata" && change.severity !== "cosmetic");
  if (substantive.length === 0) {
    return "cosmetic";
  }
  if (markers.length > 0) {
    return "marked";
  }
  if (substantive.every((change) => change.severity === "additive" || change.severity === "expanding")) {
    return "expanding";
  }
  return "self-licensed";
}

function summarise(
  changeClass: ChangeClass,
  changes: readonly SourceChange[],
  reintroduced: readonly Continuation[]
): string {
  const touched = changes.length;
  switch (changeClass) {
    case "empty":
      return "no source-level changes detected";
    case "identical":
      return "identical to the previous observation";
    case "cosmetic":
      return `${touched} source(s) changed formatting or metadata only`;
    case "marked":
      return `${touched} source(s) changed with a phantom marker explaining the change`;
    case "self-licensed":
      return `${touched} source(s) changed and the server licensed the change itself`;
    case "rewriting":
      if (reintroduced.length > 0) {
        return `server re-emitted text that was tainted in an earlier session (${reintroduced.length} continuation(s))`;
      }
      return `${touched} source(s) rewritten: prompts lost content and gained new content`;
    case "expanding":
      return `${touched} source(s) grew without losing content`;
    case "reductive":
      return `${touched} source(s) lost content`;
    default:
      return "changed";
  }
}

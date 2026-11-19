import { maxSeverity, rank, type DriftReport, type Severity, type SourceChange } from "./drift.js";
import type { Observation } from "./snapshot.js";

export interface ReportInput {
  readonly server: string;
  readonly observation: Observation;
  readonly drift: DriftReport | null;
  readonly tainted: boolean;
  readonly samples: number;
  readonly skipped: readonly string[];
  readonly meridian: string;
  readonly ledgerPath: string;
}

export interface Verdict {
  readonly level: "clean" | "changed" | "warn" | "fail";
  readonly severity: Severity;
  readonly reasons: readonly string[];
}

export function verdictFor(input: ReportInput): Verdict {
  const reasons: string[] = [];
  let severity: Severity = "none";
  if (input.tainted) {
    reasons.push("the current server state is tainted from an earlier session");
  }
  if (input.drift !== null) {
    severity = maxSeverity(severity, input.drift.severity);
    switch (input.drift.changeClass) {
      case "identical":
      case "empty":
        break;
      case "cosmetic":
        reasons.push("prompt surfaces moved, but only formatting or metadata changed");
        break;
      case "expanding":
        reasons.push("the server grew its prompt surface since the last observation");
        break;
      case "marked":
        reasons.push("a change was declared with a phantom marker");
        break;
      case "self-licensed":
        reasons.push("the server changed its own prompts without an independent explanation");
        break;
      case "reductive":
        reasons.push("the server removed prompt content it previously supplied");
        break;
      case "rewriting":
        reasons.push("the server rewrote prompt content or re-emitted tainted text");
        break;
      default:
        reasons.push("the server changed");
    }
  }
  if (input.tainted) {
    severity = maxSeverity(severity, "rewriting");
  }
  const level: Verdict["level"] =
    rank(severity) >= rank("rewriting")
      ? "fail"
      : rank(severity) >= rank("expanding")
        ? "warn"
        : rank(severity) >= rank("additive")
          ? "changed"
          : "clean";
  if (reasons.length === 0) {
    reasons.push("no prompt changes and no taint on record");
  }
  return { level, severity, reasons };
}

export function formatReport(input: ReportInput): string {
  const verdict = verdictFor(input);
  const lines: string[] = [];
  const drift = input.drift;
  const title = input.server;
  lines.push(`phantom ${title}`);
  lines.push(`  status      ${verdict.level.toUpperCase()} (${verdict.severity})`);
  lines.push(`  fingerprint ${input.observation.fingerprint.slice(0, 16)}`);
  lines.push(`  meridian    ${input.meridian}`);
  lines.push(`  ledger      ${input.ledgerPath}`);
  lines.push(`  observations ${input.samples}`);
  for (const reason of verdict.reasons) {
    lines.push(`  note        ${reason}`);
  }
  if (drift !== null && drift.sources.length > 0) {
    lines.push("");
    lines.push(`  changes since previous observation (${drift.changeClass})`);
    for (const change of drift.sources) {
      lines.push(`    ${formatChange(change)}`);
    }
  }
  if (drift !== null && drift.reintroduced.length > 0) {
    lines.push("");
    lines.push("  continuations: text from a tainted observation returned");
    for (const item of drift.reintroduced) {
      lines.push(`    ${item.kind}:${item.id}  ${truncate(item.needle, 90)}`);
    }
  }
  if (drift !== null && drift.markers.length > 0) {
    lines.push("");
    lines.push("  markers");
    for (const marker of drift.markers) {
      lines.push(`    ${marker}`);
    }
  }
  const counts = countSources(input.observation);
  lines.push("");
  lines.push("  prompt surface");
  for (const [name, value] of counts) {
    lines.push(`    ${name.padEnd(18)} ${value}`);
  }
  if (input.skipped.length > 0) {
    lines.push("");
    lines.push("  not observed");
    for (const item of input.skipped) {
      lines.push(`    ${item}`);
    }
  }
  return lines.join("\n");
}

function formatChange(change: SourceChange): string {
  const sign = change.change === "added" ? "+" : change.change === "removed" ? "-" : "~";
  const detail =
    change.change === "modified"
      ? ` ${change.removedTokens.length} token(s) removed, ${change.addedTokens.length} added`
      : "";
  const marker = change.marked ? " [marked]" : "";
  return `${sign} ${change.kind}:${change.id} (${change.severity})${detail}${marker}`;
}

function countSources(observation: Observation): Map<string, string> {
  const counts = new Map<string, string>();
  for (const source of observation.sources) {
    const current = counts.get(source.kind) ?? "0";
    counts.set(source.kind, String(Number(current) + 1));
  }
  return new Map([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function truncate(text: string, length: number): string {
  const single = text.replace(/\s+/gu, " ");
  return single.length > length ? `${single.slice(0, length)}...` : single;
}

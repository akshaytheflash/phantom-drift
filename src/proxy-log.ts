import type { ProxyEvent } from "./proxy.js";

/**
 * Human readable lines for proxy events. Kept separate from the CLI so the
 * proxy can be tested without a terminal.
 */
export function formatProxyEvent(event: ProxyEvent): string | null {
  switch (event.type) {
    case "session-open":
      return "[phantom] session opened";
    case "session-close":
      return "[phantom] session closed";
    case "ledger-error":
    case "write-error":
      return event.error === undefined ? "[phantom] transport error" : `[phantom] ${event.error}`;
    default:
      return null;
  }
}

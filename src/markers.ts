/**
 * Phantom markers are invisible annotations a server author can embed in any
 * prompt surface. They let a legitimate server explain a change ("added the
 * scope parameter") without phantom needing a database of every tool. A
 * refresh that is fully covered by markers is reported as `marked`, not
 * `self-licensed`, which is the difference between a server that documents its
 * changes and one that quietly rewrites its own instructions.
 *
 * Grammar, matched on the raw string:
 *
 *   <!-- phantom v1 change=added-scope digest=ab12cd34ef56 -->
 *   <U+E0020..U+E007E run>  ...tag-encoded "phantom v1 change=..." <U+E007F>
 *
 * The second form uses Unicode tag characters, the same transport the
 * "invisible instructions" prompt injection technique uses, so phantom reads
 * the channel attackers already exploit.
 */

export interface Marker {
  readonly tag: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly start: number;
  readonly end: number;
  /** The exact source text the marker occupies. */
  readonly raw: string;
  /** `comment` for HTML comments, `invisible` for tag characters. */
  readonly channel: "comment" | "invisible";
}

const HTML_PATTERN = /<!--\s*phantom\s+v1\b([\s\S]*?)-->/g;
const TAG_TERMINATOR = 0xe007f;
const TAG_TERMINATOR_WIDTH = 2;
const TAG_MIN = 0xe0000;
const TAG_MAX = 0xe007e;
const TAG_DECODED_BASE = 0xe0000;
/** Prefix encoded without the separating space, used to locate a marker. */
const MARKER_ANCHOR = "phantom v1";

/**
 * Encodes printable ASCII into the Unicode tag block: U+0020..U+007E maps to
 * U+E0020..U+E007E one to one, with no terminator appended.
 */
export function encodeInvisible(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error("encodeInvisible only accepts printable ASCII");
  }
  let out = "";
  for (const char of text) {
    out += String.fromCodePoint(TAG_DECODED_BASE + (char.codePointAt(0) as number));
  }
  return out;
}

/**
 * Decodes every tag character run in `text` back to ASCII. Non-tag characters
 * are skipped, so the result is the concatenation of all hidden runs.
 */
export function decodeInvisible(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= TAG_MIN && code <= TAG_MAX) {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /([a-z][a-z0-9_-]*)=(?:"([^"]*)"|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const key = match[1] as string;
    fields[key] = match[2] ?? match[3] ?? "";
  }
  return fields;
}

function collectHtmlMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  HTML_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_PATTERN.exec(text)) !== null) {
    markers.push({
      tag: match[0],
      fields: parseFields(match[1] ?? ""),
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      channel: "comment"
    });
  }
  return markers;
}

/**
 * Finds tag encoded markers. Tag characters live outside the BMP, so the scan
 * walks code points and converts positions back to UTF-16 offsets. A marker
 * must start with "phantom v1" and end before the first non tag character
 * unless a U+E007F terminator appears first. A payload without any fields is
 * left alone on purpose: it carries no meaning and is most likely a mangled
 * or unrelated tag run.
 */
function collectInvisibleMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  const encodedPrefix = encodeInvisible(MARKER_ANCHOR);
  const prefixLength = encodedPrefix.length;
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf(encodedPrefix, offset);
    if (start === -1) {
      break;
    }
    const afterPrefix = start + prefixLength;
    let cursor = afterPrefix;
    let terminator = -1;
    while (cursor < text.length) {
      const code = text.codePointAt(cursor) as number;
      if (code === TAG_TERMINATOR) {
        terminator = cursor;
        break;
      }
      if (code < TAG_MIN || code > TAG_MAX) {
        break;
      }
      cursor += code > 0xffff ? 2 : 1;
    }
    // Tag characters are astral, so each one occupies two UTF-16 units. The
    // terminator is skipped with its full width rather than one unit, which
    // would leave a lone surrogate behind.
    const end = terminator === -1 ? cursor : terminator + TAG_TERMINATOR_WIDTH;
    const fields = parseFields(decodeInvisible(text.slice(afterPrefix, cursor)));
    if (Object.keys(fields).length > 0) {
      markers.push({
        tag: "invisible",
        fields,
        start,
        end,
        raw: text.slice(start, end),
        channel: "invisible"
      });
    }
    offset = Math.max(end, afterPrefix);
  }
  return markers;
}

export function parseMarkers(text: string): Marker[] {
  return [...collectHtmlMarkers(text), ...collectInvisibleMarkers(text)].sort((a, b) => a.start - b.start);
}

/** Removes every marker from a string and trims the result. */
export function stripMarkersFromText(text: string): string {
  const markers = parseMarkers(text);
  if (markers.length === 0) {
    return text;
  }
  let out = "";
  let cursor = 0;
  for (const marker of markers) {
    out += text.slice(cursor, marker.start);
    cursor = marker.end;
  }
  return `${out}${text.slice(cursor)}`.trim();
}

/**
 * Removes markers from a JSON-compatible value. Object keys are preserved as
 * authour intent; markers only ever live in string values.
 */
export function stripMarkersDeep<T>(value: T): T {
  if (typeof value === "string") {
    return stripMarkersFromText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripMarkersDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stripMarkersDeep(item);
    }
    return out as T;
  }
  return value;
}

export function shortDigest(hexDigest: string): string {
  return hexDigest.slice(0, 12);
}

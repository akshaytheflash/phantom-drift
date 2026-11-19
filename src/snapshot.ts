import { hashValue } from "./canonical.js";
import type {
  GetPromptResult,
  ListResult,
  PromptDescriptor,
  ReadResourceResult,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ToolDescriptor
} from "./schemas.js";

export const SCHEMA_VERSIONS = [1] as const;
export type SchemaVersion = (typeof SCHEMA_VERSIONS)[number];

/** A server prompt source. `kind` names the protocol surface it came from. */
export type SourceKind =
  | "instruction"
  | "tool"
  | "resource"
  | "resource-template"
  | "prompt"
  | "prompt-content"
  | "resource-content";

export const SOURCE_KINDS: readonly SourceKind[] = [
  "instruction",
  "tool",
  "resource",
  "resource-template",
  "prompt",
  "prompt-content",
  "resource-content"
];

export interface SourceRecord {
  readonly kind: SourceKind;
  /** Stable identity: instruction, tool name, resource URI, prompt name. */
  readonly id: string;
  /** MIME hint for inspector display. */
  readonly media: string;
  /** Canonical digest of the observable prompt payload. */
  readonly digest: string;
  /** Flat projection of every string leaf, used by continuation detection. */
  readonly needles: readonly string[];
  /** Human readable preview for `phantom diff`. */
  readonly preview: string;
  /** For prompt and resource content, the parent descriptor id. */
  readonly parent: string | null;
  /** True when the source is a non-text body (image, blob, audio). */
  readonly binary: boolean;
}

export interface Observation {
  readonly schemaVersion: SchemaVersion;
  readonly server: string;
  readonly fingerprint: string;
  readonly instructions: string | null;
  readonly serverInfo: { readonly name: string; readonly version: string } | null;
  readonly sources: readonly SourceRecord[];
}

export interface ObservationInput {
  readonly server: string;
  readonly instructions: string | null;
  readonly serverInfo: { readonly name: string; readonly version: string } | null;
  readonly tools: readonly ToolDescriptor[];
  readonly resources: readonly ResourceDescriptor[];
  readonly resourceTemplates: readonly ResourceTemplateDescriptor[];
  readonly prompts: readonly PromptDescriptor[];
  /** Prompt bodies keyed by prompt name. */
  readonly promptContents: ReadonlyMap<string, GetPromptResult>;
  /** Resource bodies keyed by resource URI. */
  readonly resourceContents: ReadonlyMap<string, ReadResourceResult>;
}

const PREVIEW_LIMIT = 400;

/**
 * Extracts every non-empty string leaf from an arbitrary JSON value, in
 * document order. Used for continuation detection: if text from a poisoned
 * observation later shows up in a benign one, the server still carries it.
 */
export function stringLeaves(value: unknown): string[] {
  const out: string[] = [];
  walk(value);
  return out;

  function walk(node: unknown): void {
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      Object.keys(record)
        .sort()
        .forEach((key) => {
          walk(record[key]);
        });
    }
  }
}

function digestOf(value: unknown): string {
  return hashValue(value);
}

function previewOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) {
    return "";
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text;
}

/**
 * Normalises a prompt message's content or a resource's contents down to the
 * text the agent will actually see. Binary blobs are replaced with a marker,
 * because a base64 payload carries no prompt meaning and would bloat every
 * needle list. Non-text bodies still mark the source as binary.
 */
function collectContents(
  contents: GetPromptResult["messages"][number]["content"] | ReadResourceResult["contents"],
  flattened: unknown[],
  binary: { value: boolean }
): void {
  const list = Array.isArray(contents) ? contents : [contents];
  for (const item of list) {
    if (item === null || typeof item !== "object") {
      flattened.push(item);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") {
      flattened.push(record.text);
      continue;
    }
    if (typeof record.blob === "string" || typeof record.data === "string") {
      binary.value = true;
      flattened.push({ type: record.type ?? "binary", binary: true });
      continue;
    }
    flattened.push({ type: record.type ?? "unknown" });
  }
}

export function buildObservation(input: ObservationInput): Observation {
  const sources: SourceRecord[] = [];

  if (input.instructions !== null && input.instructions.trim().length > 0) {
    sources.push({
      kind: "instruction",
      id: "initialize.instructions",
      media: "text/markdown",
      digest: digestOf(input.instructions),
      needles: stringLeaves(input.instructions),
      preview: previewOf(input.instructions),
      parent: null,
      binary: false
    });
  }

  for (const tool of [...input.tools].sort((a, b) => a.name.localeCompare(b.name))) {
    sources.push({
      kind: "tool",
      id: tool.name,
      media: "application/vnd.mcp.tool+json",
      digest: digestOf(tool),
      needles: stringLeaves({ description: tool.description ?? "", title: tool.title ?? "", inputSchema: tool.inputSchema ?? {} }),
      preview: previewOf(tool.description ?? tool.title ?? tool.name),
      parent: null,
      binary: false
    });
  }

  for (const resource of [...input.resources].sort((a, b) => a.uri.localeCompare(b.uri))) {
    sources.push({
      kind: "resource",
      id: resource.uri,
      media: resource.mimeType ?? "application/octet-stream",
      digest: digestOf(resource),
      needles: stringLeaves({ name: resource.name ?? "", title: resource.title ?? "", description: resource.description ?? "" }),
      preview: previewOf(resource.description ?? resource.name ?? resource.uri),
      parent: null,
      binary: false
    });
  }

  for (const template of [...input.resourceTemplates].sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate))) {
    sources.push({
      kind: "resource-template",
      id: template.uriTemplate,
      media: template.mimeType ?? "application/octet-stream",
      digest: digestOf(template),
      needles: stringLeaves({ name: template.name ?? "", title: template.title ?? "", description: template.description ?? "" }),
      preview: previewOf(template.description ?? template.name ?? template.uriTemplate),
      parent: null,
      binary: false
    });
  }

  for (const prompt of [...input.prompts].sort((a, b) => a.name.localeCompare(b.name))) {
    sources.push({
      kind: "prompt",
      id: prompt.name,
      media: "application/vnd.mcp.prompt+json",
      digest: digestOf(prompt),
      needles: stringLeaves({ description: prompt.description ?? "", title: prompt.title ?? "" }),
      preview: previewOf(prompt.description ?? prompt.title ?? prompt.name),
      parent: null,
      binary: false
    });

    const body = input.promptContents.get(prompt.name);
    if (body !== undefined) {
      const flattened: unknown[] = [];
      const binary = { value: false };
      for (const message of body.messages) {
        flattened.push({ role: message.role });
        collectContents(message.content, flattened, binary);
      }
      sources.push({
        kind: "prompt-content",
        id: prompt.name,
        media: "application/vnd.mcp.prompt-content+json",
        digest: digestOf({ description: body.description ?? null, messages: flattened }),
        needles: stringLeaves({ description: body.description ?? "" }).concat(
          flattened.filter((item): item is string => typeof item === "string")
        ),
        preview: previewOf(flattened.filter((item) => typeof item === "string").join("\n")),
        parent: prompt.name,
        binary: binary.value
      });
    }
  }

  for (const resource of [...input.resources].sort((a, b) => a.uri.localeCompare(b.uri))) {
    const body = input.resourceContents.get(resource.uri);
    if (body === undefined) {
      continue;
    }
    const flattened: unknown[] = [];
    const binary = { value: false };
    collectContents(body.contents, flattened, binary);
    sources.push({
      kind: "resource-content",
      id: resource.uri,
      media: resource.mimeType ?? "application/vnd.mcp.resource-content+json",
      digest: digestOf(flattened),
      needles: stringLeaves(flattened),
      preview: previewOf(flattened.filter((item) => typeof item === "string").join("\n")),
      parent: resource.uri,
      binary: binary.value
    });
  }

  const material = {
    instructions: input.instructions ?? null,
    serverInfo: input.serverInfo,
    sources: sources.map((source) => ({
      kind: source.kind,
      id: source.id,
      digest: source.digest
    }))
  };

  return {
    schemaVersion: 1,
    server: input.server,
    fingerprint: digestOf(material),
    instructions: input.instructions,
    serverInfo: input.serverInfo,
    sources
  };
}

export function sourceKey(kind: SourceKind, id: string): string {
  return `${kind}\u0000${id}`;
}

export function indexSources(sources: readonly SourceRecord[]): Map<string, SourceRecord> {
  const map = new Map<string, SourceRecord>();
  for (const source of sources) {
    map.set(sourceKey(source.kind, source.id), source);
  }
  return map;
}

export type ListFetcher<T> = (cursor: string | null) => Promise<ListResult<T>>;

/**
 * Walks a paginated list until the server returns no cursor. Guards against
 * servers that repeat a cursor forever, which would otherwise hang phantom.
 */
export async function collectPages<T>(fetchPage: ListFetcher<T>, maxPages = 100): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) {
      return items;
    }
    // A server that returns the cursor it was just given is asking for the
    // same page again. That is the same deadlock as repeating an earlier one.
    if (seen.has(result.nextCursor) || result.nextCursor === cursor) {
      throw new Error(`server repeated pagination cursor ${JSON.stringify(result.nextCursor)}`);
    }
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`server did not finish paginating after ${maxPages} pages`);
}

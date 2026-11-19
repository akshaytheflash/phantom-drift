import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

import { collectPages, type ListFetcher } from "./snapshot.js";
import {
  getPromptResultSchema,
  normalizeCursor,
  promptSchema,
  protocolVersionSchema,
  readResourceResultSchema,
  resourceSchema,
  resourceTemplateSchema,
  toolSchema,
  type GetPromptResult,
  type PromptDescriptor,
  type ReadResourceResult,
  type ResourceDescriptor,
  type ResourceTemplateDescriptor,
  type ToolDescriptor
} from "./schemas.js";

export interface PhantomClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface ConnectOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** How phantom identifies itself to the server. */
  readonly clientInfo?: PhantomClientInfo;
}

export interface ConnectedSession {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function clientInfoFromEnv(env: NodeJS.ProcessEnv = process.env): PhantomClientInfo {
  return {
    name: "phantom-observation",
    version: env.npm_package_version ?? "0.1.0"
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * Starts the server as a child process and completes the MCP initialize
 * handshake. Throws with a readable message when the process exits early.
 */
export async function connectServer(options: ConnectOptions): Promise<ConnectedSession> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...(options.args ?? [])],
    env,
    stderr: "ignore",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {})
  });
  const client = new Client(options.clientInfo ?? clientInfoFromEnv(), {
    capabilities: {}
  });
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    await withTimeout(client.connect(transport), timeout, "initialize handshake");
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw new Error(describeConnectFailure(options.command, error), { cause: error });
  }
  return {
    client,
    transport,
    close: async () => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  };
}

function describeConnectFailure(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `failed to start MCP server ${JSON.stringify(command)}: ${message}`;
}

/**
 * Reads every prompt surface the server supports. `skipped` names the
 * capabilities the server did not advertise, so a report can state what it
 * could not observe rather than silently under-reporting.
 */
export interface CollectResult {
  readonly instructions: string | null;
  readonly serverInfo: { readonly name: string; readonly version: string } | null;
  readonly tools: ToolDescriptor[];
  readonly resources: ResourceDescriptor[];
  readonly resourceTemplates: ResourceTemplateDescriptor[];
  readonly prompts: PromptDescriptor[];
  readonly promptContents: Map<string, GetPromptResult>;
  readonly resourceContents: Map<string, ReadResourceResult>;
  readonly skipped: string[];
}

export function readClientMeta(client: Client): {
  instructions: string | null;
  serverInfo: { readonly name: string; readonly version: string } | null;
} {
  const instructions = client.getInstructions();
  const version = client.getServerVersion();
  const info: Implementation | undefined = version;
  const serverInfo =
    info === undefined
      ? null
      : { name: info.name, version: info.version };
  return {
    instructions: instructions !== undefined && instructions.trim().length > 0 ? instructions : null,
    serverInfo
  };
}

export function toolFetcher(client: Client): ListFetcher<ToolDescriptor> {
  return async (cursor) => {
    const result = await client.listTools(cursor === null ? undefined : { cursor });
    return {
      items: (result.tools ?? []).map((tool) => toolSchema.parse(tool)),
      nextCursor: normalizeCursor(result.nextCursor)
    };
  };
}

export function resourceFetcher(client: Client): ListFetcher<ResourceDescriptor> {
  return async (cursor) => {
    const result = await client.listResources(cursor === null ? undefined : { cursor });
    return {
      items: (result.resources ?? []).map((resource) => resourceSchema.parse(resource)),
      nextCursor: normalizeCursor(result.nextCursor)
    };
  };
}

export function templateFetcher(client: Client): ListFetcher<ResourceTemplateDescriptor> {
  return async (cursor) => {
    const result = await client.listResourceTemplates(cursor === null ? undefined : { cursor });
    return {
      items: (result.resourceTemplates ?? []).map((template) => resourceTemplateSchema.parse(template)),
      nextCursor: normalizeCursor(result.nextCursor)
    };
  };
}

export function promptFetcher(client: Client): ListFetcher<PromptDescriptor> {
  return async (cursor) => {
    const result = await client.listPrompts(cursor === null ? undefined : { cursor });
    return {
      items: (result.prompts ?? []).map((prompt) => promptSchema.parse(prompt)),
      nextCursor: normalizeCursor(result.nextCursor)
    };
  };
}

export interface CollectOptions {
  readonly readPromptBodies?: boolean;
  readonly readResourceBodies?: boolean;
  readonly timeoutMs?: number;
}

export async function collectObservationInput(
  client: Client,
  options: CollectOptions = {}
): Promise<CollectResult> {
  const skipped: string[] = [];
  const capabilities = client.getServerCapabilities() ?? {};
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const meta = readClientMeta(client);

  const tools: ToolDescriptor[] = capabilities.tools
    ? await withTimeout(collectPages(toolFetcher(client)), timeout, "tools/list")
    : [];

  const resources: ResourceDescriptor[] = capabilities.resources
    ? await withTimeout(collectPages(resourceFetcher(client)), timeout, "resources/list")
    : [];

  const resourceTemplates: ResourceTemplateDescriptor[] = capabilities.resources
    ? await withTimeout(collectPages(templateFetcher(client)), timeout, "resources/templates/list")
    : [];

  const prompts: PromptDescriptor[] = capabilities.prompts
    ? await withTimeout(collectPages(promptFetcher(client)), timeout, "prompts/list")
    : [];

  if (!capabilities.tools) {
    skipped.push("tools");
  }
  if (!capabilities.resources) {
    skipped.push("resources");
  }
  if (!capabilities.prompts) {
    skipped.push("prompts");
  }

  const promptContents = new Map<string, GetPromptResult>();
  if ((options.readPromptBodies ?? true) && prompts.length > 0) {
    for (const prompt of prompts) {
      try {
        const result = await withTimeout(
          client.getPrompt({ name: prompt.name }),
          timeout,
          `prompts/get ${prompt.name}`
        );
        promptContents.set(prompt.name, getPromptResultSchema.parse(result));
      } catch (error) {
        skipped.push(`prompts/get ${prompt.name}: ${errorMessage(error)}`);
      }
    }
  }

  const resourceContents = new Map<string, ReadResourceResult>();
  if ((options.readResourceBodies ?? false) && resources.length > 0) {
    for (const resource of resources) {
      try {
        const result = await withTimeout(
          client.readResource({ uri: resource.uri }),
          timeout,
          `resources/read ${resource.uri}`
        );
        resourceContents.set(resource.uri, readResourceResultSchema.parse(result));
      } catch (error) {
        skipped.push(`resources/read ${resource.uri}: ${errorMessage(error)}`);
      }
    }
  }

  return {
    instructions: meta.instructions,
    serverInfo: meta.serverInfo,
    tools,
    resources,
    resourceTemplates,
    prompts,
    promptContents,
    resourceContents,
    skipped
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { protocolVersionSchema };

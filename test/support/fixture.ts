import type {
  GetPromptResult,
  PromptDescriptor,
  ReadResourceResult,
  ResourceDescriptor,
  ToolDescriptor
} from "../../src/schemas.js";
import { buildObservation, type ObservationInput } from "../../src/snapshot.js";

export interface FixtureOptions {
  readonly server?: string;
  readonly instructions?: string | null;
  readonly tools?: ReadonlyArray<Partial<ToolDescriptor>>;
  readonly prompts?: ReadonlyArray<Partial<PromptDescriptor> & Pick<PromptDescriptor, "name">>;
  readonly promptBodies?: Readonly<Record<string, GetPromptResult>>;
  readonly resources?: readonly ResourceDescriptor[];
  readonly resourceTemplates?: ObservationInput["resourceTemplates"];
  readonly resourceContents?: ReadonlyArray<readonly [string, ReadResourceResult]>;
}

export function tool(name: string, description: string): ToolDescriptor {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

export function fixture(options: FixtureOptions = {}): ReturnType<typeof buildObservation> {
  return buildObservation({
    server: options.server ?? "fixture",
    instructions: options.instructions === undefined ? "Base instructions." : options.instructions,
    serverInfo: { name: "fixture", version: "1.0.0" },
    tools: (options.tools ?? []).map((entry) => ({
      inputSchema: { type: "object", properties: {} },
      ...entry
    })) as ToolDescriptor[],
    resources: options.resources ?? [],
    resourceTemplates: options.resourceTemplates ?? [],
    prompts: (options.prompts ?? []).map((entry) => ({ ...entry })) as PromptDescriptor[],
    promptContents: new Map(Object.entries(options.promptBodies ?? {})),
    resourceContents: new Map(options.resourceContents ?? [])
  });
}

import { z } from "zod";

export const textContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    annotations: z.unknown().optional(),
    _meta: z.unknown().optional()
  })
  .passthrough();

export const nonTextContentSchema = z
  .object({ type: z.string().min(1) })
  .passthrough();

export const contentSchema = z.union([textContentSchema, nonTextContentSchema]);

export const toolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.unknown()).optional().default({ type: "object" }),
    outputSchema: z.record(z.unknown()).optional(),
    annotations: z.record(z.unknown()).optional(),
    title: z.string().optional(),
    icons: z.array(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional()
  })
  .passthrough();

export const resourceSchema = z
  .object({
    uri: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    annotations: z.record(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional()
  })
  .passthrough();

export const resourceTemplateSchema = z
  .object({
    uriTemplate: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    annotations: z.record(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional()
  })
  .passthrough();

export const promptSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    arguments: z.array(z.unknown()).optional(),
    icons: z.array(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional()
  })
  .passthrough();

export const resourceContentsSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional()
  })
  .passthrough();

export const getPromptResultSchema = z
  .object({
    description: z.string().optional(),
    messages: z
      .array(
        z
          .object({
            role: z.string(),
            content: z.union([contentSchema, z.array(contentSchema)])
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

export const readResourceResultSchema = z
  .object({
    contents: z.array(resourceContentsSchema).default([])
  })
  .passthrough();

export const protocolVersionSchema = z.string().min(1);

export type ToolDescriptor = z.infer<typeof toolSchema>;
export type ResourceDescriptor = z.infer<typeof resourceSchema>;
export type ResourceTemplateDescriptor = z.infer<typeof resourceTemplateSchema>;
export type PromptDescriptor = z.infer<typeof promptSchema>;
export type GetPromptResult = z.infer<typeof getPromptResultSchema>;
export type ReadResourceResult = z.infer<typeof readResourceResultSchema>;

export interface ListResult<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export function normalizeCursor(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

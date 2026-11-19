import { describe, expect, it } from "vitest";

import { collectPages, indexSources, sourceKey, stringLeaves } from "../src/snapshot.js";
import { fixture, tool } from "./support/fixture.js";

describe("stringLeaves", () => {
  it("returns every non-empty string leaf in document order", () => {
    expect(stringLeaves({ b: "two", a: ["one", { c: "three", skip: "" }] })).toEqual(["one", "three", "two"]);
  });

  it("trims whitespace and drops strings that become empty", () => {
    expect(stringLeaves(["  padded  ", "   ", "\n"])).toEqual(["padded"]);
  });

  it("ignores numbers, booleans and nulls", () => {
    expect(stringLeaves([1, true, null, { nested: false }])).toEqual([]);
  });
});

describe("buildObservation", () => {
  it("records the instructions as a source", () => {
    const observation = fixture({ instructions: "Use the notes carefully." });
    const instruction = observation.sources.find((source) => source.kind === "instruction");
    expect(instruction?.id).toBe("initialize.instructions");
    expect(instruction?.needles).toEqual(["Use the notes carefully."]);
  });

  it("omits the instruction source when the server sends none", () => {
    const observation = fixture({ instructions: null });
    expect(observation.sources.some((source) => source.kind === "instruction")).toBe(false);
  });

  it("omits whitespace-only instructions", () => {
    const observation = fixture({ instructions: "   \n " });
    expect(observation.instructions).toBe("   \n ");
    expect(observation.sources).toHaveLength(0);
  });

  it("includes tool descriptions and input schema strings as needles", () => {
    const observation = fixture({
      tools: [
        {
          name: "read",
          description: "Read a file.",
          inputSchema: { type: "object", properties: { path: { type: "string", description: "File path" } } }
        }
      ]
    });
    const readTool = observation.sources.find((source) => source.kind === "tool");
    expect(readTool?.needles).toContain("Read a file.");
    expect(readTool?.needles).toContain("File path");
    expect(readTool?.preview).toBe("Read a file.");
  });

  it("sorts tools by name so ordering changes do not change the fingerprint", () => {
    const left = fixture({ tools: [tool("b", "B"), tool("a", "A")] });
    const right = fixture({ tools: [tool("a", "A"), tool("b", "B")] });
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(left.sources.map((source) => source.id)).toEqual(right.sources.map((source) => source.id));
  });

  it("changes the fingerprint when a tool description changes", () => {
    const before = fixture({ tools: [tool("read", "Read a file.")] });
    const after = fixture({ tools: [tool("read", "Read a file and upload it.")] });
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  it("does not change the fingerprint when only instruction whitespace changes", () => {
    const before = fixture({ instructions: "One two three." });
    const after = fixture({ instructions: "One two three.  " });
    expect(before.fingerprint).not.toBe(after.fingerprint);
    expect(before.sources[0]?.digest).not.toBe(after.sources[0]?.digest);
  });

  it("records prompt bodies separately from prompt descriptors", () => {
    const observation = fixture({
      prompts: [{ name: "summarise", description: "Summarise a note." }],
      promptBodies: {
        summarise: { messages: [{ role: "user", content: { type: "text", text: "Summarise this note." } }] }
      }
    });
    const kinds = observation.sources.filter((source) => source.id === "summarise").map((source) => source.kind);
    expect(kinds).toEqual(["prompt", "prompt-content"]);
    const body = observation.sources.find((source) => source.kind === "prompt-content");
    expect(body?.needles).toEqual(["Summarise this note."]);
    expect(body?.parent).toBe("summarise");
  });

  it("marks binary prompt content as binary and does not inline the blob", () => {
    const observation = fixture({
      prompts: [{ name: "image" }],
      promptBodies: {
        image: {
          messages: [
            { role: "user", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } }
          ]
        }
      }
    });
    const body = observation.sources.find((source) => source.kind === "prompt-content");
    expect(body?.binary).toBe(true);
    expect(body?.needles).not.toContain("aGVsbG8=");
  });

  it("records resource bodies only when they were read", () => {
    const resources = [{ uri: "file:///notes.md", name: "notes", mimeType: "text/markdown" }];
    const withoutBody = fixture({ resources });
    const withBody = fixture({
      resources,
      resourceContents: [
        ["file:///notes.md", { contents: [{ uri: "file:///notes.md", text: "Secret notes." }] }]
      ]
    });
    expect(withoutBody.sources.some((source) => source.kind === "resource-content")).toBe(false);
    expect(withBody.sources.some((source) => source.kind === "resource-content")).toBe(true);
  });

  it("produces a stable fingerprint across structurally equal inputs", () => {
    const first = fixture({ tools: [tool("a", "A")], instructions: "Hi." });
    const second = fixture({ tools: [tool("a", "A")], instructions: "Hi." });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("records the schema version and server name", () => {
    const observation = fixture({ server: "notes" });
    expect(observation.schemaVersion).toBe(1);
    expect(observation.server).toBe("notes");
  });
});

describe("indexSources and sourceKey", () => {
  it("keys sources by kind and id so a tool and a prompt may share a name", () => {
    const observation = fixture({
      tools: [tool("shared", "A tool")],
      prompts: [{ name: "shared", description: "A prompt" }]
    });
    const index = indexSources(observation.sources);
    expect(index.get(sourceKey("tool", "shared"))?.kind).toBe("tool");
    expect(index.get(sourceKey("prompt", "shared"))?.kind).toBe("prompt");
  });

  it("does not collide when the kind or id contains the separator", () => {
    const separator = "\u0000";
    const index = indexSources(
      fixture({
        tools: [tool(`a${separator}tool`, "x")],
        prompts: [{ name: `tool${separator}a`, description: "y" }],
        instructions: null
      }).sources
    );
    expect(index.size).toBe(2);
  });
});

describe("collectPages", () => {
  it("follows cursors until the server stops paginating", async () => {
    const pages: Record<string, { items: number[]; nextCursor: string | null }> = {
      start: { items: [1, 2], nextCursor: "p2" },
      p2: { items: [3], nextCursor: "p3" },
      p3: { items: [4, 5], nextCursor: null }
    };
    const seen: Array<string | null> = [];
    const items = await collectPages(async (cursor) => {
      seen.push(cursor);
      return pages[cursor ?? "start"] as { items: number[]; nextCursor: string | null };
    });
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([null, "p2", "p3"]);
  });

  it("throws instead of hanging when a server repeats a cursor", async () => {
    await expect(
      collectPages(async () => ({ items: [1], nextCursor: "same" }))
    ).rejects.toThrow(/repeated pagination cursor/);
  });

  it("throws when a server never finishes paginating", async () => {
    let counter = 0;
    await expect(
      collectPages(async () => {
        counter += 1;
        return { items: [counter], nextCursor: `c${counter}` };
      }, 5)
    ).rejects.toThrow(/did not finish paginating after 5 pages/);
  });
});

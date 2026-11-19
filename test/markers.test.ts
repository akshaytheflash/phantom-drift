import { describe, expect, it } from "vitest";

import {
  decodeInvisible,
  encodeInvisible,
  parseMarkers,
  stripMarkersDeep,
  stripMarkersFromText
} from "../src/markers.js";

const TERMINATOR = String.fromCodePoint(0xe007f);

describe("encodeInvisible / decodeInvisible", () => {
  it("round trips printable ASCII", () => {
    const text = "phantom v1 change=added-scope";
    expect(decodeInvisible(encodeInvisible(text))).toBe(text);
  });

  it("emits only characters in the Unicode tag block", () => {
    const encoded = encodeInvisible("abc");
    for (const char of encoded) {
      const code = char.codePointAt(0) as number;
      expect(code).toBeGreaterThanOrEqual(0xe0020);
      expect(code).toBeLessThanOrEqual(0xe007e);
    }
  });

  it("rejects text outside printable ASCII instead of producing garbage", () => {
    expect(() => encodeInvisible("caf\u00e9")).toThrow(/printable ASCII/);
    expect(() => encodeInvisible("new\nline")).toThrow(/printable ASCII/);
  });

  it("decodes tag characters embedded between visible text", () => {
    const hidden = encodeInvisible("phantom v1 note=hi");
    expect(decodeInvisible(`visible${hidden}text`)).toBe("phantom v1 note=hi");
  });

  it("ignores ordinary text when decoding", () => {
    expect(decodeInvisible("plain ascii")).toBe("");
  });
});

describe("parseMarkers", () => {
  it("parses an HTML comment marker with bare and quoted fields", () => {
    const text = 'Add a scope parameter. <!-- phantom v1 change=added-scope digest="ab12 cd34" -->';
    const [marker] = parseMarkers(text);
    expect(marker).toBeDefined();
    expect(marker?.channel).toBe("comment");
    expect(marker?.fields).toEqual({ change: "added-scope", digest: "ab12 cd34" });
    expect(marker?.start).toBe(text.indexOf("<!--"));
    expect(marker?.raw).toBe("<!-- phantom v1 change=added-scope digest=\"ab12 cd34\" -->");
  });

  it("parses an invisible marker", () => {
    const encoded = `${encodeInvisible("phantom v1 change=security-fix")}${TERMINATOR}`;
    const [marker] = parseMarkers(`hide${encoded}`);
    expect(marker?.channel).toBe("invisible");
    expect(marker?.fields).toEqual({ change: "security-fix" });
  });

  it("returns markers in source order across both channels", () => {
    const invisible = `${encodeInvisible("phantom v1 a=1")}${TERMINATOR}`;
    const text = `<!-- phantom v1 a=1 -->${invisible}`;
    const markers = parseMarkers(text);
    expect(markers).toHaveLength(2);
    expect(markers[0]?.channel).toBe("comment");
    expect(markers[1]?.channel).toBe("invisible");
  });

  it("ignores lookalikes that are not phantom v1 markers", () => {
    expect(parseMarkers("<!-- phantom v2 change=x -->")).toHaveLength(0);
    expect(parseMarkers("<!-- other v1 change=x -->")).toHaveLength(0);
    expect(parseMarkers("phantom v1 change=x")).toHaveLength(0);
  });

  it("does not loop forever on an unterminated invisible marker", () => {
    // A missing terminator is still an injection attempt. It is parsed so the
    // text can be stripped, and parsing terminates at the end of the input.
    const text = `start${encodeInvisible("phantom v1 change=x")}`;
    expect(parseMarkers(text)).toHaveLength(1);
  });

  it("ignores an unterminated HTML comment", () => {
    expect(parseMarkers("<!-- phantom v1 change=x")).toHaveLength(0);
  });

  it("parses multiple comment markers", () => {
    const text = "a <!-- phantom v1 change=one --> b <!-- phantom v1 change=two -->";
    expect(parseMarkers(text).map((marker) => marker.fields["change"])).toEqual(["one", "two"]);
  });
});

describe("stripMarkersFromText", () => {
  it("removes a comment marker and surrounding whitespace", () => {
    expect(stripMarkersFromText("Read it.  <!-- phantom v1 change=x -->")).toBe("Read it.");
  });

  it("removes an invisible marker even without its terminator", () => {
    // A well formed marker ends in U+E007F. Phantom still strips a run that
    // starts with "phantom v1" when the terminator is missing, so a malformed
    // injection cannot survive by dropping its last character.
    const encoded = encodeInvisible("phantom v1 change=x");
    expect(stripMarkersFromText(`Read it. ${encoded}`)).toBe("Read it.");
  });

  it("removes a terminated marker at the very end of the text", () => {
    const encoded = `${encodeInvisible("phantom v1 change=x")}${TERMINATOR}`;
    expect(stripMarkersFromText(`Read it. ${encoded}`)).toBe("Read it.");
  });

  it("returns text unchanged when there is no marker", () => {
    expect(stripMarkersFromText("  keep me  ")).toBe("  keep me  ");
  });
});

describe("stripMarkersDeep", () => {
  it("strips strings inside arrays and objects without changing structure", () => {
    const value = {
      name: "tool",
      description: "Do it. <!-- phantom v1 change=x -->",
      args: ["a <!-- phantom v1 change=y -->", 3, { nested: "b<!-- phantom v1 change=z -->" }]
    };
    expect(stripMarkersDeep(value)).toEqual({
      name: "tool",
      description: "Do it.",
      args: ["a", 3, { nested: "b" }]
    });
  });

  it("leaves non-string primitives untouched", () => {
    expect(stripMarkersDeep([1, true, null, 2.5])).toEqual([1, true, null, 2.5]);
  });
});

describe("invisible marker round trip", () => {
  const payloads = [
    "a=1",
    "change=added-scope digest=ab12cd34",
    "change=\"multi word value\" note=short",
    "x=y z=1 a=0",
    "k=l_" + "v".repeat(64)
  ];

  for (const payload of payloads) {
    it(`strips payload ${JSON.stringify(payload)} exactly`, () => {
      const encoded = `${encodeInvisible(`phantom v1 ${payload}`)}${TERMINATOR}`;
      for (const prefix of ["", "Read it. ", "x"]) {
        for (const suffix of ["", " more", "\n"]) {
          const text = `${prefix}${encoded}${suffix}`;
          const markers = parseMarkers(text);
          expect(markers).toHaveLength(1);
          expect(markers[0]?.raw).toBe(encoded);
          expect(stripMarkersFromText(text)).not.toContain("\u{e007f}");
          expect(stripMarkersFromText(text)).not.toMatch(/[\ud800-\udfff]/);
        }
      }
    });
  }

  it("leaves ordinary astral text untouched", () => {
    const text = "Smile \u{1F600} and wave \u{1F44B}.";
    expect(parseMarkers(text)).toHaveLength(0);
    expect(stripMarkersFromText(text)).toBe(text);
  });
});

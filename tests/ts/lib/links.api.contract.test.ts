import { describe, expect, it } from "vitest";
import * as auditTypes from "../../../src/lib/audit/types.js";
import * as links from "../../../src/lib/links.js";

const SHARED_LINK_HELPER_EXPORTS = [
  "extractLinkTarget",
  "extractLinkTargets",
  "extractMarkdownLinkTarget",
  "extractWikilinkTarget",
  "isMarkdownLink",
  "isWikilink",
  "toMarkdownLink",
  "toWikilink",
] as const;

const COMPAT_AUDIT_TYPES_REEXPORTS = [
  "extractWikilinkTarget",
  "isMarkdownLink",
  "isWikilink",
  "toMarkdownLink",
  "toWikilink",
] as const;

describe("link helper API contract", () => {
  it("exports the stable shared helper surface from src/lib/links.ts", () => {
    expect(Object.keys(links).sort()).toEqual([...SHARED_LINK_HELPER_EXPORTS].sort());
  });

  it("keeps compatibility re-exports in src/lib/audit/types.ts", () => {
    for (const name of COMPAT_AUDIT_TYPES_REEXPORTS) {
      expect(auditTypes).toHaveProperty(name);
      expect(auditTypes[name]).toBe(links[name]);
    }
  });

  it("does not widen compatibility exports with non-legacy helpers", () => {
    expect(auditTypes).not.toHaveProperty("extractMarkdownLinkTarget");
    expect(auditTypes).not.toHaveProperty("extractLinkTarget");
    expect(auditTypes).not.toHaveProperty("extractLinkTargets");
  });

  it("preserves helper behavior across shared and compatibility import paths", () => {
    const sample = "[[My Note]]";
    expect(auditTypes.isWikilink(sample)).toBe(true);
    expect(auditTypes.extractWikilinkTarget(sample)).toBe("My Note");
    expect(auditTypes.toMarkdownLink(sample)).toBe(links.toMarkdownLink(sample));
    expect(auditTypes.toWikilink("[My Note](My Note.md)")).toBe(links.toWikilink("[My Note](My Note.md)"));
    expect(auditTypes.isMarkdownLink("[My Note](My Note.md)")).toBe(true);
  });
});

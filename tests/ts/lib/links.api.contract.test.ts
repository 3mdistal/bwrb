import { describe, expect, it } from "vitest";
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

describe("link helper API contract", () => {
  it("exports the stable shared helper surface from src/lib/links.ts", () => {
    expect(Object.keys(links).sort()).toEqual([...SHARED_LINK_HELPER_EXPORTS].sort());
  });
});

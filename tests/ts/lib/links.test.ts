import { describe, it, expect } from "vitest";
import {
  isWikilink,
  isMarkdownLink,
  extractWikilinkTarget,
  extractMarkdownLinkTarget,
  toWikilink,
  toMarkdownLink,
  extractLinkTarget,
  extractLinkTargets,
} from "../../../src/lib/links.js";

describe("link utilities", () => {
  describe("isWikilink", () => {
    it("should detect valid wikilinks", () => {
      expect(isWikilink("[[Note]]")).toBe(true);
      expect(isWikilink("[[My Note Name]]")).toBe(true);
      expect(isWikilink("[[Note with spaces]]")).toBe(true);
    });

    it("should reject non-wikilinks", () => {
      expect(isWikilink("Note")).toBe(false);
      expect(isWikilink("[Note]")).toBe(false);
      expect(isWikilink("[Note](Note.md)")).toBe(false);
      expect(isWikilink("[[]]")).toBe(false);
      expect(isWikilink("")).toBe(false);
    });

    it("should reject quoted wikilinks (handled separately)", () => {
      // isWikilink is strict - quoted wikilinks need special handling
      expect(isWikilink('"[[Note]]"')).toBe(false);
    });
  });

  describe("isMarkdownLink", () => {
    it("should detect valid markdown links", () => {
      expect(isMarkdownLink("[Note](Note.md)")).toBe(true);
      expect(isMarkdownLink("[My Note](My Note.md)")).toBe(true);
      expect(isMarkdownLink("[Display Text](actual-file.md)")).toBe(true);
    });

    it("should detect quoted markdown links", () => {
      expect(isMarkdownLink('"[Note](Note.md)"')).toBe(true);
      expect(isMarkdownLink('"[My Note](My Note.md)"')).toBe(true);
    });

    it("should reject non-markdown links", () => {
      expect(isMarkdownLink("[[Note]]")).toBe(false);
      expect(isMarkdownLink("[Note]")).toBe(false);
      expect(isMarkdownLink("[Note](Note)")).toBe(false); // Missing .md
      expect(isMarkdownLink("Note")).toBe(false);
      expect(isMarkdownLink("")).toBe(false);
    });
  });

  describe("extractWikilinkTarget", () => {
    it("should extract target from simple wikilink", () => {
      expect(extractWikilinkTarget("[[Note]]")).toBe("Note");
      expect(extractWikilinkTarget("[[My Note Name]]")).toBe("My Note Name");
    });

    it("should extract target from quoted wikilink", () => {
      expect(extractWikilinkTarget('"[[Note]]"')).toBe("Note");
    });

    it("should stop at alias delimiter", () => {
      expect(extractWikilinkTarget("[[Note|Display Text]]")).toBe("Note");
    });

    it("should stop at heading delimiter", () => {
      expect(extractWikilinkTarget("[[Note#Section]]")).toBe("Note");
    });

    it("should return null for non-wikilinks", () => {
      expect(extractWikilinkTarget("Note")).toBe(null);
      expect(extractWikilinkTarget("[Note](Note.md)")).toBe(null);
    });
  });

  describe("extractMarkdownLinkTarget", () => {
    it("should extract target from simple markdown link", () => {
      expect(extractMarkdownLinkTarget("[Note](Note.md)")).toBe("Note");
      expect(extractMarkdownLinkTarget("[My Note](My Note.md)")).toBe("My Note");
    });

    it("should extract target from quoted markdown link", () => {
      expect(extractMarkdownLinkTarget('"[Note](Note.md)"')).toBe("Note");
    });

    it("should handle display text different from target", () => {
      expect(extractMarkdownLinkTarget("[Display](target-file.md)")).toBe("target-file");
    });

    it("should return null for non-markdown links", () => {
      expect(extractMarkdownLinkTarget("[[Note]]")).toBe(null);
      expect(extractMarkdownLinkTarget("Note")).toBe(null);
      expect(extractMarkdownLinkTarget("[Note](Note)")).toBe(null); // Missing .md
    });
  });

  describe("toWikilink", () => {
    it("should convert plain text to wikilink", () => {
      expect(toWikilink("Note")).toBe("[[Note]]");
      expect(toWikilink("My Note Name")).toBe("[[My Note Name]]");
    });

    it("should convert markdown link to wikilink", () => {
      expect(toWikilink("[Note](Note.md)")).toBe("[[Note]]");
      expect(toWikilink("[My Note](My Note.md)")).toBe("[[My Note]]");
    });

    it("should be idempotent for existing wikilinks", () => {
      expect(toWikilink("[[Note]]")).toBe("[[Note]]");
      expect(toWikilink("[[My Note]]")).toBe("[[My Note]]");
    });

    it("should be idempotent for quoted wikilinks", () => {
      expect(toWikilink('"[[Note]]"')).toBe('"[[Note]]"');
    });
  });

  describe("toMarkdownLink", () => {
    it("should convert plain text to markdown link", () => {
      expect(toMarkdownLink("Note")).toBe("[Note](Note.md)");
      expect(toMarkdownLink("My Note Name")).toBe("[My Note Name](My Note Name.md)");
    });

    it("should convert wikilink to markdown link", () => {
      expect(toMarkdownLink("[[Note]]")).toBe("[Note](Note.md)");
      expect(toMarkdownLink("[[My Note]]")).toBe("[My Note](My Note.md)");
    });

    it("should convert quoted wikilink to markdown link", () => {
      expect(toMarkdownLink('"[[Note]]"')).toBe("[Note](Note.md)");
    });

    it("should be idempotent for existing markdown links", () => {
      expect(toMarkdownLink("[Note](Note.md)")).toBe("[Note](Note.md)");
      expect(toMarkdownLink("[My Note](My Note.md)")).toBe("[My Note](My Note.md)");
    });
  });

  describe("round-trip conversions", () => {
    it("should round-trip wikilink -> markdown -> wikilink", () => {
      const original = "[[My Note]]";
      const markdown = toMarkdownLink(original);
      const backToWiki = toWikilink(markdown);
      expect(backToWiki).toBe(original);
    });

    it("should round-trip markdown -> wikilink -> markdown", () => {
      const original = "[My Note](My Note.md)";
      const wikilink = toWikilink(original);
      const backToMarkdown = toMarkdownLink(wikilink);
      expect(backToMarkdown).toBe(original);
    });
  });

  describe("extractLinkTarget", () => {
    it("should extract from wikilink and markdown values", () => {
      expect(extractLinkTarget("[[Note]]")).toBe("Note");
      expect(extractLinkTarget('"[[Note]]"')).toBe("Note");
      expect(extractLinkTarget("[Display](target-file.md)")).toBe("target-file");
      expect(extractLinkTarget('"[Display](target-file.md)"')).toBe("target-file");
    });

    it("should return null for non-link values", () => {
      expect(extractLinkTarget("plain text")).toBe(null);
      expect(extractLinkTarget("[Note](Note)")).toBe(null);
    });
  });

  describe("extractLinkTargets", () => {
    it("should extract embedded wikilinks and markdown links", () => {
      expect(extractLinkTargets("See [[One]] and [[Two]]")).toEqual(["One", "Two"]);
      expect(extractLinkTargets("Read [A](A.md) and [B](B.md)")).toEqual(["A", "B"]);
    });

    it("should extract from arrays and ignore non-strings", () => {
      expect(extractLinkTargets(["[[One]]", "[Two](Two.md)", 42])).toEqual(["One", "Two"]);
    });

    it("should fall back to direct single-link parsing", () => {
      expect(extractLinkTargets("[[Target|Alias]]")).toEqual(["Target"]);
      expect(extractLinkTargets("[[Target#Heading]]")).toEqual(["Target"]);
    });
  });
});

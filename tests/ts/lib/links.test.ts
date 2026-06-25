import { describe, it, expect } from "vitest";
import {
  isWikilink,
  isMarkdownLink,
  extractWikilinkTarget,
  extractMarkdownLinkTarget,
  toWikilink,
  toMarkdownLink,
  wikilinkTargetBasename,
  wikilinkTargetPath,
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

  describe("wikilinkTargetBasename", () => {
    it("returns a bare target unchanged", () => {
      expect(wikilinkTargetBasename("Opening Track")).toBe("Opening Track");
    });

    it("strips a path qualifier to the last segment", () => {
      expect(wikilinkTargetBasename("Tracks/Opening Track")).toBe("Opening Track");
      expect(wikilinkTargetBasename("a/b/c/Opening Track")).toBe("Opening Track");
    });

    it("strips a display alias", () => {
      expect(wikilinkTargetBasename("Opening Track|Intro")).toBe("Opening Track");
    });

    it("strips a heading", () => {
      expect(wikilinkTargetBasename("Opening Track#Verse")).toBe("Opening Track");
    });

    it("strips combined path + alias", () => {
      expect(wikilinkTargetBasename("Tracks/Opening Track|Intro")).toBe("Opening Track");
    });

    it("strips combined path + heading + alias", () => {
      expect(wikilinkTargetBasename("Tracks/Opening Track#Verse|Intro")).toBe(
        "Opening Track"
      );
    });

    it("unwraps a fully bracketed wikilink", () => {
      expect(wikilinkTargetBasename("[[Tracks/Opening Track|Intro]]")).toBe(
        "Opening Track"
      );
      expect(wikilinkTargetBasename('"[[Tracks/Opening Track]]"')).toBe("Opening Track");
    });
  });

  describe("wikilinkTargetPath", () => {
    it("returns a bare target unchanged", () => {
      expect(wikilinkTargetPath("Opening Track")).toBe("Opening Track");
    });

    it("PRESERVES the path qualifier (unlike wikilinkTargetBasename)", () => {
      expect(wikilinkTargetPath("Tracks/Opening Track")).toBe("Tracks/Opening Track");
      expect(wikilinkTargetPath("Albums/Best Album/songs/Owned")).toBe(
        "Albums/Best Album/songs/Owned"
      );
    });

    it("strips a display alias but keeps the path", () => {
      expect(wikilinkTargetPath("Tracks/Opening Track|Intro")).toBe(
        "Tracks/Opening Track"
      );
    });

    it("strips a heading but keeps the path", () => {
      expect(wikilinkTargetPath("Tracks/Opening Track#Verse")).toBe(
        "Tracks/Opening Track"
      );
    });

    it("strips combined heading + alias but keeps the path", () => {
      expect(wikilinkTargetPath("Tracks/Opening Track#Verse|Intro")).toBe(
        "Tracks/Opening Track"
      );
    });

    it("unwraps a fully bracketed wikilink, preserving the path", () => {
      expect(wikilinkTargetPath("[[Tracks/Opening Track|Intro]]")).toBe(
        "Tracks/Opening Track"
      );
      expect(wikilinkTargetPath('"[[Albums/Best Album/songs/Owned]]"')).toBe(
        "Albums/Best Album/songs/Owned"
      );
    });
  });
});

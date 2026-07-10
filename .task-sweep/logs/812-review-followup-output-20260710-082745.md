NO BLOCKERS

## Verdict rationale

All four follow-up notes are addressed correctly in the embedded diff, the core #812 fix remains sound, and docs/tests are consistent with body-only semantics.

**Follow-up resolutions verified:**
1. **Synthetic split element** — `if (content.endsWith('\n')) lines.pop()` correctly drops only the artifact (works for CRLF too, since `\r\n` ends in `\n`; the `/\r?\n/` split handles the rest). Files without trailing newline and empty files are unaffected.
2. **Lazy source loading** — `loadSearchableFileSources([...rawResults.keys()], ...)` reads only files with raw hits; zero-match and sparse queries no longer read the whole candidate set.
3. **Limit test** — frontmatter-only decoy (`Limit Decoy.md`) competes under `limit: 1`; assertion pins line 5, exact text, and body-only `contextAfter`.
4. **CRLF end-to-end** — real `\r\n` fixture verifies body-boundary exclusion, original line 5, and clean context (no stray `\r`, no phantom EOF line).

**Correctness spot-checks:**
- Boundary math: match on closing `---` (index 3 < bodyStartIndex 4) excluded; `contextBefore` clamped to `bodyStartIndex`; `contextAfter` clamped to real EOF. Verified against both fixtures.
- Engine parity: restriction runs after either `runRipgrep` or `runNodeFallbackSearch`, and context is rebuilt from source lines, keeping both engines identical.
- Incomplete/missing frontmatter returns index 0 (whole file searchable) — safe failure mode.
- Existing limit/truncation tests updated from `type` to `deployment` to stay meaningful under body-only semantics.
- Docs, help text, README, CHANGELOG all updated consistently; stale #812 references removed. Scope is tight.

## Optional notes (non-blocking)

1. **Decoy ordering weakens the limit test slightly**: `Boundary Match.md` sorts before `Limit Decoy.md`, so a hypothetical buggy implementation that applied `limit` to raw (pre-restriction) results would still pick the real match first and pass. Renaming the decoy to sort first (e.g., `AAA Decoy.md`) would make the test discriminate the failure mode it targets.
2. **Node fallback double-read**: when ripgrep is unavailable, matched files are read once by the fallback search and again by `loadSearchableFileSources`. Negligible in practice; could share the content later if profiling ever cares.
3. **BOM retained in line text**: `findMarkdownBodyStartIndex` strips the BOM for boundary detection only; a body match on line 1 of a BOM-prefixed file without frontmatter would display the BOM in `text`. Cosmetic and pre-existing.
4. **TOCTOU**: file content is re-read after the raw search; a concurrent edit could desync line numbers. Acceptable for a CLI; not worth guarding.
---
title: bwrb audit
description: Validate notes against schema
---

Validate vault files against schema and report issues, with optional interactive repair.

## Synopsis

```bash
bwrb audit [options] [target]
```

The target argument is auto-detected as type, path (contains `/`), or where expression.

## Options

### Targeting

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Filter by type path |
| `-p, --path <glob>` | Filter by file path pattern |
| `-w, --where <expr>` | Filter by frontmatter expression (repeatable) |
| `-b, --body <query>` | Filter by body content |
| `-a, --all` | Target all files (explicit vault-wide selector) |

### Issue Filtering

| Option | Description |
|--------|-------------|
| `--only <issue-type>` | Only report specific issue type |
| `--ignore <issue-type>` | Ignore specific issue type |
| `--strict` | Treat unknown fields as errors instead of warnings |
| `--allow-field <fields>` | Allow additional fields beyond schema (repeatable) |
| `--check-schema-docs` | Also report schema types/fields that have no `description` |

### Repair

| Option | Description |
|--------|-------------|
| `--fix` | Interactive repair mode (writes by default; requires explicit targeting) |
| `--auto` | With `--fix`: automatically apply unambiguous fixes |
| `--dry-run` | With `--fix`: preview fixes without writing |
| `--execute` | With `--fix --auto`: apply auto-fixes for execute-gated issues (for example `trailing-whitespace`) |

Repair mode writes by default and requires explicit targeting (selectors or `--all`).
Use `--dry-run` to preview fixes without writing.

Delete semantics in repair mode:

- `bwrb audit --fix` (interactive only) can offer an explicit `[delete note]` action for clearly unrecoverable type problems (currently `orphan-file` and `invalid-type`).
- Delete is never the default choice.
- `bwrb audit --fix --auto` and `bwrb audit --fix --auto --execute` never delete files.
- `bwrb audit --fix --output json` is invalid (interactive repair and JSON mode are intentionally separated).

### Output

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `text`, `json` |

## Issue Types

| Type | Description |
|------|-------------|
| `orphan-file` | File in managed directory but no `type` field |
| `invalid-type` | Type field value not recognized in schema |
| `missing-required` | Required field is missing |
| `empty-string-required` | Required field is empty/whitespace/empty list |
| `invalid-option` | Field value not in allowed option values |
| `unknown-field` | Field not defined in schema (warning by default) |
| `wrong-directory` | File location doesn't match its type's output_dir |
| `format-violation` | Field value doesn't match expected format (wikilink, etc.) |
| `stale-reference` | Wikilink points to non-existent file |
| `trailing-whitespace` | Trailing spaces/tabs on raw frontmatter `key: value` lines (warning; auto-fixable) |
| `wrong-scalar-type` | Scalar value has wrong type for schema |
| `illegal-aliases` | An [`alias`-role field](/reference/schema/#alias) has empty or non-string entries (the Obsidian aliases format requires non-empty, unique strings) |
| `unlinked-mention` | A known entity's name or [registered alias](/reference/schema/#alias) appears in body prose as plain text but is not wikilinked (warning; exact/alias matches auto-fixable, fuzzy/ambiguous matches flag-only — see below) |
| `frequent-unlinked-term` | A proper-noun-ish term mentioned frequently across the vault that has **no note yet** (warning; **advisory heuristic, never auto-fixable** — see below) |
| `missing-body-section` | A heading section declared in the type's [`body_sections`](/reference/schema/) is missing from the note body, or present at the wrong heading level (warning; **auto-fixable** — `--fix` appends the canonical heading scaffold — see below) |
| `broken-body-wikilink` | A well-formed `[[wikilink]]` in the note **body** whose target resolves to **no note** via the alias-aware, case-insensitive note index (warning; **flag-only** — offers a "did you mean?" hint but never auto-links — see below) |
| `malformed-body-wikilink` | Wikilink bracket syntax in the body that is broken — an empty target (`[[]]`/`[[ ]]`) or an unclosed `[[` (warning; **flag-only**) |
| `broken-body-file-link` | A relative markdown file/image link in the body — `[text](path.md)` / `![alt](img.png)` — whose target does not exist on disk (warning; **flag-only**) |
| `missing-successor` | A [recurring](/automation/task-system/) note satisfies its trigger (e.g. `status = done`) but its chain field (`next`) is empty — a successor was never spawned (e.g. completed outside bwrb). Warning; **auto-fixable** (`--fix` spawns it, identical to the fast path) |
| `invalid-recurrence` | A [recurrence](/automation/task-system/) rule is broken at the config level — a malformed trigger, a non-date offset base, or a template that doesn't exist (error; **never auto-fixable** — a config error gets the same safety net as data) |

Note: built-in fields written by `bwrb new` (currently `id` and `name`) are always allowed and do not produce `unknown-field` issues.
Invalid option values inside list fields are reported as `invalid-option` with `listIndex` metadata, not a separate issue code.
For a [`date`](/reference/schema/) field with `multiple: true` (a list of dates), each element is validated against the field's granularity and an invalid element is reported as `invalid-date-format` with `listIndex` metadata identifying the offending value. List elements are reported for manual correction (not auto-fixed); only scalar date values are auto-normalized.

A **numeric** date element (e.g. an unquoted `2026`, which YAML parses as a number) is treated exactly like a numeric scalar date: it is owned by the date check, so it is reported **once** — as `invalid-date-format` when it isn't a valid date for the field's granularity, or as `wrong-scalar-type` ("should be quoted as a string") when it *is* a valid date. It is never additionally reported as `invalid-list-element`. This matches scalar date handling and what `bwrb new`/`bwrb edit` accept on write.

An empty or whitespace-only date value is treated as **unset**, not as an invalid date — the same convention every optional field follows (an empty optional field never produces a format/type issue). So an optional `date` field stored as `""` produces no `invalid-date-format` issue, matching what `bwrb new`/`bwrb edit` accept on write. An empty **required** date is reported once as [`empty-string-required`](#issue-codes) (consistent with every other required field), and an empty **element** inside a date list is reported once as `invalid-list-element` — never additionally as `invalid-date-format`.

## Examples

### Basic Auditing

```bash
# Check all files (report only)
bwrb audit

# Check only tasks
bwrb audit --type objective/task

# Check specific directory
bwrb audit --path "Ideas/**"

# Check files with specific status
bwrb audit --where "status=active"

# Check files containing TODO
bwrb audit --body "TODO"
```

### Issue Filtering

```bash
# Only missing required fields
bwrb audit --only missing-required

# Ignore unknown fields
bwrb audit --ignore unknown-field

# Strict mode: unknown fields are errors
bwrb audit --strict

# Allow specific extra fields
bwrb audit --allow-field custom --allow-field legacy
```

### Repair Mode

```bash
# Fix issues across the entire vault (explicit targeting required)
bwrb audit --all --fix

# Preview fixes across the entire vault
bwrb audit --all --fix --dry-run --auto

# Interactive fix mode (writes by default; requires explicit targeting)
bwrb audit --all --fix

# Interactive fix mode for a subset
bwrb audit --path "Ideas/**" --fix

# Preview fixes without writing
bwrb audit --path "Ideas/**" --fix --dry-run

# Auto-apply unambiguous fixes (requires --execute)
bwrb audit --path "Ideas/**" --fix --auto --execute

# Preview auto-fixes
bwrb audit --path "Ideas/**" --fix --auto
```

### Trailing whitespace hygiene semantics

`trailing-whitespace` is a raw-frontmatter hygiene warning with narrow scope:

- It inspects YAML frontmatter `key: value` lines only (single-line key/value entries).
- Quoted values: whitespace inside the quotes is allowed; only whitespace after the closing quote is flagged.
- Block scalars (`|` or `>`) are excluded; content lines inside the block are ignored.
- It trims both spaces and tabs at line end.
- The fix is minimal-diff line trim only (no YAML reserialization).

Known non-matches:

- Whitespace before inline comments is not end-of-line whitespace (for example `status: raw  # note`) and is not flagged.
- Nested `key:` entries with no inline value are not treated as single-line key/value entries.

Auto-fix gating for this issue:

| Command | Result |
|---------|--------|
| `bwrb audit --fix` | Interactive mode. If you confirm the fix, the line trim is written. |
| `bwrb audit --fix --auto` | Preview only when `trailing-whitespace` is present (no writes). |
| `bwrb audit --fix --auto --execute` | Applies `trailing-whitespace` auto-fixes to disk. |

If a run contains `trailing-whitespace` and `--auto` is used without `--execute`, treat that run as preview-only.

```bash
# Preview trailing-whitespace auto-fixes (no writes)
bwrb audit --only trailing-whitespace --fix --auto

# Apply trailing-whitespace auto-fixes
bwrb audit --only trailing-whitespace --fix --auto --execute
```

Example on-disk behavior (minimal diff):

```text
before: status: "raw"   
after:  status: "raw"
```

`bwrb audit --fix` refuses to run without a TTY when interactive fixes are needed (use `--fix --auto` for non-interactive previews, and add `--execute` for execute-gated auto-fixes like `trailing-whitespace`).

### Unlinked-mention semantics (web integrity)

`unlinked-mention` is the closed-world web-integrity check: bwrb knows every note (by name) and, via the [`alias`-role field](/reference/schema/#alias), every registered alias. It scans note **bodies** for any known name or alias that appears as plain text but is **not** wikilinked, so the vault stays a connected graph instead of islands.

It enforces a strict **trust line** — only matches bwrb can be certain about are auto-linked; everything uncertain becomes a visible review item that is never silently resolved:

| Tier | What it matches | Behavior |
|------|-----------------|----------|
| **Exact / alias** | The literal note name, or a registered alias, present as unlinked plain text and resolving to exactly **one** entity | **Trusted → auto-fixable.** `--fix --auto --execute` converts it to a wikilink (`--fix --auto` alone previews). |
| **Fuzzy** | A capitalized phrase that is a near (small Levenshtein distance) match to a known name, e.g. `Steve Yeg` ≈ `Steve Yegge` | **Review item ("did you mean?") — never auto-linked.** |
| **Ambiguous** | A surface that matches **multiple** distinct entities/aliases, e.g. `Mercury` | **Never auto-resolved.** Listed as a review item with all candidates. |

Auto-fix output format:

- When the surface text equals the canonical note name, the fix uses a plain wikilink: `[[Steve Yegge]]`.
- When the surface differs from the canonical name (an alias, or different casing), the fix preserves the author's text via the Obsidian display-alias form: `[[Entity|surface]]`.

```text
# Exact name mention
before: I spoke with Steve Yegge today.
after:  I spoke with [[Steve Yegge]] today.

# Alias mention (display form preserves the surface)
before: Notes from Stevey.
after:  Notes from [[Steve Yegge|Stevey]].
```

False-positive guards (none of these are scanned or rewritten):

- Text already inside `[[wikilinks]]`, markdown links/images, fenced code blocks, inline code spans, and bare URLs.
- A note never flags a mention of **its own** name or alias.
- Matching is word-boundary aware (`Ada` does not match inside `Adafruit` or `Canada`) and case-insensitive, but the original surface casing is preserved in the fix.

Only frontmatter is exempt from scanning — this detection looks at body prose only. Surfaces shorter than three characters are ignored to avoid noise. The entity index is built once per run and each body is scanned in a single pass, so cost scales with body size rather than notes × entities.

```bash
# Report unlinked mentions only
bwrb audit --only unlinked-mention

# Auto-link trusted (exact/alias) mentions across the Notes directory
bwrb audit --path "Notes/**" --fix --auto --execute
```

Fuzzy and ambiguous mentions are reported with a suggestion but are **never** modified by `--fix --auto`; resolve them with interactive `--fix` (which will skip them with the suggestion) or by editing manually.

### Frequent-unlinked-term semantics (open-world nudge)

`frequent-unlinked-term` is the **open-world** counterpart to `unlinked-mention`. Where `unlinked-mention` keeps *known* entities linked, this detection points at entities that probably *should* exist but don't yet — it surfaces proper-noun-ish terms mentioned a lot across the vault that have **no note**. It attacks the failure mode where the AI agent (or you) never links something because it doesn't know the entity exists in the first place. Create the note, and `unlinked-mention` keeps it wired up forever after.

**Advisory only — this detection NEVER takes action.** It is always reported as a warning and is **never auto-fixable**: there is no `--fix` path for it, `--fix --auto` ignores it, and interactive `--fix` lists it as a manual item only. Because it never acts, it is *allowed* to be a little noisy; the thresholds exist purely to keep the report readable, not for correctness. Just ignore any suggestion that isn't a real entity.

**The heuristic (and its honest limits).** Discovering an unknown "thing" in prose without an LLM is inherently fuzzy. The detection approximates proper nouns with **runs of Capitalized words** (1–3 words: `Rust`, `Steve Yegge`, `New York Times`), counted only in prose. Known limits, stated plainly:

- **No semantic understanding.** A repeated capitalized non-entity (e.g. a recurring section title) can surface. That's expected — ignore it.
- **Sentence-start noise.** Any word can be capitalized simply by starting a sentence. To suppress this, single-word candidates are held to a stricter bar (longer minimum length, full stopword filtering, and must appear at least once *mid-sentence*), and a small stopword list (days, months, pronouns, common sentence openers) is filtered. Leading filler words are stripped from phrases (`The Rust Foundation` → `Rust Foundation`).
- **Multi-word phrases are favored** over single words, because a 2–3 word capitalized phrase is far more likely to be a genuine proper noun.

**Thresholds (defaults).** A term is surfaced only when it appears **≥ 4 times in total** across **≥ 2 distinct notes**. These keep one-off capitalizations out of the report. (The thresholds live as documented constants — `FREQUENT_TERM_DEFAULTS` — in `src/lib/audit/frequent-unlinked-term.ts`; tune them there.)

**Exclusions (the closed-world handoff).**

- A term whose text matches an existing **note name** or a **registered alias** is never surfaced — that's `unlinked-mention`'s job. The two detections never overlap.
- Terms that are already wikilinked are not counted: existing `[[wikilinks]]`, markdown links, fenced code blocks, inline code, and bare URLs are masked out (the same masking `unlinked-mention` uses), so only *prose* mentions count. A term that is always linked has zero prose mentions and can't reach the threshold.

Because the threshold is vault-wide, this detection aggregates across all scanned notes and reports its findings under a single `(vault-wide)` heading rather than against one file. Each finding lists the term, how many times it was mentioned, and the notes it appeared in.

```bash
# Report frequent unlinked terms only
bwrb audit --only frequent-unlinked-term

# Suppress them (e.g. while focusing on fixable issues)
bwrb audit --ignore frequent-unlinked-term
```

### Missing-body-section semantics (body structure)

`missing-body-section` validates the **markdown body**, not the frontmatter. The schema heavily enforces YAML frontmatter, but the body has historically been unchecked: `bwrb new` and `bwrb edit` scaffold the heading sections declared in a type's [`body_sections`](/reference/schema/) (e.g. a `bug` gets `## Steps to Reproduce`), but nothing stops a user from later deleting or renaming one. This detection re-checks, at audit time, that every declared section heading is still present.

What it checks:

- For each section declared in the resolved type's `body_sections` (including nested `children`), the body must contain a matching ATX heading — the exact title at the declared `level`. Trailing whitespace and ATX closing hashes (`## Title ##`) are tolerated.
- A heading written inside a fenced code block, inline code, or a link does **not** satisfy the requirement — the same [body masking](#unlinked-mention-semantics-web-integrity) used by `unlinked-mention` is applied, so only real prose headings count.
- If a heading with the right title exists but at the **wrong level**, it is still flagged (with the offending `lineNumber`), and the fix appends a correctly-leveled heading rather than rewriting yours.

What it does **not** check: it validates heading *presence/structure* only — not whether the body content under a section is filled in (bullets, checkboxes, paragraph counts). It also does not validate body links; that is the job of the [body-link checks](#body-link-validation-semantics-link-integrity) (`broken-body-wikilink`, `malformed-body-wikilink`, `broken-body-file-link`), which never overlap with this structural check.

**Auto-fixable.** Adding a declared heading is a safe, deterministic, **additive** repair — `--fix` appends the missing section using the *same* scaffold `bwrb new`/`bwrb edit` emit (heading + the section's `content_type` placeholder), so it never deletes or rewrites existing prose. It is idempotent: a re-run finds the now-present heading and does nothing (no duplicate headings). Types that declare no `body_sections` are never flagged.

```bash
# Report missing body sections only
bwrb audit --only missing-body-section

# Append missing sections automatically
bwrb audit --fix --auto --execute --all

# Suppress the check
bwrb audit --ignore missing-body-section
```

### Body-link validation semantics (link integrity)

The body-link checks validate the actual **links written in a note's markdown body** — the link-integrity counterpart to `missing-body-section`'s structure check. They are all **flag-only**: bwrb reports the problem (often with a suggestion) but never edits body prose links, because the intended target can't be known safely.

There are three codes:

- **`broken-body-wikilink`** — a *well-formed* `[[Target]]` (also `[[Target|display]]`, `[[Target#heading]]`, and embeds `![[Target]]`) whose target resolves to **no note**. Resolution uses the same alias-aware, case-insensitive [note index](/reference/schema/#alias) that relation fields use: a link written as `[[an alias]]` or `[[REALNOTE]]` resolves wherever the note's name or a [registered alias](/reference/schema/#alias) does. When a near-named note exists, a flag-only *"did you mean?"* hint is offered. An **ambiguous** body wikilink (its text matches more than one note) is **not** flagged — it is still a working Obsidian link (Obsidian resolves by proximity); ambiguity is only an error in *relation fields*, which is a separate frontmatter check.
- **`malformed-body-wikilink`** — bracket syntax that looks like a wikilink but is broken: an empty/whitespace-only target (`[[]]`, `[[ ]]`) or an unclosed `[[` with no matching `]]`.
- **`broken-body-file-link`** — a markdown file or image link, `[text](path)` / `![alt](path)`, whose **relative** target does not exist on disk. The path is resolved relative to the note's own directory (a leading `/` is treated as the vault root, Obsidian-style), with percent-encoding (e.g. `%20`) decoded for the existence check. **External targets are never checked**: URLs with a scheme (`https:`, `mailto:`, `tel:`…), protocol-relative `//host` links, and pure in-page anchors (`#section`).

All three respect code context: links written inside **fenced code blocks** or **inline code** are masked out and never flagged. Reported issues carry the offending `lineNumber` and the raw link `value`.

**Relationship to `unlinked-mention`.** These checks are the inverse of [`unlinked-mention`](#unlinked-mention-semantics-web-integrity) and never overlap with it:

- `unlinked-mention` flags a **known entity's name appearing as plain text** that *should* be a wikilink (it masks out existing `[[...]]` before scanning).
- `broken-body-wikilink` flags an **actual `[[...]]` link that points nowhere** (it looks *only* at existing wikilinks).

They are also disjoint from `frequent-unlinked-term` (an open-world plain-text heuristic) and from the relation-field checks (`stale-reference`, `malformed-wikilink`, `ambiguous-link-target`), which validate **frontmatter** values only.

```bash
# Report broken body wikilinks only
bwrb audit --only broken-body-wikilink

# Suppress broken file/image link checks
bwrb audit --ignore broken-body-file-link
```

### Non-interactive mode

```bash
# Safe automation (no prompts)
bwrb audit --fix --auto --execute --all
# Report-only JSON for CI/daemons
bwrb audit --output json
```

### JSON recommendations for delete-eligible issues

`bwrb audit --output json` is report-only and never deletes files. For delete-eligible findings (such as `orphan-file` or `invalid-type`), JSON output includes recommendation metadata so automation can decide on follow-up actions.

```json
{
  "code": "invalid-type",
  "autoFixable": false,
  "meta": {
    "recommendation": {
      "action": "delete-note",
      "reason": "invalid-type",
      "interactiveOnly": true,
      "source": "audit-fix"
    }
  }
}
```

### Phase 5: Type coercion fixes

```bash
# Auto-coerce unambiguous string scalars
bwrb audit --only wrong-scalar-type --fix --auto --execute --all

# Fix malformed wikilinks interactively
bwrb audit --only format-violation --fix --all
```

Empty required values ("", whitespace-only strings, or empty lists) are reported as `empty-string-required` and repaired interactively (or auto-filled when a default exists).


### CI Integration

```bash
# JSON output for CI
bwrb audit --output json

# Fail build on schema violations
bwrb audit --output json || exit 1
```

## Type Resolution

Audit resolves each file's type from its frontmatter `type` field:

- If `type` is missing: reports `orphan-file` and skips type-dependent checks
- If `type` is invalid: reports `invalid-type` and skips type-dependent checks
- Type-dependent checks (`missing-required`, `invalid-option`, `wrong-directory`) require valid type resolution

Use `--type` to filter by type; it does not fix missing type fields.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | No violations found, or `--fix --auto` completed (remaining issues are reported) |
| `1` | Violations found in report-only mode, or `--fix` (interactive) left remaining issues |

## See Also

- [Validation and Audit](/concepts/validation-and-audit/) — Audit concepts
- [bwrb bulk](/reference/commands/bulk/) — Batch fix operations
- [Targeting Model](/reference/targeting/) — Selector reference

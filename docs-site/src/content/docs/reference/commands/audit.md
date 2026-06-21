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

Note: built-in fields written by `bwrb new` (currently `id` and `name`) are always allowed and do not produce `unknown-field` issues.
Invalid option values inside list fields are reported as `invalid-option` with `listIndex` metadata, not a separate issue code.

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

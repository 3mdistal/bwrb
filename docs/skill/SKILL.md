---
name: bwrb
description: Schema-driven note management CLI for markdown vaults (bowerbird). Use for creating, querying, and editing structured notes programmatically.
---

# bwrb Agent Skill

bwrb (bowerbird) is a CLI for managing notes in Obsidian-style markdown vaults with schema-enforced frontmatter.

## When to Use This Skill

Use bwrb when you need to:
- Create structured notes with validated frontmatter
- Query and filter notes by type or field values
- Edit note frontmatter programmatically
- Generate wikilinks for Obsidian
- Validate notes against a schema

## Vault Resolution

bwrb finds the vault in this order:
1. `--vault <path>` flag
2. Find-up nearest ancestor containing `.bwrb/schema.json`
3. `BWRB_VAULT` environment variable
4. Bounded find-down beneath the current directory: one candidate is selected;
   multiple candidates prompt in a TTY or error in non-interactive/JSON mode

Always verify you're targeting the correct vault before operations.

## Initializing a Vault

Create a new bwrb vault with `init`:

```bash
# Initialize in current directory (non-interactive)
bwrb init --yes

# Initialize at specific path
mkdir -p /path/to/vault
bwrb init /path/to/vault --yes

# Reinitialize existing vault (destructive)
bwrb init --force --yes

# JSON output for scripting
bwrb init --yes --output json
```

The target directory must already exist. `init` creates `.bwrb/` inside it; it
does not create the vault directory itself.

The command creates `.bwrb/schema.json` with:
- Version 2 format
- Default `wikilink` link format
- Auto-detected Obsidian vault name (if `.obsidian/` exists)
- Empty `types: {}` (add types with `bwrb schema new type`)

## Schema Discovery

Before creating or querying notes, understand the vault's schema:

```bash
# List all types and their structure
bwrb schema list
bwrb schema types

# Show all types with fields inline (full overview)
bwrb schema list --verbose
bwrb schema types --verbose

# Show specific type definition with fields
bwrb schema list type task
bwrb schema fields task

# Get JSON output for parsing
bwrb schema list type task --output json
bwrb schema fields task --output json
bwrb schema list --verbose --output json  # All types with fields as JSON
```

## Configuration

bwrb supports vault-wide configuration in `.bwrb/schema.json` under the `config` key:

```json
{
  "config": {
    "link_format": "wikilink",
    "date_format": "YYYY-MM-DD"
  }
}
```

### Available Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `link_format` | `wikilink`, `markdown` | `wikilink` | Format for relation field links |
| `date_format` | Pattern string | `YYYY-MM-DD` | Pattern for generated full dates and unambiguous parsing |
| `date_granularity` | `day`, `month`, `year` | `day` | Vault default for allowed partial-date precision |
| `calendars` | Object | `{}` | Custom calendar registry for non-Gregorian date fields |
| `open_with` | `system`, `editor`, `visual`, `obsidian` | `system` | Default --open behavior |
| `editor` | Command string | `$EDITOR` | Terminal editor command |
| `visual` | Command string | `$VISUAL` | GUI editor command |
| `obsidian_vault` | String | auto | Obsidian vault name for URI opening |
| `default_dashboard` | String | none | Dashboard run with no name |
| `excluded_directories` | `string[]` | `[]` | Directory prefixes to exclude from discovery/targeting |
| `mention_fuzzy_threshold` | Integer `0`–`5` | `2` | Fuzzy edit-distance cap for mention suggestions |
| `mention_corpus_calibration` | Boolean | `true` | Dampen vault-common single-word targets |
| `mention_corpus_min_notes` | Integer | `3` | Corpus damping minimum note count |
| `mention_corpus_noncanonical_ratio` | Number `0`–`1` | `0.5` | Corpus damping casing threshold |
| `mention_link_once` | Boolean | `false` | Limit auto-fixes to one link per note/target pair |
| `mention_exclude_types` | `string[]` | `[]` | Types excluded from mention target indexing |
| `mention_exclude_paths` | `string[]` | `[]` | Globs excluded from mention target indexing |

### Date Format

The `date_format` option controls generated full-date values and disambiguates
matching input:

- `YYYY-MM-DD` - ISO 8601 (default, recommended)
- `MM/DD/YYYY` - US format
- `DD/MM/YYYY` - EU format
- `DD-MM-YYYY` - EU format with dashes

Gregorian date fields are canonicalized to `YYYY-MM-DD` when written; partial
dates remain ISO (`YYYY-MM` or `YYYY`). A value that exactly matches the
configured format can be parsed without guessing, so `01/02/2026` is January 2
under `MM/DD/YYYY` and February 1 under `DD/MM/YYYY`. Without an explicit
`date_format`, legacy unambiguous slash/dash input remains accepted. Once a
format is explicitly configured, non-ISO full dates must match it; canonical
`YYYY-MM-DD` and permitted ISO partials remain accepted.

### Custom Calendars

Vaults can define custom calendars in `config.calendars` and opt date fields in
with `calendar` or type-level `calendar_default`:

```json
{
  "config": {
    "calendars": {
      "tmi": {
        "hoursInDay": 336,
        "eras": [
          { "name": "Before Humans", "shortName": "BH", "backwards": true },
          { "name": "After Humans", "shortName": "AR" }
        ],
        "months": [{ "name": "Month One", "days": 2 }]
      }
    }
  }
}
```

Calendar date strings use `<eraShort> <year>-<month>-<day> [<hour>:<minute>]`,
for example `AR 3019-01-02 266:50` for the one-month calendar above. JSON list output expands these fields as
`{ value, calendar, linear }`; sort and `--where` compare the linear value.
For calendar-anchored relative-date chains, `d` means the calendar's
`hoursInDay`; `w` is rejected.

```bash
# View current config
bwrb config list

# Edit a command-supported config option
bwrb config edit open_with --json '"editor"'

# Set date writing and partial-date defaults
bwrb config edit date_format --json '"DD/MM/YYYY"'
bwrb config edit date_granularity --json '"month"'

# Exclude directories globally
bwrb config edit excluded_directories --json '["Archive","Templates"]'
```

`config list/edit` supports `link_format`, `editor`, `visual`, `open_with`,
`obsidian_vault`, `default_dashboard`, `excluded_directories`, `date_format`,
`date_granularity`, `mention_exclude_types`, `mention_exclude_paths`, and
`mention_link_once`. `calendars`, `mention_fuzzy_threshold`, and the
`mention_corpus_*` keys remain **schema-only**: edit `.bwrb/schema.json` and run
`bwrb schema validate`. Guided calendar authoring is tracked in
[#790](https://github.com/3mdistal/bwrb/issues/790).

For command edits, `date_format` must contain each of `YYYY`, `MM`, and `DD`
exactly once. `date_granularity` accepts `day`, `month`, or `year`.

## Built-in Frontmatter Fields

Some fields are recognized by bwrb regardless of schema:

- `id`: reserved/system-managed UUID created by `bwrb new` and should not be edited.
- `name`: always allowed and persisted by both interactive and JSON creation. It is the note identity and remains unchanged when the physical filename is normalized or pattern-derived.
- `forked-from`: reserved immediate-source UUID for document lineage. It is not a wikilink. Agents must not set or modify it through ordinary `new --json`, `edit`, template input, schema defaults, or audit fixes. Use guarded `lineage adopt` for known historical derivation between existing notes.

Create a document fork when preserving an earlier draft matters:

```bash
bwrb new --fork "Briefs/Launch Brief" --label concise --output json
bwrb new --fork 8f48f6a8-55c1-4ea7-9f4b-96735ed24af3 --name "Launch Brief v2" --output json
```

Fork targets are exact path, name, alias, or stable UUID matches. For agents,
always provide `--name` or `--label` and use `--output json`; the result contains
`path`, the child's fresh `id`, `forked_from`, and `warnings`. Do not combine
fork mode with a type, template, `--json`, instance, or ownership-selection
flag. The child is a normal note beside its source, not a hidden snapshot.

Adopt two existing notes only when their immediate derivation is known. Always
preview first and inspect the exact paths, IDs, changes, warnings, and body
hashes before executing:

```bash
bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json
bwrb lineage adopt "Child note" --from "Parent note" --execute --output json
```

Targets are exact UUID, path, basename, name, or alias matches and must have the
same resolved type. Adoption has no force or bulk mode, refuses an existing
child edge and unsafe/cyclic graph state, and changes only missing target IDs
plus the child's `forked-from`. A successful JSON result has `mode`, `child`,
`parent`, `changes`, `warnings`, and `body_invariance`; require both
`body_invariance.*.unchanged` values to be `true`. IDs shown as generated in a
dry run are provisional until execute revalidates under locks.

Deleting a document with direct fork children refuses unless `--force` is
supplied. With `--force`, bwrb deletes only the selected document: children keep
their `forked-from` value, which surfaces as `dangling-forked-from` in
`bwrb audit`. Use `bwrb list --lineage <target> --output json` before forcing a
parent deletion when an agent needs to enumerate the affected family.

## Core Commands for Agents

### Querying Notes

```bash
# List notes with JSON output (for parsing)
bwrb list idea --output json
bwrb list task --output json

# Filter by frontmatter fields
bwrb list task --where "status == 'active'" --output json
bwrb list task --where "priority == 'high' && status != 'done'" --output json

# Include specific fields in output
bwrb list task --fields status,priority --output json

# Sort matches before reading or limiting output
bwrb list task --sort deadline --output json
bwrb list task --sort priority --desc --output json

# Relative-date fields sort/filter by their resolved query-time value
bwrb list event --sort position --output json
bwrb list event --where "position < date('2026-01-03T00:00:00Z')" --output json

# Calendar date fields sort/filter by their linear calendar value
bwrb list event --sort when --output json
bwrb list event --where "when > 'AR 1000-01-01'" --output json

# Limit or count matches
bwrb list task --limit 5 --output json
bwrb list task --count --output json

# In name mode, limit caps output but never resolves ambiguity for actions
bwrb list --name "Duplicate" --limit 1 --output paths --picker none
# Use an exact relative path before opening from automation
bwrb list --name "Projects/Duplicate.md" --open --app print --picker none

# Target by stable id
bwrb list --id "<uuid>" --output json

# Full-text search in Markdown body content (YAML frontmatter excluded)
bwrb list --body "search term" --output json
```

`--body` searches only the Markdown body. Use `--where` when you need a
frontmatter field predicate. Detailed `--matches` line numbers still refer to
the original file, and displayed context never crosses into YAML frontmatter.

### Relative-Date Fields

Schema fields with `prompt: "relative-date"` store structured constraints, not
computed dates. Use JSON/object input in automation:

```bash
bwrb new event --json '{"name":"Scene B","position":{"kind":"equal","ref":"[[Scene A]]","field":"start","offset":"34h"}}'
bwrb edit "Scene B" --json '{"position":[{"kind":"after","ref":"[[Scene A]]","field":"start","offset":"1w"}]}'
```

`kind` is `equal`, `after`, or `before`; `offset` uses `min`, `h`, `d`, or `w`.
`bwrb list --output json` renders the field as `{ source, resolved, resolution }`.
Do not write resolved values back into frontmatter.

### Creating Notes

```bash
# Non-interactive creation with JSON frontmatter
bwrb new idea --json '{"name": "My Idea", "status": "raw"}'
bwrb new task --json '{"name": "Fix bug", "status": "backlog", "priority": "high"}'

# With template
bwrb new task --template bug-report --json '{"name": "Login fails"}'

# Skip template system entirely
bwrb new task --no-template --json '{"name": "Quick task"}'

# Include body sections
bwrb new task --json '{"name": "Task", "_body": {"Steps": ["Step 1", "Step 2"]}}'

# Include a raw Markdown body
bwrb new task --json '{"name": "Task", "_body": "## Notes\n\n- Captured from a script."}'

# Skip instance scaffolding for templates that define instances
bwrb new task --template epic --no-instances --json '{"name": "Ship feature"}'
```

Some templates define **instance scaffolding** (child notes created alongside
the main note). By default, `bwrb new` creates those instances; pass
`--no-instances` to skip child creation. Every child is filed in its own type's
configured `output_dir`, not beside the parent unless those directories happen
to match.

Instance defaults on fields whose resolved schema prompt is `date` evaluate the
same relative date expressions as the parent (`@today+3d`, `today() + '7d'`).
Date-looking defaults on non-date fields remain literal. Instance `defaults`
and an explicit instance `filename` do **not** interpolate parent placeholders
such as `{name}`; use literal child values or the child type's own filename
pattern.

When `bwrb new --json` runs instance scaffolding, the response includes an `instances` object with the created, skipped, and error lists. This object is omitted when `--no-instances` is set.

When `bwrb new --json` normalizes a filename (for example removing `/`, `?`, or other non-portable characters), the JSON response includes `nameTransformed` with `original`, `sanitized`, and `filename`. Long relative paths over 200 characters include `pathLengthWarning`; paths over 260 characters are rejected.

Before relying on templates in automation, check template health:

```bash
bwrb template list --output json
bwrb template validate --output json
```

`template list --output json` includes `valid`, `status`, and `issues` per template. `template validate` exits non-zero when any template is invalid and includes suggested repairs for unknown fields, invalid defaults, filename-pattern references, body placeholders, constraints, and instance defaults.

```json
{
  "path": "Projects/Ship feature.md",
  "instances": {
    "created": ["Projects/Ship feature/Design.md"],
    "skipped": [],
    "errors": []
  }
}
```

Notes created via `bwrb new` always include a system-managed frontmatter `id` (UUIDv4). The `id` is reserved: you cannot set it in `bwrb new --json`, and you cannot modify it via `bwrb edit`.

`forked-from` is also reserved. If an agent encounters it, treat the value as an
immediate source note UUID and leave it unchanged. `bwrb audit --output json`
reports malformed, dangling, duplicate-ID, and cyclic lineage metadata.

To inspect that history, prefer
`bwrb list --lineage <target> --output json` over walking `forked-from`
manually. It resolves the target exactly and returns the complete component—all
ancestors, descendants, and collateral sibling/cousin branches—with structured
warnings for malformed edges. Every member returns the same physical tree.
JSON `depth` is the node's rendered-tree generation minus the target's
generation, and `relationship` is `ancestor`, `target`, `descendant`, or
`related`; related cousins can therefore have negative, zero, or positive
depth.

### Editing Notes

```bash
# Patch frontmatter by query
bwrb edit "Note Name" --json '{"status": "done"}'

# Patch frontmatter by stable id
bwrb edit --id "<uuid>" --json '{"status": "done"}'

# Target specific type
bwrb edit --type task "Fix bug" --json '{"priority": "high"}'

# Filter then edit
bwrb edit --type task --where "status == 'active'" "Deploy" --json '{"status": "done"}'
```

Notes:
- If multiple notes share the same name, `bwrb edit` errors and lists candidates. Disambiguate with `--type`, `--path`, or a vault-relative path.
- `bwrb new --json` rejects unknown frontmatter fields after merging template defaults. `bwrb edit --json` rejects unknown fields in the patch.

### Deleting Notes

```bash
# Single-file delete (confirmation unless --force)
bwrb delete "Note Name" --force

# Scoped delete: query + targeting, requires --execute to delete
bwrb delete --type idea "Specific Name" --execute --force

# Bulk delete preview (dry-run is default for bulk)
bwrb delete --type task

# Explicit dry-run preview
bwrb delete --type task --dry-run

# Single-file JSON dry-run does not need --force
bwrb delete "Note Name" --dry-run --output json

# Bulk delete with confirmation (skip with --force)
bwrb delete --type task --execute --force
```

### Finding Notes

```bash
# Get wikilink (avoid interactive picker)
bwrb list --name "Note Name" --output link --picker none

# JSON output for scripting
bwrb list --name "Note" --output json --picker none

# Open and get path
bwrb list --name "Note Name" --open --app print --picker none

# Open and get path by stable id
bwrb list --id "<uuid>" --open --app print --picker none
```

### Validation

```bash
# Audit all notes against schema
bwrb audit

# Audit specific type
bwrb audit --type task

# JSON output for parsing issues
bwrb audit --output json

# JSON issue metadata (for hygiene checks, under `issue.meta`)
# trailing-whitespace: line, before, after, trimmedCount
# unknown-enum-casing: suggested, matchedBy, before, after
# frontmatter-key-casing: fromKey, toKey, before, after (or conflictValue)
# duplicate-list-values: duplicates, removedCount, before, after
# invalid-boolean-coercion: coercedTo, before, after
# orphan-file / invalid-type may include recommendation metadata:
# meta.recommendation.action=delete-note (report-only; no delete is performed)

# Fix issues (interactive writes by default; explicit targeting required)
# Apply guided fixes
bwrb audit --path "Ideas/**" --fix
# Preview fixes without writing
bwrb audit --path "Ideas/**" --fix --dry-run
# Auto-apply unambiguous fixes
bwrb audit --path "Ideas/**" --fix --auto --execute
# Preview auto-fixes
bwrb audit --path "Ideas/**" --fix --auto
# Note: auto mode never deletes files
# Note: directory-move fixes (wrong-directory, owned-wrong-location) never
#       overwrite an existing file. If a different file already occupies the
#       destination, the move is SKIPPED and reported as a conflict (counted as
#       Failed, not Fixed) so no data is lost; resolve the collision manually.
# Note: unlinked-mention single-word note names are conservative: exact casing
#       is required, common/static and vault-common corpus words are skipped,
#       and capitalized single-word names are ignored at sentence/list/heading
#       starts where capitalization carries no signal. Declared aliases remain
#       explicit link intent.
# Note: to link each mention target at most once per note (dense repeats read
#       poorly), enable link-once: pass --mention-link-once (or set config
#       mention_link_once: true; --no-mention-link-once overrides it off).
#       Notes already containing a prose/frontmatter wikilink to the target get
#       no new links; detection/reporting still lists every occurrence.

# Fix a specific issue code (auto-fix; safe to script)
bwrb audit --path "Ideas/**" --only trailing-whitespace --fix --auto --execute
bwrb audit --path "Ideas/**" --only trailing-whitespace --fix --auto

# Non-interactive automation
bwrb audit --output json
bwrb audit --fix --auto --execute --all
# Refuse interactive audit fixes without a TTY
bwrb audit --fix --all

# Non-interactive schema migrations
# Preview first; JSON includes uncapped per-note fileChanges.
bwrb schema migrate --output json
# Execute deterministic note changes with an explicit schema version.
bwrb schema migrate --execute --set-version 1.1.0 --output json
# Execute non-deterministic changes (data removal/review) with explicit consent.
bwrb schema migrate --execute --set-version 2.0.0 --yes --output json
```

#### Type Inference and Check Dependencies

Audit resolves each file's type from its frontmatter `type` field. Understanding this is critical for automation:

- **Type resolution**: Each file's `type` field is read and matched to the schema by short name (e.g., `task`, not `objective/task`)
- **Early termination**: If `type` is missing or invalid, audit reports `orphan-file` or `invalid-type` and **skips all type-dependent checks**
- **Filtering vs fixing**: `--type` filters which files to audit; it does not fix missing type fields

**Check dependency table:**

| Check | Requires Type Resolution |
|-------|-------------------------|
| `orphan-file` | No (reports missing type) |
| `invalid-type` | No (reports unrecognized type) |
| `trailing-whitespace` | No (operates on raw frontmatter lines; schema/type not needed) |
| `missing-required` | Yes |
| `invalid-option` | Yes |
| `unknown-field` | Yes |
| `wrong-directory` | Yes |
| `format-violation` | Yes |
| `stale-reference` | Partial (body wikilinks always checked; frontmatter relation fields require type) |

**Workflow for files with type issues:**

```bash
# Step 1: Find files with type problems
bwrb audit --only orphan-file --output json
bwrb audit --only invalid-type --output json

# Step 1b: Find whitespace hygiene issues (warnings; auto-fixable)
bwrb audit --only trailing-whitespace --output json

# Step 2: Fix type field (bulk or individual)
bwrb bulk --path "SomeDir/" --set type=task --execute

# Step 3: Re-run full audit to catch type-dependent issues
bwrb audit
```

### Dashboards (Saved Queries)

Dashboards save common list queries for reuse:

```bash
# Create a dashboard with flags
bwrb dashboard new my-tasks --type task --where "status == 'active'"
bwrb dashboard new inbox --type task --where "status == 'inbox'" --default-output tree

# Create via JSON
bwrb dashboard new my-query --json '{"type":"task","where":["priority==high"]}'

# Run a saved dashboard
bwrb dashboard my-tasks
bwrb dashboard my-tasks --output json  # Override default output format

# List all dashboards
bwrb dashboard list
bwrb dashboard list --output json  # JSON output for scripting
```

## Best Practices

1. **Use canonical `list --output json`** for note discovery and `audit --output json` for validation; avoid starting new automation on hidden compatibility `search`/`open`
2. **Always use `--picker none`** to prevent interactive prompts blocking automation
3. **Query schema first** before creating notes to understand required fields
4. **Use `--json` input** for `new` and `edit` to avoid interactive prompts
5. **Validate with audit** after bulk operations
6. **Use filter expressions** (`--where`) for targeted queries rather than fetching all notes

### Commander Negated Flags (`--no-*`)

For automation, treat Commander negated flags as a contract:

- `--no-foo` maps to `options.foo === false` at runtime.
- Do not assume `options.noFoo` exists.

Examples in bwrb:

- `bwrb new ... --no-template` => `options.template === false`
- `bwrb list --body "..." --matches --no-context` => `options.context === false`
- `bwrb schema migrate ... --no-backup` => `options.backup === false`

## Filter Expression Syntax

```bash
# Equality
--where "status == 'active'"

# Inequality
--where "status != 'done'"

# Logical operators
--where "priority == 'high' && status == 'active'"
--where "status == 'done' || status == 'cancelled'"

# Comparison (for dates/numbers)
--where "created > '2024-01-01'"
```

## Common Patterns

```bash
# Get all active tasks as JSON
bwrb list task --where "status == 'active'" --output json

# Create a task and capture the path
bwrb new task --json '{"name": "New Task", "status": "backlog"}' --output json

# Bulk update (edit works on single notes; loop for bulk)
for note in $(bwrb list task --where "status == 'in-progress'" --output paths); do
  bwrb edit "$note" --json '{"status": "done"}'
done

# Bulk update (non-interactive confirmation)
bwrb bulk --all --set status=processed --execute --yes
echo "y" | bwrb bulk --all --set status=processed --execute

# Generate a wikilink for insertion
bwrb list --name "Target Note" --output link --picker none  # Output: [[Target Note]]
```

## Error Handling

bwrb exits with non-zero status on errors. JSON output includes error information:

```bash
bwrb list nonexistent --output json
# {"error": "Type not found: nonexistent"}
```

Check exit codes in scripts:
```bash
if ! bwrb audit --type task --output json; then
  echo "Validation failed"
fi
```

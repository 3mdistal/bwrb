---
title: JSON Mode
description: Scripting and automation with command-specific JSON input and output
---

Bowerbird's machine-readable options are command-specific. Use `--output json`
only where that command's `--help` lists it, and use `--json` input only on
commands that explicitly accept a JSON payload. They are not universal global
flags.

For commands that can prompt or open a picker, add the global
`--non-interactive` flag when you need a hard no-prompt guarantee:

```bash
bwrb --non-interactive new task --json '{"name":"Fix login","priority":"high"}'
bwrb --non-interactive edit "My Task" --json '{"status":"settled"}'
```

## JSON output shapes

Check the command reference before choosing a parser. Bowerbird emits one
complete JSON value, but success shapes differ by workflow:

| Workflow | Success shape |
| --- | --- |
| `list [filters] --output json` | Raw array of note objects with `_path`, `_name`, and frontmatter |
| `list --count --output json` | Raw `{ "count": number }` object |
| `list --name ... --output json` | `{ "success": true, "data": [...] }` |
| `list --fuzzy ... --output json` | `{ "success": true, "data": [...] }`, including scores and match metadata |
| `list --body ... --matches --output json` | Match report with `success`, `data`, `totalMatches`, and `truncated` |
| `list --lineage ... --output json` | Raw `{ "target", "nodes", "warnings" }` object |
| `new --fork ... --output json` | `{ "success": true, "path", "id", "forked_from", "warnings" }` |
| `lineage adopt ... --output json` | `{ "success": true, "mode", "child", "parent", "changes", "warnings", "body_invariance" }` |

Normal list output is intentionally a raw array:

```bash
bwrb list task --output json | jq -r '.[] | ._path'
```

Name and fuzzy resolution use a success envelope:

```bash
bwrb list --name "My Note" --output json --picker none | jq -r '.data[0].path'
bwrb list --fuzzy "My Nte" --output json | jq '.data[] | {path, score}'
```

Lineage output is a raw graph object, not a `data` envelope:

```bash
bwrb list --lineage "Briefs/Launch Brief" --output json | jq '.nodes[]'
```

Adoption output uses a success envelope because it describes a planned or
applied mutation. Preview is the default; require `mode == "dry-run"`, review
the paths and changes, and then rerun with `--execute`. Generated preview IDs
are provisional. Both `body_invariance.child.unchanged` and
`body_invariance.parent.unchanged` should be `true`.

## JSON input

`new` and `edit` accept frontmatter payloads directly:

```bash
bwrb new task --json '{"name":"Fix login","priority":"high"}'
bwrb edit "My Task" --json '{"status":"settled"}'
```

Other management commands accept JSON only where their help documents it, such
as `config edit <key> --json <value>` and selected template/dashboard workflows.
Run `bwrb <command> --help`; do not infer `--json` support from another command.

`bwrb new --json` reports filename safety metadata when relevant:
`nameTransformed` appears when a requested name is normalized, and
`pathLengthWarning` appears for relative paths longer than 200 characters.
Paths longer than 260 characters are rejected.

## Errors and exits

Machine-readable failures normally use a structured error object such as:

```json
{
  "success": false,
  "error": "No matches for query",
  "code": 1
}
```

The process exit code remains authoritative. Consumers should tolerate added
fields and should not assume that every successful command uses the same
envelope merely because errors share a common shape.

Audit JSON is report-only: it never applies fixes or deletes. For
delete-eligible findings, issue metadata may include a recommendation under
`meta.recommendation`.

## See Also

- [AI integration](/automation/ai-integration/)
- [bwrb list](/reference/commands/list/)
- [Targeting Model](/reference/targeting/)

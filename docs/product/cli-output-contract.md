# CLI JSON Output + Exit Contract

> Product-level contract for machine-readable CLI output.

**Canonical docs:** User-facing JSON behavior lives in the docs-site
[JSON Mode](../../docs-site/src/content/docs/automation/json-mode.md) and
command-reference pages. This note records implementation constraints and the
intentional command-specific shapes.

## Scope

JSON is not a universal global mode. A command supports `--output json` or
`--json` input only when its registered help says so. Adding either option is a
command-boundary API decision and needs command-specific tests and docs.

When a command selects JSON output, it must write exactly one complete,
newline-terminated JSON value to stdout. Prompts and human diagnostics must not
pollute stdout; warnings belong on stderr or should be suppressed. Success exits
`0`; failure exits non-zero. The CLI-wide codes are `0` success, `1` validation,
`2` I/O, and `3` schema.

## Success shapes are command-specific

The helpers in `src/lib/output.ts` define a useful `JsonSuccess`/`JsonError`
envelope, but not every successful workflow uses that envelope. Existing shapes
are part of the compatibility contract:

| Workflow | Success JSON |
| --- | --- |
| Normal `list --output json` | Raw array of note objects |
| `list --receipt --output json` | Receipt with applied selectors/settings, pre-limit matched count, returned count, `truncated`, and `data` rows |
| `list --count --output json` | Raw `{ count }` object |
| Canonical name/fuzzy modes | `{ success: true, data: [...] }` |
| Detailed body matches | `{ success: true, data: [...], totalMatches, truncated }` |
| `list --lineage --output json` | Raw `{ target, nodes, warnings }` object |
| `new --fork --output json` | `{ success: true, path, id, forked_from, warnings, ... }` |
| Other mutation/management commands | Usually a `JsonSuccess` envelope; document and test the exact command shape |

Do not wrap a legacy raw success shape merely to make the prose look uniform.
That would be a product/API change, not a documentation correction.

`--receipt` is an explicit JSON-only opt-in for normal filtered-list output. It
preserves the raw array when omitted and is incompatible with `--count`,
`--open`, lineage, and name/fuzzy/detailed-match modes. Typed queries validate
all field references against the selected schema type; queries without
`--type` remain permissive.

## Error contract

Machine-readable command failures should emit a structured error object on
stdout and set a non-zero process exit code:

```ts
export interface JsonError {
  success: false;
  error: string;
  data?: unknown;
  errors?: Array<{
    field: string;
    value?: unknown;
    message: string;
    expected?: string[] | string;
    suggestion?: string;
  }>;
  code?: number;
}
```

The process exit code is authoritative; `code` is best-effort metadata. Clients
must ignore unknown fields so compatible metadata can be added later.

One command-specific exception is deliberate: `audit --fix --auto` exits `0`
after its preview or execution pass even when non-auto-fixable issues remain.
Interactive `audit --fix` exits non-zero when issues remain. Consumers that need
the remaining-issue count should parse the audit summary rather than infer it
from the auto-fix process status.

## Termination guidance

Avoid `process.exit()` in deep helpers. Return or throw to the command boundary,
which decides the output shape and exit code. If a command must exit directly,
write the full JSON value first. This prevents truncated output when stdin stays
open or the command is embedded in automation.

## Author checklist

- Register and document JSON flags per command; never claim blanket support.
- Emit one parseable JSON value with no human text on stdout.
- Preserve the command's established success shape.
- Emit structured errors and a non-zero failure exit.
- Test prompt-mode/stdin-open termination for mutation commands.
- Document raw arrays/objects and envelopes exactly as consumers receive them.

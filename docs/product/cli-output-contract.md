# CLI JSON Output + Exit Contract

> The product-level contract for machine-readable CLI output.

**Canonical docs:** This document is product rationale + implementation contract. It should be mirrored on the docs-site (planned path: `/reference/output/`).

---

## Why this exists

Bowerbird is designed to be scriptable and composable. In `--output json` mode, the CLI is an API.

This contract ensures:
- Automation and CI can parse output reliably.
- The Neovim plugin (and any wrappers) can depend on stable JSON.
- We avoid intermittent truncated JSON caused by exiting too early.

---

## Contract (authoritative)

When `--output json` is selected, commands MUST follow these rules:

### Stdout

- MUST write **exactly one** complete JSON value to **stdout**.
- MAY pretty-print the JSON (whitespace and internal newlines are allowed).
- MUST newline-terminate the output.
- MUST NOT write any non-JSON text to stdout (no tables, prompts, progress, warnings, etc.).
- Consumers MUST parse stdout as JSON (not line-delimited/NDJSON).

### Stderr

- Human-oriented logs, progress, warnings, and diagnostics MUST go to **stderr**, or be suppressed in JSON mode.
- In JSON mode, commands SHOULD avoid interactive prompts; if required input is missing, return `JsonError` and a non-zero exit code instead.

### JSON envelope

- Stdout MUST be a single `JsonResult` value.
- Command-specific payload belongs under `data`.

The canonical envelope is defined in `src/lib/output.ts`:

```ts
export interface JsonSuccess<T = unknown> {
  success: true;
  data?: T;
  path?: string;
  updated?: string[];
  message?: string;
}

export interface JsonError {
  success: false;
  error: string;
  errors?: Array<{
    field: string;
    value?: unknown;
    message: string;
    expected?: string[] | string;
    suggestion?: string;
  }>;
  code?: number;
}

export type JsonResult<T = unknown> = JsonSuccess<T> | JsonError;
```

**Structured error details:** Use `errors[]` for machine-readable details (e.g., resolution candidates):

```json
{
  "success": false,
  "error": "No matches for query",
  "errors": [
    { "field": "candidate", "value": "Work/Task A.md", "message": "Matching file" }
  ]
}
```

---

## Stability & compatibility

- The `JsonResult` envelope is intended to be forward-compatible: consumers MUST ignore unknown fields.
- We MAY add new optional fields over time without breaking consumers.
- We SHOULD NOT rename/remove existing fields without a major version bump.
- The process exit code is authoritative; `JsonError.code` is best-effort metadata.

---

## Exit behavior

### Exit codes

- Success MUST exit with code `0`.
- Failure MUST exit with a non-zero code.

The CLI-wide exit codes are defined in `src/lib/output.ts`:

- `0` `SUCCESS`
- `1` `VALIDATION_ERROR`
- `2` `IO_ERROR`
- `3` `SCHEMA_ERROR`

### Errors in JSON mode

- In `--output json`, failures MUST still emit a JSON error object (`JsonError`) on stdout.
- When available, `JsonError.code` SHOULD match the process exit code.

---

## Termination (`process.exit`) guidance

Avoid `process.exit()` from inside deep helpers.

- Prefer returning a result or throwing an error and letting the command handler decide:
  - what to print
  - what exit code to use
- If `process.exit()` is used, it MUST be done only at the command boundary and only after stdout has been written.

This reduces the risk of truncated JSON output.

---

## Examples

### Success

```json
{
  "success": true,
  "data": {
    "count": 3
  }
}
```

### Failure

```json
{
  "success": false,
  "error": "Invalid schema",
  "code": 3
}
```

---

## Author checklist (for command implementations)

In `--output json`:
- Emit one `JsonResult` to stdout (newline-terminated).
- Send logs/warnings/progress to stderr (or suppress).
- Do not call `process.exit()` from helper functions.
- On failure, emit `JsonError` and set a non-zero exit code.

# Benchmark Matrix Runner

`pnpm bench:run` creates a disposable, deterministic fixture and records
per-command observations as JSONL plus a JSON report. It is an internal
measurement tool, not ordinary CI: it does not establish a performance budget,
and the 10k list/count profile remains a manual investigation path.

Always provide explicit temporary and output directories outside a real vault:

```sh
pnpm bench:run -- --temp /tmp/bwrb-bench-fixture --out /tmp/bwrb-bench-out \
  --profile realistic --mode built --samples 1 --warm-repeats 1
```

`--mode built` measures `dist/index.js`; use `--mode source` only when a
source-versus-built comparison is the question. The runner emits a one-line
JSON pointer to `benchmark-report.json` and `benchmark.raw.jsonl`. Parse those
artifacts rather than treating terminal timing as a durable result. Workflows
that should not mutate the fixture are labelled `contaminated` if their
checksum changes. Peak RSS is explicitly `unmeasured` because Node does not
provide portable child-process peak RSS.

Use `--full-test-command` only for a deliberately bounded command. Do not put
large fixture runs or timing thresholds in the normal CI path without a
separate decision and a versioned baseline.

## WP7.4 performance contract

`pnpm bench:contract` is the auditable, built-CLI performance runner. It uses
synthetic, metadata-only teenylilthoughts analogues at 5,000 and 10,000 notes;
it never opens or mutates a live vault. Each single-command sample gets a
fresh disposable copy, while the parallel case edits four distinct notes in
one disposable 10,000-note fixture.

```sh
pnpm build
pnpm bench:contract -- --temp /tmp/bwrb-wp74-fixtures --out artifacts/health/wp74-$(date +%Y%m%d-%H%M%S) \
  --samples 3 --contention isolated
```

The runner requires Node 22 and executes the absolute `dist/index.js` path.
It records raw JSONL and a report with the executable, commit, fixture shape,
contention label, total/first-output/close timing, observed mutation timing,
exit/output validity, target and fixture checksums, and macOS peak RSS from
`/usr/bin/time -l`. On other platforms RSS is explicitly unmeasured.

The command measures exact absolute-path edit, exact-basename edit (the
unambiguous `task-00009` filename identity, not a frontmatter `name` or fuzzy
match), unfiltered `list --count`, sequential invocations, and four concurrent
distinct edits.
Production code currently exposes no trustworthy startup/schema/discovery
phase instrumentation, so those phases are explicitly marked unavailable—not
invented from wall-clock guesses. Treat any shared-machine run as
contaminated context, not an accepted budget result. The report says whether
each initial WP7.4 budget was met; an unavailable measurement remains
unmeasured rather than passing by optimism. Tiny bureaucratic umbrella, but
it keeps the rain off the evidence.

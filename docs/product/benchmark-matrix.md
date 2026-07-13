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

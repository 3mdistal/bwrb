# Health-report contract

This is internal health tooling, not a Bowerbird CLI contract. It prevents audit and test evidence from being given a larger meaning than the run earned.

## Canonical unused-surface evidence

`pnpm knip` is the canonical unused-code and unused-dependency check. Its result is the only Knip result that may support an unused-surface conclusion.

`pnpm knip:prod` is a **production entrypoint audit**, not a dead-code report. It deliberately excludes build, docs-site, schema-generation, packaging, and test roots. A production-only finding is never a removal candidate until full Knip and the relevant support surface agree.

## Machine-readable reports

Generate a template with `pnpm health:report`, or record one completed check, for example:

```sh
pnpm health:report -- --check full-knip --status passed --classification measured \
  --fixture repository --retry-mode not-applicable --raw-artifact artifacts/health/full-knip.json \
  --out artifacts/health/full-knip-report.json
```

Every report includes a versioned header: commit, package version, Node and pnpm versions, operating-system platform, fixture identity, retry mode, worker count, PTY availability, and raw-artifact paths. A missing value is recorded explicitly as `unknown`, `not-recorded`, or `not-applicable`; it must not be silently inferred.

Result classifications are deliberately separate from pass/fail:

- `measured`: directly observed under the recorded run conditions.
- `inferred`: a conclusion derived from other recorded evidence.
- `unmeasured`: no run was made.
- `skipped`: a planned run was deliberately not made, including unsupported PTY environments.
- `retried`: the result required more than one attempt; it is feedback evidence, not retry-zero reliability evidence.
- `contaminated`: the run was affected by a named condition such as shared contention, fixture drift, or an invalid environment.

`test-feedback` is the default retrying feedback lane. `test-retry-zero` is the distinct reliability lane. PTY results retain their own availability/skipped state.

## Artifacts and retention

Future CI and benchmark work writes raw material beneath `artifacts/health/` and uploads it as the `health-report-artifacts` GitHub Actions artifact with `retention-days: 30`. Reports keep relative raw-artifact paths so a summary cannot outlive the evidence it names. Long-lived accepted benchmark baselines belong in a later versioned fixture/baseline package, not in this transient CI artifact.

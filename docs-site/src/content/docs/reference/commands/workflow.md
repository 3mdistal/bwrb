---
title: bwrb workflow
description: Run a bounded attempt, attestation, and deterministic acceptance loop
---

`workflow run` is an explicit, bounded orchestration command. It invokes one
executable, requires one strict JSON attestation, writes that evidence as a
typed note, and retries only while a deterministic scalar acceptance rule and
every declared budget permit it.

It is separate from transition effects and recurrence. Those mechanisms remain
one-hop and do not cascade.

## Synopsis

```bash
bwrb workflow run <query> \
  --expected-revision <revision> \
  --run-id <stable-id> \
  --attempt-command <executable> \
  [--attempt-arg <value> ...] \
  [--output text|json]
```

The query must resolve exactly. The workflow type must compose a trait with an
`attempt_loop` policy. `--expected-revision` is the opaque revision returned by
`bwrb list --output json`; no child starts when that observation is already
stale. `--run-id` is a caller-owned idempotency key using 1–128 letters,
numbers, dots, underscores, or hyphens.

The attempt command is executed directly with the repeated arguments. Bowerbird
does not invoke a shell or expand pipes, redirects, variables, or command
substitutions. The child inherits the runner's existing environment and
authority; Bowerbird does not authenticate or sandbox it.

## Attempt protocol

The executable must exit zero and write exactly one JSON object to stdout:

```json
{
  "happened": "Ran the focused evaluator against revision abc123",
  "failed": "Two fixtures still miss the threshold",
  "baseline": 0.61,
  "observed": 0.74,
  "tokens_used": 842
}
```

`happened` is non-empty. `failed` is a non-empty string or `null`. Metrics are
finite numbers and `tokens_used` is a non-negative integer. Unknown keys,
invalid JSON, output over 64 KiB, a nonzero exit, or a timeout stops the run;
protocol failures are not silently retried.

Each invocation receives `BWRB_ATTEMPT_WORKFLOW`, `BWRB_ATTEMPT_RUN_ID`,
`BWRB_ATTEMPT_ITERATION`, `BWRB_ATTEMPT_REMAINING_SECONDS`, and
`BWRB_ATTEMPT_REMAINING_TOKENS`.

## Evidence and terminal state

Every valid attempt becomes a typed note using fixed fields: `workflow`,
`run-id`, `iteration`, `idempotency-key`, `happened`, `failed`, `baseline`,
`observed`, `tokens-used`, and `outcome`. `outcome` is `accepted` only when
`failed` is null, the metric passes, and the attempt stayed within its token
budget.

A workflow-specific lock serializes runners. Rerunning the same run ID finds
existing contiguous attestations and resumes without duplicating attempts.
Once the workflow records that run ID and a terminal value, the invocation is a
read-only idempotent replay.

Terminal stop reasons are `criterion-accepted`, `max-iterations-reached`,
`wall-clock-budget-reached`, `token-budget-reached`, `token-budget-exceeded`,
`attempt-process-failed`, `attempt-timed-out`, and `invalid-attestation`.

An accepted run exits zero. A safely recorded terminal failure returns the full
result but exits nonzero. The final workflow edit uses the starting revision
and honors transition guards. If another writer changed the workflow,
Bowerbird returns both revisions and never overwrites the newer state merely to
make the failure prettier.

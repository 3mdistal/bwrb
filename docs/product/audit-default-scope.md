# Default `bwrb audit` scope

Status: shaped for Work
Date: 2026-08-09
Canonical behavior docs to update during Work: [`docs-site/src/content/docs/reference/commands/audit.md`](../../docs-site/src/content/docs/reference/commands/audit.md)

## Summary

`bwrb audit` should validate explicit schema, structure, identity, ownership, lineage, and link-integrity contracts by default. It should not run prose-connectivity heuristics unless the caller asks for them.

The first slice will remove both `unlinked-mention` and `frequent-unlinked-term` from the default audit profile. A new `--mentions` flag will opt into those two analyses. Fuzzy near-match analysis will require a further explicit opt-in through `--mention-fuzzy` or a positive `--mention-fuzzy-threshold`.

This preserves the mention safety net while restoring a fast, predictable default audit. The bird may still inspect every noun, but only after being invited.

## Context

Bowerbird's product vision places schema enforcement at the core and the AI safety net, including unlinked-mention analysis, in the outermost circle. The current default audit crosses those layers invisibly: a command described as validating notes against a schema also performs multiple whole-vault prose analyses.

The behavior is especially costly in a large real-world vault. Read-only measurements against an installed Bowerbird CLI showed a routine no-fuzzy audit taking tens of seconds, while the fuzzy mention pass could run for minutes.

The main cost is not schema validation. Exact mention analysis builds a full-vault corpus and scans every selected body against a large combined surface pattern. Fuzzy analysis then compares each eligible capitalized phrase against every known entity name with Levenshtein distance. The frequent-term post-pass rereads every selected body.

## Problem

The default command currently violates three useful expectations:

1. **Scope:** `audit` sounds like enforcement of explicit vault contracts, while unlinked prose and candidate entities are editorial suggestions.
2. **Cost:** callers cannot predict that a routine audit may become a minutes-long corpus analysis.
3. **Automation:** default text and JSON output can acquire heuristic warnings and latency unrelated to schema validity.

`unlinked-mention` remains valuable as deterministic graph-maintenance assistance, and `frequent-unlinked-term` remains useful as an advisory discovery pass. Their value does not require default execution.

## Desired outcome

A user can run `bwrb audit` frequently and trust that it checks declared vault integrity without performing optional prose analysis. A user or agent can deliberately request mention analysis, including fuzzy suggestions when desired, using discoverable CLI flags. Existing mention detection and repair capabilities remain available.

## Options considered

### 1. Disable fuzzy matching only

This removes the worst unbounded nested comparison but leaves exact mention analysis and the frequent-term pass in every audit. The measured full audit still took 40.1 seconds with fuzzy disabled. This is insufficient.

### 2. Exclude mention issues by default and rely only on existing `--only`

This is the smallest runtime change: callers could run `--only unlinked-mention` and `--only frequent-unlinked-term` separately. It lacks an ergonomic way to request the complete mention safety net in one run.

### 3. Add an explicit mention profile at the existing command boundary

Add `--mentions` for the two prose heuristics and `--mention-fuzzy` for the expensive fuzzy tier. Preserve `--only` for issue-specific runs. This makes cost and intent visible without adding a top-level command or moving detector ownership.

**Recommended.**

### 4. Create a separate command such as `bwrb mentions`

This produces the strongest conceptual separation but expands the command surface, duplicates audit targeting/output/fix behavior, and creates a migration larger than the demonstrated problem requires. Defer unless the explicit audit profile later proves awkward.

## Recommended direction

### Default profile

`bwrb audit` and `bwrb audit --fix` exclude:

- `unlinked-mention`
- `frequent-unlinked-term`
- every corpus/index/post-pass cost used exclusively by those issue families

Broken or malformed body links remain in the default audit because they are integrity defects. Schema-declared body sections remain because they are explicit contracts.

### Explicit mention profile

```sh
bwrb audit --mentions
```

This enables:

- exact known-name and registered-alias detection;
- ambiguous exact-surface review items; and
- `frequent-unlinked-term` advisory findings.

It does not enable fuzzy near-match analysis.

`--mentions` composes with existing targeting, output, and repair flags. In repair mode it explicitly permits the existing trusted exact/alias mention fixes; the frequent-term detector remains non-fixable.

### Explicit fuzzy tier

```sh
bwrb audit --mentions --mention-fuzzy
bwrb audit --mention-fuzzy
bwrb audit --mention-fuzzy-threshold 3
```

`--mention-fuzzy` implies `--mentions`. A positive `--mention-fuzzy-threshold` also implies fuzzy analysis and the mention profile. The configured threshold continues to tune distance once fuzzy analysis is enabled; it does not enable fuzzy analysis by itself.

`--no-mention-fuzzy` remains as a compatibility flag and is harmless with `--mentions`. Combining it with `--mention-fuzzy` or a positive `--mention-fuzzy-threshold` is a command-boundary validation error independent of flag order. A threshold of `0` disables fuzzy analysis and does not independently opt into mention analysis.

### Existing issue filters

- `--only unlinked-mention` opts into that detector without requiring `--mentions`; fuzzy remains off unless explicitly enabled.
- `--only frequent-unlinked-term` opts into that detector without requiring `--mentions`.
- `--mentions --only <mention-code>` is accepted as a redundant but coherent narrowing.
- `--mention-fuzzy --only frequent-unlinked-term` is rejected because fuzzy findings belong to `unlinked-mention`, which `--only` excluded.
- Existing `--ignore` semantics remain unchanged.

### Configuration

No new persistent `audit_mentions` or `mention_fuzzy` schema keys are in the first slice. The existing `mention_fuzzy_threshold` remains a tuning value with default `2`, but fuzzy work is dormant until the caller opts in. Persistent default-profile customization can be shaped later if real usage demands it.

### Compatibility and communication

This is an intentional default-behavior change:

- scripts depending on mention findings from bare `bwrb audit` must add `--mentions`;
- scripts depending on fuzzy findings must also add `--mention-fuzzy` or a positive threshold;
- JSON shape and issue objects do not change, but default results omit the two advisory issue families;
- the changelog, command help, canonical audit reference, validation concept page where relevant, and `docs/skill/SKILL.md` must describe the new opt-in contract in the same change.

## Architecture grounding and fit

Architecture grounding is **not required** for this bounded local CLI policy change. The owning boundary is already explicit and does not alter a shared service, schema protocol, or cross-repository contract.

- **Demonstrated caller:** a maintainer running bare `bwrb audit` in a large vault expects a routine integrity check and encounters minutes-long prose analysis.
- **Existing primitives:** `--only`, `--ignore`, Commander command-boundary options, `AuditRunOptions`, and the existing detector gates in `runAuditDetailed` already control issue selection.
- **Ownership boundaries:** the `audit` command owns CLI intent and validation; audit detection owns execution of selected detectors; individual mention detectors retain their current matching and repair semantics.
- **Legacy contracts to preserve:** explicit `--only unlinked-mention`, explicit `--only frequent-unlinked-term`, targeting, text/JSON result shapes, exit codes, and safe mention-fix behavior.
- **Shared vocabulary:** `core audit` means declared integrity checks; `mention profile` means the two prose-connectivity heuristics; `fuzzy tier` means flag-only near-match suggestions within `unlinked-mention`.
- **Smallest compatible delta:** resolve mention inclusion once at the command/audit-run boundary and skip all mention-only setup and passes when disabled. Do not rewrite matching algorithms in this slice.
- **Deferred capabilities:** detector performance optimization, parsed-body caching, generic named audit profiles, repeatable `--include`/`--ignore`, persistent profile configuration, and a separate mentions command.
- **Reversibility:** the detectors and issue codes remain intact; the behavior can be restored by changing selection defaults, while users can opt in immediately.
- **Direct evidence:** current command registration and detector gates; issues #600, #601, #622, and #783; canonical audit documentation; the measurements above.
- **Inference:** users generally interpret bare audit as contract enforcement rather than editorial review. This aligns with the product vision and the observed caller but has not been surveyed broadly.
- **Unresolved owner questions:** none.

Bowerbird's product-boundary gate passes: this change selects deterministic validation and advisory checks. It owns no agent, retry, scheduling, deployment, or process policy.

## Constraints

- Preserve the current issue codes and explicit workflows.
- Do not weaken schema, identity, ownership, lineage, relative-date, body-link, or schema-declared body-section checks.
- Do not make fuzzy matching automatic merely because a vault has a nonzero configured threshold.
- Resolve positive/negated flag conflicts at the command boundary and test both flag orders, consistent with Commander's `--no-*` contract.
- Keep user-facing behavior canonical in `docs-site`; this product brief records rationale and links to that contract.
- Update the automation skill because bare `bwrb audit` will no longer inspect unlinked prose.
- Do not introduce a CI timing threshold tied to a shared machine. Use the existing benchmark machinery or a recorded manual measurement for real-vault performance evidence.

## Risks and assumptions

- **Silent coverage reduction:** existing users may assume bare audit still checks mentions. Mitigate with help text, changelog/migration guidance, and explicit examples.
- **Flag complexity:** `--mentions`, `--mention-fuzzy`, threshold, `--only`, and `--no-mention-fuzzy` need one centralized option-resolution matrix rather than scattered conditionals.
- **Performance remains imperfect:** the explicit mention profile will still be slow. This slice makes the cost intentional; it does not optimize it.
- **Default audit may still have other scale costs:** acceptance must measure the complete new default rather than infer its speed from one detector benchmark.

## Acceptance story

Acceptance story ID: `audit-core-default-v1`

**Successful-user story:** In a vault containing schema errors, broken links, exact unlinked names, a repeated unknown proper noun, and a fuzzy near-match, a maintainer can run bare `bwrb audit` and quickly receive only declared integrity findings. They can add `--mentions` to receive exact/alias and frequent-term findings, then explicitly add `--mention-fuzzy` to receive fuzzy suggestions. Existing safe repair and JSON contracts continue to work.

Required assertions:

1. Bare text and JSON audits do not report either mention issue code and do not build the mention corpus/index or execute either mention body pass.
2. Bare audit still reports representative schema, identity, ownership, body-section, and broken-body-link findings.
3. `--mentions` reports exact/alias, ambiguous, and frequent-term findings but no fuzzy near-match.
4. `--mention-fuzzy` and a positive `--mention-fuzzy-threshold` imply mention analysis and report fuzzy near-matches.
5. Each explicit `--only` mention code still works without `--mentions`; incompatible flag combinations fail clearly and identically in either order.
6. Bare `audit --fix` does not propose or apply mention rewrites; `--mentions --fix` and `--only unlinked-mention --fix` preserve current preview, execute, ambiguity, and safety behavior.
7. Text/JSON shapes, exit codes, targeting semantics, and all non-mention audit behavior remain compatible.
8. Canonical docs, help, changelog, and `docs/skill/SKILL.md` explain the opt-in and migration contract.
9. A built-CLI read-only benchmark against a large real-world vault records before/after wall time and content checksums. The new bare default must avoid all mention-only work and materially improve over the no-fuzzy baseline; the evidence packet must report the actual ratio rather than inventing a portable CI budget.
10. Full local CI parity passes in repository order.

Independent real-interface acceptance: **required**, interface class **CLI**. An independent tester must run the built CLI against a disposable representative vault and verify the default, `--mentions`, fuzzy opt-in, JSON, and repair-preview stories. The large-vault benchmark is read-only performance evidence, not the tester's mutation surface.

Execution placement: **local**. The implementation and ordinary test suite do not require Framework compute or persistent servers. Any generated benchmark fixture must remain disposable and local; no relocatability requirement applies.

## Architecture fingerprint

```yaml
authoritySchemaVersion: 2
outcome: Make bare bwrb audit a fast contract-integrity check while preserving mention analysis as an explicit opt-in.
shipping-surfaces:
  - id: bwrb-audit-cli-contract
    repository: 3mdistal/bwrb
    product-surface: bwrb audit text, JSON, and fix CLI behavior plus its canonical docs and agent skill
    constituency: human CLI users and automation or agents operating Markdown vaults
    durable-destination: Bowerbird mainline product and bwrb.dev command documentation
    integration-action: merge
governing-architecture: Resolve optional audit profiles once at the audit command/run boundary; keep detector and repair ownership unchanged and skip all mention-only work unless selected.
acceptance-story:
  id: audit-core-default-v1
  summary: Bare audit reports explicit vault-contract defects quickly; mention and fuzzy analyses appear only through deliberate flags while explicit legacy workflows remain available.
  required-assertions: 10 assertions in the Acceptance story section, including independent CLI acceptance.
risk-strategy:
  kind: system-ready
  production-validation-after-merge: false
```

## Shape authority envelope

```yaml
stage: shape
authority-source: "$shape this fix."
authorized-scope:
  repositories:
    - 3mdistal/bwrb
  product-surfaces:
    - bwrb audit default and explicit mention-selection contract
  outcome: Freeze an implementation-ready decision brief for the audit default-scope correction.
allowed-mutations:
  - artifact-write
write-targets:
  artifacts:
    - docs/product/audit-default-scope.md
governing-artifact:
  path: docs/product/audit-default-scope.md
  revision: shape-audit-default-scope-r1
delegation-ceiling: []
acceptance-state:
  status: pending
  summary: Shape is complete when the brief freezes the destination; no production implementation or acceptance evidence exists yet.
  blockers: []
ledger-revision: shape-audit-default-scope-r1
status: active
```

## Next steps

Work should implement the centralized option-resolution matrix, preserve the detector internals, update tests and canonical documentation, run full CI parity, benchmark the built CLI, and obtain independent CLI acceptance. Work should produce a draft pull request for maintainer review; readiness does not transfer review custody or authorize merge.

No material product question remains. Future detector optimization should be shaped separately after the default-scope correction is proven.

## Work execution record

```yaml
stage: work
authority-source: "$work"
authorized-scope:
  repositories:
    - 3mdistal/bwrb
  product-surfaces:
    - bwrb audit default and explicit mention-selection contract
  outcome: Implement and prove the frozen audit default-scope correction on a draft pull request.
allowed-mutations:
  - artifact-write
  - ephemeral-test-resource
  - branch
  - commit
  - push
  - pull-request
write-targets:
  artifacts:
    - task-owned branch files required by the frozen implementation and evidence
test-resources:
  - id: focused-vitest-vaults
    kind: file
    surface: OS temporary directories created by the focused and full Bowerbird test suites
    ownership-marker: suite-generated bwrb-* mkdtemp basenames returned to this task's test processes
    baseline: no task-created pathname exists before each mkdtemp call
    allowed-actions: [create, update, exercise, delete]
    cleanup-trigger: each test afterEach or global teardown, with final residue check before Work completion
    cleanup-method: suite-owned recursive removal of the exact returned mkdtemp path
    cleanup-proof: successful suite teardown plus absence of this run's returned paths
    shared-impact: none
    isolation: local-runtime
    ownership: task-created
    production-data: false
    customer-data: false
    cost: none
    boundary-evidence:
      - tests use mkdtemp under the operating-system temporary directory and retain the returned exact path for teardown
      - final suite teardown passed and a Land absence scan found no matching task test directories
    max-lifetime-minutes: 1440
    declared-at: 2026-08-09T00:00:00-04:00
    expires-at: 2026-08-10T00:00:00-04:00
    status: cleaned
    phase: work
  - id: independent-cli-qa-vault
    kind: file
    surface: OS temporary directory matching /tmp/bwrb-audit-qa.* plus its suite-owned transcript
    ownership-marker: .bwrb-audit-qa-owned marker containing this task revision
    baseline: no task-created pathname exists before the tester's mktemp call
    allowed-actions: [create, update, exercise, delete]
    cleanup-trigger: completion or blockage of the frozen H1-H6 CLI story
    cleanup-method: recursive removal of the exact mktemp path after the tester returns transcript evidence
    cleanup-proof: tester reports the exact path removed and root confirms it no longer exists
    shared-impact: none
    isolation: local-runtime
    ownership: task-created
    production-data: false
    customer-data: false
    cost: none
    boundary-evidence:
      - the tester may mutate only the disposable fixture it creates under the returned mktemp path
      - the repository checkout and large real-world benchmark vault remain read-only to the tester
      - both tester reports recorded exact-path removal and Land rechecked those paths as absent
    max-lifetime-minutes: 120
    declared-at: 2026-08-09T15:35:00-04:00
    expires-at: 2026-08-09T17:35:00-04:00
    status: cleaned
    phase: work
governing-artifact:
  path: docs/product/audit-default-scope.md
  revision: work-audit-default-scope-r2
architecture-fingerprint: unchanged from the Architecture fingerprint section
architecture-grounding:
  applicability: not-required
  reason: bounded local CLI selection policy with an already-evidenced command and detector boundary
  status: grounded
delegation-ceiling:
  - read-only repository inventory
acceptance-state:
  status: pending
  summary: Implementation, technical gates, benchmark, independent CLI acceptance, draft PR, and CI evidence remain pending.
  blockers: []
ledger-revision: work-audit-default-scope-r2
status: active
```

## Work verification evidence

- Focused audit profile suite: 350 tests passed, followed by the expanded
  threshold-zero slice with 8 passing profile tests.
- Full local CI parity passed in the repository-mandated order: build,
  package verification, typecheck, lint, knip, then 3,022 passing non-PTY
  tests (3 skipped).
- A read-only built-CLI benchmark against a large real-world vault more than
  halved bare-audit wall time while continuing to report core issues. Aggregate
  Markdown checksums were identical before and after.

## Frozen independent CLI acceptance story

Persona: a vault maintainer who wants a fast integrity audit and chooses prose
link advice only when useful.

Starting state: the exact committed artifact is built locally; the tester owns
a fresh disposable vault carrying the `independent-cli-qa-vault` marker.

H1. Inspect `bwrb audit --help` through the built CLI.
    Expect the default/mention distinction and all three positive selectors to
    be readable and discoverable.

H2. Run bare text and JSON audits on a fixture containing one core schema
    defect, one broken body link, one exact unlinked name, one fuzzy near-match,
    and a frequent unknown proper-noun phrase.
    Expect core findings, with neither mention issue code or prose suggestion.

H3. Run `audit --mentions` on the same fixture.
    Expect exact/alias/ambiguous and frequent-term analysis, with no fuzzy
    suggestion.

H4. Run `audit --mention-fuzzy` and a positive threshold selector.
    Expect both selectors to imply the mention profile and surface the fuzzy
    suggestion.

H5. Exercise threshold zero and conflicting positive/negative fuzzy selectors.
    Expect zero not to opt in, and conflicts to fail clearly regardless of flag
    order.

H6. Run default and explicit mention auto-fix flows on fresh disposable copies.
    Expect default auto-fix not to rewrite prose; expect explicit mention
    selection to link the trusted exact occurrence while leaving fuzzy and
    frequent-term findings untouched.

Regression checks: existing exact `--only` selectors remain sufficient;
stdout/stderr, exits, and remediation text remain legible in a real terminal.

Cleanup: remove the tester's exact disposable vault path and report proof.

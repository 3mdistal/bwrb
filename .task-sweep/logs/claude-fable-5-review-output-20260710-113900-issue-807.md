BLOCKERS

## SPEC FIDELITY

**Blocker**
1. **Unrequested scope: committed agent artifacts.** `.task-sweep/logs/claude-fable-5-plan-20260710-103418-issue-807.log`, `...-plan-output-...md`, and `...-plan-prompt-...md` are internal planning logs/prompts (including the full planning packet and repo internals) committed into the repo. Nothing in the spec or repo conventions calls for shipping these; they are accidental artifacts and should be removed before merge.

**Met**
- Windows CI lane: additive `windows_lock_tests` job (`.github/workflows/ci.yml:151-176`); does not rename required checks, Node 22 / pnpm 10.11.0 per standards.
- Deterministic real cross-process harness: `tests/ts/fixtures/lineage-lock-worker.ts` + `tests/ts/lib/lineage-lock-cross-process.test.ts` cover live-holder protection, dead-holder recovery, successor protection, 4×12 sentinel-verified stress, and artifact cleanup via real `spawn` with event handshakes.
- Disappearance classification: `DeleteTargetDisappearedError` (`src/commands/delete.ts:907-914`) thrown only from under-lock call sites (`:685`, `:868` pass `true`); initial not-found path (`classifyMissingAsDisappeared` default false) preserves the existing `ENOENT`/`IO_ERROR` contract as required.
- Docs/changelog/SKILL updated; `docs-site/.../delete.md:104-133` text and JSON exactly match implementation and the cross-process test assertions. No #820 scope creep observed.

## STANDARDS AND RISK

**Non-blocking**
1. **Bulk-path test gap.** Bulk disappearance (`handleBulkDelete`, `src/commands/delete.ts:685`) has no automated test; only single-file text and `--path` JSON flows are exercised in `lineage-lock-cross-process.test.ts`. Independent tester evidence covers it, but a regression test would lock the contract in. Also, the local `catch` bodies in `handleBulkDelete`/`deleteResolvedFile` are not visible in this diff — confirm they rethrow `DeleteTargetDisappearedError` rather than collapsing it (evidence suggests they do).
2. **Fragile
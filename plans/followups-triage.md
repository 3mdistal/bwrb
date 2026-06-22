# Follow-up Triage

> The 25 follow-up issues (#608–#655) filed while clearing the original 23-issue
> backlog (see [`execution-order.md`](execution-order.md)). This doc triages them by
> impact and proposes an order. It points at issues; it does not restate them.

**First: close [#630](https://github.com/3mdistal/bwrb/issues/630).** It was filed mid-flight during #603 but **already fixed by #107** — `createScaffoldedInstances` now files each instance in its child type's `output_dir` ([template.ts:1527](src/lib/template.ts)). Verify on `main` and close as resolved. (Not counted in the tiers below.)

---

## How these were rated

- **Impact** = does it cause wrong/lost data or block a user, vs. cosmetic/coverage.
- **Leverage** = cheap fix that unblocks a lot (e.g. CI flakes block *every* PR).
- **Cluster** = shares files/context with another item, so cheaper done together.

Two findings dominate: **#636** (silent data loss under the hierarchical-scope pattern we just shipped) and **#619** (notes silently invisible to core commands). Everything else is smaller.

---

## Tier 1 — Correctness & high-leverage (do first)

| Issue | Why it's first |
|---|---|
| [#636](https://github.com/3mdistal/bwrb/issues/636) `under()` doesn't canonicalize aliases | **Silent data loss.** Aliased context targets vanish from `under()` subtree queries — a footgun directly under the [[#554]] hierarchical-scope pattern we just shipped. Highest user impact. |
| [#619](https://github.com/3mdistal/bwrb/issues/619) nested-subdir notes invisible | Notes in nested subdirs under `output_dir` are invisible to `list`/`search`/`--fuzzy`. Core-command data invisibility — easy to lose track of real notes. |
| [#643](https://github.com/3mdistal/bwrb/issues/643) CI seed-step flake | Not user-facing, but it spuriously fails CI on essentially every PR (hit twice this run, needed manual re-runs). Cheap test-infra fix, unblocks all future velocity. Do it early. |
| [#614](https://github.com/3mdistal/bwrb/issues/614) empty-string date write↔audit gap | `new`/`edit` accept `""` for a date; `audit` then rejects it. A trust gap in the deterministic safety net — write and audit must agree. Small fix. |
| [#626](https://github.com/3mdistal/bwrb/issues/626) `schema.schema.json` `frontmatter` vs `fields` drift | The published JSON-schema disagrees with the loader, breaking anyone editing `schema.json` with a JSON LSP. Cheap, and removes a confusing footgun. |

---

## Tier 2 — Smaller bugs & polish

| Issue | Note |
|---|---|
| [#648](https://github.com/3mdistal/bwrb/issues/648) boolean/number template defaults fall through to raw-text | Real typing gap in template-default prompts; logic now isolated in one helper, so cheap. |
| [#609](https://github.com/3mdistal/bwrb/issues/609) schema "did you mean a type?" unreachable | Dead path — decide: wire `resolveSourceType` into the relevant commands, or remove it. |
| [#616](https://github.com/3mdistal/bwrb/issues/616) case-variant real-name vs alias collision | Resolution can pick an alias over a case-variant real note. Low impact; alias-cluster (see below). |
| [#641](https://github.com/3mdistal/bwrb/issues/641) audit double-reports empty/numeric date-list elements | Noise, not a slip-through. Align audit path with create/edit path (skip blanks). |
| [#620](https://github.com/3mdistal/bwrb/issues/620) `search --output content` + `--fuzzy` | Documented format silently ignored under `--fuzzy`. Implement or reject clearly. |
| [#639](https://github.com/3mdistal/bwrb/issues/639) `schema discover` unreadable-root exit code | Locked root dir reports "0 files" (exit 0) instead of exit 2. Edge case. |

---

## Tier 3 — Enhancements (capability), roughly by value

| Issue | Note |
|---|---|
| [#632](https://github.com/3mdistal/bwrb/issues/632) cross-type recurrence name collisions | A wart on a *documented* [[#107]] feature ("finish draft → spawn review") — successor reuses the predecessor name across types, tripping audit. Higher than the rest of this tier. |
| [#652](https://github.com/3mdistal/bwrb/issues/652) audit body wikilink/link validation | Completes the other half of #510 (broken `[[wikilinks]]`/relative links in bodies). Audit-body cluster with #653. |
| [#634](https://github.com/3mdistal/bwrb/issues/634) `under()` parent-map cache + arg validation | Perf (avoid full-vault re-parse per query) + flag a non-relation field arg. **Cluster with #636** (same operator). |
| [#617](https://github.com/3mdistal/bwrb/issues/617) dup-alias severity + `illegal-aliases` auto-fix | Consistency + a safe auto-fix. Alias cluster. |
| [#622](https://github.com/3mdistal/bwrb/issues/622) `unlinked-mention` configurable threshold + interactive ambiguous resolution | Quality-of-life on the centerpiece detection. |
| [#624](https://github.com/3mdistal/bwrb/issues/624) `frequent-unlinked-term` non-ASCII coverage | Broaden word-start to Unicode uppercase. Small, advisory-only. |
| [#628](https://github.com/3mdistal/bwrb/issues/628) `schema list fields` provenance | Show inherited/trait origin in the flat field list. |
| [#637](https://github.com/3mdistal/bwrb/issues/637) render context hierarchy as a tree | Onboarding aid for the hierarchical-scope pattern. |
| [#655](https://github.com/3mdistal/bwrb/issues/655) `file.*` sort keys + `recent --open/--save-as` | Adds `file.mtime`/`ctime` sort to `list` (lets `recent` become a thin alias) + parity flags. |

---

## Tier 4 — Tech-debt / chores (opportunistic — do when already in the file)

| Issue | Note |
|---|---|
| [#608](https://github.com/3mdistal/bwrb/issues/608) dedupe `findCloseMatches`/`findClosestMatch` | Now that `levenshteinDistance` is shared, the higher-level close-match helpers are the next consolidation. Cluster with #609 (same schema close-match area). |
| [#650](https://github.com/3mdistal/bwrb/issues/650) `formatMigrationResult` unreachable | Decide: wire into `migrate` dry-run preview (genuinely useful) or remove as dead code. |
| [#646](https://github.com/3mdistal/bwrb/issues/646) two `buildParentMap` functions | Rename for clarity (`...FromFiles` vs `...FromSchema`). |
| [#653](https://github.com/3mdistal/bwrb/issues/653) consolidate body-heading-presence logic | `edit`'s `addMissingSections` vs audit's `missing-body-section` fix duplicate the check. Cluster with #652. |

---

## Suggested clusters (cheaper done together)

- **`under()` operator** — [#636](https://github.com/3mdistal/bwrb/issues/636) + [#634](https://github.com/3mdistal/bwrb/issues/634): both edit `src/lib/expression.ts`/`query.ts`. Do #636 (alias canonicalization) and #634 (cache + arg validation) in one pass.
- **Alias semantics** — [#636](https://github.com/3mdistal/bwrb/issues/636), [#616](https://github.com/3mdistal/bwrb/issues/616), [#617](https://github.com/3mdistal/bwrb/issues/617): alias resolution + alias audit. Shared mental model.
- **Schema close-match** — [#608](https://github.com/3mdistal/bwrb/issues/608) + [#609](https://github.com/3mdistal/bwrb/issues/609): same `findCloseMatches`/`resolveSourceType` code in `schema.ts`.
- **Audit body** — [#652](https://github.com/3mdistal/bwrb/issues/652) + [#653](https://github.com/3mdistal/bwrb/issues/653): body-link validation + the heading-presence helper consolidation.
- **list/recent** — [#655](https://github.com/3mdistal/bwrb/issues/655) builds on the `list-helpers.ts` extracted in #597.

---

## Summary

```
Close now:  #630 (already fixed by #107)
Tier 1:     #636  #619  #643  #614  #626        (correctness + high-leverage)
Tier 2:     #648  #609  #616  #641  #620  #639  (smaller bugs / polish)
Tier 3:     #632  #652  #634  #617  #622  #624  #628  #637  #655   (enhancements)
Tier 4:     #608  #650  #646  #653               (tech-debt, opportunistic)
```

If picking only a handful: **#636, #619, #643** are the three that most repay the effort —
the first two stop silent data loss in shipped features, the third stops CI from crying wolf.

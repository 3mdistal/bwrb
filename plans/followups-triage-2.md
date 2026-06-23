# Follow-up Triage — Wave 2

> The 17 follow-ups (#659–#697) filed while clearing the Wave-1 triage
> ([`followups-triage.md`](followups-triage.md), now all merged). Same tiering:
> impact → leverage → clusters. Points at issues; doesn't restate them.

---

## Tier 1 — Correctness (data loss / wrong output on valid vaults)

| Issue | Why it's first |
|---|---|
| [#683](https://github.com/3mdistal/bwrb/issues/683) `invalid-list-element` blank-removal uses stale indices | **Data loss.** On a non-alias list with 2+ blank entries, `audit --fix` can delete the WRONG (distinct) element. #617 dodged it for alias fields; the underlying bug still bites any list field. Narrow trigger, but silent destruction = top priority. Fix: reverse-index / filter-by-value removal. |
| [#661](https://github.com/3mdistal/bwrb/issues/661) audit flags legitimately-owned notes as `wrong-directory` | Audit cries wolf on a **correct** vault: an owned note in its owner's `<owner>/<field>/` dir is flagged. Erodes trust in the safety net. Fix: exempt correctly-placed owned notes from the wrong-directory check. |
| [#675](https://github.com/3mdistal/bwrb/issues/675) `search --body` filters on deprecated `--path-glob`, ignores `--path` | Silent wrong results: `search <q> --body --path <glob>` doesn't actually filter. Small fix (switch to canonical `options.path`), real impact. |
| [#664](https://github.com/3mdistal/bwrb/issues/664) empty optional number flags `wrong-scalar-type` instead of unset | The #614 rule (empty optional = unset) wasn't applied to numbers. Trivial, restores cross-type consistency. |

---

## Tier 2 — Smaller bugs & polish

| Issue | Note |
|---|---|
| [#659](https://github.com/3mdistal/bwrb/issues/659) `isChildOf`/`isDescendantOf` don't canonicalize aliased `parent` values | Sibling of #636 (which fixed `under()`). Same silent-miss class; lower impact (people usually write `parent` canonically). Reuse `buildVaultAliasMap`. |
| [#662](https://github.com/3mdistal/bwrb/issues/662) `open <name> print` outputs nothing for nested-subdir notes (non-interactive) | Surfaced by #619 making nested notes discoverable; `open` print path doesn't resolve them. |
| [#676](https://github.com/3mdistal/bwrb/issues/676) `search --fuzzy` silently ignores `--open`/`--edit` | Same silent-ignore class as #620. Wire them in or reject clearly. |
| [#689](https://github.com/3mdistal/bwrb/issues/689) `file.*` keys accepted in `--fields` but render empty | From #655. Either render the stat value in `--fields` or reject it there (allowed only in `--sort`). |

---

## Tier 3 — Enhancements

| Issue | Note |
|---|---|
| [#668](https://github.com/3mdistal/bwrb/issues/668) template default editing single-selects a multiple-select field | Real gap: a template can only set ONE default value for a `multiple` select. Wire the multiselect prompt into template modes. |
| [#697](https://github.com/3mdistal/bwrb/issues/697) `edit` add-sections doesn't recurse into children of present parents | edit↔audit disagreement (audit flags the missing nested child, edit won't add it). Completes the #653 consolidation's intent. |
| [#694](https://github.com/3mdistal/bwrb/issues/694) migration diff doesn't auto-detect field renames | A rename surfaces as add+remove, so the `rename-field` preview path (and the #650 docs example) never fires from real CLI. Implement rename detection, or correct the docs. |
| [#670](https://github.com/3mdistal/bwrb/issues/670) extend unknown-type "did you mean?" to `template` + case-only mismatches | Completeness on #609: `template` commands still give bare unknown-type errors; case-only typos (`TASK`) get no hint. |
| [#679](https://github.com/3mdistal/bwrb/issues/679) cross-type recurrence successor name template | #632 made cross-type successors unique via a numeric suffix; a `recurrence` name template (`Review: {name}`) would be nicer than `Chapter One 2`. |
| [#673](https://github.com/3mdistal/bwrb/issues/673) auto-fix (quote) numeric date-list elements per-element | From #641: a valid numeric date-list element is flag-only because the whole-field fixer would collapse the array. Per-element quoting makes it auto-fixable. **Cluster with #683** (same list-element fix path). |

---

## Tier 4 — Tech-debt / prevention

| Issue | Note |
|---|---|
| [#666](https://github.com/3mdistal/bwrb/issues/666) generate the published JSON Schema from Zod | **Highest-leverage chore.** Two hand-maintained schema files + Zod keep re-drifting (this caused #626, and #693). Generating the JSON Schema (or the docs-site copy) from a single source eliminates the whole class. |
| [#693](https://github.com/3mdistal/bwrb/issues/693) tighten knip ignore for `src/lib/migration/*.ts` | The blanket ignore hid #650's dead code. Scope it to specific exports so future dead helpers get caught. |
| [#691](https://github.com/3mdistal/bwrb/issues/691) `levenshteinDistance` two-row rolling buffer | Pure perf; allocates full O(n·m) matrix. Low priority — only matters under `search --fuzzy`/audit body scans on long strings. |

---

## Suggested clusters (cheaper done together)

- **List-element fix path** — [#683](https://github.com/3mdistal/bwrb/issues/683) + [#673](https://github.com/3mdistal/bwrb/issues/673): both edit the `invalid-list-element` fixer (`audit/fix.ts`). Fix the stale-index removal and add per-element numeric quoting in one pass.
- **search flags** — [#675](https://github.com/3mdistal/bwrb/issues/675) + [#676](https://github.com/3mdistal/bwrb/issues/676): both in `src/commands/search.ts`.
- **schema drift prevention** — [#666](https://github.com/3mdistal/bwrb/issues/666) + [#693](https://github.com/3mdistal/bwrb/issues/693): the "stop hand-maintained artifacts from rotting" theme.
- **template prompts/suggestions** — [#668](https://github.com/3mdistal/bwrb/issues/668) + [#670](https://github.com/3mdistal/bwrb/issues/670): template command UX.
- **alias-aware hierarchy** — [#659](https://github.com/3mdistal/bwrb/issues/659): reuses #636's `buildVaultAliasMap`.

---

## Summary

```
Tier 1:  #683  #661  #675  #664        (data loss / wrong output on valid vaults)
Tier 2:  #659  #662  #676  #689        (smaller bugs / polish)
Tier 3:  #668  #697  #694  #670  #679  #673   (enhancements)
Tier 4:  #666  #693  #691               (tech-debt / prevention)
```

If picking a few: **#683** (stops silent data loss), **#661** (stops audit false-flagging correct vaults), and **#666** (kills the schema-drift class that keeps generating issues).

# Execution Order

> The single "what next, and why this order" view across every open issue.
> This doc **points** at the feature briefs — it does not restate their designs.
> When in doubt, the brief is the source of truth; this file only sequences.

Briefs:
- [`features/ingest-safety-net.md`](features/ingest-safety-net.md) — deterministic safety net under the agent
- [`features/schema-expressiveness.md`](features/schema-expressiveness.md) — richer schema = better agent + tighter web
- [`features/task-system.md`](features/task-system.md) — event-driven recurrence + offset templating

---

## The dependency spine

```
aliases (#266) ──┬─→ ingest safety net  (search/audit pieces)
                 └─→ schema-expressiveness #1
traits (#442) ─────→ task-system recurrence
date-expr-in-values (#603) ─→ task-system (recurrence + multi-spawn)
under operator (#602) ─→ hierarchical scope (#554)
```

Two keystones unlock most of the tree: **aliases** (#266) and **traits** (#442).
Everything else is either downstream of those or standalone hygiene.

---

## Phase 0 — Hygiene that protects the safety net (do first, cheap)

The whole direction rests on "audit is a *trustworthy* deterministic safety net."
These are correctness gaps in the date/audit machinery that quietly undermine that trust,
plus the doc/cleanup debt. None are blocked by anything.

- **#592** — `bwrb new` stores unnormalized dates (fails its own audit). Self-contradiction; fix before leaning on audit harder.
- **#593** — list/multiple date fields skip per-element date validation. Same trust gap; also matters once date-offset (#603) lands.
- **#604** — dedupe `levenshteinDistance` into a shared util. Trivial, and a prerequisite for `search --fuzzy`. (Incidental cleanup called out in [ingest-safety-net.md](features/ingest-safety-net.md).)
- **#599** — clean up stale `AGENTS.md` (enum refs, architecture tree).
- **#605** — reconcile `vision.md` + `roadmap.md` with the product-direction review.

---

## Phase 1 — Aliases keystone

- **#266** — aliases as a first-class field *role* (+ Obsidian aliases validation).

See [schema-expressiveness.md §1](features/schema-expressiveness.md) and [ingest-safety-net.md §1](features/ingest-safety-net.md).
This is the shared #1 priority of both briefs — a *role* bwrb understands, not a convention, so
linking, `search --fuzzy`, and `unlinked-mention` all consult it uniformly. Unblocks Phase 2.

---

## Phase 2 — Ingest safety net (the end goal: "nothing swept under the rug")

Built on aliases. Order within the phase = the compose order from the brief.

- **#93** — `search --fuzzy` (scored lookup; reuses deduped Levenshtein from #604).
- **#600** — `audit: unlinked-mention` (centerpiece; exact/alias → auto-fix, fuzzy → flag).
- **#601** — `audit: frequent-unlinked-term` (open-world nudge; advisory, thresholded).
- **#87** — daily-note sweep/reviewed field convention (coverage bookkeeping).

See [ingest-safety-net.md "How the pieces compose"](features/ingest-safety-net.md).

---

## Phase 3 — Traits keystone

- **#442** — schema traits for reusable field bundles.

See [schema-expressiveness.md §2](features/schema-expressiveness.md).
Composition (*also-has*) alongside inheritance (*is-a*). Reuse `schema list` to render trait-composed
fields. Unblocks the recurrence config in Phase 4.

---

## Phase 4 — Task system

Needs traits (#442) for the `recurring` trait, and date-expressions for both mechanisms.

- **#603** — evaluate date expressions in template values (offsets). Shared substrate: wires the existing `date-expression.ts` engine into template value generation. Powers both recurrence's field-offset and multi-spawn's staggered deadlines.
- **#107** — event-driven recurrence (spawn-on-transition) + offset multi-spawn templating.

See [task-system.md](features/task-system.md). Build #603 first — #107's two mechanisms both depend on it.
The audit backstop (missing-successor) is a new detection, sibling to `unlinked-mention`.

---

## Phase 5 — Hierarchical scope

Independent of the task system; design is settled. Can run in parallel with Phase 3–4 if desired.

- **#602** — `under` query operator (dereference a relation, walk the *target's* ancestor chain).
- **#554** — hierarchical scope / contexts-as-real-notes (collapses `scope` + `context` into one tree).

See [schema-expressiveness.md §3](features/schema-expressiveness.md). #602 is the one new primitive #554 needs.

---

## Phase 6 — Schema discovery

Cheap, useful for onboarding, lowest urgency.

- **#97** — `schema discover`: deterministic field-usage report (descriptive facts, not prescriptive audit).

See [schema-expressiveness.md §4](features/schema-expressiveness.md).

---

## Opportunistic — touch when you're already in the file

Not sequenced; fold into whichever phase lands you in the relevant code.

- **#598** — consolidate the repeated handler scaffold in `audit/fix.ts` → during Phase 2/4 audit work.
- **#597** — extract sort/tree helpers out of `list.ts` into a tested lib module.
- **#596** — consolidate duplicated field-prompt logic across new/template flows → during Phase 4 templating.
- **#595** — unify null handling in migration change-preview formatter.
- **#500** — `audit --fix`: optimize repeated backlink scans for delete safety → during Phase 2 audit work.

---

## Backlog — real but unscheduled

- **#510** — Markdown body validation in audit (feature, p4).
- **#68** — `bwrb recent/history` command (feature, p4).

---

## Summary table

| Phase | Theme | Issues | Gated by |
|---|---|---|---|
| 0 | Hygiene / trust | #592, #593, #604, #599, #605 | — |
| 1 | Aliases keystone | #266 | — |
| 2 | Ingest safety net | #93, #600, #601, #87 | #266 (#604) |
| 3 | Traits keystone | #442 | — |
| 4 | Task system | #603, #107 | #442 |
| 5 | Hierarchical scope | #602, #554 | — |
| 6 | Schema discovery | #97 | — |
| ~ | Opportunistic | #598, #597, #596, #595, #500 | in-file |
| ~ | Backlog | #510, #68 | — |

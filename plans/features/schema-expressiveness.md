# Schema Expressiveness

> Make the schema richer so the agent uses it correctly and the vault stays a web.
> The schema is the shared language; investing here pays off everywhere.

---

## Why this cluster

The AI brainstorm (see `ingest-safety-net.md`) concluded that **schema-as-language** is the real multiplier: schema *descriptions* (shipped v0.1.9) already make an AI agent use types correctly with no extra plumbing. So the highest-ROI investment isn't AI features — it's making the schema more expressive. Every bit of richness improves the agent's extraction for free, and deterministic audit enforces it.

Four threads, in build order.

---

## 1. Aliases — first-class field *role* (from #266)

**Status today:** no alias concept exists. Every `alias` reference in `src/` is wikilink *display* aliases (`[[Target|Alias]]`), command aliases, or doc comments. Nothing in `schema.schema.json`.

**Decision:** aliases are a **recognized field role** bwrb understands (like `owned` is today) — *not* a loose convention — so linking, `search --fuzzy`, and `audit: unlinked-mention` all consult them uniformly. Conventions drift and break the deterministic guarantee.

Two parts:
1. The alias **role** — the load-bearing new thing; unblocks the entire ingest safety net.
2. Obsidian-format **validation** (array, no dupes, no empty strings) — the original #266 ask; comes nearly free once aliases are modeled.

**Priority: #1** — it's a dependency of the AI safety-net work.

---

## 2. Traits — composition alongside inheritance (#442)

`extends` is *is-a* (inheritance); **traits** are *also-has* (composition). Recurring field bundles — status, due/review dates, scope, rating — are exactly the cross-cutting pattern inheritance models badly.

```json
{
  "traits": {
    "actionable": { "fields": { "status": {…}, "due": {…} } }
  },
  "types": { "task": { "extends": "objective", "traits": ["actionable"] } }
}
```

- High value, moderate effort, low conceptual risk.
- Hard parts (named in #442): collision/precedence rules must be deterministic and documented; resolved-schema must be visible. **Reuse `schema list`** — it already renders *inherited* fields; extend it to render *trait-composed* fields.
- Purest expression of schema-as-language: define a pattern once, the agent applies it consistently.

**Priority: #2.**

---

## 3. Hierarchical scope — contexts as real notes + `under` join (#554)

**Keep this one.** (Tagged `ralph:intent:brainstorm`; this is the brainstorm outcome.)

### The problem it solves
Notes today carry two redundant fields — a `scope` select (life domain) and a `context` relation (project) — where the domain is derivable from the context. The redundancy is a double-entry maintenance problem: move PKM from software-dev to personal and you fix the PKM entity *and* bulk-update every note. There are also no transitive queries ("everything in the career domain") without keeping the redundant field or OR-ing every leaf.

### Correction to an earlier claim
`isDescendantOf` does **not** already solve this. It walks the *filtered note's own* `parent` chain (e.g. task → milestone → objective). The context lives in a *field*, not the note's structural parent, so the existing functions can't reach it. The transitive-query pain is genuinely unsolved.

### The design (decided)
Contexts/domains are **real entity notes** in a `parent` hierarchy. A "domain" (career) is just a root node; a project (Builder) is a child.

```yaml
# contexts/career.md        →  parent: null
# contexts/Builder.md       →  parent: "[[career]]"
# a task                    →  context: "[[Builder]]"   (only the leaf; domain derivable)
```

Query at any altitude:
- `context = [[Builder]]` — exact
- `context under [[career]]` — Builder, Vercel, Job Search, anything deeper

### The one new primitive
A `under` operator that **dereferences a relation field, then walks the *target's* ancestor chain** — distinct from `isDescendantOf` (which walks the current note's own chain). Generalizes to *any* relation field, not just context.

### The bonus
This **collapses scope + context into one concept**: a single tree of context notes, queried at any level. Two fields → one field → zero redundancy — without inventing a new "tree" field type (just `parent`, which entities already have, plus `under`). Because contexts are real notes, they also get aliases, `unlinked-mention` coverage, and existing relation-source audit validation. Everything reinforces.

**Why entities not labels:** contexts are mixed — some are rich (Betson, Builder: own content, backlinks, graph presence), some are basically labels (PKM, Job Search). Modeling them all as notes keeps the rich ones first-class and the labels cost almost nothing.

**Priority: #3** — design is settled; build after aliases + traits.

---

## 4. `schema discover` — deterministic field-usage facts (reframe of #97)

Same move as ingest: "AI suggests a schema" is redundant (the agent does that well). The deterministic kernel survives: bwrb reports **frontmatter facts** over a folder — every field that appears, frequency, value-type consistency, which files diverge.

**Works in two roles:**
- **Before a schema exists** → onboarding: raw material for designing types.
- **After a schema exists** → drift detection: fields used but undefined, defined-but-unused, values diverging from declared options.

**Clean line vs `audit`:** discover is **descriptive** (facts, no judgment, never passes/fails); audit is **prescriptive** (what's wrong vs the schema). Safe to run anytime. Could be its own mode or fold into #188 (`bwrb init`).

**Priority: #4** — cheap, useful for onboarding, lower urgency than the rest.

---

## Build order
aliases → traits → hierarchical scope → `schema discover`.

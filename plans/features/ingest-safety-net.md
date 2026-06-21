# Ingest as a Deterministic Safety Net

> bwrb is the deterministic safety net *under* the AI agent, not a parallel agent.
>
> Supersedes `ai-ingest.md` and `agentic-workflows.md` (both to be archived).

---

## Context: why the old plans are dead

`ai-ingest.md` and `agentic-workflows.md` were both designed in a **pre-agentic world**, where bwrb itself had to become the LLM caller (embed an OpenRouter client, a model-pricing table, prompt/workflow storage, cost tracking, confidence scoring).

That assumption is now invalid. In daily use, bwrb is driven *through* an AI harness (Claude Code, Codex, etc.) that already does extraction, multi-step orchestration, and cost accounting better than a baked-in Haiku call ever would.

- **`agentic-workflows.md` → killed outright.** It reinvents the agent harness. No payoff.
- **`ai-ingest.md` → killed as an LLM command, but its *kernel* survives** as the deterministic primitives below.

The LLM-calling, confidence-UI, and approval-flow parts are redundant. What's *not* redundant is everything bwrb can guarantee **deterministically**, so the human doesn't have to trust that the AI didn't miss something.

---

## The actual end goal

Ramble daily notes — journal, write, whatever — every day, and **know nothing gets swept under the rug**. Two guarantees underneath that:

1. **Coverage** — everything I rambled actually got looked at.
2. **Web integrity** — every mention of a known name links to the right entity; the vault stays a connected graph, not islands.

Extraction is just the means, and extraction is the part the harness already does well.

---

## The organizing reframe: closed-world vs open-world

| | Who | How |
|---|---|---|
| **Open-world discovery** — "is there a new task/idea/person buried in this ramble?" Unbounded, needs judgment. | **The agent**, via prompting | fuzzy, LLM |
| **Closed-world verification** — "of the entities I *already know*, are they all linked everywhere they're mentioned?" Bounded, no false positives. | **bwrb** | deterministic |

bwrb's job is the closed-world half (plus a cheap heuristic nudge toward the open-world half). The agent's loop becomes:

```
ramble → agent extracts → agent asks bwrb "does this exist?" (search --fuzzy)
       → agent writes conformant notes → bwrb audit proves nothing is orphaned
```

This also leans on the **schema-as-shared-language** insight: schema *descriptions* (shipped v0.1.9) already make the agent use types correctly. The highest-ROI investment is making the schema more expressive, not AI plumbing — every bit of schema richness improves the agent's extraction for free, and the deterministic audit enforces it.

---

## The pieces (all deterministic, all AI-agnostic)

| Piece | Type | Trust model |
|---|---|---|
| Entity `aliases` field | schema (net-new) | substrate — makes the rest trustworthy |
| `search --fuzzy` | new search flag | agent/human decides; reuses existing Levenshtein |
| `audit: unlinked-mention` | new audit detection | **exact/alias → `--fix --auto`; fuzzy → flag only** |
| `audit: frequent-unlinked-term` | new audit detection | flag only, thresholded, advisory |
| daily-note sweep field | schema convention | coverage bookkeeping |

### 1. Entity `aliases` — net-new substrate
There is **no alias concept in bwrb today.** Every `alias` reference in `src/` is wikilink *display* aliases (`[[Target|Alias]]`), command aliases, or doc comments. Nothing in `schema.schema.json` defines it. Aliases are load-bearing for everything else ("Steve" / "Steve Yegge" / "stevey" → one entity). Relates to dormant issue #266 (Obsidian aliases validation).

### 2. `search --fuzzy` — the lookup primitive
Returns scored candidates so the agent can check "does X already exist?" before writing. **Low effort:** `levenshteinDistance` already exists in the codebase — implemented *twice* (`src/lib/schema.ts:835`, `src/lib/validation.ts:400`). Incidental cleanup: extract into one shared util.

### 3. `audit: unlinked-mention` — the web-integrity guarantee (centerpiece)
bwrb knows every note and (with #1) every alias. It scans note bodies for the literal name of a known entity that appears as plain text but isn't wikilinked, and flags it. Two tiers:
- **Exact name or registered alias** present, not linked → trusted, auto-fixable.
- **Fuzzy near-match** ("Steve Yeg" ≈ `[[Steve Yegge]]`) → review item with "did you mean?", **never auto-linked.**

Ambiguity ("Mercury" = planet/element/Freddie) is never auto-resolved — it becomes a visible review item, which *is* the "nothing swept under the rug" behavior.

### 4. `audit: frequent-unlinked-term` — open-world nudge
Attacks the real failure mode: *the AI forgets to link because it doesn't know the entity exists.* Surfaces things mentioned a lot that have no note yet ("you might want notes for these 6 things"). **Honest caveat:** discovering an unknown "thing" in prose without an LLM is inherently heuristic (repeated capitalized n-grams, proper-noun-ish phrases, threshold e.g. ≥4 mentions across ≥2 notes). That's noisy — *fine here* because it's advisory-only and never acts. Gate behind a threshold; iterate on the heuristic over time.

### 5. daily-note sweep field — coverage
Almost no new code: a frontmatter convention on the existing `daily-note` type (e.g. `reviewed` / `ai-process-stage`) plus a `list --where` query / saved dashboard. The risk (agent forgetting to stamp it) is prompting discipline, not a bwrb feature.

---

## How the pieces compose
1. `search --fuzzy` → prevents the miss (agent checks before writing).
2. `unlinked-mention` → backstop for entities that exist but got missed (closed-world).
3. `frequent-unlinked-term` → surfaces entities that should exist but don't yet (open-world).

(3) creates the entity that should exist → (2) keeps it wired up forever after. Complete deterministic safety net, zero LLM calls.

---

## Trust line (decided)
Trust **exact matches** for auto-action; **flag fuzziness** for review. Never auto-resolve ambiguity.

---

## Follow-up actions (not yet done)
- [ ] Archive `plans/features/agentic-workflows.md` (killed).
- [ ] Archive / supersede `plans/features/ai-ingest.md` (kernel migrated here).
- [ ] Reframe the open "Phase 6 ingest" issues rather than blank-closing them:
  - #93 (entity matching) → becomes `search --fuzzy` + `unlinked-mention`.
  - #96 (AI extraction via OpenRouter/Anthropic), #94 (ingest skeleton), #91 (approval flow), #81 (`--auto`/thresholds), #89 (Phase 6 umbrella) → close as superseded (LLM-in-bwrb is dead).
  - #87 (`ai-process-stage` field) → shrinks to the daily-note sweep convention (#5).
  - #103 (schema migration hooks for re-indexing) → re-evaluate; only relevant if re-sweeping is needed.
  - New issues: entity `aliases` field, `search --fuzzy`, `audit: unlinked-mention`, `audit: frequent-unlinked-term`.
  - Incidental: dedupe `levenshteinDistance` into a shared util.

# Does BWRB already give agents enough information to form safe, bounded queries?

## Answer

**Shaped decision:** BWRB already has the right semantic home for query intent: the vault schema, plus reusable dashboards for curated query mechanics. It does **not** need a second schema-level `query-intent` language now. But the current surface is not yet sufficient for an agent to know that an executed, bounded query returned a faithful slice of a larger match set.

The gap is narrower and more mechanical:

1. finish the typed-query validation contract so every referenced field in a typed `--where` expression is actually validated; and
2. add an **opt-in query receipt mode** that reports the resolved selectors and result cardinality (`matched`, `returned`, `limited`/`truncated`) while leaving the legacy raw-array JSON output unchanged.

This is not a claim that every query needs ceremony. Ordinary `list --output json` should remain a raw array for compatibility and direct row consumption. But **the raw array is not the best complete design for bounded agent retrieval**: once `--limit` is present, array length alone is ambiguous. The best design is two explicit contracts—raw rows when the caller asks only for rows, and an opt-in receipt when the caller needs to prove scope and completeness. The receipt is a small lantern, not a new moon.

**Priority decision from shaping:** both gaps should be fixed. Incomplete typed-field validation is a correctness defect because invalid queries can look like valid empty results. Missing limited-result cardinality is an agent-safety defect because partial results can look complete.

## Evidence

### 1. The shipped schema can already explain what to query

The schema model supports descriptions at the three semantic levels an agent needs:

- a type description says what the type is for and when to use it;
- a field description says what the field is for and when to use it; and
- a select option can be either a legacy bare value or `{ value, description }`, where the description explains what the option means or when to choose it. The object form is explicitly additive so existing schemas remain valid. ([`src/types/schema.ts`](../src/types/schema.ts#L72-L85), [`src/types/schema.ts`](../src/types/schema.ts#L119-L135), [`src/types/schema.ts`](../src/types/schema.ts#L430-L437))

Descriptions survive field inheritance and subtype overrides, so the effective type view can carry inherited meaning rather than forcing an agent to reconstruct it from raw ancestors. ([`tests/ts/lib/schema-descriptions.test.ts`](../tests/ts/lib/schema-descriptions.test.ts#L73-L108))

`schema list type <type> --output json` returns the type description, resolved own/trait/inherited fields, prompt type, allowed options (including option descriptions), relation source, defaults, and other selected field properties. ([`src/commands/schema/helpers/output.ts`](../src/commands/schema/helpers/output.ts#L52-L127), [`src/commands/schema/helpers/output.ts`](../src/commands/schema/helpers/output.ts#L161-L196)) The verbose all-type JSON view uses the same field formatter. ([`src/commands/schema/helpers/output.ts`](../src/commands/schema/helpers/output.ts#L750-L851)) Canonical docs explicitly present this as the self-documenting agent discovery path. ([`docs-site/src/content/docs/reference/commands/schema.md`](../docs-site/src/content/docs/reference/commands/schema.md#L58-L67))

Documentation coverage is enforceable, but opt-in: `audit --check-schema-docs` reports types and own fields that lack descriptions and deliberately skips inherited duplicates and static identity fields. ([`src/lib/audit/schema-docs.ts`](../src/lib/audit/schema-docs.ts#L1-L53), [`src/commands/audit.ts`](../src/commands/audit.ts#L214-L221))

**Limit of this evidence:** descriptions are optional. The coverage audit does not require descriptions on individual select options. Also, the type-detail/verbose JSON formatter omits some raw field properties that can matter to query construction, including `multiple` and `filter`; `schema list fields --output json` does expose the full raw `definition` with origin, but an agent must know to use that second surface. ([`src/commands/schema/helpers/output.ts`](../src/commands/schema/helpers/output.ts#L161-L196), [`src/commands/schema/list.ts`](../src/commands/schema/list.ts#L240-L275)) The self-documenting surface is therefore capable, but not uniformly complete from one recommended call.

### 2. The query language and type boundary already prevent several unsafe mistakes

The canonical targeting model says selectors compose by intersection and recommends `--type` as the boundary that enables strict `--where` validation. It documents comparison, boolean, hierarchy, and relation-dereferencing semantics, including the important difference between `isDescendantOf(...)` and `under(field, ...)`. ([`docs-site/src/content/docs/reference/targeting.md`](../docs-site/src/content/docs/reference/targeting.md#L6-L25), [`docs-site/src/content/docs/reference/targeting.md`](../docs-site/src/content/docs/reference/targeting.md#L48-L91))

At runtime, typed equality/inequality and `contains(...)` comparisons reject unknown fields and invalid select values with allowed values and spelling suggestions. `under(...)` separately verifies that its first argument exists and is relation-typed. ([`src/lib/expression-validation.ts`](../src/lib/expression-validation.ts#L66-L166), [`src/lib/expression-validation.ts`](../src/lib/expression-validation.ts#L274-L356), [`tests/ts/lib/expression-validation.test.ts`](../tests/ts/lib/expression-validation.test.ts#L295-L364)) The 0.3.0 fixture build directly rejected both `status == 'settledd'` (suggesting `settled`) and `statsu == 'raw'` (suggesting `status`).

`under()` is not merely documented aspiration: its relation-field validation was a tracked follow-up to the original operator, and alias-related silent omissions were treated as a correctness bug rather than acceptable best effort. ([issue #602](https://github.com/3mdistal/bwrb/issues/602), [issue #634](https://github.com/3mdistal/bwrb/issues/634), [issue #636](https://github.com/3mdistal/bwrb/issues/636))

**Limit of this evidence:** the shipped validator does not actually validate every field reference, despite the broad “strict validation” language in the canonical targeting docs. Its comparison extractor covers only `==`, `!=`, `contains`, `hasTag`, and the special `under` path. ([`src/lib/expression-validation.ts`](../src/lib/expression-validation.ts#L66-L117), [`src/lib/expression-validation.ts`](../src/lib/expression-validation.ts#L168-L225)) Direct 0.3.0 probes showed that both of these typed misspellings exited `0` with `[]`:

```bash
bwrb list --type idea --where "statsu < 3" --output json
bwrb list --type idea --where "startsWith(statsu, 'r')" --output json
```

That is a real correctness/ergonomics defect, not a reason to invent query intent metadata. An agent can currently mistake “invalid field reference” for “valid query, no matches.”

### 3. The observed limited JSON is intentional behavior, not a regression

Normal filtered `list --output json` is explicitly a legacy raw array. `list --count --output json` is a separate raw `{ "count": number }` shape. Existing shapes are a compatibility contract and must not be wrapped merely for uniformity. ([`docs/product/cli-output-contract.md`](../docs/product/cli-output-contract.md#L22-L39), [`docs-site/src/content/docs/automation/json-mode.md`](../docs-site/src/content/docs/automation/json-mode.md#L35-L75))

Implementation calculates the full `matchCount`, returns it only when `--count` is selected, then applies `--limit` before serializing rows. The normal JSON branch emits only the row array; each row always carries `_path`, `_name`, and a revision of the exact bytes observed, even when `--fields` projects the frontmatter. ([`src/commands/list.ts`](../src/commands/list.ts#L875-L895), [`src/commands/list.ts`](../src/commands/list.ts#L942-L998)) Tests pin all three behaviors: raw array, limited array length, and count-before-limit. ([`tests/ts/commands/list.test.ts`](../tests/ts/commands/list.test.ts#L151-L166), [`tests/ts/commands/list.test.ts`](../tests/ts/commands/list.test.ts#L396-L443))

The feature's originating issue asked for `--limit` to restrict output and `--count` to provide the count as a distinct operation; it did not specify combined row-plus-cardinality metadata. ([issue #520](https://github.com/3mdistal/bwrb/issues/520))

Therefore Alice's observed “one projected record with a revision, while a separate count says 27” is:

- **not a bug** relative to the documented and tested 0.3.0 contract;
- **intentional compatibility behavior** at the output-shape level; and
- **an agent-ergonomics gap** because the limited response alone cannot distinguish “exactly one match” from “the first of 27 matches.”

The row revision solves a different problem: it proves which bytes were read for a later guarded edit. It says nothing about query completeness. ([`docs-site/src/content/docs/reference/commands/list.md`](../docs-site/src/content/docs/reference/commands/list.md#L82-L89))

#### Is the intentional raw-array behavior the best design?

Not by itself. It was a reasonable design for the original compatibility goal: a homogeneous array is easy to pipe through `jq`, existing consumers already parse it, and an unbounded array is self-counting. The design becomes insufficient when the command itself applies a bound, because `length == 1` cannot distinguish one total match from one returned row out of 27.

The obvious alternatives are worse than an opt-in receipt:

- **Always wrap the array:** complete, but breaks the established machine contract.
- **Wrap only when `--limit` is present:** makes the top-level JSON shape depend on an otherwise orthogonal modifier and breaks limited-query consumers.
- **Repeat count metadata on every row:** wasteful, semantically awkward, and cannot describe an empty result.
- **Put metadata on stderr:** separates rows from metadata, but produces a fragile two-channel machine contract.
- **Require a separate `--count` call:** compatible, but introduces an extra round trip and the count and fetch may observe different vault states.

An explicitly requested receipt is therefore the best current design direction: it makes the richer contract deliberate while preserving the raw-array contract exactly for existing callers.

### 4. Dashboards help with reusable mechanics, but they do not document intent or execution completeness

Dashboards are stored, validated saved `list` queries. They preserve type, path, where clauses, body search, output, projection, limit, count, and sort. ([`src/types/schema.ts`](../src/types/schema.ts#L981-L1020), [`src/commands/list.ts`](../src/commands/list.ts#L741-L755)) Running one resolves targets through the same targeting module and delegates to the same `listObjects` output path, so a limited JSON dashboard has the same missing cardinality signal. ([`src/commands/dashboard.ts`](../src/commands/dashboard.ts#L128-L166))

`dashboard list --output json` does make the complete saved definitions inspectable. ([`src/commands/dashboard.ts`](../src/commands/dashboard.ts#L287-L311)) But a dashboard has no description, rationale, expected cardinality, or “safe for” field. ([`src/types/schema.ts`](../src/types/schema.ts#L985-L1010)) It is useful as a curated query example and stable alias, not yet a query-intent contract or an execution receipt.

### 5. Agent guidance encourages bounded retrieval, but it currently requires two calls to prove completeness

The maintained agent skill tells agents to inspect the schema first, use `--where` rather than fetch everything, project fields, and use `--limit` or `--count`. ([`docs/skill/SKILL.md`](../docs/skill/SKILL.md#L83-L104), [`docs/skill/SKILL.md`](../docs/skill/SKILL.md#L270-L315), [`docs/skill/SKILL.md`](../docs/skill/SKILL.md#L631-L639)) That is sound discipline. It does not say that a limited raw array carries no total count or prescribe a count-then-fetch protocol when completeness matters.

The docs already use a richer receipt-like JSON contract where the workflow demands it: detailed body-match mode reports `totalMatches` and `truncated`. ([`docs-site/src/content/docs/automation/json-mode.md`](../docs-site/src/content/docs/automation/json-mode.md#L35-L47)) This is precedent for an opt-in query receipt, not precedent for changing ordinary list JSON.

## Inferences

1. **Query formation and query verification are separate contracts.** Schema metadata answers “which type, field, and value represent this intent?” A receipt answers “what selectors did BWRB apply, how many records matched, and is this response complete?” Adding more prose to the schema cannot answer the second question.

2. **A new query-intent DSL would duplicate the agent's job.** The product boundary says BWRB remains the deterministic layer beneath an AI agent, while `list` remains the canonical read surface. ([`docs/product/roadmap.md`](../docs/product/roadmap.md#L29-L45)) Natural-language interpretation belongs above BWRB; deterministic validation and reporting belong inside it.

3. **Saved dashboards are the right place for curated query examples, but only after their semantics are made inspectable enough.** A dashboard can keep a known-good filter stable. A future description could say what it is for, but it still would not prove the completeness of a particular run.

4. **The highest-risk current failure is false emptiness, not ambiguous intent.** A typo in an unvalidated expression shape can produce `[]` with success, and a limited result can look complete. Both mislead the agent about data coverage after intent has already been chosen.

## Uncertainties

1. There is no primary-repo evidence yet about how often real agents misconstruct a query after reading a well-described schema versus how often they merely misread a limited result. The recent behavior establishes one concrete receipt gap, not its frequency across workloads.

2. The best public name and exact output shape for a receipt remain product choices. `--explain`, `--receipt`, and an explicit receipt-oriented JSON output mode imply different expectations. This research settles the capability boundary, not the final flag spelling.

3. It is unresolved whether dashboard descriptions are valuable enough to add now. They would improve discovery among multiple saved queries, but they should not be bundled as a prerequisite for execution receipts.

4. A complete field-reference validator must define how to treat dynamic or nested access without breaking the documented permissive no-`--type` mode. The recommendation is strict only when a type is present, matching the existing public contract.

## Recommendation

### Decision: strengthen the existing layers; do not add a new query-intent layer

Park two near-term work packets, in this order, while the surrounding product direction continues through shape:

#### Work item A — Make typed query validation honest and complete

- With `--type`, walk the complete expression AST and reject every unknown frontmatter field reference, including relational/numeric comparisons and function arguments such as `startsWith(statsu, ...)`.
- Preserve permissive cross-type behavior when `--type` is absent.
- Keep the existing select-option and `under()` checks.
- Add regression tests for misspelled fields under every supported operator/function family.
- Reconcile the canonical “strict validation” docs with the shipped behavior.

This is the first fix: it closes a correctness gap before adding a nicer report about it.

#### Work item B — Add an explicit, compatibility-safe query receipt

Add an opt-in mode for normal `list` and saved-dashboard execution. It should leave existing raw-array and `{ count }` outputs byte-shape compatible when the flag is absent. The receipt contract should include, at minimum:

```json
{
  "query": {
    "type": "task",
    "path": null,
    "where": ["status == 'in-progress'"],
    "body": null,
    "sort": "deadline",
    "desc": false,
    "limit": 1,
    "fields": ["status", "deadline"]
  },
  "matched": 27,
  "returned": 1,
  "truncated": true,
  "data": ["...ordinary projected rows..."]
}
```

Contract requirements:

- `matched` is computed before limit; `returned` is the emitted row count.
- `truncated` is equivalent to `returned < matched` for ordinary bounded list results.
- The receipt echoes normalized/applied selectors, not the agent's natural-language rationale.
- Dashboard runs identify the dashboard name and saved definition alongside the applied query.
- Empty results distinguish a valid zero-match query from validation failure via exit status and the receipt.
- The existing revision remains per row and retains its current meaning.
- Ordinary `list --output json`, `list --count --output json`, and dashboard JSON remain unchanged unless the receipt is explicitly requested.

The final CLI spelling should be chosen during `/work` from two compatibility-safe forms:

1. **Preferred:** an explicit receipt flag valid only with JSON (for example, `--receipt`), returning the receipt plus `data` in one execution.
2. **Fallback:** a separate explain/receipt-only mode that returns the applied query and match count without rows. This is simpler but preserves the current two-call cost and cannot prove that a later row fetch saw the same vault state.

Do not put receipt metadata on stderr and do not silently wrap the default array. Both would make a clean machine contract murkier.

### Compatibility fallback for older BWRB versions

Update the agent skill to prescribe:

1. inspect the effective type schema;
2. include `--type` for strict validation;
3. run the exact query with `--count --output json` when coverage matters;
4. then run the same query with explicit `--fields`, `--sort`, and `--limit`;
5. never infer completeness from raw array length when `--limit` is present.

This is coherent and compatible for versions without receipts, but it cannot guarantee that the count and fetch observed the same vault state.

## Sources

- [`src/types/schema.ts`](../src/types/schema.ts) — schema descriptions, select-option metadata, dashboard definition
- [`src/commands/schema/list.ts`](../src/commands/schema/list.ts) and [`src/commands/schema/helpers/output.ts`](../src/commands/schema/helpers/output.ts) — shipped schema introspection shapes
- [`src/lib/expression-validation.ts`](../src/lib/expression-validation.ts), [`src/lib/where-targeting.ts`](../src/lib/where-targeting.ts), and [`src/lib/query.ts`](../src/lib/query.ts) — typed validation and query evaluation
- [`src/commands/list.ts`](../src/commands/list.ts) — list projection, count, limit, revision, and JSON behavior
- [`src/commands/dashboard.ts`](../src/commands/dashboard.ts) and [`src/lib/dashboard.ts`](../src/lib/dashboard.ts) — saved-query execution and persistence
- [`docs-site/src/content/docs/reference/targeting.md`](../docs-site/src/content/docs/reference/targeting.md), [`docs-site/src/content/docs/reference/commands/list.md`](../docs-site/src/content/docs/reference/commands/list.md), and [`docs-site/src/content/docs/automation/json-mode.md`](../docs-site/src/content/docs/automation/json-mode.md) — canonical user-facing query and JSON contracts
- [`docs/skill/SKILL.md`](../docs/skill/SKILL.md) — maintained agent usage guidance
- [`docs/product/cli-output-contract.md`](../docs/product/cli-output-contract.md) and [`docs/product/roadmap.md`](../docs/product/roadmap.md) — compatibility and product-boundary constraints
- [`tests/ts/commands/list.test.ts`](../tests/ts/commands/list.test.ts), [`tests/ts/lib/expression-validation.test.ts`](../tests/ts/lib/expression-validation.test.ts), and [`tests/ts/lib/schema-descriptions.test.ts`](../tests/ts/lib/schema-descriptions.test.ts) — pinned behavior
- [issue #520](https://github.com/3mdistal/bwrb/issues/520), [issue #602](https://github.com/3mdistal/bwrb/issues/602), [issue #634](https://github.com/3mdistal/bwrb/issues/634), and [issue #636](https://github.com/3mdistal/bwrb/issues/636) — primary issue history

## Handoff

**Output:** the decision is implemented on `codex/query-receipts-strict-validation`: typed queries validate all referenced fields, while `list` and named dashboards offer an explicit JSON-only `--receipt` without changing legacy output shapes.

**Next:** verify and land the implementation. The two-call protocol remains a compatibility fallback for older versions, not the destination.

# Canonical Documentation Policy

> Source-of-truth policy for documentation in this repository.

---

## Decision

- `docs-site/src/content/docs/` is the canonical source for user-facing CLI behavior and semantics.
- `docs/product/` is for rationale, tradeoffs, planning, and internal implementation notes.

This policy is authoritative for documentation placement and conflict resolution.

---

## Scope Boundaries

### Docs-site (`docs-site/src/content/docs/`)

Use docs-site for normative, user-facing guidance, including:

- Command behavior and flag semantics
- Output behavior users/scripts rely on
- Workflows, how-tos, and reference pages

If a contributor asks, "What does the CLI do?" the canonical answer belongs in docs-site.

### Product Docs (`docs/product/`)

Use product docs for internal context, including:

- Why decisions were made
- Design constraints and tradeoffs
- Product direction, roadmap intent, and implementation rationale

If a contributor asks, "Why did we choose this?" the answer belongs in `docs/product/`.

---

## Precedence and Conflicts

When statements conflict:

1. For user-facing CLI behavior, docs-site wins.
2. `docs/product/` must link to docs-site instead of restating behavior contracts.
3. If uncertainty remains, clarify docs rather than changing runtime behavior in this policy issue.

---

## Link vs Mirror Rules

Default rule: **summary + link**, not full mirroring.

- In `docs/product/`, include a short rationale note and link to canonical docs-site pages for behavior.
- In docs-site, include short summaries that link to deeper product rationale when useful.
- Avoid keeping two full behavior specs in both trees.

Mirroring full content is an exception and should be temporary, explicit, and removed once links are in place.

---

## Change Protocol

When a PR changes CLI behavior/semantics:

1. Update canonical docs-site pages in the same PR.
2. Update related `docs/product/` rationale only as needed.
3. In `docs/product/`, link to docs-site for behavior details (do not duplicate contracts).

When a PR changes rationale only:

1. Update `docs/product/`.
2. Add or adjust docs-site summary links only if user-facing context changed.

---

## Quick Routing Examples

- `--dry-run` semantics or safety flag behavior -> docs-site concept/reference pages
- JSON output shape users should consume -> docs-site automation/reference pages
- Why `audit --fix` is conservative -> `docs/product/audit-fix-policy.md`
- Product philosophy and prioritization -> `docs/product/vision.md`, `docs/product/roadmap.md`

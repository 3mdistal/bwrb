---
title: Docs Taxonomy and Naming
description: Conventions for concept boundaries, naming, and duplicate prevention
---

This page defines how to add docs without creating near-duplicates.

## Taxonomy at a glance

| Area | Purpose | Primary content | Avoid |
| --- | --- | --- | --- |
| Concepts (`/concepts/`) | Explain stable mental models and invariants | Why a behavior exists, how to think about it | Exhaustive option tables |
| Reference (`/reference/`) | Define exact command/flag/schema behavior | Syntax, options, contracts, edge cases | Re-teaching full concept narratives |
| Product (`/product/`) | Team-facing direction and governance | Vision, roadmap, docs governance | User-facing command semantics |

Rule of thumb: concepts explain meaning, reference defines mechanics, product defines governance.

## Concepts vs reference boundaries

- Put a page in **Concepts** when the main value is a reusable mental model.
- Put a page in **Reference** when the main value is exhaustive command/flag/property details.
- Cross-link both ways when a concept and reference page touch the same area.

Example boundary:

- `concepts/cli-safety-and-flags` explains the safety model and semantics for `--execute`, `--dry-run`, and `--force`.
- `reference/commands/*` pages should link to that concept instead of re-documenting the same semantics in full.

## Split vs consolidate

Default to **consolidate**.

Create a new concepts page only when the topic introduces a distinct mental model with distinct invariants.

Consolidate into an existing concepts page when:

- The proposed page would define the same key terms as an existing page.
- The same examples or caveats would be repeated.
- The difference is mostly wording (for example, adding "and flags" to an existing CLI safety concept).

Canonical page rule: one concept gets one canonical page. Extend it with sections and heading anchors instead of creating sibling pages that overlap.

## Slug, path, and file naming conventions

- Use kebab-case file names.
- Keep slugs aligned with file path (for example `concepts/validation-and-audit`).
- Use concise noun-phrase slugs for concepts.
- Avoid near-synonym variants that represent the same concept.
- Use `and` in a slug only when both nouns are inseparable in practice (for example `types-and-inheritance`).

## Title conventions

- Concepts and product pages use concise Title Case (for example `CLI Safety and Flags`).
- Command reference pages keep the command form `bwrb <command>` (for example `bwrb audit`).
- Non-command reference pages use descriptive Title Case (for example `Schema Reference`, `Targeting Model`).

These conventions match the current docs corpus and should be treated as canonical for new pages.

## Search before adding checklist

Before creating a new page, complete this checklist:

1. Check sidebar slugs in `docs-site/astro.config.mjs` for an existing destination.
2. Search title/slug keywords across docs:

```bash
rg -n "<proposed title|slug keywords>" docs-site/src/content/docs
```

3. Review nearby pages in the same area (`concepts`, `reference`, or `product`) for overlap.
4. If overlap exists, extend the canonical page instead of creating a new page.
5. If a rename/consolidation is required, add a redirect in `docs-site/astro.config.mjs`.

Pass criteria: no existing page covers the same invariant, and the new page has a clearly different reader question than existing pages.

## Repository examples

- Good: `concepts/cli-safety-and-flags` is the canonical semantics page for safety flags; command refs should link to it.
- Good: `reference/commands/schema` consolidates subcommand behavior behind one command page and anchor sections.
- Avoid: creating a second concepts page that restates CLI safety semantics with a slightly different title.

## Non-goals for this convention

- No broad rename sweep of existing docs.
- No IA redesign beyond adding governance guidance.
- No behavior/spec changes to CLI semantics.

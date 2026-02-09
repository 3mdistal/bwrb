---
title: Documentation Policy
description: Where canonical docs live and how to cross-link
---

This page explains where to document behavior vs rationale in the Bowerbird repo.

## Canonical source

- User-facing CLI behavior is canonical in docs-site (`docs-site/src/content/docs/`) and published at `https://bwrb.dev`.
- Product rationale and internal design notes live in `docs/product/`.

## Practical rule

- Behavior contracts: document in docs-site.
- Internal rationale: document in `docs/product/` and link to docs-site for behavior details.
- Prefer summary + link over duplicating full behavior specs.

For the full policy, see [`docs/product/canonical-docs-policy.md`](https://github.com/3mdistal/bwrb/blob/main/docs/product/canonical-docs-policy.md).

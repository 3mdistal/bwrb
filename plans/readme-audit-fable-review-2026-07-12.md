# Fable review of the README audit

Model requested: `claude-fable-5` via local Claude Code  
Finish state: completed successfully  
Source reviewed: `plans/readme-audit-2026-07-12.md` and its repository evidence

## Verdict

Fable agreed with the central diagnosis: the README's main problem is scope and
orientation rather than widespread factual drift. It approved the recommended
audience order and information architecture, with four material amendments.

## Must incorporate

1. **Treat the README as the npm landing page.** `package.json` includes
   `README.md` in the published package. This largely resolves the audience
   question in favor of prospective and installing users.
2. **Use absolute public links.** Public documentation links in the rewrite
   should point to `https://bwrb.dev` or absolute GitHub URLs so they work from
   npm as well as GitHub.
3. **Name the source-install bug.** `cd ~/Developer/bwrb` is a personal path,
   not a runnable contributor instruction. Source setup should begin with a
   portable clone instruction.
4. **Reframe the duplication claim.** The canonical-docs policy explicitly
   scopes its boundary to `docs-site/` and `docs/product/`; the more exact claim
   is that the README contradicts its own declaration of the docs site as canon
   by mirroring extensive behavior contracts.

## Additional recommendations

- Surface deterministic guardrails for agent-authored vaults in the opening;
  this is a distinctive part of the product vision, while Bowerbird itself does
  not call an LLM.
- Make the capability map account for `dashboard`, `recent`, `bulk`, and
  `config`, with a full-command-reference escape hatch.
- Prefer linking to the canonical Quick Start over embedding another schema,
  because the generated `init --yes` schema must currently be replaced before
  the documented example flow.
- Remove the hand-maintained repository tree rather than shortening it.
- Avoid hardcoded release versions in README prose, and consider linking to the
  changelog.

## Proposed acceptance criteria

- `npm install -g bwrb` is the first installation command.
- Source setup appears only under Contributing and uses a portable clone path.
- All public links are absolute and resolve from the npm rendering context.
- Every shown command is verified copy-paste runnable, or the README links to
  the canonical Quick Start instead of duplicating its schema.
- Detailed schema, template, picker, app-mode, and completion contracts are
  replaced by short summaries and canonical links.
- The hand-curated source tree is removed.
- The contributor section links `AGENTS.md` and the exact CI-parity workflow.
- The opening states the type-safety promise, product boundaries, and the
  deterministic agent-guardrail use case.
- No hardcoded current package version appears in prose.
- `pnpm docs:lint`, `pnpm docs:doctor`, and `pnpm docs:check` pass.

## Verification note

Fable reported 36 Markdown headings rather than the audit's original 31.
Independent counting outside fenced code blocks confirmed 36, so the audit was
corrected.

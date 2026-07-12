# README audit

## Question

Does the repository README accurately orient a new user to Bowerbird's current
value, installation path, command surface, and canonical documentation—and what
should change, if anything?

## Answer

The README is mostly accurate, but it is not doing the README job cleanly. It
opens with a generic category description, omits the normal package installation
path, and then expands into a 641-line second user manual. That conflicts with
the repository's own documentation policy and makes the product's strongest
idea—type safety for Markdown notes—harder to see than its feature inventory.

This should be a focused rewrite rather than a factual patch. The target is a
short front door for prospective users and contributors, with detailed behavior
routed to `bwrb.dev`. Because `README.md` ships in the npm package, this is also
the package's npm landing page; prospective and installing users are therefore
the primary audience, not merely one possible audience.

## Evidence

### 1. Critical: the public installation path is missing

The README's Installation section offers only a source checkout and development
mode ([README](../README.md#installation)). The canonical installation guide
leads with `npm install -g bwrb` and also documents `pnpm add -g bwrb`
([installation guide](../docs-site/src/content/docs/getting-started/installation.md)).
The package is currently published as `bwrb@0.2.4`, matching the repository
version in [`package.json`](../package.json).

**Recommendation:** make `npm install -g bwrb` the primary path, keep pnpm as an
alternative, and move source installation into a contributor section.

### 2. High: the opening undersells the product's distinct promise

"Schema-driven note management for markdown vaults" is accurate, but broad
([README](../README.md#bwrb)). The product vision supplies a clearer distinction:
"the type system for your notes," with schema enforcement as the core and PKM
features around it ([product vision](../docs/product/vision.md#what-is-bowerbird)).
The README's first concrete explanation is an eight-item capability list, so a
reader learns what it has before learning why it exists.

**Recommendation:** lead with the type-safety promise and a two- or three-sentence
boundary: Markdown stays the source of truth; Bowerbird creates, validates,
queries, and migrates notes against a schema; it is not a note editor, database,
sync service, or LLM. One sentence should surface its distinctive role as a set
of deterministic guardrails beneath the agents that author a vault.

### 3. High: the README contradicts its own declaration of canonical docs

The README declares the docs site canonical near the top
([README](../README.md#documentation-policy)), but then reproduces detailed
behavior contracts for schema fields, body sections, templates, instance
scaffolding, query resolution, picker modes, and shell completion. Repository
policy reinforces "summary + link, not full mirroring" and warns against parallel
full behavior specs across the two documentation trees it governs
([canonical policy](../docs/product/canonical-docs-policy.md#link-vs-mirror-rules)).

This duplication carries drift risk and obscures navigation. The 641-line README
contains 36 Markdown headings outside fenced examples, while the docs site has
dedicated getting started, schema, template, list, completion, and
command-reference pages.

**Recommendation:** retain only:

- the product promise and boundaries;
- prerequisites and package installation;
- one five-minute path from `init` to creating and listing a note;
- a compact capability/command map linking to canonical pages;
- contributor setup and quality-check links;
- pre-release status and roadmap link.

Move or remove the detailed schema reference, template specification, instance
edge cases, picker semantics, completion inventory, and duplicated `list`
examples. Those belong on `bwrb.dev`.

Public documentation links should be absolute `https://bwrb.dev` or GitHub URLs,
not repository-relative links, so they resolve from both GitHub and npm.

### 4. Medium: the quick path does not demonstrate the payoff

Setup stops after `bwrb init --yes` and sends the reader elsewhere for a runnable
schema ([README](../README.md#setup)). The following Usage block begins with eight
lines about vault-resolution precedence, then ranges across templates, querying,
forks, and lineage adoption ([README](../README.md#usage)). That is reference
material, not a first-success narrative.

**Recommendation:** show a tiny end-to-end sequence whose commands are guaranteed
by the generated starter vault: install, `bwrb init --yes`, inspect or create a
starter type, create one note, list it, and audit it. If `init --yes` does not
currently create a schema that supports that exact flow, link directly to the
canonical Quick Start rather than inventing a partial example.

### 5. Medium: contributor material is mixed into user documentation

Generated-schema warnings, the repository tree, test commands, and docs-site
development are legitimate contributor information
([README](../README.md#schema-validation), [README](../README.md#file-structure),
[README](../README.md#running-tests)). They arrive after hundreds of lines of
user reference material and do not form a clear contributor path.

**Recommendation:** consolidate them under a short Contributing section that
points to `AGENTS.md`, the exact CI workflow or documented parity commands, and
the docs-site contributor README. Avoid maintaining a hand-curated partial source
tree; it goes stale without helping a new contributor navigate the architecture.

The current source-install example also begins with the personal path
`~/Developer/bwrb`, which is not a portable instruction. Contributor setup should
show a clone command and repository-relative steps.

### 6. Low: naming and information hierarchy can be tightened

The pronunciation note is personable and worth keeping. The separate
Documentation policy section, however, is repository governance presented before
the product overview. Readers need the product and first action before the rules
for where maintainers write docs.

**Recommendation:** keep a prominent Documentation link near the top, but move
the policy link into Contributing. Use "Bowerbird" in prose and `bwrb` for the
binary consistently.

## Verified facts

- Repository and npm package versions both report `0.2.4`.
- The runtime prerequisite is Node.js 22 or newer.
- Current root help exposes 14 top-level commands, including `recent` and
  `lineage`; `search` and `open` remain hidden compatibility commands.
- `validate_schema.sh` and the generated `schema.schema.json` both exist.
- `pnpm docs:lint`, `pnpm docs:doctor`, and `pnpm docs:check` pass on the current
  checkout.

These checks support the conclusion that the dominant problem is scope and
orientation, not widespread factual decay.

## Inferences

- The README grew by accreting release-specific documentation parity updates.
  Its individual sections are often careful and current, but their combined
  shape is no longer coherent.
- A shorter README will reduce maintenance cost only if the rewrite replaces
  removed contracts with direct canonical links. Deleting detail without routing
  readers would merely exchange duplication for a scavenger hunt.
- The useful audience order is: prospective user, installing user, returning
  user seeking docs, then contributor. The npm rendering context settles this
  more firmly than repository taste alone.

## Uncertainties

- Whether badges, screenshots, or a terminal recording are desired. None is
  necessary to fix the current structural problem.
- The exact minimal schema/example to embed should be verified against a fresh
  `bwrb init --yes` vault during implementation.

## Recommendation

Rewrite the README around this structure:

1. Name, pronunciation, one-line type-safety promise, and pre-release warning.
2. Three short "why Bowerbird" bullets and explicit product boundaries.
3. Install from npm, verify with `bwrb --version`.
4. Five-minute quick start with one visible success.
5. Compact capability map: create/edit, find/open, schema/audit/migrate,
   templates, automation/lineage—each linked to canonical docs.
6. Documentation and roadmap links.
7. Short contributor section with source setup and CI-parity pointer.

## Acceptance criteria

- `npm install -g bwrb` is the first installation command shown.
- Source installation appears only under Contributing and uses a portable clone
  path, not `~/Developer/bwrb`.
- Public links are absolute and resolve from the npm README context.
- Every shown command is verified copy-paste runnable. If a fresh
  `bwrb init --yes` vault cannot support the complete embedded example, link to
  the canonical Quick Start rather than duplicating its schema.
- Detailed behavior-contract tables and specs for schemas, templates, picker and
  app modes, and completion are replaced with summaries plus canonical links.
- The hand-curated repository tree is removed.
- The capability map covers the full command surface directly or via a full
  command-reference link, including `recent`, `bulk`, `dashboard`, and `config`.
- The opening states the type-safety promise, clear product boundaries, and the
  deterministic agent-guardrail use case.
- No current package version is hardcoded in prose.
- The contributor section points to `AGENTS.md` and the repository's exact local
  CI-parity sequence.
- `pnpm docs:lint`, `pnpm docs:doctor`, and `pnpm docs:check` pass.

Aim for roughly 150–250 lines. Treat that as a design constraint, not a sacred
number: enough room to sing, not enough to become the whole aviary.

## Sources

- [`README.md`](../README.md)
- [`package.json`](../package.json)
- [`src/index.ts`](../src/index.ts)
- [Canonical documentation policy](../docs/product/canonical-docs-policy.md)
- [Product vision](../docs/product/vision.md)
- [Installation guide](../docs-site/src/content/docs/getting-started/installation.md)
- [Quick Start](../docs-site/src/content/docs/getting-started/quick-start.md)

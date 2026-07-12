# Bowerbird (`bwrb`)

Short for **Bowerbird**, pronounced "birb."

**The type system for your notes.** Bowerbird is a CLI that creates, validates, queries, and migrates Markdown notes against a schema. Your files remain plain Markdown; Bowerbird supplies the guardrails.

It is especially useful beneath AI agents that write to a vault: the agent can work quickly while deterministic commands enforce structure, find notes, and catch drift. Bowerbird does not call an LLM or require an account, cloud, or database.

> [!WARNING]
> Bowerbird is pre-release software. The CLI is usable, but its schema format and command surface may change before v1.0. Follow the [roadmap](https://bwrb.dev/product/roadmap/) for current direction.

## Why Bowerbird?

- **Schema enforcement for Markdown.** Define types, inherited fields, relations, templates, and body structure without surrendering your files to an app.
- **Safe evolution.** Audit existing notes, preview repairs, and migrate schemas explicitly as your vault changes.
- **One deterministic CLI.** Create, edit, find, open, and batch-update notes interactively or through machine-readable automation.

Bowerbird is not a note editor, sync service, database, CMS, or version-control system. Use the tools you already like for those jobs; Bowerbird keeps the notes they touch structurally sound.

## Install

Bowerbird requires Node.js 22 or newer.

```sh
npm install -g bwrb
bwrb --version
```

Or install it with pnpm:

```sh
pnpm add -g bwrb
```

See the full [installation guide](https://bwrb.dev/getting-started/installation/) for shell completion, upgrades, and troubleshooting.

## Create your first vault

```sh
mkdir my-vault
cd my-vault
bwrb init --yes
bwrb --vault . --non-interactive schema new type idea --directory Ideas --output json
bwrb --vault . --non-interactive new idea --json '{"name":"First idea"}'
bwrb --vault . list --type idea --output json
```

This creates `.bwrb/schema.json`, adds an `idea` type, writes `Ideas/First idea.md`, and lists the result as JSON. The schema is the source of truth for the vault's types and fields.

Continue with the [five-minute Quick Start](https://bwrb.dev/getting-started/quick-start/) to define prompted fields and audit your first notes.

Once a vault has a schema, everyday commands look like this:

```sh
bwrb new idea
bwrb list --type idea
bwrb edit "My Idea"
bwrb audit
```

Run `bwrb --help` or `<command> --help` to inspect the installed command surface. Use `--vault /path/to/vault` from outside a vault, or let Bowerbird discover the nearest `.bwrb/schema.json` from your current directory.

## What you can do

| Goal | Commands | Documentation |
| --- | --- | --- |
| Create and edit typed notes | `new`, `edit`, `delete` | [Creating notes](https://bwrb.dev/reference/commands/new/) |
| Find, inspect, and open notes | `list`, `recent` | [Finding notes](https://bwrb.dev/reference/commands/list/) |
| Define and evolve types | `schema` | [Schema reference](https://bwrb.dev/reference/schema/) |
| Detect and repair drift | `audit`, `bulk` | [Auditing](https://bwrb.dev/reference/commands/audit/) |
| Reuse note structures | `template` | [Templates](https://bwrb.dev/templates/overview/) |
| Preserve document ancestry | `lineage`, `new --fork` | [Lineage](https://github.com/3mdistal/bwrb/blob/main/docs-site/src/content/docs/reference/commands/lineage.md) |
| Save repeatable queries | `dashboard` | [Dashboards](https://bwrb.dev/reference/commands/dashboard/) |
| Configure and automate vaults | `config`, `--non-interactive`, JSON modes | [JSON automation](https://bwrb.dev/automation/json-mode/) |

The complete user documentation lives at [bwrb.dev](https://bwrb.dev/). User-facing CLI behavior is canonical there; product rationale and plans live in [`docs/product`](https://github.com/3mdistal/bwrb/tree/main/docs/product).

## Core model

Each vault contains a version 2 schema at `.bwrb/schema.json`. Types live in a flat map and can extend one parent type. Fields may be static, prompted, derived from vault relations, or constrained to select options. Templates add reusable defaults, bodies, and related-note scaffolding.

Markdown remains the source of truth. Bowerbird refuses invalid writes through its CLI, while `bwrb audit` finds drift introduced by external editors or agents. Schema migrations make structural changes explicit and reviewable.

For the complete contracts, use the canonical guides:

- [Types and inheritance](https://bwrb.dev/concepts/types-and-inheritance/)
- [Schema concepts](https://bwrb.dev/concepts/schema/)
- [Templates](https://bwrb.dev/templates/overview/)
- [Schema migrations](https://bwrb.dev/concepts/migrations/)
- [Targeting notes and vaults](https://bwrb.dev/reference/targeting/)
- [Getting started](https://bwrb.dev/getting-started/introduction/)

## Contributing

Clone the repository and install the pinned pnpm version's dependencies:

```sh
git clone https://github.com/3mdistal/bwrb.git
cd bwrb
corepack enable
pnpm install
pnpm build
```

Run the CLI from source with `pnpm dev -- <command>`. Before pushing code, run the repository's CI-parity checks in this exact order:

```sh
pnpm build
pnpm verify:pack
pnpm typecheck
pnpm lint
pnpm knip
pnpm test -- --exclude='**/*.pty.test.ts'
```

Contributor and architecture guidance lives in [`AGENTS.md`](https://github.com/3mdistal/bwrb/blob/main/AGENTS.md). Documentation work should also follow the [canonical documentation policy](https://github.com/3mdistal/bwrb/blob/main/docs/product/canonical-docs-policy.md).

## Project links

- [Documentation](https://bwrb.dev/)
- [Changelog](https://bwrb.dev/changelog/)
- [Roadmap](https://bwrb.dev/product/roadmap/)
- [Issues](https://github.com/3mdistal/bwrb/issues)
- [MIT License](https://github.com/3mdistal/bwrb/blob/main/LICENSE)

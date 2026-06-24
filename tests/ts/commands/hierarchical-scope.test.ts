import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

/**
 * Guard test for #554 — "Hierarchical scope / contexts as notes".
 *
 * Proves the DECIDED design end-to-end through the real CLI, with NO new field
 * type: contexts/domains are modelled as ordinary entity notes in a `parent`
 * hierarchy, tasks carry only the LEAF `context` relation, and the life-domain
 * is derivable by walking up the tree via the `under` operator (#602).
 *
 * The point of the test is to lock in that the enabling primitives that already
 * shipped (entity types with a self-referential `parent` relation + the `under`
 * operator + relation-source audit validation) compose into the pattern, so the
 * redundant `scope` select field is unnecessary.
 */
describe('#554 hierarchical scope — contexts as notes + under()', () => {
  let vaultDir: string;

  // A `context` entity type with a self-referential `parent` relation is all the
  // schema needs. No "tree" field type, no `scope` select.
  const SCHEMA = {
    version: 2,
    types: {
      entity: {
        output_dir: 'Entities',
        fields: { type: { value: 'entity' } },
        field_order: ['type'],
      },
      // Contexts/domains are real notes. `career` (root) and `Builder`,
      // `Vercel`, `PKM` (descendants) are all the same type; the hierarchy is
      // expressed purely through `parent`.
      context: {
        extends: 'entity',
        output_dir: 'Contexts',
        recursive: true,
        fields: {
          type: { value: 'context' },
          // Self-referential parent relation — entities already support this.
          parent: { prompt: 'relation', source: 'context' },
          aliases: { prompt: 'list', alias: true, list_format: 'yaml-array', default: [] },
        },
        field_order: ['type', 'parent', 'aliases'],
      },
      task: {
        output_dir: 'Tasks',
        fields: {
          type: { value: 'task' },
          status: {
            prompt: 'select',
            options: ['backlog', 'active', 'done'],
            default: 'backlog',
            required: true,
          },
          // The leaf context only — the domain is DERIVABLE, so no `scope`.
          context: { prompt: 'relation', source: 'context' },
        },
        field_order: ['type', 'status', 'context'],
      },
    },
    audit: { ignored_directories: [] },
  };

  const writeNote = async (rel: string, frontmatter: string[]) => {
    const path = join(vaultDir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, ['---', ...frontmatter, '---', ''].join('\n'));
  };

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-554-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(SCHEMA, null, 2)
    );

    // Context tree:
    //   career (domain / root)
    //     └── Builder (project)
    //           └── Vercel (sub-project)
    //   software-dev (domain / root)
    //     └── PKM (project)
    await writeNote('Contexts/career.md', ['type: context']);
    await writeNote('Contexts/Builder.md', ['type: context', 'parent: "[[career]]"']);
    await writeNote('Contexts/Vercel.md', ['type: context', 'parent: "[[Builder]]"']);
    await writeNote('Contexts/software-dev.md', ['type: context']);
    await writeNote('Contexts/PKM.md', ['type: context', 'parent: "[[software-dev]]"']);

    // Tasks carry ONLY the leaf context — never a redundant `scope`.
    await writeNote('Tasks/Blog for Builder.md', [
      'type: task',
      'status: active',
      'context: "[[Builder]]"',
    ]);
    await writeNote('Tasks/Vercel migration.md', [
      'type: task',
      'status: active',
      'context: "[[Vercel]]"',
    ]);
    await writeNote('Tasks/Tag career directly.md', [
      'type: task',
      'status: active',
      'context: "[[career]]"',
    ]);
    await writeNote('Tasks/Reorganize PKM.md', [
      'type: task',
      'status: backlog',
      'context: "[[PKM]]"',
    ]);
  });

  afterAll(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('queries an ENTIRE DOMAIN at any altitude with under(context, ...)', async () => {
    // career domain = Builder (depth 1) + Vercel (depth 2) + career itself.
    // PKM lives under software-dev, so it must be excluded.
    const result = await runCLI(
      ['list', 'task', '--where', "under(context, '[[career]]')", '--output', 'paths'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Blog for Builder.md');
    expect(result.stdout).toContain('Vercel migration.md');
    expect(result.stdout).toContain('Tag career directly.md');
    expect(result.stdout).not.toContain('Reorganize PKM.md');
  });

  it('queries a mid-tree project subtree — under(context, [[Builder]])', async () => {
    const result = await runCLI(
      ['list', 'task', '--where', "under(context, '[[Builder]]')", '--output', 'paths'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    // Builder itself + Vercel beneath it.
    expect(result.stdout).toContain('Blog for Builder.md');
    expect(result.stdout).toContain('Vercel migration.md');
    // career is the PARENT of Builder, not under it.
    expect(result.stdout).not.toContain('Tag career directly.md');
    expect(result.stdout).not.toContain('Reorganize PKM.md');
  });

  it('still supports an EXACT leaf match — context = [[Vercel]]', async () => {
    const result = await runCLI(
      ['list', 'task', '--where', "context == '[[Vercel]]'", '--output', 'paths'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Vercel migration.md');
    expect(result.stdout).not.toContain('Blog for Builder.md');
    expect(result.stdout).not.toContain('Tag career directly.md');
  });

  it('derives the domain from the leaf — a separate `scope` field is unnecessary', async () => {
    // The Vercel task records ONLY `context: [[Vercel]]`. Without any `scope`
    // field, it is still reachable from its domain (career) purely by walking
    // the context tree. This is the scope+context collapse in action.
    const domainQuery = await runCLI(
      ['list', 'task', '--where', "under(context, '[[career]]')", '--output', 'paths'],
      vaultDir
    );
    expect(domainQuery.stdout).toContain('Vercel migration.md');

    // The other domain is cleanly partitioned by the same mechanism.
    const otherDomain = await runCLI(
      ['list', 'task', '--where', "under(context, '[[software-dev]]')", '--output', 'paths'],
      vaultDir
    );
    expect(otherDomain.stdout).toContain('Reorganize PKM.md');
    expect(otherDomain.stdout).not.toContain('Vercel migration.md');
  }, 30000);

  it('contexts are real notes — relation-source audit validates the context tree', async () => {
    // A task pointing at a non-existent context note must be flagged by audit,
    // exactly like any other broken relation. This is the "contexts get
    // validation for free" property.
    await writeNote('Tasks/Broken context.md', [
      'type: task',
      'status: active',
      'context: "[[Nonexistent Domain]]"',
    ]);

    const result = await runCLI(['audit', 'task', '--output', 'json'], vaultDir);

    // audit exits non-zero when it finds issues; the dangling context relation
    // must be among them.
    expect(result.stdout).toContain('Nonexistent Domain');
  });

  it('migration recipe: drops a now-redundant `scope` field with bulk --delete', async () => {
    // Simulate a legacy note carrying BOTH the leaf context and a redundant
    // life-domain `scope`. After confirming the domain is derivable via
    // under(), the redundant field is dropped with a single bulk operation.
    await writeNote('Tasks/Legacy double-entry.md', [
      'type: task',
      'status: active',
      'scope: career',
      'context: "[[Builder]]"',
    ]);

    // Pre-check: the domain is already derivable from the leaf context, so the
    // `scope` field carries no information the tree doesn't already encode.
    const derivable = await runCLI(
      ['list', 'task', '--where', "under(context, '[[career]]')", '--output', 'paths'],
      vaultDir
    );
    expect(derivable.stdout).toContain('Legacy double-entry.md');

    // Migration: drop the redundant field (dry-run first, then execute).
    const dryRun = await runCLI(
      ['bulk', 'task', '--where', "!isEmpty(scope)", '--delete', 'scope'],
      vaultDir
    );
    expect(dryRun.exitCode).toBe(0);

    const execute = await runCLI(
      ['bulk', 'task', '--where', "!isEmpty(scope)", '--delete', 'scope', '--execute'],
      vaultDir
    );
    expect(execute.exitCode).toBe(0);

    // After migration: `scope` is gone, but the note is STILL reachable from
    // its domain via the context tree. Zero information lost.
    const afterScope = await runCLI(
      ['list', 'task', '--where', "!isEmpty(scope)", '--output', 'paths'],
      vaultDir
    );
    expect(afterScope.stdout).not.toContain('Legacy double-entry.md');

    const afterDomain = await runCLI(
      ['list', 'task', '--where', "under(context, '[[career]]')", '--output', 'paths'],
      vaultDir
    );
    expect(afterDomain.stdout).toContain('Legacy double-entry.md');
  }, 30000);

  it('a domain note is itself a queryable note with descendants', async () => {
    // Because contexts are notes, the tree is introspectable with the existing
    // hierarchy functions on the context type itself.
    const descendants = await runCLI(
      ['list', 'context', '--where', "isDescendantOf('[[career]]')", '--output', 'paths'],
      vaultDir
    );

    expect(descendants.exitCode).toBe(0);
    expect(descendants.stdout).toContain('Builder.md');
    expect(descendants.stdout).toContain('Vercel.md');
    expect(descendants.stdout).not.toContain('PKM.md');
  });
});

/**
 * Guard test for #636 — "under() does not canonicalize aliases".
 *
 * Aliases are a field role (#266): a context note can declare alternate names.
 * Before #636, `under()` matched wikilink targets literally, so a task using an
 * aliased context (e.g. context: [[BuilderProject]] where BuilderProject is an
 * alias of Builder) silently dropped out of every subtree query. This locks in
 * that aliases are canonicalized on BOTH the relation value and the query node.
 */
describe('#636 under() canonicalizes aliases', () => {
  let vaultDir: string;

  const SCHEMA = {
    version: 2,
    types: {
      entity: {
        output_dir: 'Entities',
        fields: { type: { value: 'entity' } },
        field_order: ['type'],
      },
      context: {
        extends: 'entity',
        output_dir: 'Contexts',
        recursive: true,
        fields: {
          type: { value: 'context' },
          parent: { prompt: 'relation', source: 'context' },
          aliases: { prompt: 'list', alias: true, list_format: 'yaml-array', default: [] },
        },
        field_order: ['type', 'parent', 'aliases'],
      },
      task: {
        output_dir: 'Tasks',
        fields: {
          type: { value: 'task' },
          status: {
            prompt: 'select',
            options: ['backlog', 'active', 'done'],
            default: 'backlog',
            required: true,
          },
          context: { prompt: 'relation', source: 'context' },
        },
        field_order: ['type', 'status', 'context'],
      },
    },
    audit: { ignored_directories: [] },
  };

  const writeNote = async (rel: string, frontmatter: string[]) => {
    const path = join(vaultDir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, ['---', ...frontmatter, '---', ''].join('\n'));
  };

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-636-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));

    // career (alias: careerAlias)
    //   └── Builder (alias: BuilderProject)
    //         └── Vercel
    await writeNote('Contexts/career.md', [
      'type: context',
      'aliases:',
      '  - careerAlias',
    ]);
    await writeNote('Contexts/Builder.md', [
      'type: context',
      'parent: "[[career]]"',
      'aliases:',
      '  - BuilderProject',
    ]);
    await writeNote('Contexts/Vercel.md', ['type: context', 'parent: "[[Builder]]"']);

    // Two notes claim the same alias 'Dup' -> ambiguous.
    await writeNote('Contexts/Alpha.md', [
      'type: context',
      'aliases:',
      '  - Dup',
    ]);
    await writeNote('Contexts/Beta.md', [
      'type: context',
      'aliases:',
      '  - Dup',
    ]);

    // Task uses the ALIAS as its context value.
    await writeNote('Tasks/Aliased context task.md', [
      'type: task',
      'status: active',
      'context: "[[BuilderProject]]"',
    ]);
    // Task uses the canonical leaf.
    await writeNote('Tasks/Canonical leaf task.md', [
      'type: task',
      'status: active',
      'context: "[[Vercel]]"',
    ]);
    // Task pointing at the ambiguous alias.
    await writeNote('Tasks/Ambiguous alias task.md', [
      'type: task',
      'status: active',
      'context: "[[Dup]]"',
    ]);
  });

  afterAll(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('matches an aliased relation target against a canonical ancestor', async () => {
    // context: [[BuilderProject]] (alias of Builder) IS under career.
    const result = await runCLI(
      ['list', 'task', '--where', "under(context, '[[career]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Aliased context task.md');
    expect(result.stdout).toContain('Canonical leaf task.md');
  });

  it('resolves an aliased query node to its canonical note and walks its subtree', async () => {
    // under(context, '[[BuilderProject]]') must behave like '[[Builder]]':
    // both the aliased-context task and the Vercel-leaf task (Vercel is under
    // Builder) are returned.
    const result = await runCLI(
      ['list', 'task', '--where', "under(context, '[[BuilderProject]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Aliased context task.md');
    expect(result.stdout).toContain('Canonical leaf task.md');
  });

  it('canonicalizes an aliased query node that is an ancestor', async () => {
    const result = await runCLI(
      ['list', 'task', '--where', "under(context, '[[careerAlias]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Aliased context task.md');
    expect(result.stdout).toContain('Canonical leaf task.md');
  });

  it('does not resolve an ambiguous alias to a subtree (no silent winner)', async () => {
    // 'Dup' is claimed by both Alpha and Beta, so it is dropped from the alias
    // map. The Dup task must NOT be reachable via either claimant's subtree —
    // the engine refuses to silently pick a winner. (A literal Dup-vs-Dup self
    // match would still pass under(context, '[[Dup]]'); the guarantee under test
    // is that no canonicalization to Alpha/Beta happens.)
    const viaAlpha = await runCLI(
      ['list', 'task', '--where', "under(context, '[[Alpha]]')", '--output', 'paths'],
      vaultDir
    );
    expect(viaAlpha.exitCode).toBe(0);
    expect(viaAlpha.stdout).not.toContain('Ambiguous alias task.md');

    const viaBeta = await runCLI(
      ['list', 'task', '--where', "under(context, '[[Beta]]')", '--output', 'paths'],
      vaultDir
    );
    expect(viaBeta.exitCode).toBe(0);
    expect(viaBeta.stdout).not.toContain('Ambiguous alias task.md');
  });

  it('does not crash on a dangling alias', async () => {
    const result = await runCLI(
      ['list', 'task', '--where', "under(context, '[[GhostAlias]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Aliased context task.md');
  });
}, 30000);

/**
 * Guard test for #659 — "isChildOf/isDescendantOf don't canonicalize aliased
 * parent values" (sibling of #636).
 *
 * `isChildOf`/`isDescendantOf` walk the candidate note's OWN `parent` chain. If
 * a note writes `parent: [[Alias]]` (an alias of the real parent), the literal
 * comparison used to silently miss the true ancestor — the same blind spot #636
 * fixed for `under()`. This locks in that the parent-chain walk canonicalizes
 * aliases on BOTH the chain values and the query node, end-to-end through the
 * real CLI, reusing the #636 alias map.
 */
describe('#659 isChildOf/isDescendantOf canonicalize aliased parent values', () => {
  let vaultDir: string;

  const SCHEMA = {
    version: 2,
    types: {
      entity: {
        output_dir: 'Entities',
        fields: { type: { value: 'entity' } },
        field_order: ['type'],
      },
      context: {
        extends: 'entity',
        output_dir: 'Contexts',
        recursive: true,
        fields: {
          type: { value: 'context' },
          parent: { prompt: 'relation', source: 'context' },
          aliases: { prompt: 'list', alias: true, list_format: 'yaml-array', default: [] },
        },
        field_order: ['type', 'parent', 'aliases'],
      },
    },
    audit: { ignored_directories: [] },
  };

  const writeNote = async (rel: string, frontmatter: string[]) => {
    const path = join(vaultDir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, ['---', ...frontmatter, '---', ''].join('\n'));
  };

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-659-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));

    // career (alias: careerAlias)
    //   └── Builder (alias: BuilderProject)
    //         └── Vercel   (parent written as the ALIAS [[BuilderProject]])
    //               └── Edge (parent written as canonical [[Vercel]])
    await writeNote('Contexts/career.md', ['type: context', 'aliases:', '  - careerAlias']);
    await writeNote('Contexts/Builder.md', [
      'type: context',
      'parent: "[[career]]"',
      'aliases:',
      '  - BuilderProject',
    ]);
    // Vercel's parent is the ALIAS of Builder — the #659 bug case.
    await writeNote('Contexts/Vercel.md', ['type: context', 'parent: "[[BuilderProject]]"']);
    await writeNote('Contexts/Edge.md', ['type: context', 'parent: "[[Vercel]]"']);

    // Two notes claim the same alias 'Dup' -> ambiguous, dropped from the map.
    await writeNote('Contexts/Alpha.md', ['type: context', 'aliases:', '  - Dup']);
    await writeNote('Contexts/Beta.md', ['type: context', 'aliases:', '  - Dup']);
    // A note whose parent is the ambiguous alias.
    await writeNote('Contexts/DupChild.md', ['type: context', 'parent: "[[Dup]]"']);
  });

  afterAll(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('isChildOf matches an aliased parent value against the canonical node', async () => {
    // Vercel's parent is [[BuilderProject]] (alias of Builder).
    const result = await runCLI(
      ['list', 'context', '--where', "isChildOf('[[Builder]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Vercel.md');
    // Builder's own (canonical) parent is career — not a child of Builder.
    expect(result.stdout).not.toContain('Builder.md');
  });

  it('isChildOf resolves an aliased query node to its canonical note', async () => {
    // Builder's parent is the canonical [[career]]; query node careerAlias.
    const result = await runCLI(
      ['list', 'context', '--where', "isChildOf('[[careerAlias]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Builder.md');
  });

  it('isDescendantOf walks through an aliased link to a canonical ancestor', async () => {
    // Vercel.parent = [[BuilderProject]] -> Builder -> career.
    const result = await runCLI(
      ['list', 'context', '--where', "isDescendantOf('[[career]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Builder.md');
    expect(result.stdout).toContain('Vercel.md');
    expect(result.stdout).toContain('Edge.md'); // mixed alias/canonical chain
    expect(result.stdout).not.toContain('career.md'); // root is not its own descendant
  });

  it('isDescendantOf resolves an aliased query node and matches its subtree', async () => {
    // Query node BuilderProject -> Builder; Vercel and Edge are under Builder.
    const result = await runCLI(
      ['list', 'context', '--where', "isDescendantOf('[[BuilderProject]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Vercel.md');
    expect(result.stdout).toContain('Edge.md');
  });

  it('does not resolve an ambiguous alias in the parent chain (no silent winner)', async () => {
    // DupChild.parent = [[Dup]]; 'Dup' is ambiguous (Alpha + Beta) so it stays
    // literal and never canonicalizes into either claimant's subtree.
    const viaAlpha = await runCLI(
      ['list', 'context', '--where', "isChildOf('[[Alpha]]')", '--output', 'paths'],
      vaultDir
    );
    expect(viaAlpha.exitCode).toBe(0);
    expect(viaAlpha.stdout).not.toContain('DupChild.md');

    const viaBeta = await runCLI(
      ['list', 'context', '--where', "isChildOf('[[Beta]]')", '--output', 'paths'],
      vaultDir
    );
    expect(viaBeta.exitCode).toBe(0);
    expect(viaBeta.stdout).not.toContain('DupChild.md');
  });

  it('does not crash on a dangling alias query node', async () => {
    const result = await runCLI(
      ['list', 'context', '--where', "isDescendantOf('[[GhostAlias]]')", '--output', 'paths'],
      vaultDir
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Vercel.md');
  });
}, 30000);

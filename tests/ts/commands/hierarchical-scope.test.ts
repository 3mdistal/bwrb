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
          parent: { prompt: 'relation', source: 'context', format: 'quoted-wikilink' },
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
          context: { prompt: 'relation', source: 'context', format: 'quoted-wikilink' },
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

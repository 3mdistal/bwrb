import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

/**
 * Guard test for #637 — "render a context/parent hierarchy as a tree".
 *
 * `list --output tree` builds a parent-based hierarchy tree whenever the result
 * set actually carries `parent` links — regardless of whether the type is
 * `recursive`. This makes any entity type modelling a context/domain hierarchy
 * via `parent` (the #554 pattern) renderable with `--output tree`, while keeping
 * the directory tree as the fallback when there are no parent links.
 *
 * The vault defines two structurally-identical hierarchies:
 *   - `context`  — recursive: true   (already trees pre-#637)
 *   - `domain`   — recursive: false  (the #637 gap: previously fell to dir tree)
 * plus a `note` type with NO parent field (directory-tree fallback).
 */
describe('#637 list --output tree renders parent hierarchy', () => {
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
          parent: { prompt: 'relation', source: 'context', format: 'quoted-wikilink' },
        },
        field_order: ['type', 'parent'],
      },
      // Same parent hierarchy, but NOT marked recursive. This is the #637 case.
      domain: {
        extends: 'entity',
        output_dir: 'Domains',
        fields: {
          type: { value: 'domain' },
          parent: { prompt: 'relation', source: 'domain', format: 'quoted-wikilink' },
        },
        field_order: ['type', 'parent'],
      },
      // No parent field at all — must keep using the directory tree.
      note: {
        output_dir: 'Notes',
        fields: { type: { value: 'note' } },
        field_order: ['type'],
      },
    },
    audit: { ignored_directories: [] },
  };

  const writeNote = async (rel: string, frontmatter: string[]) => {
    const path = join(vaultDir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, ['---', ...frontmatter, '---', ''].join('\n'));
  };

  // The index of `line` within `lines`, or -1.
  const lineIndex = (lines: string[], substr: string): number =>
    lines.findIndex(l => l.includes(substr));

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-637-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));

    // career -> Builder -> Vercel (3 levels), plus a second root.
    for (const type of ['context', 'domain'] as const) {
      const dir = type === 'context' ? 'Contexts' : 'Domains';
      await writeNote(`${dir}/career.md`, [`type: ${type}`]);
      await writeNote(`${dir}/Builder.md`, [`type: ${type}`, 'parent: "[[career]]"']);
      await writeNote(`${dir}/Vercel.md`, [`type: ${type}`, 'parent: "[[Builder]]"']);
      await writeNote(`${dir}/personal.md`, [`type: ${type}`]);
    }

    // note type — no parent anywhere; lives in nested directories.
    await writeNote('Notes/a.md', ['type: note']);
    await writeNote('Notes/Sub/b.md', ['type: note']);
  });

  afterAll(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('renders a NON-recursive type with parent links as a parent tree (the #637 gap)', async () => {
    const result = await runCLI(['list', '--type', 'domain', '--output', 'tree'], vaultDir);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n');

    // Parent tree, not a directory tree: no "Domains/" directory node.
    expect(result.stdout).not.toContain('Domains/');

    // career and Builder and Vercel all present, nested in order.
    const career = lineIndex(lines, 'career');
    const builder = lineIndex(lines, 'Builder');
    const vercel = lineIndex(lines, 'Vercel');
    expect(career).toBeGreaterThanOrEqual(0);
    expect(builder).toBeGreaterThan(career);
    expect(vercel).toBeGreaterThan(builder);

    // Builder is indented under career; Vercel deeper than Builder.
    const indent = (i: number) => lines[i]!.search(/[^\s│├└─]/);
    expect(indent(builder)).toBeGreaterThan(indent(career));
    expect(indent(vercel)).toBeGreaterThan(indent(builder));
  });

  it('still renders a recursive type with parent links as a parent tree (no regression)', async () => {
    const result = await runCLI(['list', '--type', 'context', '--output', 'tree'], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Contexts/');
    const lines = result.stdout.split('\n');
    const career = lineIndex(lines, 'career');
    const builder = lineIndex(lines, 'Builder');
    const vercel = lineIndex(lines, 'Vercel');
    expect(builder).toBeGreaterThan(career);
    expect(vercel).toBeGreaterThan(builder);
  });

  it('shows multiple roots, each with their own subtree', async () => {
    const result = await runCLI(['list', '--type', 'domain', '--output', 'tree'], vaultDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('career');
    expect(result.stdout).toContain('personal');
  });

  it('-L/--depth truncates the parent tree', async () => {
    const result = await runCLI(
      ['list', '--type', 'domain', '--output', 'tree', '-L', '2'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    // Depth 2: career (1) + Builder (2) visible, Vercel (3) truncated.
    expect(result.stdout).toContain('career');
    expect(result.stdout).toContain('Builder');
    expect(result.stdout).not.toContain('Vercel');
  });

  it('respects --sort / --desc ordering of roots and children', async () => {
    const asc = await runCLI(
      ['list', '--type', 'domain', '--output', 'tree', '--sort', 'name'],
      vaultDir
    );
    const desc = await runCLI(
      ['list', '--type', 'domain', '--output', 'tree', '--sort', 'name', '--desc'],
      vaultDir
    );

    expect(asc.exitCode).toBe(0);
    expect(desc.exitCode).toBe(0);

    // Roots are career and personal. Ascending: career before personal.
    const ascLines = asc.stdout.split('\n');
    const descLines = desc.stdout.split('\n');
    expect(lineIndex(ascLines, 'career')).toBeLessThan(lineIndex(ascLines, 'personal'));
    // Descending flips root order.
    expect(lineIndex(descLines, 'personal')).toBeLessThan(lineIndex(descLines, 'career'));
  });

  it('falls back to a directory tree when the result set has NO parent links', async () => {
    const result = await runCLI(['list', '--type', 'note', '--output', 'tree'], vaultDir);

    expect(result.exitCode).toBe(0);
    // Directory tree: directory nodes with trailing slash are present.
    expect(result.stdout).toContain('Notes/');
    expect(result.stdout).toContain('Sub/');
    expect(result.stdout).toContain('a');
    expect(result.stdout).toContain('b');
  });
});

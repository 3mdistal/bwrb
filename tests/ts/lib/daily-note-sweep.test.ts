import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { loadSchema } from '../../../src/lib/schema.js';
import { discoverManagedFiles } from '../../../src/lib/discovery.js';
import { parseNote } from '../../../src/lib/frontmatter.js';
import { applyWhereExpressions } from '../../../src/lib/where-targeting.js';

/**
 * Guards the documented "daily-note sweep" coverage recipe
 * (docs-site/.../automation/ai-integration.md → "Daily-Note Sweep").
 *
 * The convention: a `reviewed` boolean on a vault-defined daily-note type marks
 * whether a note has been swept for extractable items. The recipe to surface
 * un-swept notes is:
 *
 *   bwrb list --type daily-note --where "reviewed != true"
 *
 * The load-bearing detail this test pins down: `reviewed != true` must match
 * BOTH notes with `reviewed: false` AND notes that have no `reviewed` field at
 * all (never touched). `reviewed == false` must NOT — it silently skips the
 * never-reviewed notes, which are exactly the ones at risk of being swept under
 * the rug.
 */

const SWEEP_SCHEMA = {
  $schema: 'https://bwrb.dev/schema.json',
  version: 2,
  config: { link_format: 'wikilink' as const },
  types: {
    'daily-note': {
      description: 'A dated journal/ramble note.',
      output_dir: 'Daily Notes',
      fields: {
        reviewed: {
          prompt: 'boolean' as const,
          description: 'Whether this note has been swept for extractable items.',
        },
      },
    },
  },
};

async function createSweepVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-sweep-'));
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(
    join(vaultDir, '.bwrb', 'schema.json'),
    JSON.stringify(SWEEP_SCHEMA, null, 2)
  );
  await mkdir(join(vaultDir, 'Daily Notes'), { recursive: true });

  // Never touched — no `reviewed` field at all.
  await writeFile(
    join(vaultDir, 'Daily Notes', 'never-touched.md'),
    `---\ntype: daily-note\n---\nRambled about a new idea.\n`
  );
  // Explicitly not yet reviewed.
  await writeFile(
    join(vaultDir, 'Daily Notes', 'explicit-false.md'),
    `---\ntype: daily-note\nreviewed: false\n---\nMore rambling.\n`
  );
  // Already swept.
  await writeFile(
    join(vaultDir, 'Daily Notes', 'reviewed-true.md'),
    `---\ntype: daily-note\nreviewed: true\n---\nSwept this one.\n`
  );

  return vaultDir;
}

describe('daily-note sweep recipe', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createSweepVault();
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  async function filter(where: string): Promise<string[]> {
    const schema = await loadSchema(vaultDir);
    const files = await discoverManagedFiles(schema, vaultDir, 'daily-note');

    const parsed: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
    for (const file of files) {
      const { frontmatter } = await parseNote(file.path);
      parsed.push({ path: file.path, frontmatter });
    }

    const result = await applyWhereExpressions(parsed, {
      schema,
      typePath: 'daily-note',
      whereExpressions: [where],
      vaultDir,
    });

    if (!result.ok) {
      throw new Error(`where filter failed: ${result.error}`);
    }
    return result.files.map((f) => basename(f.path)).sort();
  }

  it('discovers all daily notes when unfiltered', async () => {
    const all = await filter('isDefined(type)');
    expect(all).toEqual([
      'explicit-false.md',
      'never-touched.md',
      'reviewed-true.md',
    ]);
  });

  it('"reviewed != true" surfaces both explicit-false AND never-touched notes', async () => {
    // This is the documented recipe. It must catch the never-touched note.
    const unswept = await filter('reviewed != true');
    expect(unswept).toEqual(['explicit-false.md', 'never-touched.md']);
  });

  it('"reviewed == false" silently misses never-touched notes (why the recipe uses != true)', async () => {
    const onlyExplicit = await filter('reviewed == false');
    expect(onlyExplicit).toEqual(['explicit-false.md']);
    // Documents the trap: the never-touched note is invisible to == false.
    expect(onlyExplicit).not.toContain('never-touched.md');
  });

  it('"reviewed == true" surfaces only swept notes', async () => {
    const swept = await filter('reviewed == true');
    expect(swept).toEqual(['reviewed-true.md']);
  });
});

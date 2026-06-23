import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the prompt module so we can drive the interactive candidate picker
// without a real TTY. `promptSelection` is the only prompt the ambiguous
// mention handler uses; we queue its responses per test.
const promptSelectionMock = vi.fn<(message: string, options: string[]) => Promise<string | null>>();
vi.mock('../../../src/lib/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/prompt.js')>();
  return {
    ...actual,
    promptSelection: (message: string, options: string[]) =>
      promptSelectionMock(message, options),
  };
});

import { loadSchema } from '../../../src/lib/schema.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import { runInteractiveFix, runAutoFix } from '../../../src/lib/audit/fix.js';
import type { Schema } from '../../../src/types/schema.js';

const SCHEMA: Schema = {
  version: 2,
  types: {
    meta: { fields: {} },
    person: {
      extends: 'meta',
      output_dir: 'People',
      fields: {
        type: { value: 'person' },
        aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
      },
      field_order: ['type', 'aliases'],
    },
    note: {
      extends: 'meta',
      output_dir: 'Notes',
      fields: { type: { value: 'note' } },
      field_order: ['type'],
    },
  },
};

describe('unlinked-mention: interactive ambiguous resolution (#622)', () => {
  let vaultDir: string;

  beforeEach(async () => {
    promptSelectionMock.mockReset();
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-unlinked-int-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
    await mkdir(join(vaultDir, 'People'), { recursive: true });
    await mkdir(join(vaultDir, 'Notes'), { recursive: true });

    // Two distinct entities both expose the surface "Mercury":
    //   - the planet note "Mercury"
    //   - the person "Freddie" via alias "Mercury"
    await writeFile(join(vaultDir, 'Notes', 'Mercury.md'), `---\ntype: note\n---\n`);
    await writeFile(
      join(vaultDir, 'People', 'Freddie.md'),
      `---\ntype: person\naliases:\n  - Mercury\n---\n`
    );
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  async function writeDaily(body: string): Promise<void> {
    await writeFile(join(vaultDir, 'Notes', 'Daily.md'), `---\ntype: note\n---\n${body}\n`);
  }

  it('rewrites the mention to [[Chosen]] when a candidate is picked', async () => {
    await writeDaily('Talking about Mercury.');
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });

    // Pick the planet "Mercury" (the surface equals the canonical name).
    promptSelectionMock.mockResolvedValueOnce('Mercury');

    await runInteractiveFix(results, schema, vaultDir, { dryRun: false });

    expect(promptSelectionMock).toHaveBeenCalledTimes(1);
    const after = await readFile(join(vaultDir, 'Notes', 'Daily.md'), 'utf-8');
    expect(after).toContain('[[Mercury]]');
    // No leftover plain-text mention.
    expect(after).not.toMatch(/(?<!\[\[)Mercury(?!\]\])/);
  });

  it('uses the display form [[Chosen|surface]] when surface differs from the note', async () => {
    await writeDaily('Talking about Mercury.');
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });

    // Pick "Freddie" — the surface "Mercury" differs from the note name.
    promptSelectionMock.mockResolvedValueOnce('Freddie');

    await runInteractiveFix(results, schema, vaultDir, { dryRun: false });

    const after = await readFile(join(vaultDir, 'Notes', 'Daily.md'), 'utf-8');
    expect(after).toContain('[[Freddie|Mercury]]');
  });

  it('leaves the mention untouched when the user skips', async () => {
    await writeDaily('Talking about Mercury.');
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });

    promptSelectionMock.mockResolvedValueOnce('[skip]');

    await runInteractiveFix(results, schema, vaultDir, { dryRun: false });

    const after = await readFile(join(vaultDir, 'Notes', 'Daily.md'), 'utf-8');
    expect(after).toContain('Talking about Mercury.');
    expect(after).not.toContain('[[');
  });

  it('--auto (runAutoFix) never resolves an ambiguous mention', async () => {
    await writeDaily('Talking about Mercury.');
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });

    await runAutoFix(results, schema, vaultDir, { dryRun: false });

    // No prompt is shown and nothing is rewritten.
    expect(promptSelectionMock).not.toHaveBeenCalled();
    const after = await readFile(join(vaultDir, 'Notes', 'Daily.md'), 'utf-8');
    expect(after).toContain('Talking about Mercury.');
    expect(after).not.toContain('[[');
  });

  it('offers the candidate entities (plus skip/quit) in the prompt', async () => {
    await writeDaily('Talking about Mercury.');
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });

    promptSelectionMock.mockResolvedValueOnce('[skip]');
    await runInteractiveFix(results, schema, vaultDir, { dryRun: false });

    const [, options] = promptSelectionMock.mock.calls[0]!;
    expect(options).toContain('Freddie');
    expect(options).toContain('Mercury');
    expect(options).toContain('[skip]');
    expect(options).toContain('[quit]');
  });
});

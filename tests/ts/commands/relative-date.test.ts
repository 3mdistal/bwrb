import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI, TEST_SCHEMA } from '../fixtures/setup.js';
import { ExitCodes } from '../../../src/lib/output.js';

describe('relative-date fields', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-relative-date-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await mkdir(join(vaultDir, 'Moments'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(relativeDateSchema(), null, 2)
    );
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('resolves chains for list JSON, sort, and where comparisons', async () => {
    await writeMoment('A', { start: '2026-01-01' });
    await writeMoment('B', {
      position: [{ kind: 'equal', ref: '[[A]]', field: 'start', offset: '34h' }],
    });
    await writeMoment('C', {
      position: [{ kind: 'equal', ref: '[[B]]', field: 'position', offset: '-2h' }],
    });
    await writeMoment('D', {
      position: [{ kind: 'after', ref: '[[A]]', field: 'start', offset: '1w' }],
    });

    // Plain YYYY-MM-DD anchors resolve at local midnight, so expected instants
    // must be derived the same way to stay timezone-independent (local vs CI).
    const HOUR = 60 * 60 * 1000;
    const baseMs = new Date(2026, 0, 1).getTime();
    const iso = (ms: number) => new Date(ms).toISOString();

    const sorted = await runCLI(['list', 'moment', '--sort', 'position', '--output', 'json'], vaultDir);
    expect(sorted.exitCode).toBe(0);
    const rows = JSON.parse(sorted.stdout) as Array<Record<string, unknown>>;
    expect(rows.map(row => row._name)).toEqual(['A', 'C', 'B', 'D']);
    expect(rows[0]!.position).toMatchObject({
      resolved: iso(baseMs),
      resolution: 'ok',
    });
    expect(rows[1]!.position).toMatchObject({
      resolved: iso(baseMs + 32 * HOUR),
      resolution: 'ok',
    });
    expect(rows[2]!.position).toMatchObject({
      resolved: iso(baseMs + 34 * HOUR),
      resolution: 'ok',
    });
    expect(rows[3]!.position).toMatchObject({
      resolved: null,
      resolution: 'unanchored',
    });

    const filtered = await runCLI(
      ['list', 'moment', '--where', `position < date('${iso(baseMs + 33 * HOUR)}')`, '--output', 'json'],
      vaultDir
    );
    expect(filtered.exitCode).toBe(0);
    const filteredRows = JSON.parse(filtered.stdout) as Array<Record<string, unknown>>;
    expect(filteredRows.map(row => row._name)).toEqual(['A', 'C']);
  });

  it('keeps unresolved relative-date sort values last in both directions', async () => {
    await writeMoment('Early', { start: '2026-01-01' });
    await writeMoment('Late', { start: '2026-02-01' });
    await writeMoment('Floating', {
      position: [{ kind: 'after', ref: '[[Late]]', field: 'start', offset: '1w' }],
    });

    const ascending = await runCLI(['list', 'moment', '--sort', 'position', '--output', 'json'], vaultDir);
    expect(ascending.exitCode).toBe(0);
    const ascendingRows = JSON.parse(ascending.stdout) as Array<Record<string, unknown>>;
    expect(ascendingRows.map(row => row._name)).toEqual(['Early', 'Late', 'Floating']);
    expect(ascendingRows[2]!.position).toMatchObject({
      resolved: null,
      resolution: 'unanchored',
    });

    const descending = await runCLI(['list', 'moment', '--sort', 'position', '--desc', '--output', 'json'], vaultDir);
    expect(descending.exitCode).toBe(0);
    const descendingRows = JSON.parse(descending.stdout) as Array<Record<string, unknown>>;
    expect(descendingRows.map(row => row._name)).toEqual(['Late', 'Early', 'Floating']);
    expect(descendingRows[2]!.position).toMatchObject({
      resolved: null,
      resolution: 'unanchored',
    });
  });

  it('reports cycles, contradictions, and bound violations in audit', async () => {
    await writeMoment('Cycle A', {
      position: [{ kind: 'equal', ref: '[[Cycle B]]', field: 'position', offset: '0h' }],
    });
    await writeMoment('Cycle B', {
      position: [{ kind: 'equal', ref: '[[Cycle A]]', field: 'position', offset: '0h' }],
    });
    await writeMoment('Anchor 1', { start: '2026-01-01' });
    await writeMoment('Anchor 2', { start: '2026-01-03' });
    await writeMoment('Contradiction', {
      position: [
        { kind: 'equal', ref: '[[Anchor 1]]', field: 'start', offset: '0h' },
        { kind: 'equal', ref: '[[Anchor 2]]', field: 'start', offset: '0h' },
      ],
    });
    await writeMoment('Bounded', {
      position: [
        { kind: 'equal', ref: '[[Anchor 1]]', field: 'start', offset: '0h' },
        { kind: 'after', ref: '[[Anchor 1]]', field: 'start', offset: '1w' },
      ],
    });

    const audit = await runCLI(['audit', 'moment', '--output', 'json'], vaultDir);
    expect(audit.exitCode).toBe(0);
    const output = JSON.parse(audit.stdout) as {
      files: Array<{ path: string; issues: Array<{ code: string; field?: string }> }>;
    };
    const codes = output.files.flatMap(file => file.issues.map(issue => issue.code));
    expect(codes).toContain('relative-date-cycle');
    expect(codes).toContain('relative-date-contradiction');
    expect(codes).toContain('relative-date-bound-violation');
  });

  it('accepts new/edit JSON object and list shapes with key-specific validation', async () => {
    await writeMoment('Anchor', { start: '2026-01-01' });

    const created = await runCLI(
      [
        'new',
        'moment',
        '--no-template',
        '--json',
        JSON.stringify({
          name: 'Created',
          position: { kind: 'equal', ref: '[[Anchor]]', field: 'start', offset: '12h' },
        }),
      ],
      vaultDir
    );
    expect(created.exitCode).toBe(ExitCodes.SUCCESS);
    const createdOutput = JSON.parse(created.stdout) as { path: string };
    const content = await readFile(join(vaultDir, createdOutput.path), 'utf-8');
    expect(content).toContain('position:');
    expect(content).toContain('kind: equal');
    expect(content).toContain('offset: 12h');

    const edited = await runCLI(
      [
        'edit',
        'Created',
        '--json',
        JSON.stringify({
          position: [{ kind: 'after', ref: '[[Anchor]]', field: 'start', offset: '1w' }],
        }),
      ],
      vaultDir
    );
    expect(edited.exitCode).toBe(ExitCodes.SUCCESS);

    const invalid = await runCLI(
      [
        'edit',
        'Created',
        '--json',
        JSON.stringify({ position: { kind: 'near', ref: '[[Anchor]]' } }),
      ],
      vaultDir
    );
    expect(invalid.exitCode).toBe(ExitCodes.VALIDATION_ERROR);
    const invalidOutput = JSON.parse(invalid.stdout) as { errors: Array<{ message: string }> };
    expect(invalidOutput.errors[0]!.message).toContain('position.kind');
  });

  async function writeMoment(
    name: string,
    fields: { start?: string; position?: unknown }
  ): Promise<void> {
    const lines = ['---', 'type: moment', `name: ${JSON.stringify(name)}`];
    if (fields.start) lines.push(`start: ${JSON.stringify(fields.start)}`);
    if (fields.position !== undefined) {
      lines.push(`position: ${JSON.stringify(fields.position)}`);
    }
    lines.push('---', '');
    await writeFile(join(vaultDir, 'Moments', `${name}.md`), lines.join('\n'));
  }
});

function relativeDateSchema(): Record<string, unknown> {
  return {
    ...TEST_SCHEMA,
    types: {
      ...TEST_SCHEMA.types,
      moment: {
        output_dir: 'Moments',
        filename: '{name}',
        fields: {
          name: { prompt: 'text', required: true },
          start: { prompt: 'date' },
          position: { prompt: 'relative-date', source: 'moment' },
        },
      },
    },
  };
}

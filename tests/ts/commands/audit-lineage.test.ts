import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI, TEST_SCHEMA } from '../fixtures/setup.js';

const HEX_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HEX_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function ideaFrontmatter(id: string, forkedFrom?: string): string {
  return `---
type: idea
id: ${id}
${forkedFrom ? `forked-from: ${forkedFrom}\n` : ''}status: raw
priority: medium
---
`;
}

describe('audit command lineage UUID identity', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-lineage-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(TEST_SCHEMA, null, 2)
    );
    await mkdir(join(vaultDir, 'Ideas'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('treats a cross-case fork reference as valid in text output', async () => {
    await writeFile(
      join(vaultDir, 'Ideas', 'Parent.md'),
      ideaFrontmatter(HEX_A.toUpperCase())
    );
    await writeFile(
      join(vaultDir, 'Ideas', 'Child.md'),
      ideaFrontmatter(HEX_B, HEX_A)
    );

    const result = await runCLI(
      ['audit', 'idea', '--only', 'dangling-forked-from'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No issues found');
  });

  it('reports case-only duplicate IDs in JSON and exits with an error', async () => {
    await writeFile(
      join(vaultDir, 'Ideas', 'Upper.md'),
      ideaFrontmatter(HEX_A.toUpperCase())
    );
    await writeFile(
      join(vaultDir, 'Ideas', 'Lower.md'),
      ideaFrontmatter(HEX_A)
    );

    const result = await runCLI(
      ['audit', 'idea', '--only', 'duplicate-note-id', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout) as {
      files: Array<{ issues: Array<{ code: string; value?: unknown }> }>;
      summary: { totalErrors: number };
    };
    const issues = output.files.flatMap((file) => file.issues);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.code === 'duplicate-note-id')).toBe(true);
    expect(issues.map((issue) => issue.value)).toEqual(
      expect.arrayContaining([HEX_A.toUpperCase(), HEX_A])
    );
    expect(output.summary.totalErrors).toBe(2);
  });

  it('reports a mixed-case lineage cycle in text and exits with an error', async () => {
    await writeFile(
      join(vaultDir, 'Ideas', 'A.md'),
      ideaFrontmatter(HEX_A.toUpperCase(), HEX_B)
    );
    await writeFile(
      join(vaultDir, 'Ideas', 'B.md'),
      ideaFrontmatter(HEX_B, HEX_A)
    );

    const result = await runCLI(
      ['audit', 'idea', '--only', 'fork-cycle'],
      vaultDir
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Fork lineage cycle detected');
    expect(result.stdout).toContain('Ideas/A.md');
    expect(result.stdout).toContain('Ideas/B.md');
  });

  it('enforces required note identity only after frontmatter-v1 migration', async () => {
    await writeFile(
      join(vaultDir, 'Ideas', 'Missing.md'),
      `---\ntype: idea\nstatus: raw\npriority: medium\n---\n`
    );
    await writeFile(
      join(vaultDir, 'Ideas', 'Invalid.md'),
      `---\ntype: idea\nid: definitely-not-a-uuid\nstatus: raw\npriority: medium\n---\n`
    );

    const legacy = await runCLI(
      ['audit', 'idea', '--only', 'missing-note-id', '--output', 'json'],
      vaultDir
    );
    expect(legacy.exitCode).toBe(0);

    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify({
        ...TEST_SCHEMA,
        config: { ...TEST_SCHEMA.config, identity_store: 'frontmatter-v1' },
      }, null, 2)
    );

    const missing = await runCLI(
      ['audit', 'idea', '--only', 'missing-note-id', '--output', 'json'],
      vaultDir
    );
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).files).toMatchObject([
      { path: 'Ideas/Missing.md', issues: [{ code: 'missing-note-id' }] },
    ]);

    const invalid = await runCLI(
      ['audit', 'idea', '--only', 'invalid-note-id', '--output', 'json'],
      vaultDir
    );
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).files).toMatchObject([
      { path: 'Ideas/Invalid.md', issues: [{ code: 'invalid-note-id' }] },
    ]);
  });
});

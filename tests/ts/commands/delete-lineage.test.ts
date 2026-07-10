import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  cleanupTestVault,
  createTestVault,
  runCLI,
} from '../fixtures/setup.js';

const A = 'AAAAAAAA-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

function idea(id: string | undefined, parent?: string): string {
  return `---
type: idea
${id === undefined ? '' : `id: ${id}\n`}${parent === undefined ? '' : `forked-from: ${parent}\n`}status: raw
priority: medium
---
`;
}

describe('delete fork-lineage safety', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('blocks roots and middles, permits leaves, and lists stable child paths', async () => {
    const root = join(vaultDir, 'Ideas/Root.md');
    const middle = join(vaultDir, 'Ideas/Middle.md');
    const leaf = join(vaultDir, 'Ideas/Leaf.md');
    const idlessChild = join(vaultDir, 'Ideas/Idless Child.md');
    await writeFile(root, idea(A));
    await writeFile(middle, idea(B, A.toLowerCase()));
    await writeFile(leaf, idea(C, B));
    await writeFile(idlessChild, idea(undefined, A));

    const rootResult = await runCLI(['delete', 'Root', '--dry-run'], vaultDir);
    expect(rootResult.exitCode).toBe(1);
    expect(rootResult.stderr).toContain('2 direct fork children');
    expect(rootResult.stderr.indexOf('Ideas/Idless Child.md'))
      .toBeLessThan(rootResult.stderr.indexOf('Ideas/Middle.md'));

    const middleResult = await runCLI([
      'delete', '--type', 'idea', 'Middle', '--dry-run',
    ], vaultDir);
    expect(middleResult.exitCode).toBe(1);
    expect(middleResult.stderr).toContain('Ideas/Leaf.md');

    const leafResult = await runCLI(['delete', 'Leaf'], vaultDir, 'y\n');
    expect(leafResult.exitCode, leafResult.stderr || leafResult.stdout).toBe(0);
    expect(existsSync(leaf)).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(middle)).toBe(true);
  });

  it('returns machine-readable JSON for child and duplicate refusals', async () => {
    const parent = join(vaultDir, 'Ideas/Parent.md');
    await writeFile(parent, idea(A));
    await writeFile(join(vaultDir, 'Ideas/Child.md'), idea(B, A));

    const childResult = await runCLI([
      'delete', 'Parent', '--dry-run', '--output', 'json',
    ], vaultDir);
    expect(childResult.exitCode).toBe(1);
    expect(JSON.parse(childResult.stdout)).toMatchObject({
      success: false,
      code: 1,
      data: {
        path: 'Ideas/Parent.md',
        reason: 'has-fork-children',
        childCount: 1,
        children: [{ path: 'Ideas/Child.md', id: B }],
      },
    });

    await writeFile(join(vaultDir, 'Ideas/Duplicate.md'), idea(A.toLowerCase()));
    const duplicateResult = await runCLI([
      'delete', 'Ideas/Parent.md', '--dry-run', '--output', 'json',
    ], vaultDir);
    expect(duplicateResult.exitCode).toBe(1);
    expect(JSON.parse(duplicateResult.stdout)).toMatchObject({
      success: false,
      data: {
        reason: 'duplicate-identity',
        duplicates: ['Ideas/Duplicate.md', 'Ideas/Parent.md'],
      },
    });

    const forced = await runCLI([
      'delete', 'Ideas/Parent.md', '--force', '--output', 'json',
    ], vaultDir);
    expect(forced.exitCode).toBe(0);
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(join(vaultDir, 'Ideas/Duplicate.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'Ideas/Child.md'))).toBe(true);
  });

  it('guards actual single, scoped, bulk, and non-interactive flows before prompts or partial deletion', async () => {
    const parent = join(vaultDir, 'Ideas/Parent.md');
    const child = join(vaultDir, 'Ideas/Child.md');
    const baseline = join(vaultDir, 'Ideas/Sample Idea.md');
    await writeFile(parent, idea(A));
    await writeFile(child, idea(B, A));

    const attempts = [
      ['delete', 'Parent'],
      ['delete', '--type', 'idea', 'Parent', '--execute'],
      ['delete', '--type', 'idea', '--execute'],
      ['--non-interactive', 'delete', 'Parent'],
    ];
    for (const args of attempts) {
      const result = await runCLI(args, vaultDir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('fork lineage would be orphaned');
      expect(existsSync(parent)).toBe(true);
      expect(existsSync(child)).toBe(true);
      expect(existsSync(baseline)).toBe(true);
    }
  });

  it('allows non-force deletion when the target id is missing or malformed', async () => {
    const missing = join(vaultDir, 'Ideas/Missing ID.md');
    const malformed = join(vaultDir, 'Ideas/Malformed ID.md');
    await writeFile(missing, idea(undefined));
    await writeFile(malformed, idea('not-a-uuid'));

    for (const target of ['Missing ID', 'Malformed ID']) {
      const result = await runCLI(['delete', target], vaultDir, 'y\n');
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    }
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(malformed)).toBe(false);
  });

  it('makes bulk dry-run all-or-nothing and reports each blocked target', async () => {
    await writeFile(join(vaultDir, 'Ideas/Parent.md'), idea(A));
    await writeFile(join(vaultDir, 'Ideas/Child.md'), idea(B, A));
    const result = await runCLI([
      'delete', '--type', 'idea', '--output', 'json',
    ], vaultDir);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.data.blocked).toEqual([expect.objectContaining({
      path: 'Ideas/Parent.md',
      reason: 'has-fork-children',
    })]);
    expect(output.error).not.toContain('would be deleted');
    expect(existsSync(join(vaultDir, 'Ideas/Parent.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'Ideas/Child.md'))).toBe(true);
  });

  it('treats self and two-node cycles as blocking direct-child edges', async () => {
    await writeFile(join(vaultDir, 'Ideas/Self.md'), idea(A, A));
    await writeFile(join(vaultDir, 'Ideas/Cycle A.md'), idea(B, C));
    await writeFile(join(vaultDir, 'Ideas/Cycle B.md'), idea(C, B));

    for (const target of ['Self', 'Cycle A', 'Cycle B']) {
      const result = await runCLI(['delete', target, '--dry-run'], vaultDir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('direct fork child');
    }
  });

  it('--force deletes only the parent and leaves an audit-visible dangling reference', async () => {
    const parent = join(vaultDir, 'Ideas/Parent.md');
    const child = join(vaultDir, 'Ideas/Child.md');
    await writeFile(parent, idea(A));
    await writeFile(child, idea(B, A));

    const deleted = await runCLI([
      'delete', 'Parent', '--force', '--output', 'json',
    ], vaultDir);
    expect(deleted.exitCode, deleted.stderr || deleted.stdout).toBe(0);
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(child)).toBe(true);
    expect(await readFile(child, 'utf-8')).toContain(`forked-from: ${A}`);

    const audit = await runCLI([
      'audit', 'idea', '--only', 'dangling-forked-from', '--output', 'json',
    ], vaultDir);
    const issues = JSON.parse(audit.stdout).files
      .flatMap((file: { issues: Array<{ code: string }> }) => file.issues);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'dangling-forked-from' }));
  });

  it('applies the guard to owned paths discovered under owner folders', async () => {
    const ownerDir = join(vaultDir, 'Projects/Lineage Project');
    const researchDir = join(ownerDir, 'research');
    await mkdir(researchDir, { recursive: true });
    await writeFile(join(ownerDir, 'Lineage Project.md'), `---\ntype: project\nstatus: active\n---\n`);
    const parent = join(researchDir, 'Owned Parent.md');
    await writeFile(parent, `---\ntype: research\nid: ${A}\nowner: "[[Lineage Project]]"\n---\n`);
    await writeFile(join(researchDir, 'Owned Child.md'), `---\ntype: research\nid: ${B}\nforked-from: ${A}\nowner: "[[Lineage Project]]"\n---\n`);

    const result = await runCLI([
      'delete', 'Projects/Lineage Project/research/Owned Parent', '--dry-run',
    ], vaultDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Owned Child.md');
    expect(existsSync(parent)).toBe(true);
  });
});

describe.sequential('fork versus delete lineage lock', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it.each([
    ['legacy id-less', false],
    ['valid id', true],
  ])('never reports delete success with a concurrently created dangling child (%s)', async (_label, withId) => {
    for (let iteration = 0; iteration < 6; iteration++) {
      const sourceName = `Race Source ${withId ? 'ID' : 'Legacy'} ${iteration}`;
      const childName = `Race Child ${withId ? 'ID' : 'Legacy'} ${iteration}`;
      const sourcePath = join(vaultDir, `Ideas/${sourceName}.md`);
      const childPath = join(vaultDir, `Ideas/${childName}.md`);
      const sourceId = `aaaaaaaa-1111-4111-8111-${String(iteration).padStart(12, '0')}`;
      await writeFile(sourcePath, idea(withId ? sourceId : undefined));

      const [forked, deleted] = await Promise.all([
        runCLI([
          'new', '--fork', sourceName, '--name', childName, '--output', 'json',
        ], vaultDir),
        runCLI(['delete', sourceName], vaultDir, 'y\n'),
      ]);

      if (deleted.exitCode === 0) {
        expect(forked.exitCode).toBe(1);
        expect(existsSync(sourcePath)).toBe(false);
        expect(existsSync(childPath)).toBe(false);
      } else {
        expect(forked.exitCode, forked.stderr || forked.stdout).toBe(0);
        expect(deleted.stderr).toContain('fork lineage would be orphaned');
        expect(existsSync(sourcePath)).toBe(true);
        expect(existsSync(childPath)).toBe(true);
      }
    }
  }, 60_000);
});

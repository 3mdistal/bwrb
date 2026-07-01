import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import {
  validateFieldForType,
  applyFrontmatterFilters,
  type FileWithFrontmatter,
} from '../../../src/lib/query.js';
import * as discovery from '../../../src/lib/discovery.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import type { Schema } from '../../../src/types/schema.js';

describe('query', () => {
  let vaultDir: string;
  let schema: Schema;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('validateFieldForType', () => {
    it('should accept valid fields', () => {
      const result = validateFieldForType(schema, 'idea', 'status');
      expect(result.valid).toBe(true);
    });

    it('should reject unknown fields', () => {
      const result = validateFieldForType(schema, 'idea', 'unknown');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown field');
    });
  });

  describe('applyFrontmatterFilters', () => {
    const makeFiles = (data: Array<{ path: string; fm: Record<string, unknown> }>): FileWithFrontmatter[] =>
      data.map(d => ({ path: join(vaultDir, d.path), frontmatter: d.fm }));

    it('should filter by where expression for equality', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
        { path: 'b.md', fm: { status: 'done' } },
        { path: 'c.md', fm: { status: 'active' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status == 'active'"],
        vaultDir,
      });

      expect(result).toHaveLength(2);
      expect(result.map(f => f.frontmatter.status)).toEqual(['active', 'active']);
    });

    it('should filter by hyphenated frontmatter keys', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { 'creation-date': '2026-01-28' } },
        { path: 'b.md', fm: { 'creation-date': '2026-01-27' } },
        { path: 'c.md', fm: { status: 'active' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["creation-date == '2026-01-28'"],
        vaultDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.frontmatter['creation-date']).toBe('2026-01-28');
    });

    it('should filter by where expression for inequality', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
        { path: 'b.md', fm: { status: 'done' } },
        { path: 'c.md', fm: { status: 'pending' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status != 'done'"],
        vaultDir,
      });

      expect(result).toHaveLength(2);
      expect(result.map(f => f.frontmatter.status)).toEqual(['active', 'pending']);
    });

    it('should filter by numeric comparison', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { priority: 1 } },
        { path: 'b.md', fm: { priority: 3 } },
        { path: 'c.md', fm: { priority: 2 } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ['priority < 3'],
        vaultDir,
      });

      expect(result).toHaveLength(2);
      expect(result.map(f => f.frontmatter.priority)).toEqual([1, 2]);
    });

    it('should combine multiple where expressions (ANDed)', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active', priority: 1 } },
        { path: 'b.md', fm: { status: 'active', priority: 3 } },
        { path: 'c.md', fm: { status: 'done', priority: 1 } },
        { path: 'd.md', fm: { status: 'active', priority: 2 } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status == 'active'", 'priority < 3'],
        vaultDir,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.frontmatter).toEqual({ status: 'active', priority: 1 });
      expect(result[1]?.frontmatter).toEqual({ status: 'active', priority: 2 });
    });

    it('should return empty array when no files match', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'done' } },
        { path: 'b.md', fm: { status: 'done' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ["status == 'active'"],
        vaultDir,
      });

      expect(result).toHaveLength(0);
    });

    it('should return all files when no filters are specified', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
        { path: 'b.md', fm: { status: 'done' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: [],
        vaultDir,
      });

      expect(result).toHaveLength(2);
    });

    it('should preserve original object references', async () => {
      const originalFile = { path: join(vaultDir, 'a.md'), frontmatter: { status: 'active' } };
      const files = [originalFile];

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: [],
        vaultDir,
      });

      expect(result[0]).toBe(originalFile);
    });

    it('should handle isEmpty function in expressions', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active', deadline: '2025-01-15' } },
        { path: 'b.md', fm: { status: 'active' } },
        { path: 'c.md', fm: { status: 'done', deadline: '' } },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ['!isEmpty(deadline)'],
        vaultDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.frontmatter.deadline).toBe('2025-01-15');
    });

    it('should treat parent-like relation fields as hierarchy for isRoot()', async () => {
      const files = makeFiles([
        { path: 'Objectives/Tasks/Standalone Task.md', fm: { type: 'task', status: 'raw' } },
        {
          path: 'Objectives/Tasks/Child Task.md',
          fm: { type: 'task', status: 'raw', milestone: '"[[Alpha Release]]"' },
        },
      ]);

      const result = await applyFrontmatterFilters(files, {
        whereExpressions: ['isRoot()'],
        vaultDir,
        schema,
        typePath: 'task',
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.path).toContain('Standalone Task.md');
    });

    describe('under() operator (full-vault relation-target resolution)', () => {
      // Build a context hierarchy out of recursive `task` notes so they live in
      // the vault and are discoverable by the full-vault augmentation pass:
      //   career (root)
      //     └── Builder
      //           └── Vercel
      const contextNotes: string[] = [];

      beforeAll(async () => {
        const write = async (name: string, parent: string | null) => {
          const path = join(vaultDir, 'Objectives/Tasks', `${name}.md`);
          const parentLine = parent ? `\nparent: "[[${parent}]]"` : '';
          await writeFile(
            path,
            `---\ntype: task\nstatus: backlog${parentLine}\n---\n`
          );
          contextNotes.push(path);
        };
        await write('career', null);
        await write('Builder', 'career');
        await write('Vercel', 'Builder');
      });

      afterAll(async () => {
        await Promise.all(contextNotes.map(p => rm(p, { force: true })));
      });

      it('matches a note whose relation target is a deep descendant of the node', async () => {
        // Candidate task has NO parent of its own; its `milestone` relation
        // points at Vercel, which is under career via Builder.
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[Vercel]]"' } },
        ]);

        const result = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });

        expect(result).toHaveLength(1);
      });

      it('does not match when the relation target is not under the node', async () => {
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[career]]"' } },
        ]);

        const result = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[Builder]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });

        expect(result).toHaveLength(0);
      });

      it('is distinct from isDescendantOf — relation chain vs the note\'s own chain', async () => {
        // The candidate has no structural `parent`, only a `milestone` relation.
        // isDescendantOf walks the literal `parent` chain (empty) -> false; the
        // `milestone` relation is NOT folded into the structural chain (#709), so
        // these stay distinct. under(milestone, '[[career]]') follows the
        // relation -> true.
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[Vercel]]"' } },
        ]);

        const descResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(descResult).toHaveLength(0);

        const underResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(underResult).toHaveLength(1);
      });

      it('parses the vault exactly once (parent + alias maps share one snapshot)', async () => {
        // Regression for #634: the full-vault augmentation used to walk + parse
        // the vault twice per `under` query (once for the parent map via
        // discoverManagedFiles + parseNote, once for the alias map via its own
        // buildVaultNoteSnapshot). Both maps now come from a SINGLE snapshot.
        const snapshotSpy = vi.spyOn(discovery, 'buildVaultNoteSnapshot');
        try {
          const files = makeFiles([
            { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[Vercel]]"' } },
          ]);

          const result = await applyFrontmatterFilters(files, {
            whereExpressions: ["under(milestone, '[[career]]')"],
            vaultDir,
            schema,
            typePath: 'task',
          });

          // Behavior unchanged: still matches the deep-descendant relation target.
          expect(result).toHaveLength(1);
          // And the vault snapshot was built exactly once for the query.
          expect(snapshotSpy).toHaveBeenCalledTimes(1);
        } finally {
          snapshotSpy.mockRestore();
        }
      });

      it('does not match (and does not crash) on a dangling relation target', async () => {
        const files = makeFiles([
          { path: 'Objectives/Tasks/Leaf.md', fm: { type: 'task', status: 'backlog', milestone: '"[[Ghost]]"' } },
        ]);

        const result = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });

        expect(result).toHaveLength(0);
      });
    });

    describe('isChildOf / isDescendantOf full-vault ancestor resolution (#709)', () => {
      // Build a structural `parent` chain that deliberately climbs THROUGH a
      // note of a DIFFERENT type than the filtered candidate, so the
      // intermediate note is excluded from a `--type task` candidate set:
      //   career (task, root)
      //     └── Release Alpha (milestone)   <- filtered out by --type task
      //           └── (candidate task's parent)
      // The candidate task's own `parent` is the milestone, so its ancestor
      // chain only reaches `career` if the milestone -> career link is resolved
      // from the FULL vault. With the old candidate-only parent map the walk
      // stopped at the milestone and missed `career`.
      const builtNotes: string[] = [];

      beforeAll(async () => {
        const writeNote = async (
          dir: string,
          name: string,
          fm: string
        ): Promise<void> => {
          const path = join(vaultDir, dir, `${name}.md`);
          await writeFile(path, `---\n${fm}\n---\n`);
          builtNotes.push(path);
        };
        await writeNote('Objectives/Tasks', 'career', 'type: task\nstatus: backlog');
        await writeNote(
          'Objectives/Milestones',
          'Release Alpha',
          'type: milestone\nstatus: backlog\nparent: "[[career]]"'
        );
      });

      afterAll(async () => {
        await Promise.all(builtNotes.map(p => rm(p, { force: true })));
      });

      it('finds an ancestor reachable only THROUGH a type-filtered-out note', async () => {
        // The candidate is a task whose parent is a milestone (filtered out of a
        // --type task candidate set). The true ancestor `career` sits above the
        // milestone. isDescendantOf must walk past the milestone to find it.
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Deep Task.md',
            fm: { type: 'task', status: 'backlog', parent: '"[[Release Alpha]]"' },
          },
        ]);

        const result = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });

        expect(result).toHaveLength(1);
      });

      it('isChildOf still matches only the DIRECT parent (not a grandparent)', async () => {
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Deep Task.md',
            fm: { type: 'task', status: 'backlog', parent: '"[[Release Alpha]]"' },
          },
        ]);

        // Direct child of the milestone: matches.
        const directResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isChildOf('[[Release Alpha]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(directResult).toHaveLength(1);

        // career is the GRANDparent, not the direct parent: isChildOf must NOT
        // match (only isDescendantOf walks transitively).
        const grandparentResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isChildOf('[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(grandparentResult).toHaveLength(0);
      });

      it('isRoot uses parent-LIKE links but isDescendantOf uses only structural parent', async () => {
        // A task attached ONLY via its `milestone` relation (no literal `parent`)
        // is NOT a root (isRoot consults the broad parent-like set), yet it is
        // NOT a descendant of the milestone's ancestors either, because
        // isDescendantOf walks only the literal `parent` chain (empty here). This
        // locks the getHierarchyFields decision: parent-like relations count for
        // isRoot, but are queried structurally only via `under` (#709).
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Milestone Only.md',
            fm: { type: 'task', status: 'backlog', milestone: '"[[Release Alpha]]"' },
          },
        ]);

        const rootResult = await applyFrontmatterFilters(files, {
          whereExpressions: ['isRoot()'],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(rootResult).toHaveLength(0); // attached via milestone -> not a root

        const descResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        // No structural `parent`, so the milestone's own ancestor (career) is not
        // reached by isDescendantOf — that is `under(milestone, ...)`'s job.
        expect(descResult).toHaveLength(0);
      });

      it('keeps the three operators semantically distinct on one vault', async () => {
        // One candidate task that simultaneously:
        //   - has its own structural parent chain (parent -> milestone -> career)
        //   - records a separate `milestone` relation pointing at career directly
        // so the operators read DIFFERENT inputs and must disagree.
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Mixed Task.md',
            fm: {
              type: 'task',
              status: 'backlog',
              parent: '"[[Release Alpha]]"',
              milestone: '"[[career]]"',
            },
          },
        ]);

        // isChildOf: direct structural parent only -> the milestone, NOT career.
        const childOfCareer = await applyFrontmatterFilters(files, {
          whereExpressions: ["isChildOf('[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(childOfCareer).toHaveLength(0);

        // isDescendantOf: own parent chain, transitively reaches career.
        const descOfCareer = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(descOfCareer).toHaveLength(1);

        // under(milestone, ...): dereferences the RELATION field, which points at
        // career directly (inclusive of the direct target) -> matches even though
        // career is not the note's structural parent.
        const underCareer = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[career]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(underCareer).toHaveLength(1);

        // And under reading the relation field disagrees with the structural
        // operators on a DIFFERENT node: the milestone relation does not point at
        // Release Alpha nor under it, so under(milestone, '[[Release Alpha]]')
        // is false even though isChildOf('[[Release Alpha]]') is true.
        const underAlpha = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[Release Alpha]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(underAlpha).toHaveLength(0);

        const childOfAlpha = await applyFrontmatterFilters(files, {
          whereExpressions: ["isChildOf('[[Release Alpha]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(childOfAlpha).toHaveLength(1);
      });
    });

    describe('duplicate basename does not hijack a parentless candidate (#737)', () => {
      // parentMap is keyed by BASENAME. The full-vault augmentation (#709) merges
      // parent edges for the WHOLE vault so chains can climb through filtered-out
      // notes. The hazard: a parentless CANDIDATE shares its basename with a
      // DIFFERENT, parented note elsewhere in the vault. The vault merge must not
      // borrow that other note's `parent` for the candidate's basename, or the
      // root candidate falsely matches isDescendantOf/isChildOf of that other
      // note's ancestor. Duplicate basenames are a supported vault shape.
      const builtNotes: string[] = [];

      beforeAll(async () => {
        const writeNote = async (
          dir: string,
          name: string,
          fm: string
        ): Promise<void> => {
          const path = join(vaultDir, dir, `${name}.md`);
          await writeFile(path, `---\n${fm}\n---\n`);
          builtNotes.push(path);
        };
        // Root ancestor.
        await writeNote('Objectives/Tasks', 'hijack-root', 'type: task\nstatus: backlog');
        // A DIFFERENT note named `Shared` that DOES have a parent, living
        // elsewhere in the vault. It is under `hijack-root`.
        await writeNote(
          'Objectives/Milestones',
          'Shared',
          'type: milestone\nstatus: backlog\nparent: "[[hijack-root]]"'
        );
      });

      afterAll(async () => {
        await Promise.all(builtNotes.map(p => rm(p, { force: true })));
      });

      it('a parentless candidate is NOT a descendant of the other Shared note\'s ancestor', async () => {
        // The candidate is a ROOT task named `Shared` with NO parent. It collides
        // by basename with the parented milestone `Shared` written above. The
        // candidate must stay root, not inherit the milestone's parent.
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Shared.md',
            fm: { type: 'task', status: 'backlog' },
          },
        ]);

        const descResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[hijack-root]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(descResult).toHaveLength(0);

        const childResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isChildOf('[[hijack-root]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(childResult).toHaveLength(0);
      });

      it('the parentless candidate is still a root despite the same-basename parented note', async () => {
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Shared.md',
            fm: { type: 'task', status: 'backlog' },
          },
        ]);

        const rootResult = await applyFrontmatterFilters(files, {
          whereExpressions: ['isRoot()'],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(rootResult).toHaveLength(1);
      });

      it('a candidate with its OWN parent keeps its own chain, not the colliding note\'s', async () => {
        // Candidate `Shared` here HAS its own parent (`hijack-root` directly).
        // Its own edge must win, and it must be a DIRECT child (isChildOf), which
        // would be impossible if it had borrowed the milestone\'s parent.
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Shared.md',
            fm: { type: 'task', status: 'backlog', parent: '"[[hijack-root]]"' },
          },
        ]);

        const childResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isChildOf('[[hijack-root]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(childResult).toHaveLength(1);
      });
    });

    describe('duplicate intermediate ancestor basenames keep path identity (#738)', () => {
      const builtNotes: string[] = [];

      beforeAll(async () => {
        const writeNote = async (
          dir: string,
          name: string,
          fm: string
        ): Promise<void> => {
          const path = join(vaultDir, dir, `${name}.md`);
          await mkdir(join(vaultDir, dir), { recursive: true });
          await writeFile(path, `---\n${fm}\n---\n`);
          builtNotes.push(path);
        };

        await writeNote('Objectives/Tasks', 'correct-root', 'type: task\nstatus: backlog');
        await writeNote('Objectives/Tasks', 'wrong-root', 'type: task\nstatus: backlog');
        await writeNote(
          'Archive/Milestones',
          'Shared Phase',
          'type: milestone\nstatus: backlog\nparent: "[[wrong-root]]"'
        );
        await writeNote(
          'Objectives/Milestones',
          'Shared Phase',
          'type: milestone\nstatus: backlog\nparent: "[[correct-root]]"'
        );
      });

      afterAll(async () => {
        await Promise.all(builtNotes.map(p => rm(p, { force: true })));
      });

      it('climbs through the path-qualified same-basename parent, not the first basename edge', async () => {
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Path Keyed Leaf.md',
            fm: {
              type: 'task',
              status: 'backlog',
              parent: '"[[Objectives/Milestones/Shared Phase]]"',
            },
          },
        ]);

        const correctResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[correct-root]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(correctResult).toHaveLength(1);

        const wrongResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["isDescendantOf('[[wrong-root]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(wrongResult).toHaveLength(0);
      });

      it('under() also walks the path-qualified relation target through the correct duplicate basename', async () => {
        const files = makeFiles([
          {
            path: 'Objectives/Tasks/Path Keyed Relation.md',
            fm: {
              type: 'task',
              status: 'backlog',
              milestone: '"[[Objectives/Milestones/Shared Phase]]"',
            },
          },
        ]);

        const correctResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[correct-root]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(correctResult).toHaveLength(1);

        const wrongResult = await applyFrontmatterFilters(files, {
          whereExpressions: ["under(milestone, '[[wrong-root]]')"],
          vaultDir,
          schema,
          typePath: 'task',
        });
        expect(wrongResult).toHaveLength(0);
      });
    });

    it('should throw on invalid expression syntax', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
      ]);

      await expect(
        applyFrontmatterFilters(files, {
          whereExpressions: ["status == 'active' &&"],
          vaultDir,
        })
      ).rejects.toThrow(/Expression error in/);
    });

    it('should throw on expression runtime errors', async () => {
      const files = makeFiles([
        { path: 'a.md', fm: { status: 'active' } },
      ]);

      await expect(
        applyFrontmatterFilters(files, {
          whereExpressions: ['missingFn(status)'],
          vaultDir,
        })
      ).rejects.toThrow(/Unknown function: missingFn/);
    });
  });
});

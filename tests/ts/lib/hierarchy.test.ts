import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildParentMap,
  buildNotePathMap,
  detectCycle,
  checkExistingCycle,
  validateParentNoCycle,
} from '../../../src/lib/hierarchy.js';
import { loadSchema } from '../../../src/lib/schema.js';

describe('hierarchy', () => {
  describe('detectCycle', () => {
    it('should detect a simple cycle (A -> B -> A)', () => {
      const parentMap = new Map<string, string>([
        ['Task A', 'Task B'],
        ['Task B', 'Task A'],
      ]);

      // Simulating: we're setting Task A's parent to Task B
      // But Task B already has Task A as parent, so this creates a cycle
      const result = detectCycle('Task A', 'Task B', parentMap);
      expect(result.hasCycle).toBe(true);
      expect(result.cyclePath).not.toBeNull();
    });

    it('should detect a longer cycle (A -> B -> C -> A)', () => {
      const parentMap = new Map<string, string>([
        ['Task B', 'Task C'],
        ['Task C', 'Task A'],
      ]);

      // Setting Task A's parent to Task B creates: A -> B -> C -> A
      const result = detectCycle('Task A', 'Task B', parentMap);
      expect(result.hasCycle).toBe(true);
      expect(result.cyclePath).toContain('Task A');
      expect(result.cyclePath).toContain('Task B');
      expect(result.cyclePath).toContain('Task C');
    });

    it('should detect self-reference (A -> A)', () => {
      const parentMap = new Map<string, string>();

      const result = detectCycle('Task A', 'Task A', parentMap);
      expect(result.hasCycle).toBe(true);
      expect(result.cyclePath).toEqual(['Task A', 'Task A']);
    });

    it('should return no cycle for valid chain (A -> B -> C)', () => {
      const parentMap = new Map<string, string>([
        ['Task B', 'Task C'],
        // Task C has no parent
      ]);

      // Setting Task A's parent to Task B is valid (no cycle back to A)
      const result = detectCycle('Task A', 'Task B', parentMap);
      expect(result.hasCycle).toBe(false);
      expect(result.cyclePath).toBeNull();
    });

    it('should return no cycle for orphan parent', () => {
      const parentMap = new Map<string, string>();

      // Setting Task A's parent to Task B, where Task B has no parent
      const result = detectCycle('Task A', 'Task B', parentMap);
      expect(result.hasCycle).toBe(false);
      expect(result.cyclePath).toBeNull();
    });
  });

  describe('checkExistingCycle', () => {
    it('should detect existing cycle in parent chain', () => {
      const parentMap = new Map<string, string>([
        ['Task A', 'Task B'],
        ['Task B', 'Task C'],
        ['Task C', 'Task A'], // Creates cycle
      ]);

      const result = checkExistingCycle('Task A', parentMap);
      expect(result.hasCycle).toBe(true);
      expect(result.cyclePath).not.toBeNull();
    });

    it('should return no cycle for valid chain', () => {
      const parentMap = new Map<string, string>([
        ['Task A', 'Task B'],
        ['Task B', 'Task C'],
      ]);

      const result = checkExistingCycle('Task A', parentMap);
      expect(result.hasCycle).toBe(false);
      expect(result.cyclePath).toBeNull();
    });

    it('should return no cycle for orphan', () => {
      const parentMap = new Map<string, string>([
        ['Task B', 'Task C'],
      ]);

      // Task A has no parent
      const result = checkExistingCycle('Task A', parentMap);
      expect(result.hasCycle).toBe(false);
      expect(result.cyclePath).toBeNull();
    });
  });

  describe('buildParentMap', () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bwrb-hierarchy-test-'));
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempDir, 'Tasks'), { recursive: true });

      // Create schema with recursive task type
      await writeFile(
        join(tempDir, '.bwrb/schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            task: {
              recursive: true,
              output_dir: 'Tasks',
              fields: {
                title: { prompt: 'input' },
              },
            },
          },
        })
      );

      // Create test notes with parent relationships
      await writeFile(
        join(tempDir, 'Tasks/Parent Task.md'),
        `---
type: task
title: Parent Task
---
# Parent Task
`
      );

      await writeFile(
        join(tempDir, 'Tasks/Child Task.md'),
        `---
type: task
title: Child Task
parent: "[[Parent Task]]"
---
# Child Task
`
      );

      await writeFile(
        join(tempDir, 'Tasks/Grandchild Task.md'),
        `---
type: task
title: Grandchild Task
parent: "[[Child Task]]"
---
# Grandchild Task
`
      );
    });

    afterAll(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should build parent map from files', async () => {
      const schema = await loadSchema(tempDir);
      const parentMap = await buildParentMap(schema, tempDir);

      expect(parentMap.get('Child Task')).toBe('Parent Task');
      expect(parentMap.get('Grandchild Task')).toBe('Child Task');
      expect(parentMap.has('Parent Task')).toBe(false); // No parent
    });
  });

  describe('buildNotePathMap', () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bwrb-notepath-test-'));
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempDir, 'Tasks'), { recursive: true });

      await writeFile(
        join(tempDir, '.bwrb/schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            task: {
              output_dir: 'Tasks',
              fields: { title: { prompt: 'input' } },
            },
          },
        })
      );

      await writeFile(
        join(tempDir, 'Tasks/My Task.md'),
        `---
type: task
title: My Task
---
`
      );
    });

    afterAll(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should build note name to path map', async () => {
      const schema = await loadSchema(tempDir);
      const notePathMap = await buildNotePathMap(schema, tempDir);

      expect(notePathMap.get('My Task')).toBe(join(tempDir, 'Tasks/My Task.md'));
    });
  });

  describe('validateParentNoCycle', () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bwrb-validate-cycle-test-'));
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempDir, 'Tasks'), { recursive: true });

      await writeFile(
        join(tempDir, '.bwrb/schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            task: {
              recursive: true,
              output_dir: 'Tasks',
              fields: {
                title: { prompt: 'input' },
              },
            },
          },
        })
      );

      // Task A has parent Task B
      await writeFile(
        join(tempDir, 'Tasks/Task A.md'),
        `---
type: task
title: Task A
parent: "[[Task B]]"
---
`
      );

      // Task B has no parent
      await writeFile(
        join(tempDir, 'Tasks/Task B.md'),
        `---
type: task
title: Task B
---
`
      );
    });

    afterAll(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should return null for valid parent assignment', async () => {
      const schema = await loadSchema(tempDir);

      // Creating Task C with parent Task A is valid (no cycle)
      const result = await validateParentNoCycle(
        schema,
        tempDir,
        'Task C',
        '[[Task A]]'
      );

      expect(result).toBeNull();
    });

    it('should detect cycle when setting parent to descendant', async () => {
      const schema = await loadSchema(tempDir);

      // Setting Task B's parent to Task A would create cycle (A -> B -> A)
      const result = await validateParentNoCycle(
        schema,
        tempDir,
        'Task B',
        '[[Task A]]'
      );

      expect(result).not.toBeNull();
      expect(result!.type).toBe('parent_cycle');
      expect(result!.cyclePath).toBeDefined();
      expect(result!.cyclePath!.length).toBeGreaterThan(1);
    });

    it('should detect self-reference', async () => {
      const schema = await loadSchema(tempDir);

      // Setting Task A's parent to itself
      const result = await validateParentNoCycle(
        schema,
        tempDir,
        'Task A',
        '[[Task A]]'
      );

      expect(result).not.toBeNull();
      expect(result!.type).toBe('parent_cycle');
      expect(result!.message).toContain('cycle');
    });

    it('should handle quoted wikilinks', async () => {
      const schema = await loadSchema(tempDir);

      const result = await validateParentNoCycle(
        schema,
        tempDir,
        'Task C',
        '"[[Task B]]"'
      );

      expect(result).toBeNull();
    });
  });
});

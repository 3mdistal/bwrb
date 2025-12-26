import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  evaluateExpression,
  matchesExpression,
  parseDuration,
  type EvalContext,
} from '../../../src/lib/expression.js';

describe('expression', () => {
  const makeContext = (frontmatter: Record<string, unknown>): EvalContext => ({
    frontmatter,
    file: {
      name: 'Test File',
      path: 'Ideas/Test File.md',
      folder: 'Ideas',
      ext: '.md',
    },
  });

  describe('parseExpression', () => {
    it('should parse simple comparison', () => {
      const expr = parseExpression("status == 'done'");
      expect(expr.type).toBe('BinaryExpression');
    });

    it('should parse boolean expressions', () => {
      const expr = parseExpression("a && b || c");
      expect(expr.type).toBe('BinaryExpression');
    });

    it('should parse function calls', () => {
      const expr = parseExpression("isEmpty(status)");
      expect(expr.type).toBe('CallExpression');
    });

    it('should throw on invalid syntax', () => {
      expect(() => parseExpression("status ==")).toThrow();
    });
  });

  describe('evaluateExpression - comparisons', () => {
    it('should evaluate equality', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("status == 'done'", ctx)).toBe(true);
      expect(matchesExpression("status == 'pending'", ctx)).toBe(false);
    });

    it('should evaluate inequality', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("status != 'pending'", ctx)).toBe(true);
      expect(matchesExpression("status != 'done'", ctx)).toBe(false);
    });

    it('should evaluate numeric comparisons', () => {
      const ctx = makeContext({ priority: 2 });
      expect(matchesExpression("priority < 3", ctx)).toBe(true);
      expect(matchesExpression("priority > 1", ctx)).toBe(true);
      expect(matchesExpression("priority <= 2", ctx)).toBe(true);
      expect(matchesExpression("priority >= 2", ctx)).toBe(true);
      expect(matchesExpression("priority < 2", ctx)).toBe(false);
    });
  });

  describe('evaluateExpression - boolean logic', () => {
    it('should evaluate AND', () => {
      const ctx = makeContext({ status: 'done', priority: 1 });
      expect(matchesExpression("status == 'done' && priority == 1", ctx)).toBe(true);
      expect(matchesExpression("status == 'done' && priority == 2", ctx)).toBe(false);
    });

    it('should evaluate OR', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("status == 'done' || status == 'pending'", ctx)).toBe(true);
      expect(matchesExpression("status == 'open' || status == 'pending'", ctx)).toBe(false);
    });

    it('should evaluate NOT', () => {
      const ctx = makeContext({ status: 'done' });
      expect(matchesExpression("!isEmpty(status)", ctx)).toBe(true);
      expect(matchesExpression("!(status == 'done')", ctx)).toBe(false);
    });
  });

  describe('evaluateExpression - functions', () => {
    it('should evaluate contains for strings', () => {
      const ctx = makeContext({ title: 'Hello World' });
      expect(matchesExpression("contains(title, 'World')", ctx)).toBe(true);
      expect(matchesExpression("contains(title, 'Foo')", ctx)).toBe(false);
    });

    it('should evaluate contains for arrays', () => {
      const ctx = makeContext({ tags: ['urgent', 'bug'] });
      expect(matchesExpression("contains(tags, 'urgent')", ctx)).toBe(true);
      expect(matchesExpression("contains(tags, 'feature')", ctx)).toBe(false);
    });

    it('should evaluate isEmpty', () => {
      expect(matchesExpression("isEmpty(status)", makeContext({}))).toBe(true);
      expect(matchesExpression("isEmpty(status)", makeContext({ status: '' }))).toBe(true);
      expect(matchesExpression("isEmpty(tags)", makeContext({ tags: [] }))).toBe(true);
      expect(matchesExpression("isEmpty(status)", makeContext({ status: 'done' }))).toBe(false);
    });

    it('should evaluate startsWith and endsWith', () => {
      const ctx = makeContext({ title: 'WIP: Feature' });
      expect(matchesExpression("startsWith(title, 'WIP')", ctx)).toBe(true);
      expect(matchesExpression("endsWith(title, 'Feature')", ctx)).toBe(true);
    });

    it('should evaluate today()', () => {
      const ctx = makeContext({});
      const expr = parseExpression("today()");
      const result = evaluateExpression(expr, ctx);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should evaluate hasTag', () => {
      const ctx = makeContext({ tags: ['urgent', 'bug'] });
      expect(matchesExpression("hasTag('urgent')", ctx)).toBe(true);
      expect(matchesExpression("hasTag('feature')", ctx)).toBe(false);
    });
  });

  describe('parseDuration', () => {
    it('should parse day durations', () => {
      expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseDuration("'7d'")).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse week durations', () => {
      expect(parseDuration('1w')).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse hour durations', () => {
      expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
    });

    it('should return null for invalid durations', () => {
      expect(parseDuration('invalid')).toBeNull();
      expect(parseDuration('7')).toBeNull();
    });
  });

  describe('date arithmetic', () => {
    it('should compare dates', () => {
      const ctx = makeContext({ deadline: '2025-01-01' });
      expect(matchesExpression("deadline < '2025-01-15'", ctx)).toBe(true);
      expect(matchesExpression("deadline > '2024-12-01'", ctx)).toBe(true);
    });
  });

  describe('member expressions', () => {
    it('should access file properties', () => {
      const ctx = makeContext({});
      expect(matchesExpression("file.folder == 'Ideas'", ctx)).toBe(true);
      expect(matchesExpression("file.name == 'Test File'", ctx)).toBe(true);
    });

    it('should access nested frontmatter', () => {
      const ctx = makeContext({ metadata: { author: 'alice' } });
      expect(matchesExpression("metadata.author == 'alice'", ctx)).toBe(true);
    });
  });

  describe('complex expressions', () => {
    it('should handle complex boolean logic', () => {
      const ctx = makeContext({ status: 'in-progress', priority: 1, deadline: '2025-01-15' });
      expect(matchesExpression(
        "(status == 'in-progress' || status == 'backlog') && priority < 3",
        ctx
      )).toBe(true);
    });

    it('should handle combined function calls', () => {
      const ctx = makeContext({ status: 'done', tags: ['complete'] });
      expect(matchesExpression(
        "status == 'done' && !isEmpty(tags)",
        ctx
      )).toBe(true);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NumberedSelectPrompt, type NumberedSelectOptions } from '../../../src/lib/numberedSelect.js';

/**
 * Helper to create a prompt instance for testing.
 */
function createPrompt(options: Partial<NumberedSelectOptions> & { choices: string[] }): NumberedSelectPrompt {
  return new NumberedSelectPrompt({
    message: options.message ?? 'Select an option',
    choices: options.choices,
    initial: options.initial,
  });
}

describe('NumberedSelectPrompt', () => {
  describe('constructor', () => {
    it('should initialize with default cursor at 0', () => {
      const prompt = createPrompt({ choices: ['a', 'b', 'c'] });
      // Access private properties via type assertion for testing
      expect((prompt as any).cursor).toBe(0);
      expect((prompt as any).currentPage).toBe(0);
    });

    it('should initialize with custom initial index', () => {
      const prompt = createPrompt({ choices: ['a', 'b', 'c'], initial: 2 });
      expect((prompt as any).cursor).toBe(2);
    });

    it('should calculate total pages correctly', () => {
      // 5 items = 1 page
      const prompt1 = createPrompt({ choices: Array(5).fill('x') });
      expect((prompt1 as any).totalPages).toBe(1);

      // 10 items = 1 page
      const prompt2 = createPrompt({ choices: Array(10).fill('x') });
      expect((prompt2 as any).totalPages).toBe(1);

      // 11 items = 2 pages
      const prompt3 = createPrompt({ choices: Array(11).fill('x') });
      expect((prompt3 as any).totalPages).toBe(2);

      // 25 items = 3 pages
      const prompt4 = createPrompt({ choices: Array(25).fill('x') });
      expect((prompt4 as any).totalPages).toBe(3);
    });

    it('should set initial page based on initial cursor', () => {
      // If initial is 15, should start on page 2 (index 1)
      const prompt = createPrompt({
        choices: Array(25).fill('x'),
        initial: 15,
      });
      expect((prompt as any).currentPage).toBe(1);
    });
  });

  describe('empty choices', () => {
    it('should return aborted result for empty choices', async () => {
      const prompt = createPrompt({ choices: [] });
      const result = await prompt.run();
      expect(result.aborted).toBe(true);
      expect(result.value).toBeUndefined();
      expect(result.index).toBe(-1);
    });
  });
});

describe('Number key mapping', () => {
  // Test the number key logic directly
  function parseNumberKey(char: string): number {
    if (char === '0') return 9;
    const num = parseInt(char, 10);
    if (num >= 1 && num <= 9) return num - 1;
    return -1;
  }

  function getDisplayKey(indexInPage: number): string {
    return indexInPage === 9 ? '0' : String(indexInPage + 1);
  }

  it('should map keys 1-9 to indices 0-8', () => {
    expect(parseNumberKey('1')).toBe(0);
    expect(parseNumberKey('2')).toBe(1);
    expect(parseNumberKey('3')).toBe(2);
    expect(parseNumberKey('4')).toBe(3);
    expect(parseNumberKey('5')).toBe(4);
    expect(parseNumberKey('6')).toBe(5);
    expect(parseNumberKey('7')).toBe(6);
    expect(parseNumberKey('8')).toBe(7);
    expect(parseNumberKey('9')).toBe(8);
  });

  it('should map key 0 to index 9 (10th item)', () => {
    expect(parseNumberKey('0')).toBe(9);
  });

  it('should return -1 for non-number keys', () => {
    expect(parseNumberKey('a')).toBe(-1);
    expect(parseNumberKey('-')).toBe(-1);
    expect(parseNumberKey('+')).toBe(-1);
  });

  it('should display correct keys for indices', () => {
    expect(getDisplayKey(0)).toBe('1');
    expect(getDisplayKey(1)).toBe('2');
    expect(getDisplayKey(8)).toBe('9');
    expect(getDisplayKey(9)).toBe('0');
  });
});

describe('Pagination logic', () => {
  const ITEMS_PER_PAGE = 10;

  function calculatePage(cursor: number): number {
    return Math.floor(cursor / ITEMS_PER_PAGE);
  }

  function getPageRange(page: number, totalItems: number): { start: number; end: number } {
    const start = page * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, totalItems);
    return { start, end };
  }

  it('should calculate correct page for cursor position', () => {
    expect(calculatePage(0)).toBe(0);
    expect(calculatePage(9)).toBe(0);
    expect(calculatePage(10)).toBe(1);
    expect(calculatePage(19)).toBe(1);
    expect(calculatePage(20)).toBe(2);
  });

  it('should calculate correct page range', () => {
    // First page of 25 items
    expect(getPageRange(0, 25)).toEqual({ start: 0, end: 10 });
    // Second page
    expect(getPageRange(1, 25)).toEqual({ start: 10, end: 20 });
    // Third page (partial)
    expect(getPageRange(2, 25)).toEqual({ start: 20, end: 25 });
  });

  it('should handle single page correctly', () => {
    expect(getPageRange(0, 5)).toEqual({ start: 0, end: 5 });
    expect(getPageRange(0, 10)).toEqual({ start: 0, end: 10 });
  });
});

describe('Navigation logic', () => {
  // Test wrap-around behavior
  function moveUp(cursor: number, totalItems: number): number {
    if (cursor > 0) return cursor - 1;
    return totalItems - 1; // Wrap to end
  }

  function moveDown(cursor: number, totalItems: number): number {
    if (cursor < totalItems - 1) return cursor + 1;
    return 0; // Wrap to beginning
  }

  it('should wrap cursor from top to bottom', () => {
    expect(moveUp(0, 5)).toBe(4);
  });

  it('should wrap cursor from bottom to top', () => {
    expect(moveDown(4, 5)).toBe(0);
  });

  it('should move cursor normally within bounds', () => {
    expect(moveUp(3, 5)).toBe(2);
    expect(moveDown(2, 5)).toBe(3);
  });
});

describe('Number key selection', () => {
  // Test the absolute index calculation
  function getAbsoluteIndex(numberKey: string, currentPage: number): number {
    const ITEMS_PER_PAGE = 10;
    let indexInPage: number;
    if (numberKey === '0') {
      indexInPage = 9;
    } else {
      const num = parseInt(numberKey, 10);
      if (num >= 1 && num <= 9) {
        indexInPage = num - 1;
      } else {
        return -1;
      }
    }
    return currentPage * ITEMS_PER_PAGE + indexInPage;
  }

  it('should calculate correct absolute index on page 0', () => {
    expect(getAbsoluteIndex('1', 0)).toBe(0);
    expect(getAbsoluteIndex('5', 0)).toBe(4);
    expect(getAbsoluteIndex('0', 0)).toBe(9);
  });

  it('should calculate correct absolute index on page 1', () => {
    expect(getAbsoluteIndex('1', 1)).toBe(10);
    expect(getAbsoluteIndex('5', 1)).toBe(14);
    expect(getAbsoluteIndex('0', 1)).toBe(19);
  });

  it('should calculate correct absolute index on page 2', () => {
    expect(getAbsoluteIndex('1', 2)).toBe(20);
    expect(getAbsoluteIndex('3', 2)).toBe(22);
  });
});

describe('Page navigation', () => {
  function prevPage(currentPage: number, totalPages: number): number {
    if (totalPages <= 1) return currentPage;
    if (currentPage > 0) return currentPage - 1;
    return currentPage;
  }

  function nextPage(currentPage: number, totalPages: number): number {
    if (totalPages <= 1) return currentPage;
    if (currentPage < totalPages - 1) return currentPage + 1;
    return currentPage;
  }

  it('should not change page when only one page exists', () => {
    expect(prevPage(0, 1)).toBe(0);
    expect(nextPage(0, 1)).toBe(0);
  });

  it('should navigate between pages', () => {
    expect(nextPage(0, 3)).toBe(1);
    expect(nextPage(1, 3)).toBe(2);
    expect(nextPage(2, 3)).toBe(2); // At end, stay
    expect(prevPage(2, 3)).toBe(1);
    expect(prevPage(1, 3)).toBe(0);
    expect(prevPage(0, 3)).toBe(0); // At start, stay
  });
});

describe('Hint text generation', () => {
  function generateHint(totalItems: number, totalPages: number): string {
    if (totalPages > 1) {
      return '(-/+ page, 1-0 select, ↑↓ navigate, Enter confirm)';
    } else {
      const maxKey = totalItems === 10 ? '0' : String(totalItems);
      return `(1-${maxKey} select, ↑↓ navigate, Enter confirm)`;
    }
  }

  it('should show pagination hint for multiple pages', () => {
    expect(generateHint(25, 3)).toContain('-/+ page');
    expect(generateHint(25, 3)).toContain('1-0 select');
  });

  it('should show correct max key for single page', () => {
    expect(generateHint(5, 1)).toContain('1-5 select');
    expect(generateHint(3, 1)).toContain('1-3 select');
    expect(generateHint(10, 1)).toContain('1-0 select');
  });

  it('should not show pagination hint for single page', () => {
    expect(generateHint(5, 1)).not.toContain('-/+ page');
  });
});

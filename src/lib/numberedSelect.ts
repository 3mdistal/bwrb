import * as readline from 'readline';
import chalk from 'chalk';

/**
 * Options for the numbered select prompt.
 */
export interface NumberedSelectOptions {
  message: string;
  choices: string[];
  /** Initial selected index (default: 0) */
  initial?: number;
}

/**
 * Result of a numbered select prompt.
 */
export interface NumberedSelectResult {
  value: string | undefined;
  index: number;
  aborted: boolean;
}

// Constants
const ITEMS_PER_PAGE = 10;

/**
 * Get the display key for an index within a page (1-9, 0 for 10th).
 */
function getDisplayKey(indexInPage: number): string {
  return indexInPage === 9 ? '0' : String(indexInPage + 1);
}

/**
 * Parse a key character to page-relative index (0-9).
 * Returns -1 if not a valid number key.
 */
function parseNumberKey(char: string): number {
  if (char === '0') return 9; // 0 = 10th item (index 9)
  const num = parseInt(char, 10);
  if (num >= 1 && num <= 9) return num - 1;
  return -1;
}

/**
 * A select prompt that supports:
 * - Number keys (1-9, 0) for immediate selection
 * - Arrow keys for navigation (requires Enter to confirm)
 * - -/+/= for page navigation when > 10 options
 */
export class NumberedSelectPrompt {
  private message: string;
  private choices: string[];
  private cursor: number;
  private currentPage: number;
  private totalPages: number;
  private rl: readline.Interface | null = null;
  private done: boolean = false;
  private firstRender: boolean = true;
  private resolve: ((result: NumberedSelectResult) => void) | null = null;

  constructor(options: NumberedSelectOptions) {
    this.message = options.message;
    this.choices = options.choices;
    this.cursor = options.initial ?? 0;
    this.totalPages = Math.ceil(this.choices.length / ITEMS_PER_PAGE);
    this.currentPage = Math.floor(this.cursor / ITEMS_PER_PAGE);
  }

  /**
   * Run the prompt and return the result.
   */
  async run(): Promise<NumberedSelectResult> {
    // Handle empty choices
    if (this.choices.length === 0) {
      return { value: undefined, index: -1, aborted: true };
    }

    return new Promise((resolve) => {
      this.resolve = resolve;

      // Set up readline
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      // Enable raw mode for keypress detection
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      readline.emitKeypressEvents(process.stdin);

      // Initial render
      this.render();

      // Listen for keypresses
      process.stdin.on('keypress', this.handleKeypress);
      process.stdin.resume();
    });
  }

  private handleKeypress = (str: string | undefined, key: readline.Key): void => {
    if (this.done) return;

    // Handle special keys
    if (key.ctrl && key.name === 'c') {
      this.abort();
      return;
    }

    if (key.name === 'escape') {
      this.abort();
      return;
    }

    if (key.name === 'return') {
      this.submit();
      return;
    }

    // Arrow keys / vim keys for navigation
    if (key.name === 'up' || key.name === 'k') {
      this.moveUp();
      return;
    }

    if (key.name === 'down' || key.name === 'j') {
      this.moveDown();
      return;
    }

    // Page navigation
    if (str === '-') {
      this.prevPage();
      return;
    }

    if (str === '+' || str === '=') {
      this.nextPage();
      return;
    }

    // Number keys for immediate selection
    if (str && /^[0-9]$/.test(str)) {
      const indexInPage = parseNumberKey(str);
      const absoluteIndex = this.currentPage * ITEMS_PER_PAGE + indexInPage;

      if (absoluteIndex < this.choices.length) {
        this.cursor = absoluteIndex;
        this.submit();
      }
    }
  };

  private moveUp(): void {
    const oldCursor = this.cursor;
    const oldPage = this.currentPage;

    if (this.cursor > 0) {
      this.cursor--;
    } else {
      // Wrap to end
      this.cursor = this.choices.length - 1;
    }

    // Update page if cursor moved to a different page
    const newPage = Math.floor(this.cursor / ITEMS_PER_PAGE);
    if (newPage !== this.currentPage) {
      this.currentPage = newPage;
    }

    // Use differential update if staying on same page, full render if page changed
    if (oldPage === this.currentPage) {
      this.updateSelection(oldCursor, this.cursor);
    } else {
      this.render();
    }
  }

  private moveDown(): void {
    const oldCursor = this.cursor;
    const oldPage = this.currentPage;

    if (this.cursor < this.choices.length - 1) {
      this.cursor++;
    } else {
      // Wrap to beginning
      this.cursor = 0;
    }

    // Update page if cursor moved to a different page
    const newPage = Math.floor(this.cursor / ITEMS_PER_PAGE);
    if (newPage !== this.currentPage) {
      this.currentPage = newPage;
    }

    // Use differential update if staying on same page, full render if page changed
    if (oldPage === this.currentPage) {
      this.updateSelection(oldCursor, this.cursor);
    } else {
      this.render();
    }
  }

  private prevPage(): void {
    if (this.totalPages <= 1) return;

    if (this.currentPage > 0) {
      this.currentPage--;
      // Move cursor to same position on new page, or last item if page is shorter
      const pageStart = this.currentPage * ITEMS_PER_PAGE;
      const indexInPage = this.cursor % ITEMS_PER_PAGE;
      this.cursor = pageStart + indexInPage;
      this.render();
    }
  }

  private nextPage(): void {
    if (this.totalPages <= 1) return;

    if (this.currentPage < this.totalPages - 1) {
      this.currentPage++;
      // Move cursor to same position on new page, or last item if page is shorter
      const pageStart = this.currentPage * ITEMS_PER_PAGE;
      const pageEnd = Math.min(pageStart + ITEMS_PER_PAGE, this.choices.length);
      const indexInPage = Math.min(this.cursor % ITEMS_PER_PAGE, pageEnd - pageStart - 1);
      this.cursor = pageStart + indexInPage;
      this.render();
    }
  }

  private submit(): void {
    this.done = true;
    this.cleanup();
    this.clearPrompt();

    // Show final selection
    const selected = this.choices[this.cursor];
    process.stdout.write(
      `${chalk.green('✔')} ${chalk.bold(this.message)} ${chalk.cyan(selected)}\n`
    );

    this.resolve?.({
      value: selected,
      index: this.cursor,
      aborted: false,
    });
  }

  private abort(): void {
    this.done = true;
    this.cleanup();
    this.clearPrompt();

    process.stdout.write(`${chalk.red('✖')} ${chalk.bold(this.message)}\n`);

    this.resolve?.({
      value: undefined,
      index: -1,
      aborted: true,
    });
  }

  private cleanup(): void {
    process.stdin.removeListener('keypress', this.handleKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    this.rl?.close();
  }

  private clearPrompt(): void {
    // Calculate total lines to clear (prompt line + choices + hint line)
    const pageStart = this.currentPage * ITEMS_PER_PAGE;
    const pageEnd = Math.min(pageStart + ITEMS_PER_PAGE, this.choices.length);
    const visibleChoices = pageEnd - pageStart;
    const totalLines = 1 + visibleChoices + 1; // prompt + choices + hint

    // Move up and clear each line
    for (let i = 0; i < totalLines; i++) {
      process.stdout.write('\x1b[2K'); // Clear line
      if (i < totalLines - 1) {
        process.stdout.write('\x1b[1A'); // Move up
      }
    }
    process.stdout.write('\r'); // Move to start of line
  }

  /**
   * Render a single choice line.
   */
  private renderChoiceLine(absoluteIndex: number): string {
    const indexInPage = absoluteIndex - this.currentPage * ITEMS_PER_PAGE;
    const keyLabel = getDisplayKey(indexInPage);
    const choice = this.choices[absoluteIndex];
    const isSelected = absoluteIndex === this.cursor;

    if (isSelected) {
      return `${chalk.cyan('❯')} ${chalk.dim(keyLabel)}  ${chalk.cyan.underline(choice)}`;
    } else {
      return `  ${chalk.dim(keyLabel)}  ${choice}`;
    }
  }

  /**
   * Update only the lines that changed during cursor movement.
   * This avoids full re-render flicker when navigating within a page.
   */
  private updateSelection(oldCursor: number, newCursor: number): void {
    if (oldCursor === newCursor) return;

    const pageStart = this.currentPage * ITEMS_PER_PAGE;
    const pageEnd = Math.min(pageStart + ITEMS_PER_PAGE, this.choices.length);
    const visibleChoices = pageEnd - pageStart;

    // Calculate line positions relative to current cursor
    // We're at the hint line (last line), need to move up
    const oldLineOffset = visibleChoices - (oldCursor - pageStart);
    const newLineOffset = visibleChoices - (newCursor - pageStart);

    // Move up to the old selection line and update it
    process.stdout.write(`\x1b[${oldLineOffset + 1}A`); // +1 for hint line
    process.stdout.write('\x1b[2K'); // Clear line
    process.stdout.write('\r'); // Move to start
    process.stdout.write(this.renderChoiceLine(oldCursor));

    // Calculate relative movement from old line to new line
    const lineDelta = newLineOffset - oldLineOffset;
    if (lineDelta > 0) {
      process.stdout.write(`\x1b[${lineDelta}A`); // Move up
    } else if (lineDelta < 0) {
      process.stdout.write(`\x1b[${-lineDelta}B`); // Move down
    }

    // Update the new selection line
    process.stdout.write('\x1b[2K'); // Clear line
    process.stdout.write('\r'); // Move to start
    process.stdout.write(this.renderChoiceLine(newCursor));

    // Move back to the hint line (bottom)
    const moveDown = newLineOffset + 1; // +1 for hint line
    process.stdout.write(`\x1b[${moveDown}B`);
    process.stdout.write('\r'); // Move to start of line
  }

  private render(): void {
    // Clear previous output if not first render
    if (!this.done && !this.firstRender) {
      this.clearPrompt();
    }
    this.firstRender = false;

    const lines: string[] = [];

    // Prompt line with page indicator
    let promptLine = `${chalk.cyan('?')} ${chalk.bold(this.message)}`;
    if (this.totalPages > 1) {
      promptLine += chalk.dim(` [${this.currentPage + 1}/${this.totalPages}]`);
    }
    lines.push(promptLine);

    // Calculate visible range
    const pageStart = this.currentPage * ITEMS_PER_PAGE;
    const pageEnd = Math.min(pageStart + ITEMS_PER_PAGE, this.choices.length);

    // Render choices
    for (let i = pageStart; i < pageEnd; i++) {
      const indexInPage = i - pageStart;
      const keyLabel = getDisplayKey(indexInPage);
      const choice = this.choices[i];
      const isSelected = i === this.cursor;

      let line: string;
      if (isSelected) {
        line = `${chalk.cyan('❯')} ${chalk.dim(keyLabel)}  ${chalk.cyan.underline(choice)}`;
      } else {
        line = `  ${chalk.dim(keyLabel)}  ${choice}`;
      }
      lines.push(line);
    }

    // Hint line
    let hint: string;
    if (this.totalPages > 1) {
      hint = chalk.dim('(-/+ page, 1-0 select, ↑↓ navigate, Enter confirm)');
    } else {
      const maxKey = this.choices.length === 10 ? '0' : String(this.choices.length);
      hint = chalk.dim(`(1-${maxKey} select, ↑↓ navigate, Enter confirm)`);
    }
    lines.push(hint);

    process.stdout.write(lines.join('\n') + '\n');
  }
}

/**
 * Show a numbered select prompt.
 * Returns the selected value, or null if user aborts (Ctrl+C/Escape).
 */
export async function numberedSelect(
  message: string,
  choices: string[]
): Promise<string | null> {
  const prompt = new NumberedSelectPrompt({ message, choices });
  const result = await prompt.run();
  if (result.aborted) {
    return null; // User cancelled - signal quit
  }
  return result.value ?? null;
}

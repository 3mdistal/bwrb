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
    if (this.cursor > 0) {
      this.cursor--;
      // Update page if cursor moved to previous page
      const newPage = Math.floor(this.cursor / ITEMS_PER_PAGE);
      if (newPage !== this.currentPage) {
        this.currentPage = newPage;
      }
      this.render();
    } else {
      // Wrap to end
      this.cursor = this.choices.length - 1;
      this.currentPage = Math.floor(this.cursor / ITEMS_PER_PAGE);
      this.render();
    }
  }

  private moveDown(): void {
    if (this.cursor < this.choices.length - 1) {
      this.cursor++;
      // Update page if cursor moved to next page
      const newPage = Math.floor(this.cursor / ITEMS_PER_PAGE);
      if (newPage !== this.currentPage) {
        this.currentPage = newPage;
      }
      this.render();
    } else {
      // Wrap to beginning
      this.cursor = 0;
      this.currentPage = 0;
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

  private render(): void {
    // Clear previous output if not first render
    if (!this.done) {
      this.clearPrompt();
    }

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
 * Returns undefined if user aborts.
 */
export async function numberedSelect(
  message: string,
  choices: string[]
): Promise<string | undefined> {
  const prompt = new NumberedSelectPrompt({ message, choices });
  const result = await prompt.run();
  return result.value;
}

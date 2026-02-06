import { describe, expect, it } from 'vitest';
import { extractHelpCommands } from './help.js';

describe('extractHelpCommands', () => {
  it('returns empty list when Commands section is missing', () => {
    const stdout = `
Usage: bwrb [options] [command]

Options:
  -h, --help  display help for command
`;

    expect(extractHelpCommands(stdout)).toEqual([]);
  });

  it('extracts command names in display order', () => {
    const stdout = `
Usage: bwrb [options] [command]

Commands:
  new <title>        Create a new note
  edit <query>       Edit a note
  delete <query>     Delete a note

Options:
  -h, --help         display help for command
`;

    expect(extractHelpCommands(stdout)).toEqual(['new', 'edit', 'delete']);
  });

  it('ignores wrapped description continuation lines', () => {
    const stdout = `
Commands:
  dashboard list     List saved queries with long description text that wraps
                     onto another line in narrow terminals
  dashboard new      Create a saved query
  dashboard edit     Edit a saved query
Options:
  -h, --help         display help for command
`;

    expect(extractHelpCommands(stdout)).toEqual(['dashboard']);
  });

  it('normalizes ANSI and CRLF output', () => {
    const stdout =
      '\u001b[1mUsage:\u001b[0m bwrb [options] [command]\r\n\r\n\u001b[1mCommands:\u001b[0m\r\n' +
      '  new <title>      Create a note\r\n' +
      '  edit <query>     Edit a note\r\n' +
      '\r\nOptions:\r\n' +
      '  -h, --help       display help for command\r\n';

    expect(extractHelpCommands(stdout)).toEqual(['new', 'edit']);
  });

  it('ignores alias-like command specs that are not stable command names', () => {
    const stdout = `
commands:
  serve|s            Start server
  list [type]        List notes
`;

    expect(extractHelpCommands(stdout)).toEqual(['list']);
  });
});

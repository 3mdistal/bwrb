import { describe, expect, it } from 'vitest';
import {
  assertCanonicalHelpCommandOrdering,
  CANONICAL_HELP_COMMAND_ORDER,
  extractHelpCommands,
} from '../helpers/help.js';

function buildHelpOutput(commandRows: string[], sectionsAfter: string[] = ['Options:']): string {
  const commands = commandRows.map((line) => `  ${line}`).join('\n');
  return [
    'Usage: bwrb [options] [command]',
    '',
    'Commands:',
    commands,
    ...sectionsAfter,
  ].join('\n');
}

describe('help parser', () => {
  it('parses command names from the Commands section only', () => {
    const output = [
      'Usage: bwrb [options] [command]',
      '',
      'Commands:',
      '  new [options] [type]         Create a new note (interactive type navigation',
      '                               if type omitted)',
      '  edit [options] [query]       Edit an existing note',
      '  delete [options] [query]     Delete notes from the vault',
      'Options:',
      '  -h, --help                   display help for command',
    ].join('\n');

    expect(extractHelpCommands(output)).toEqual(['new', 'edit', 'delete']);
  });

  it('supports CRLF line endings', () => {
    const output = buildHelpOutput([
      'new [options] [type]         Create a new note',
      'edit [options] [query]       Edit an existing note',
    ]).replace(/\n/g, '\r\n');

    expect(extractHelpCommands(output)).toEqual(['new', 'edit']);
  });

  it('throws when Commands section is missing', () => {
    const output = ['Usage: bwrb [options] [command]', '', 'Options:'].join('\n');

    expect(() => extractHelpCommands(output)).toThrow(/Commands:/);
  });

  it('throws when no command entries are present', () => {
    const output = ['Usage: bwrb [options] [command]', '', 'Commands:', '', 'Options:'].join('\n');

    expect(() => extractHelpCommands(output)).toThrow(/no command entries/i);
  });

  it('throws when duplicate commands are present', () => {
    const output = buildHelpOutput([
      'new [options] [type]         Create a new note',
      'new [options] [type]         Create a new note again',
    ]);

    expect(() => extractHelpCommands(output)).toThrow(/Duplicate commands/);
  });

  it('accepts canonical ordering with optional trailing help', () => {
    const commandRows = [
      ...CANONICAL_HELP_COMMAND_ORDER.map((name) => `${name} [options] description`),
      'help [command] display help for command',
    ];
    const commands = extractHelpCommands(buildHelpOutput(commandRows));

    expect(() => assertCanonicalHelpCommandOrdering(commands)).not.toThrow();
  });

  it('rejects help when it is not trailing', () => {
    const commandRows = [
      ...CANONICAL_HELP_COMMAND_ORDER.slice(0, 2).map((name) => `${name} [options] description`),
      'help [command] display help for command',
      ...CANONICAL_HELP_COMMAND_ORDER.slice(2).map((name) => `${name} [options] description`),
    ];
    const commands = extractHelpCommands(buildHelpOutput(commandRows));

    expect(() => assertCanonicalHelpCommandOrdering(commands)).toThrow(/must appear at the end/);
  });
});

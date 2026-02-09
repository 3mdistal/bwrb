const CANONICAL_HELP_COMMAND_ORDER = [
  'new',
  'edit',
  'delete',
  'list',
  'open',
  'search',
  'schema',
  'audit',
  'bulk',
  'template',
  'dashboard',
  'init',
  'config',
  'completion',
] as const;

const SECTION_HEADER_RE = /^[A-Z][A-Za-z0-9 /-]*:\s*$/;
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;

function formatList(values: string[]): string {
  return values.join(', ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeHelpOutput(helpOutput: string): string {
  const normalizedLineEndings = helpOutput.replace(/\r\n/g, '\n');
  const withoutAnsi = normalizedLineEndings.replace(ANSI_ESCAPE_RE, '');
  const withoutVersion = withoutAnsi.replace(VERSION_RE, '<VERSION>');
  const projectRoot = escapeRegExp(process.cwd());
  const withoutProjectRoot = withoutVersion.replace(
    new RegExp(`${projectRoot}[^\s]*`, 'g'),
    '<PATH>'
  );

  return withoutProjectRoot.trim();
}

export function parseHelpCommandNames(helpOutput: string): string[] {
  const normalized = helpOutput.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const commandsHeaderIndex = lines.findIndex((line) => line.trim() === 'Commands:');

  if (commandsHeaderIndex === -1) {
    throw new Error('Could not find "Commands:" section in help output.');
  }

  const sectionLines: string[] = [];
  for (let i = commandsHeaderIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length > 0 && SECTION_HEADER_RE.test(trimmed)) {
      break;
    }

    sectionLines.push(line);
  }

  const entryLines = sectionLines.filter((line) => /^\s+\S/.test(line));
  const leadingIndents = entryLines.map((line) => line.match(/^\s*/)![0].length);

  if (leadingIndents.length === 0) {
    throw new Error('Found "Commands:" section but no command entries were parsed.');
  }

  const commandIndent = Math.min(...leadingIndents);
  const commandLineRe = new RegExp(`^\\s{${commandIndent}}([a-z][a-z0-9-]*)\\b`);

  const commands = entryLines
    .map((line) => {
      const match = line.match(commandLineRe);
      return match ? match[1] : null;
    })
    .filter((command): command is string => command !== null);

  if (commands.length === 0) {
    throw new Error('Found "Commands:" section but failed to extract command names.');
  }

  const duplicates = [...new Set(commands.filter((command, index) => commands.indexOf(command) !== index))];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate commands found in help output: ${formatList(duplicates)}`);
  }

  return commands;
}

export function assertCanonicalHelpCommandOrdering(commands: string[]): void {
  const helpIndex = commands.indexOf('help');
  if (helpIndex !== -1 && helpIndex !== commands.length - 1) {
    throw new Error('Optional "help" command must appear at the end of the Commands section.');
  }

  const commandsWithoutHelp = commands.filter((command) => command !== 'help');
  const expected = [...CANONICAL_HELP_COMMAND_ORDER];

  const matchesCanonicalOrder =
    commandsWithoutHelp.length === expected.length
    && commandsWithoutHelp.every((command, index) => command === expected[index]);

  if (!matchesCanonicalOrder) {
    throw new Error(
      `Unexpected command ordering. Expected: [${formatList(expected)}]. Actual: [${formatList(commandsWithoutHelp)}].`
    );
  }
}

export { CANONICAL_HELP_COMMAND_ORDER };

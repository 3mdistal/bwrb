const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function normalizeHelpOutput(stdout: string): string {
  return stdout
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Extract command names from Commander help output.
 *
 * Parses only the "Commands:" section and returns command names in display order.
 */
export function extractHelpCommands(stdout: string): string[] {
  const lines = normalizeHelpOutput(stdout).split('\n');
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === 'commands:');

  if (startIndex === -1) {
    return [];
  }

  const commands: string[] = [];
  const seen = new Set<string>();

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      continue;
    }

    if (!line.startsWith(' ') && !line.startsWith('\t') && trimmed.endsWith(':')) {
      break;
    }

    const match = line.match(/^\s+(.+?)\s{2,}.+$/);
    if (!match) {
      continue;
    }

    const commandSpec = (match[1] ?? '').trim();
    if (!commandSpec) {
      continue;
    }

    const commandName = commandSpec.split(/\s+/)[0] ?? '';
    if (!COMMAND_NAME_PATTERN.test(commandName)) {
      continue;
    }

    if (!seen.has(commandName)) {
      seen.add(commandName);
      commands.push(commandName);
    }
  }

  return commands;
}

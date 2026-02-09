const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeHelpOutput(helpOutput: string): string {
  const normalizedLineEndings = helpOutput.replace(/\r\n/g, '\n');
  const withoutAnsi = normalizedLineEndings.replace(ANSI_ESCAPE_RE, '');
  const withoutVersion = withoutAnsi.replace(VERSION_RE, '<VERSION>');
  const projectRoot = escapeRegExp(process.cwd());
  const withoutProjectRoot = withoutVersion.replace(
    new RegExp(`${projectRoot}[^\\s]*`, 'g'),
    '<PATH>'
  );

  const trimmed = withoutProjectRoot.trim();
  const withoutWrappingQuotes = trimmed.replace(/^"+/, '').replace(/"+$/, '');

  return withoutWrappingQuotes;
}
export {
  assertCanonicalHelpCommandOrdering,
  CANONICAL_HELP_COMMAND_ORDER,
  extractHelpCommands,
} from '../helpers/help.js';

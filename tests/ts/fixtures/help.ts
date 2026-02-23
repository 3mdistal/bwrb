import { PROJECT_ROOT, runCLI } from './setup.js';

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;
const WINDOWS_TEMP_BWRB_RE = /[A-Za-z]:\\[^\s"']*bwrb-test-[^\s"']*/g;
const UNIX_TEMP_BWRB_RE = /\/tmp\/bwrb-test-[^\s"']*/g;
const SEMVER_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NormalizeHelpOptions {
  vaultDir?: string;
  replaceVersion?: boolean;
}

export function normalizeCliHelpForSnapshot(text: string, options: NormalizeHelpOptions = {}): string {
  const replacementTargets = [PROJECT_ROOT, options.vaultDir].filter(
    (value): value is string => Boolean(value)
  );

  let normalized = text.replace(/\r\n/g, '\n').replace(ANSI_ESCAPE_RE, '');

  for (const target of replacementTargets.sort((a, b) => b.length - a.length)) {
    normalized = normalized.replace(new RegExp(escapeRegExp(target), 'g'), '<path>');
  }

  normalized = normalized.replace(WINDOWS_TEMP_BWRB_RE, '<path>');
  normalized = normalized.replace(UNIX_TEMP_BWRB_RE, '<path>');

  if (options.replaceVersion) {
    normalized = normalized.replace(SEMVER_RE, '<version>');
  }

  normalized = normalized
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized;
}

export async function runHelp(args: string[], vaultDir?: string) {
  const helpArgs = args.includes('--help') ? args : [...args, '--help'];
  return runCLI(helpArgs, vaultDir, undefined, {
    trimOutput: false,
    env: {
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TERM: 'dumb',
      COLUMNS: '120',
      LINES: '40',
    },
  });
}

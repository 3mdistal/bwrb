import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import {
  analyzeLinks,
  buildConceptsFromDocuments,
  collectConceptRegistry,
  collectLinksForDocuments,
  docsFilePathToHref,
  formatViolations,
  relativePath,
} from './lib/docs-link-consistency-core.mjs';

const DEFAULT_DOCS_DIR = path.join('docs-site', 'src', 'content', 'docs');
const DEFAULT_OVERRIDES_PATH = path.join(DEFAULT_DOCS_DIR, '.link-consistency.json');

const listMarkdownFiles = dirPath => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
};

const parseArgs = argv => {
  const options = {
    docsDir: DEFAULT_DOCS_DIR,
    overridesPath: DEFAULT_OVERRIDES_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--docs-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --docs-dir');
      }
      options.docsDir = value;
      index += 1;
      continue;
    }

    if (arg === '--overrides') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --overrides');
      }
      options.overridesPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const loadOverrides = overridesPath => {
  if (!fs.existsSync(overridesPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
};

const createDocuments = (rootDir, docsDir) => {
  const docsRoot = path.resolve(rootDir, docsDir);
  const markdownFiles = listMarkdownFiles(docsRoot);

  return markdownFiles.map(filePath => {
    const relativeFilePath = relativePath(docsRoot, filePath);
    const href = docsFilePathToHref(relativeFilePath);
    const markdown = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(markdown);

    return {
      absolutePath: filePath,
      filePath: path.posix.join(docsDir, relativeFilePath),
      relativeFilePath,
      href,
      markdown,
      title: typeof parsed.data.title === 'string' ? parsed.data.title.trim() : '',
    };
  });
};

const findConceptDocuments = documents =>
  documents.filter(document =>
    document.relativeFilePath.startsWith('concepts/') ||
    document.relativeFilePath === 'reference/targeting.md'
  );

/**
 * @typedef {{ write: (chunk: string | Uint8Array) => boolean }} StderrWriter
 * @typedef {{ cwd?: string, argv?: string[], stderrWriter?: StderrWriter }} LintOptions
 */

/** @param {LintOptions} options */
export const runDocsLinkConsistencyLint = ({
  cwd = process.cwd(),
  argv = [],
  stderrWriter = process.stderr,
} = {}) => {
  const options = parseArgs(argv);
  const docsDir = path.resolve(cwd, options.docsDir);
  const overridesPath = path.resolve(cwd, options.overridesPath);

  if (!fs.existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }

  const documents = createDocuments(cwd, options.docsDir);
  const conceptDocuments = findConceptDocuments(documents);
  const concepts = buildConceptsFromDocuments(conceptDocuments);
  const overrides = loadOverrides(overridesPath);

  const registry = collectConceptRegistry(concepts, overrides);
  if (registry.errors.length > 0) {
    for (const error of registry.errors) {
      stderrWriter.write(`docs:lint config error: ${error}\n`);
    }
    return 2;
  }

  const links = collectLinksForDocuments(documents);
  const violations = analyzeLinks(registry, links);
  if (violations.length > 0) {
    stderrWriter.write(`${formatViolations(violations)}\n`);
    stderrWriter.write(
      `docs:lint found ${violations.length} link consistency violation${
        violations.length === 1 ? '' : 's'
      }.\n`
    );
    return 1;
  }

  return 0;
};

const main = () => {
  const exitCode = runDocsLinkConsistencyLint({ argv: process.argv.slice(2) });
  process.exitCode = exitCode;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

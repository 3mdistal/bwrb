#!/usr/bin/env node

/* global process */

import fs from 'fs/promises';
import path from 'path';
import {
  buildDigest,
  parseVitestJson,
  renderDigest,
} from './pty-summary-core.mjs';

const DEFAULT_RESULTS_FILE = path.resolve('artifacts/pty/results.json');
const DEFAULT_LOG_DIR = path.resolve('artifacts/pty/logs');

function parseArgs(argv) {
  let resultsFile = DEFAULT_RESULTS_FILE;
  let logDir = DEFAULT_LOG_DIR;
  let previewLines = 12;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--results' && argv[i + 1]) {
      resultsFile = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--logs' && argv[i + 1]) {
      logDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--preview-lines' && argv[i + 1]) {
      previewLines = Number(argv[i + 1]);
      i += 1;
    }
  }

  return { resultsFile, logDir, previewLines };
}

async function loadTranscripts(logDir) {
  let entries;
  try {
    entries = await fs.readdir(logDir);
  } catch {
    return [];
  }

  const metadataFiles = entries.filter((name) => name.endsWith('.meta.json'));
  const transcripts = [];
  for (const metadataFile of metadataFiles) {
    const metadataPath = path.join(logDir, metadataFile);
    try {
      const metaRaw = await fs.readFile(metadataPath, 'utf8');
      const meta = JSON.parse(metaRaw);
      const logFile = typeof meta.logFile === 'string' ? meta.logFile : null;
      if (!logFile) continue;

      const logPath = path.join(logDir, logFile);
      const logRaw = await fs.readFile(logPath, 'utf8');
      const preview = logRaw
        .trimEnd()
        .split(/\r?\n/)
        .filter(Boolean);

      transcripts.push({
        id: meta.id ?? metadataFile.replace(/\.meta\.json$/, ''),
        testName: typeof meta.testName === 'string' ? meta.testName : null,
        testPath: typeof meta.testPath === 'string' ? meta.testPath : null,
        logFile,
        preview,
      });
    } catch {
      // Keep summary deterministic even if one metadata entry is malformed.
    }
  }

  return transcripts;
}

async function main() {
  const { resultsFile, logDir, previewLines } = parseArgs(process.argv.slice(2));

  let rawResults;
  try {
    rawResults = await fs.readFile(resultsFile, 'utf8');
  } catch {
    rawResults = '';
  }

  const parsed = parseVitestJson(rawResults);
  const transcripts = await loadTranscripts(logDir);
  const digest = buildDigest(parsed, transcripts, previewLines);

  process.stdout.write(`${renderDigest(digest)}\n`);
}

main().catch((error) => {
  process.stderr.write(`pty-summary failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const cwd = process.cwd();

const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const normalizeEntryPath = entry => {
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new Error(`Invalid entrypoint path: ${String(entry)}`);
  }

  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  const clean = path.posix.normalize(normalized);

  if (path.posix.isAbsolute(clean)) {
    throw new Error(`Entrypoint must be relative: ${entry}`);
  }

  const parts = clean.split('/');
  if (parts.includes('..')) {
    throw new Error(`Entrypoint must not traverse: ${entry}`);
  }

  return clean;
};

const collectExportTargets = exportsField => {
  const targets = [];

  const visit = value => {
    if (typeof value === 'string') {
      targets.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        visit(nested);
      }
    }
  };

  visit(exportsField);
  return targets;
};

const getEntrypoints = pkg => {
  const entrypoints = new Set();

  if (typeof pkg.bin === 'string') {
    entrypoints.add(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const target of Object.values(pkg.bin)) {
      entrypoints.add(target);
    }
  }

  if (typeof pkg.main === 'string') {
    entrypoints.add(pkg.main);
  }

  if (pkg.exports) {
    for (const target of collectExportTargets(pkg.exports)) {
      entrypoints.add(target);
    }
  }

  return Array.from(entrypoints).map(normalizeEntryPath);
};

const getPrimaryBinName = pkg => {
  if (typeof pkg.bin === 'string') {
    return pkg.name;
  }

  if (pkg.bin && typeof pkg.bin === 'object') {
    const [first] = Object.keys(pkg.bin);
    return first || pkg.name;
  }

  return pkg.name;
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });

const runJson = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', ...options });

const parseJsonFromOutput = output => {
  const match = output.match(/(?:^|\n)(\[|\{)/);
  if (!match) {
    throw new Error('npm pack did not return JSON output');
  }

  const start = output.indexOf(match[1], match.index);
  if (start === -1) {
    throw new Error('npm pack JSON output could not be located');
  }

  const jsonText = output.slice(start).trim();
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`npm pack JSON parsing failed: ${error.message}`);
  }
};

const listTarFiles = tarballPath => {
  const output = runJson('tar', ['-tf', tarballPath]);
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^package\//, ''))
    .map(line => line.replace(/\/$/, ''));
};

const verifyEntrypointsPresent = (tarFiles, entrypoints) => {
  const fileSet = new Set(tarFiles);
  const missing = entrypoints.filter(entry => !fileSet.has(entry));
  if (missing.length > 0) {
    throw new Error(`Missing entrypoints in tarball: ${missing.join(', ')}`);
  }

  if (!fileSet.has('package.json')) {
    throw new Error('Missing package.json in tarball');
  }
};

const installAndSmokeTest = ({ tarballPath, binName, ignoreScripts }) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrb-pack-'));
  const npmArgs = ['install', tarballPath];

  if (ignoreScripts) {
    npmArgs.splice(1, 0, '--ignore-scripts');
  }

  try {
    run('npm', npmArgs, { cwd: tempDir });

    const binPath = path.join(
      tempDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? `${binName}.cmd` : binName
    );

    if (!fs.existsSync(binPath)) {
      throw new Error(`Missing bin executable: ${binPath}`);
    }

    run(binPath, ['--help'], { cwd: tempDir });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const main = () => {
  const packageJsonPath = path.join(cwd, 'package.json');
  const pkg = readJson(packageJsonPath);

  fs.rmSync(path.join(cwd, 'dist'), { recursive: true, force: true });

  const packOutput = runJson('npm', ['pack', '--json'], { cwd });
  const packResult = parseJsonFromOutput(packOutput);
  const tarballName = packResult?.[0]?.filename;

  if (!tarballName) {
    throw new Error('npm pack did not return a tarball filename');
  }

  const tarballPath = path.join(cwd, tarballName);
  const entrypoints = getEntrypoints(pkg);
  const binName = getPrimaryBinName(pkg);

  try {
    const tarFiles = listTarFiles(tarballPath);
    verifyEntrypointsPresent(tarFiles, entrypoints);
    installAndSmokeTest({ tarballPath, binName, ignoreScripts: true });
    installAndSmokeTest({ tarballPath, binName, ignoreScripts: false });
  } finally {
    fs.rmSync(tarballPath, { force: true });
  }
};

main();

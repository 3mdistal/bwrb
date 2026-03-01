import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const docsSiteDir = path.join(rootDir, 'docs-site');
const nodeModulesDir = path.join(docsSiteDir, 'node_modules');

let hasError = false;

function logError(msg) {
  process.stderr.write(`\x1b[31m[docs-doctor] ERROR: ${msg}\x1b[0m\n`);
  hasError = true;
}

function checkDocsSite() {
  if (!fs.existsSync(nodeModulesDir)) {
    logError(`docs-site/node_modules does not exist. Please run 'pnpm docs:install' or 'cd docs-site && pnpm install'.`);
    return;
  }

  // Check essential dependencies
  const astroPath = path.join(nodeModulesDir, 'astro');
  const starlightPath = path.join(nodeModulesDir, '@astrojs', 'starlight');

  if (!fs.existsSync(astroPath)) {
    logError(`'astro' is not installed in docs-site/node_modules. Please run 'pnpm docs:install' or 'cd docs-site && pnpm install'.`);
  }

  if (!fs.existsSync(starlightPath)) {
    logError(`'@astrojs/starlight' is not installed in docs-site/node_modules. Please run 'pnpm docs:install' or 'cd docs-site && pnpm install'.`);
  }

  // Read .modules.yaml
  const modulesYamlPath = path.join(nodeModulesDir, '.modules.yaml');
  if (fs.existsSync(modulesYamlPath)) {
    try {
      const content = fs.readFileSync(modulesYamlPath, 'utf-8');

      const match = content.match(/ignoredBuilds:\n((?: {2}- .+\n?)*)/);
      if (match && match[1]) {
        const ignored = match[1]
          .split('\n')
          .map(line => line.trim().replace(/^- /, ''))
          .filter(Boolean);

        const criticalBuilds = ignored.filter(pkg => pkg.includes('sharp') || pkg.includes('esbuild'));

        if (criticalBuilds.length > 0) {
          logError(`pnpm has ignored build scripts for critical packages: ${criticalBuilds.join(', ')}.`);
          process.stderr.write(`\x1b[33m[docs-doctor] SUGGESTION: Run 'cd docs-site && pnpm approve-builds' followed by 'pnpm install' to fix this.\x1b[0m\n`);
        }
      }
    } catch (e) {
      logError(`Failed to read docs-site/node_modules/.modules.yaml: ${e.message}`);
    }
  }
}

checkDocsSite();

if (hasError) {
  process.exitCode = 1;
} else {
  process.stdout.write(`\x1b[32m[docs-doctor] All checks passed!\x1b[0m\n`);
}

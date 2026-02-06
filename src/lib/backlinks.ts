import { basename } from 'path';
import { spawn } from 'child_process';

/**
 * Find files that contain wikilinks to the given note.
 * Uses ripgrep to search for [[NoteName]] patterns.
 */
export async function findBacklinks(vaultDir: string, relativePath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const noteName = basename(relativePath, '.md');
    const pattern = `\\[\\[(${escapeRegex(noteName)}|${escapeRegex(relativePath.replace(/\.md$/, ''))})(\\|[^\\]]*)?\\]\\]`;

    const args = [
      '--files-with-matches',
      '--glob', '*.md',
      '--regexp', pattern,
      '--ignore-case',
    ];

    const rg = spawn('rg', args, {
      cwd: vaultDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    rg.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    rg.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        const files = stdout.trim().split('\n').filter(Boolean);
        resolve(files.filter((file) => file !== relativePath));
      } else {
        resolve([]);
      }
    });

    rg.on('error', () => {
      resolve([]);
    });
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

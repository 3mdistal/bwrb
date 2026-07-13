import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FixtureProfile = 'small' | 'medium' | 'large' | 'realistic' | 'teenylilthoughts-analogue-5k' | 'teenylilthoughts-analogue';

const PROFILE_COUNTS: Record<FixtureProfile, number> = {
  small: 25,
  medium: 500,
  large: 10_000,
  realistic: 96,
  'teenylilthoughts-analogue-5k': 5_000,
  'teenylilthoughts-analogue': 10_000,
};

const DEFAULT_SEED = 'bwrb-benchmark-fixtures-v1';

type Manifest = {
  format: 1;
  profile: FixtureProfile;
  seed: string;
  schemaVersion: number;
  noteCount: number;
  typeCounts: Record<string, number>;
  maxDirectoryDepth: number;
  bodySizeDistribution: Record<string, number>;
  relationDensity: number;
  checksum: string;
  audit: { expectedIssueCount: number; state: 'known-warnings' };
  analogue?: {
    bodyPolicy: 'empty';
    liveSchemaCopied: false;
    noteBodiesCopied: false;
    purpose: 'count-comparable-structurally-synthetic';
  };
};

const schema = {
  version: 2,
  traits: {
    timestamped: { fields: { created: { prompt: 'date' } } },
    tagged: { fields: { tags: { prompt: 'list', list_format: 'yaml-array' } } },
  },
  types: {
    note: { output_dir: 'Notes', fields: { type: { value: 'note' }, name: { prompt: 'text', required: true }, aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' } } },
    objective: { extends: 'note', output_dir: 'Objectives', traits: ['timestamped'], fields: { type: { value: 'objective' }, status: { prompt: 'select', options: ['active', 'paused', 'done'], required: true } } },
    task: { extends: 'objective', output_dir: 'Objectives/Tasks', traits: ['tagged'], fields: { type: { value: 'task' }, status: { prompt: 'select', options: ['next', 'active', 'done'], required: true }, parent: { prompt: 'relation', source: ['objective', 'task'] }, deadline: { prompt: 'date', granularity: 'month' } } },
    project: { extends: 'objective', output_dir: 'Projects', fields: { type: { value: 'project' }, status: { prompt: 'select', options: ['active', 'paused', 'done'], required: true }, related: { prompt: 'relation', source: ['project', 'person'], multiple: true } } },
    person: { extends: 'note', output_dir: 'Entities/People', fields: { type: { value: 'person' }, role: { prompt: 'select', options: ['friend', 'collaborator', 'reference'] } } },
    event: { extends: 'note', output_dir: 'Calendar/Events', fields: { type: { value: 'event' }, start: { prompt: 'date' }, position: { prompt: 'relative-date', source: 'event' } } },
    draft: { extends: 'note', output_dir: 'Drafts', traits: ['tagged'], fields: { type: { value: 'draft' }, status: { prompt: 'select', options: ['seed', 'working', 'published'] } } },
  },
  config: { excluded_directories: ['.bench'] },
};

function pad(value: number): string { return String(value).padStart(5, '0'); }
function id(index: number): string { return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`; }
function isAnalogue(profile: FixtureProfile): boolean { return profile.startsWith('teenylilthoughts-analogue'); }
function body(index: number, profile: FixtureProfile): string {
  if (isAnalogue(profile)) return '';
  const tier = index % 5;
  if (tier === 0) return '';
  if (tier === 1) return `A compact deterministic benchmark note ${index}.\n`;
  if (tier === 2) return `## Context\nA medium benchmark body ${index}.\n\n## Notes\nStable seed content.\n`;
  return `# Benchmark note ${index}\n\n${'This deliberately ordinary prose gives discovery and parsing a repeatable body shape. '.repeat(tier * 3)}\n`;
}

function yamlList(values: string[]): string { return values.length ? `\n${values.map(value => `  - ${JSON.stringify(value)}`).join('\n')}` : ' []'; }
function pathFor(type: string, index: number): string {
  const shard = `Area-${String(index % 12).padStart(2, '0')}`;
  const dir = type === 'task' ? `Objectives/Tasks/${shard}/Sprint-${Math.floor(index / 120)}` : type === 'objective' ? 'Objectives' : type === 'draft' ? `Drafts/${shard}/Series-${Math.floor(index / 90)}` : type === 'event' ? `Calendar/Events/${shard}` : type === 'person' ? `Entities/People/${shard}` : type === 'project' ? `Projects/${shard}` : 'Notes';
  return `${dir}/${type}-${pad(index)}.md`;
}

function note(type: string, index: number, profile: FixtureProfile): string {
  const name = `${type} ${pad(index)}`;
  const lines = ['---', `type: ${type}`, `id: ${id(index)}`, `name: ${JSON.stringify(name)}`];
  if (index % 11 === 0) lines.push(`aliases:${yamlList([`${type} alias ${pad(index)}`, `benchmark-${index}`])}`);
  if (index > 7 && index % 17 === 0) lines.push(`forked-from: ${id(index - 7)}`);
  if (type === 'objective' || type === 'project') lines.push(`status: ${index % 4 === 0 ? 'paused' : 'active'}`, `created: 2026-01-${String((index % 28) + 1).padStart(2, '0')}`);
  if (type === 'task') {
    const objectiveIndex = Math.floor(index / 7) * 7 + 1;
    lines.push(`status: ${index % 3 === 0 ? 'active' : 'next'}`, `parent: "[[objective-${pad(objectiveIndex)}]]"`, `deadline: ${JSON.stringify(`2026-${String((index % 12) + 1).padStart(2, '0')}`)}`, `tags:${yamlList(['benchmark', `shard-${index % 12}`])}`);
  }
  if (type === 'project') {
    const cycle = Math.floor(index / 7) * 7;
    const related = [`[[person-${pad(cycle + 4)}]]`];
    if (index >= 10) related.push(`[[project-${pad(index - 7)}]]`);
    lines.push(`related:${yamlList(related)}`);
  }
  if (type === 'person') lines.push(`role: ${['friend', 'collaborator', 'reference'][index % 3]}`);
  if (type === 'event') {
    lines.push(`start: 2026-02-${String((index % 28) + 1).padStart(2, '0')}`);
    if (index >= 12 && index % 4 === 0) lines.push(`position: ${JSON.stringify([{ kind: 'equal', ref: `[[event-${pad(index - 7)}]]`, field: 'start', offset: '2h' }])}`);
  }
  if (type === 'draft') lines.push(`status: ${['seed', 'working', 'published'][index % 3]}`, `tags:${yamlList(['writing', `season-${index % 4}`])}`);
  if (isAnalogue(profile)) lines.push('metadata-only: true');
  return `${lines.join('\n')}\n---\n${body(index, profile)}`;
}

function typesFor(_profile: FixtureProfile, count: number): string[] {
  const types = ['note', 'objective', 'task', 'project', 'person', 'event', 'draft'];
  return Array.from({ length: count }, (_, index) => types[index % types.length]!);
}

async function checksum(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path); else files.push(path);
    }
  }
  await walk(root);
  const { readFile } = await import('node:fs/promises');
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    if (file === join(root, 'fixture-manifest.json')) continue;
    hash.update(file.slice(root.length + 1)).update('\0').update(await readFile(file));
  }
  return hash.digest('hex');
}

export async function generateFixture(profile: FixtureProfile, outDir: string, seed = DEFAULT_SEED): Promise<Manifest> {
  if (seed !== DEFAULT_SEED) throw new Error(`Unsupported seed ${JSON.stringify(seed)}; this fixture family has one versioned deterministic seed.`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, '.bwrb'), { recursive: true });
  await writeFile(join(outDir, '.bwrb/schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  const typeCounts: Record<string, number> = {};
  const bodySizeDistribution: Record<string, number> = { empty: 0, small: 0, medium: 0, large: 0 };
  let relations = 0;
  for (const [index, type] of typesFor(profile, PROFILE_COUNTS[profile]).entries()) {
    const relative = pathFor(type, index);
    const content = note(type, index, profile);
    await mkdir(dirname(join(outDir, relative)), { recursive: true });
    await writeFile(join(outDir, relative), content);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    const bytes = Buffer.byteLength(body(index, profile));
    bodySizeDistribution[bytes === 0 ? 'empty' : bytes < 80 ? 'small' : bytes < 200 ? 'medium' : 'large']!++;
    relations += type === 'task' ? 1 : type === 'project' ? (index >= 10 ? 2 : 1) : 0;
  }
  const manifest: Manifest = {
    format: 1, profile, seed, schemaVersion: schema.version, noteCount: PROFILE_COUNTS[profile], typeCounts,
    maxDirectoryDepth: 4, bodySizeDistribution, relationDensity: Number((relations / PROFILE_COUNTS[profile]).toFixed(4)),
    checksum: '', audit: { expectedIssueCount: 3, state: 'known-warnings' },
    ...(isAnalogue(profile) ? {
      analogue: {
        bodyPolicy: 'empty' as const,
        liveSchemaCopied: false as const,
        noteBodiesCopied: false as const,
        purpose: 'count-comparable-structurally-synthetic' as const,
      },
    } : {}),
  };
  await writeFile(join(outDir, 'fixture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  manifest.checksum = await checksum(outDir);
  await writeFile(join(outDir, 'fixture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(args: string[]): { profile: FixtureProfile; out: string; seed: string } {
  const profile = args[args.indexOf('--profile') + 1] as FixtureProfile | undefined;
  const out = args[args.indexOf('--out') + 1];
  const seed = args.includes('--seed') ? args[args.indexOf('--seed') + 1]! : DEFAULT_SEED;
  if (!profile || !(profile in PROFILE_COUNTS) || !out) throw new Error('Usage: pnpm exec tsx tools/bench/generate-fixtures.ts --profile <small|medium|large|realistic|teenylilthoughts-analogue> --out <explicit-directory> [--seed bwrb-benchmark-fixtures-v1]');
  return { profile, out, seed };
}

if (process.argv[1]?.endsWith('generate-fixtures.ts')) {
  const { profile, out, seed } = parseArgs(process.argv.slice(2));
  generateFixture(profile, out, seed).then(manifest => console.log(JSON.stringify(manifest))).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

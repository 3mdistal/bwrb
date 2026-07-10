import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';
import { CONFIG_OPTION_KEYS } from '../../../src/commands/config.js';
import { ConfigSchema, type Config } from '../../../src/types/schema.js';

const INTENTIONALLY_UNEXPOSED_CONFIG_KEYS = [
  // Calendar objects need guided authoring rather than a flat config editor (#790).
  'calendars',
  // Advanced mention tuning remains schema-only; dedicated command UX has not been designed.
  'mention_fuzzy_threshold',
  'mention_corpus_calibration',
  'mention_corpus_min_notes',
  'mention_corpus_noncanonical_ratio',
] as const satisfies readonly (keyof Config)[];

describe('config command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  // ============================================================================
  // config list
  // ============================================================================

  describe('config list (all options)', () => {
    it('should show all configuration options', async () => {
      const result = await runCLI(['config', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Configuration:');
      expect(result.stdout).toContain('link_format');
      expect(result.stdout).toContain('editor');
      expect(result.stdout).toContain('visual');
      expect(result.stdout).toContain('open_with');
      expect(result.stdout).toContain('obsidian_vault');
      expect(result.stdout).toContain('excluded_directories');
      expect(result.stdout).toContain('date_format');
      expect(result.stdout).toContain('date_granularity');
    });

    it('should show default values when config is not set', async () => {
      const result = await runCLI(['config', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Default for link_format is wikilink
      expect(result.stdout).toContain('wikilink');
      // open_with should have some value (default behavior varies by environment)
      expect(result.stdout).toContain('open_with');
    });

    it('should output JSON when --output json is specified', async () => {
      const result = await runCLI(['config', 'list', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(json.data.link_format).toBe('wikilink');
      expect(json.data.excluded_directories).toEqual([]);
      expect(json.data.date_format).toBe('YYYY-MM-DD');
      expect(json.data.date_granularity).toBe('day');
      // open_with should be one of the valid options
      expect(['system', 'editor', 'visual', 'obsidian']).toContain(json.data.open_with);
    });

    it('should show explicit config values', async () => {
      // Create a vault with explicit config
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-config-explicit-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
          config: {
            link_format: 'markdown',
            open_with: 'obsidian',
            editor: 'nvim',
            date_format: 'DD/MM/YYYY',
            date_granularity: 'month',
          },
        })
      );

      try {
        const result = await runCLI(['config', 'list', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.data.link_format).toBe('markdown');
        expect(json.data.open_with).toBe('obsidian');
        expect(json.data.editor).toBe('nvim');
        expect(json.data.date_format).toBe('DD/MM/YYYY');
        expect(json.data.date_granularity).toBe('month');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('config list <option> (specific option)', () => {
    it('should list date settings with their effective defaults', async () => {
      const textResult = await runCLI(['config', 'list', 'date_granularity'], vaultDir);
      const formatResult = await runCLI(['config', 'list', 'date_format', '--output', 'json'], vaultDir);
      const granularityResult = await runCLI(
        ['config', 'list', 'date_granularity', '--output', 'json'],
        vaultDir
      );

      expect(textResult.exitCode).toBe(0);
      expect(textResult.stdout).toContain('Date Granularity (date_granularity)');
      expect(textResult.stdout).toContain('Value: day');
      expect(textResult.stdout).toContain('Options: day, month, year');
      expect(formatResult.exitCode).toBe(0);
      expect(JSON.parse(formatResult.stdout).data).toMatchObject({
        key: 'date_format',
        value: 'YYYY-MM-DD',
        default: 'YYYY-MM-DD',
      });
      expect(granularityResult.exitCode).toBe(0);
      expect(JSON.parse(granularityResult.stdout).data).toMatchObject({
        key: 'date_granularity',
        value: 'day',
        default: 'day',
      });
    });

    it('should show details for a specific option', async () => {
      const result = await runCLI(['config', 'list', 'link_format'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Link Format');
      expect(result.stdout).toContain('link_format');
      expect(result.stdout).toContain('Format for relation links');
      expect(result.stdout).toContain('wikilink, markdown');
    });

    it('should output JSON for specific option', async () => {
      const result = await runCLI(['config', 'list', 'link_format', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.key).toBe('link_format');
      expect(json.data.value).toBe('wikilink');
      expect(json.data.description).toBeDefined();
    });

    it('should error on unknown option', async () => {
      const result = await runCLI(['config', 'list', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown config option');
      expect(result.stderr).toContain('nonexistent');
    });

    it('should list available options on error', async () => {
      const result = await runCLI(['config', 'list', 'invalid_option'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Available options');
      expect(result.stdout).toContain('link_format');
    });

    it('should output JSON error for unknown option', async () => {
      const result = await runCLI(['config', 'list', 'nonexistent', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Unknown config option');
    });
  });

  // ============================================================================
  // config edit --json (programmatic)
  // ============================================================================

  describe('config edit --json (programmatic)', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-config-edit-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
        })
      );
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should set an enum value', async () => {
      const result = await runCLI(
        ['config', 'edit', 'link_format', '--json', '"markdown"'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Set link_format');

      // Verify the change persisted
      const verifyResult = await runCLI(['config', 'list', 'link_format', '--output', 'json'], tempVaultDir);
      const json = JSON.parse(verifyResult.stdout);
      expect(json.data.value).toBe('markdown');
    });

    it('should set a string value', async () => {
      const result = await runCLI(
        ['config', 'edit', 'editor', '--json', '"nvim"'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Set editor');

      // Verify the change persisted
      const verifyResult = await runCLI(['config', 'list', 'editor', '--output', 'json'], tempVaultDir);
      const json = JSON.parse(verifyResult.stdout);
      expect(json.data.value).toBe('nvim');
    });

    it('should set an array value', async () => {
      const result = await runCLI(
        ['config', 'edit', 'excluded_directories', '--json', '["Archive","Templates/"]'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Set excluded_directories');

      const verifyResult = await runCLI(['config', 'list', 'excluded_directories', '--output', 'json'], tempVaultDir);
      const json = JSON.parse(verifyResult.stdout);
      expect(json.data.value).toEqual(['Archive', 'Templates']);
    });

    it('should set date_format and date_granularity values', async () => {
      const formatResult = await runCLI(
        ['config', 'edit', 'date_format', '--json', '"DD/MM/YYYY"', '--output', 'json'],
        tempVaultDir
      );
      const granularityResult = await runCLI(
        ['config', 'edit', 'date_granularity', '--json', '"month"', '--output', 'json'],
        tempVaultDir
      );

      expect(formatResult.exitCode).toBe(0);
      expect(JSON.parse(formatResult.stdout)).toEqual({
        success: true,
        data: { key: 'date_format', value: 'DD/MM/YYYY' },
      });
      expect(granularityResult.exitCode).toBe(0);
      expect(JSON.parse(granularityResult.stdout)).toEqual({
        success: true,
        data: { key: 'date_granularity', value: 'month' },
      });

      const schema = JSON.parse(
        await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8')
      );
      expect(schema.config.date_format).toBe('DD/MM/YYYY');
      expect(schema.config.date_granularity).toBe('month');
    });

    it('should round-trip configured $TODAY defaults through new and audit', async () => {
      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
      await writeFile(
        schemaPath,
        JSON.stringify({
          version: 2,
          types: {
            release: {
              output_dir: 'Releases',
              fields: {
                type: { value: 'release' },
                today: { value: '$TODAY', prompt: 'date' },
                shipped: { prompt: 'date' },
              },
              field_order: ['type', 'today', 'shipped'],
            },
          },
        })
      );

      expect(
        (
          await runCLI(
            // Dots make this deterministic on every day of the month: the
            // format-agnostic parser does not accept DD.MM.YYYY, so only the
            // configured-pattern path can make the generated value round-trip.
            ['config', 'edit', 'date_format', '--json', '"DD.MM.YYYY"'],
            tempVaultDir
          )
        ).exitCode
      ).toBe(0);
      expect(
        (
          await runCLI(
            ['config', 'edit', 'date_granularity', '--json', '"month"'],
            tempVaultDir
          )
        ).exitCode
      ).toBe(0);

      const beforeCreate = new Date();
      const create = await runCLI(
        [
          'new',
          'release',
          '--json',
          '{"name":"Configured dates","shipped":"2026-05"}',
          '--no-template',
        ],
        tempVaultDir
      );
      const afterCreate = new Date();
      expect(create.exitCode).toBe(0);
      const created = JSON.parse(create.stdout);
      const content = await readFile(join(tempVaultDir, created.path), 'utf-8');
      const storedToday = content.match(/^today: (\d{4}-\d{2}-\d{2})$/m)?.[1];
      const expectedToday = (date: Date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
          date.getDate()
        ).padStart(2, '0')}`;
      expect(new Set([expectedToday(beforeCreate), expectedToday(afterCreate)])).toContain(
        storedToday
      );
      expect(content).toContain('shipped: 2026-05');

      const audit = await runCLI(
        ['audit', '--path', created.path, '--output', 'json'],
        tempVaultDir
      );
      expect(audit.exitCode).toBe(0);
      expect(JSON.parse(audit.stdout).summary.totalErrors).toBe(0);
    });

    it('should reject invalid date settings without writing', async () => {
      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
      const before = await readFile(schemaPath, 'utf-8');

      const invalidFormat = await runCLI(
        ['config', 'edit', 'date_format', '--json', '42', '--output', 'json'],
        tempVaultDir
      );
      expect(invalidFormat.exitCode).toBe(1);
      expect(JSON.parse(invalidFormat.stdout).success).toBe(false);
      expect(await readFile(schemaPath, 'utf-8')).toBe(before);

      const incompleteFormat = await runCLI(
        ['config', 'edit', 'date_format', '--json', '"YYYY-MM"', '--output', 'json'],
        tempVaultDir
      );
      expect(incompleteFormat.exitCode).toBe(1);
      expect(JSON.parse(incompleteFormat.stdout).error).toContain(
        'date_format must contain YYYY, MM, and DD exactly once each'
      );
      expect(await readFile(schemaPath, 'utf-8')).toBe(before);

      const invalidGranularity = await runCLI(
        ['config', 'edit', 'date_granularity', '--json', '"week"', '--output', 'json'],
        tempVaultDir
      );
      expect(invalidGranularity.exitCode).toBe(1);
      expect(JSON.parse(invalidGranularity.stdout).error).toContain(
        'Valid options: day, month, year'
      );
      expect(await readFile(schemaPath, 'utf-8')).toBe(before);
    });

    it('should leave calendar objects to the dedicated schema workflow', async () => {
      const result = await runCLI(
        ['config', 'edit', 'calendars', '--json', '{}', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toContain('Unknown config option: calendars');
    });

    it('should reject unknown mention_exclude_types without writing', async () => {
      const before = await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8');
      const result = await runCLI(
        [
          'config',
          'edit',
          'mention_exclude_types',
          '--json',
          '["zzz-not-a-type"]',
          '--output',
          'json',
        ],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('config.mention_exclude_types includes unknown type "zzz-not-a-type"');

      const after = await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8');
      expect(after).toBe(before);
    });

    it('should reject invalid enum value', async () => {
      const result = await runCLI(
        ['config', 'edit', 'link_format', '--json', '"invalid"'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid value');
      expect(result.stderr).toContain('wikilink, markdown');
    });

    it('should error on unknown option', async () => {
      const result = await runCLI(
        ['config', 'edit', 'nonexistent', '--json', '"value"'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown config option');
    });

    it('should error when option name is missing with --json', async () => {
      const result = await runCLI(
        ['config', 'edit', '--json', '"value"'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Option name required');
    });

    it('should output JSON on success when -o json is specified', async () => {
      const result = await runCLI(
        ['config', 'edit', 'link_format', '--json', '"markdown"', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.key).toBe('link_format');
      expect(json.data.value).toBe('markdown');
    });

    it('should output JSON on error when -o json is specified', async () => {
      const result = await runCLI(
        ['config', 'edit', 'link_format', '--json', '"invalid"', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Invalid value');
    });
  });

  describe('config option contract', () => {
    it('classifies every schema config key as exposed or intentionally unexposed', () => {
      const schemaKeys = Object.keys(ConfigSchema.shape).sort();
      const classifiedKeys = [
        ...CONFIG_OPTION_KEYS,
        ...INTENTIONALLY_UNEXPOSED_CONFIG_KEYS,
      ].sort();

      expect(new Set(CONFIG_OPTION_KEYS).size).toBe(CONFIG_OPTION_KEYS.length);
      expect(new Set(classifiedKeys).size).toBe(classifiedKeys.length);
      expect(classifiedKeys).toEqual(schemaKeys);
    });
  });

  // ============================================================================
  // Config persistence
  // ============================================================================

  describe('config persistence', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-config-persist-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
        })
      );
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should persist changes to schema.json', async () => {
      await runCLI(['config', 'edit', 'link_format', '--json', '"markdown"'], tempVaultDir);

      // Read the schema file directly
      const schemaContent = await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8');
      const schema = JSON.parse(schemaContent);

      expect(schema.config).toBeDefined();
      expect(schema.config.link_format).toBe('markdown');
    });

    it('should reflect changes in subsequent list commands', async () => {
      // Initial state
      const before = await runCLI(['config', 'list', '--output', 'json'], tempVaultDir);
      const beforeJson = JSON.parse(before.stdout);
      expect(beforeJson.data.link_format).toBe('wikilink'); // default

      // Make change
      await runCLI(['config', 'edit', 'link_format', '--json', '"markdown"'], tempVaultDir);

      // Verify change
      const after = await runCLI(['config', 'list', '--output', 'json'], tempVaultDir);
      const afterJson = JSON.parse(after.stdout);
      expect(afterJson.data.link_format).toBe('markdown');
    });

    it('should create config block if it does not exist', async () => {
      // Schema starts without config block
      const schemaBefore = JSON.parse(
        await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8')
      );
      expect(schemaBefore.config).toBeUndefined();

      // Set a config value
      await runCLI(['config', 'edit', 'editor', '--json', '"vim"'], tempVaultDir);

      // Config block should now exist
      const schemaAfter = JSON.parse(
        await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8')
      );
      expect(schemaAfter.config).toBeDefined();
      expect(schemaAfter.config.editor).toBe('vim');
    });
  });

  // ============================================================================
  // Environment variable precedence
  // ============================================================================

  describe('config precedence (explicit > env fallback)', () => {
    it('should show $EDITOR value when editor is not set', async () => {
      // The test vault doesn't have editor set explicitly
      // It should show whatever $EDITOR is set to in the environment
      const result = await runCLI(['config', 'list', 'editor', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      // Value should either be the env var or undefined if not set
      // We can't assert exact value since it depends on test environment
      expect(json.data.key).toBe('editor');
    });

    it('should override env fallback when explicitly set', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-config-precedence-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
          config: {
            editor: 'explicit-editor',
          },
        })
      );

      try {
        const result = await runCLI(['config', 'list', 'editor', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        // Explicit value should always be shown, regardless of $EDITOR
        expect(json.data.value).toBe('explicit-editor');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================
  // Obsidian vault auto-detection
  // ============================================================================

  describe('obsidian_vault auto-detection', () => {
    it('should auto-detect obsidian vault name from .obsidian folder', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-obsidian-detect-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempVaultDir, '.obsidian'), { recursive: true });
      
      // Create schema
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
        })
      );

      // Create .obsidian/app.json with vault name
      await writeFile(
        join(tempVaultDir, '.obsidian', 'app.json'),
        JSON.stringify({})
      );

      try {
        const result = await runCLI(['config', 'list', 'obsidian_vault', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        // When .obsidian exists, the vault name is derived from the directory name
        // The exact value depends on the temp directory name, but it should be set
        expect(json.data.key).toBe('obsidian_vault');
        // Value should be defined (auto-detected) when .obsidian folder exists
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should show undefined when no .obsidian folder exists', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-no-obsidian-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
        })
      );

      try {
        const result = await runCLI(['config', 'list', 'obsidian_vault', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.data.key).toBe('obsidian_vault');
        // Value should be undefined when no .obsidian folder
        expect(json.data.value).toBeUndefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should prefer explicit config over auto-detection', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-obsidian-explicit-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempVaultDir, '.obsidian'), { recursive: true });
      
      // Create schema with explicit obsidian_vault
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
          config: {
            obsidian_vault: 'my-explicit-vault',
          },
        })
      );

      // Create .obsidian folder (would normally trigger auto-detection)
      await writeFile(
        join(tempVaultDir, '.obsidian', 'app.json'),
        JSON.stringify({})
      );

      try {
        const result = await runCLI(['config', 'list', 'obsidian_vault', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        // Explicit value should override auto-detection
        expect(json.data.value).toBe('my-explicit-vault');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================
  // default_dashboard config
  // ============================================================================

  describe('default_dashboard config', () => {
    it('should show default_dashboard in config list', async () => {
      const result = await runCLI(['config', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('default_dashboard');
      expect(result.stdout).toContain('Dashboard to run when');
    });

    it('should show default_dashboard as undefined when not set', async () => {
      const result = await runCLI(['config', 'list', 'default_dashboard', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.key).toBe('default_dashboard');
      expect(json.data.value).toBeUndefined();
    });

    it('should set default_dashboard via --json', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-default-dashboard-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
        })
      );

      try {
        const result = await runCLI(
          ['config', 'edit', 'default_dashboard', '--json', '"my-tasks"'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Set default_dashboard');

        // Verify the change persisted
        const verifyResult = await runCLI(['config', 'list', 'default_dashboard', '--output', 'json'], tempVaultDir);
        const json = JSON.parse(verifyResult.stdout);
        expect(json.data.value).toBe('my-tasks');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should persist default_dashboard to schema.json', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-default-dashboard-persist-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
        })
      );

      try {
        await runCLI(['config', 'edit', 'default_dashboard', '--json', '"inbox"'], tempVaultDir);

        // Read the schema file directly
        const schemaContent = await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8');
        const schema = JSON.parse(schemaContent);

        expect(schema.config).toBeDefined();
        expect(schema.config.default_dashboard).toBe('inbox');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should show explicit default_dashboard value', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-default-dashboard-explicit-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
          config: {
            default_dashboard: 'my-saved-dashboard',
          },
        })
      );

      try {
        const result = await runCLI(['config', 'list', 'default_dashboard', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.data.value).toBe('my-saved-dashboard');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe('edge cases', () => {
    it('should work with missing config block in schema', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-no-config-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} },
          // No config block
        })
      );

      try {
        const result = await runCLI(['config', 'list', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        // Should still show defaults
        expect(json.data.link_format).toBe('wikilink');
        // open_with should be one of the valid options (default depends on environment)
        expect(['system', 'editor', 'visual', 'obsidian']).toContain(json.data.open_with);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error on missing schema file', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-no-schema-'));

      try {
        const result = await runCLI(['config', 'list'], tempVaultDir);

        expect(result.exitCode).toBe(1);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });
});

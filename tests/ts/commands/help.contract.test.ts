import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';
import { normalizeCliHelpForSnapshot, runHelp } from '../fixtures/help.js';

describe('help output contract snapshots', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('captures top-level help output contract', async () => {
    const result = await runHelp([]);
    const normalized = normalizeCliHelpForSnapshot(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(normalized).toContain('Usage: bwrb [options] [command]');
    expect(normalized).toContain('Commands:');
    expect(normalized).toMatchInlineSnapshot(`
      "Usage: bwrb [options] [command]

      Schema-driven note management for markdown vaults

      Options:
        -V, --version                output the version number
        -v, --vault <path>           Path to the vault directory
        -h, --help                   display help for command

      Commands:
        new [options] [type]         Create a new note (interactive type navigation
                                     if type omitted)
        edit [options] [query]       Edit an existing note
        delete [options] [query]     Delete notes from the vault
        list [options] [positional]  List notes with optional filtering
        open [options] [query]       Open a note (alias for search --open)
        search [options] [query]     Search for notes by name or content
        schema                       Schema introspection commands
        audit [options] [target]     Validate vault files against schema and report
                                     issues
        bulk [options] [target]      Mass changes across filtered file sets
        template                     Template management commands
        dashboard [options] [name]   Run or manage saved dashboard queries
        init [options] [path]        Initialize a new bwrb vault
        config                       Manage vault-wide configuration
        completion <shell>           Generate shell completion scripts
        help [command]               display help for command"
    `);
  });

  it('captures new command help output contract', async () => {
    const result = await runHelp(['new'], vaultDir);
    const normalized = normalizeCliHelpForSnapshot(result.stdout, { vaultDir });

    expect(result.exitCode).toBe(0);
    expect(normalized).toContain('Create a new note');
    expect(normalized).toContain('--template <name>');
    expect(normalized).toMatchInlineSnapshot(`
      "Usage: bwrb new [options] [type]

      Create a new note (interactive type navigation if type omitted)

      Arguments:
        type                  Type of note to create (e.g., idea, task)

      Options:
        -t, --type <type>     Type of note to create (alternative to positional
                              argument)
        -o, --open            Open the note after creation (uses BWRB_DEFAULT_APP or
                              system default)
        --json <frontmatter>  Create note non-interactively with JSON frontmatter
        --template <name>     Use a specific template (use \"default\" for default.md)
        --no-template         Skip template selection, use schema only
        --no-instances        Skip instance scaffolding (when template has instances)
        --owner <wikilink>    Owner note for owned types (e.g., \"[[My Novel]]\")
        --standalone          Create as standalone (skip owner selection for ownable
                              types)
        -h, --help            display help for command

      Examples:
        bwrb new                    # Interactive type selection
        bwrb new idea               # Create an idea
        bwrb new task               # Create a task
        bwrb new draft --open       # Create and open (respects BWRB_DEFAULT_APP)

      Templates:
        bwrb new task --template bug-report  # Use specific template
        bwrb new task --template default     # Use default.md template explicitly
        bwrb new task --no-template          # Skip templates, use schema only

      Ownership:
        bwrb new research                        # Prompted: standalone or owned?
        bwrb new research --standalone           # Create in shared location
        bwrb new research --owner \"[[My Novel]]\" # Create owned by specific note

      Instance scaffolding:
        bwrb new draft --template project        # Creates parent + child instances
        bwrb new draft --template project --no-instances  # Skip instances

      Non-interactive (JSON) mode:
        bwrb new idea --json '{\"name\": \"My Idea\", \"status\": \"raw\"}'
        bwrb new task --json '{\"name\": \"Fix bug\", \"status\": \"in-progress\"}'
        bwrb new task --json '{\"name\": \"Bug\"}' --template bug-report

      Body sections (JSON mode):
        bwrb new task --json '{\"name\": \"Fix bug\", \"_body\": {\"Steps\": [\"Step 1\", \"Step 2\"]}}'
        The _body field accepts section names as keys, with string or string[] values.

      Template management:
        Templates are managed with 'bwrb template' - see 'bwrb template --help'."
    `);
  });

  it('captures schema command help output contract', async () => {
    const result = await runHelp(['schema'], vaultDir);
    const normalized = normalizeCliHelpForSnapshot(result.stdout, { vaultDir });

    expect(result.exitCode).toBe(0);
    expect(normalized).toContain('Schema introspection commands');
    expect(normalized).toContain('Commands:');
    expect(normalized).toMatchInlineSnapshot(`
      "Usage: bwrb schema [options] [command]

      Schema introspection commands

      Options:
        -h, --help          display help for command

      Commands:
        validate [options]  Validate schema structure
        new                 Create a new type or field
        edit [name]         Edit an existing type or field
        delete [name]       Delete a type or field (dry-run by default)
        list [options]      List schema contents
        diff [options]      Show pending schema changes since last migration
        migrate [options]   Apply schema changes to existing notes
        history [options]   Show migration history
        help [command]      display help for command

      Examples:
        bwrb schema list              # List all types
        bwrb schema list objective    # Show objective type details
        bwrb schema list objective/task  # Show task subtype details
        bwrb schema list task --output json  # Show as JSON for AI/scripting
        bwrb schema validate          # Validate schema structure"
    `);
  });

  it('keeps normalized help deterministic across terminal widths', async () => {
    const narrow = await runCLI(['new', '--help'], vaultDir, undefined, {
      trimOutput: false,
      env: { FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', COLUMNS: '80', LINES: '40' },
    });
    const wide = await runCLI(['new', '--help'], vaultDir, undefined, {
      trimOutput: false,
      env: { FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', COLUMNS: '140', LINES: '40' },
    });

    expect(narrow.exitCode).toBe(0);
    expect(wide.exitCode).toBe(0);

    const narrowNormalized = normalizeCliHelpForSnapshot(narrow.stdout, { vaultDir });
    const wideNormalized = normalizeCliHelpForSnapshot(wide.stdout, { vaultDir });

    expect(narrowNormalized).toBe(wideNormalized);
  });
});

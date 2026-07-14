import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { relative } from 'path';
import { loadSchema, getType, formatUnknownTypeError } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import {
  configurePromptMode,
  promptSelection,
  printError,
  printSuccess,
  printWarning,
} from '../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  exitWithResolutionError,
  ExitCodes,
} from '../lib/output.js';
import {
  createEmptyTemplateResolution,
  findTemplateByName,
  resolveTemplateWithInheritance,
  type InheritedTemplateResolution,
} from '../lib/template.js';
import type { LoadedSchema, Template } from '../types/schema.js';
import { ConcurrentNoteModificationError, UserCancelledError } from '../lib/errors.js';
import { concurrentModificationData } from '../lib/note-write-concurrency.js';
import { createNoteFromJson } from './new/json-mode.js';
import { resolveTypePath } from './new/type-selection.js';
import { createNoteInteractive } from './new/interactive.js';
import { OwnerResolutionError } from './new/ownership.js';
import type { NewCommandOptions } from './new/types.js';
import { JsonCommandError } from './new/errors.js';
import { forkNote } from './new/fork.js';

export const newCommand = new Command('new')
  .description('Create a new note (interactive type navigation if type omitted)')
  .argument('[type]', 'Type of note to create (e.g., idea, task)')
  .option('-t, --type <type>', 'Type of note to create (alternative to positional argument)')
  .option('-o, --open', 'Open the note after creation (uses BWRB_DEFAULT_APP or system default)')
  .option('--json <frontmatter>', 'Create note non-interactively with JSON frontmatter')
  .option('--json-file <path>', 'Read JSON frontmatter from a file (avoids command-line size limits)')
  .option('--template <name>', 'Use a specific template (use "default" for default.md)')
  // NOTE: Commander maps --no-template to options.template === false.
  .option('--no-template', 'Skip template selection, use schema only')
  // NOTE: Commander maps --no-instances to options.instances === false.
  .option('--no-instances', 'Skip instance scaffolding (when template has instances)')
  .option('--owner <wikilink>', 'Owner note for owned types (e.g., "[[My Novel]]")')
  .option('--standalone', 'Create as standalone (skip owner selection for ownable types)')
  .option('--fork <target>', 'Create a new document forked from an exact note target')
  .option('--label <label>', 'Name a fork as "<source> — <label>"')
  .option('--name <name>', 'Set the fork name and filename explicitly')
  .option('--output <format>', 'Fork output format: text or json')
  .addHelpText('after', `
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
  bwrb new research --owner "[[My Novel]]" # Create owned by specific note

Instance scaffolding:
  bwrb new draft --template project        # Creates parent + child instances
  bwrb new draft --template project --no-instances  # Skip instances

Non-interactive (JSON) mode:
  bwrb new idea --json '{"name": "My Idea", "status": "raw"}'
  bwrb new idea --json-file /secure/path/idea.json
  bwrb new task --json '{"name": "Fix bug", "status": "in-progress"}'
  bwrb new task --json '{"name": "Bug"}' --template bug-report

Document forks:
  bwrb new --fork "Plans/Launch Brief" --label alternative
  bwrb new --fork 8f48f6a8-55c1-4ea7-9f4b-96735ed24af3 --name "Launch Brief v2"
  bwrb new --fork "Launch Brief" --label concise --output json

Body sections (JSON mode):
  bwrb new task --json '{"name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'
  bwrb new task --json '{"name": "Quick capture", "_body": "## Notes\\n\\n- Captured from a script."}'
  The _body field accepts a raw Markdown string or section names as keys, with string or string[] values.

Template management:
  Templates are managed with 'bwrb template' - see 'bwrb template --help'.

`)
  .action(async (positionalType: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const forkMode = options.fork !== undefined;
    const forkJsonMode = forkMode && options.output === 'json';
    const jsonMode = options.json !== undefined || options.jsonFile !== undefined || forkJsonMode;
    const typePath = options.type ?? positionalType;
    let resolvedVaultDir: string | undefined;

    try {
      if (options.json !== undefined && options.jsonFile !== undefined) {
        throw new Error('--json and --json-file are mutually exclusive.');
      }
      const jsonInput = options.json ?? (options.jsonFile !== undefined
        ? await readFile(options.jsonFile, 'utf8')
        : undefined);
      const globalOpts = getGlobalOpts(cmd);
      configurePromptMode({
        forcedNonInteractive: globalOpts.nonInteractive === true,
        bypassHint: 'Use --json <frontmatter> to create notes without prompts.',
      });
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      resolvedVaultDir = vaultDir;
      const schema = await loadSchema(vaultDir);

      validateForkOptions(positionalType, options);

      if (forkMode) {
        const result = await forkNote(schema, vaultDir, {
          target: options.fork!,
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.label !== undefined ? { label: options.label } : {}),
          nonInteractive: globalOpts.nonInteractive === true || forkJsonMode,
        });

        const relativePath = relative(vaultDir, result.path);
        if (forkJsonMode) {
          const jsonOutput: Record<string, unknown> = {
            path: relativePath,
            id: result.id,
            forked_from: result.forkedFrom,
            warnings: result.warnings,
          };
          if (result.nameTransformed) jsonOutput.nameTransformed = result.nameTransformed;
          if (result.pathLengthWarning) jsonOutput.pathLengthWarning = result.pathLengthWarning;
          printJson(jsonSuccess(jsonOutput));
        } else {
          printSuccess(`Created fork: ${relativePath}`);
          if (result.nameTransformed) {
            printWarning(
              `Warning: Note name was changed for the filename: "${result.nameTransformed.original}" -> "${result.nameTransformed.filename}"`
            );
          }
          if (result.pathLengthWarning) {
            printWarning(
              `Warning: Note path is ${result.pathLengthWarning.length} characters; paths over ${result.pathLengthWarning.threshold} may be less portable: ${result.pathLengthWarning.path}`
            );
          }
          for (const warning of result.warnings) printWarning(`Warning: ${warning}`);
        }

        if (options.open) {
          const { openNote, resolveAppMode } = await import('./open.js');
          await openNote(vaultDir, result.path, resolveAppMode(undefined, schema.config), schema.config, false);
        }
        return;
      }

      if (globalOpts.nonInteractive && !jsonMode) {
        printError('bwrb new requires --json <frontmatter> when --non-interactive is set.');
        process.exit(1);
      }

      if (jsonMode) {
        if (!typePath) {
          printJson(jsonError('Type path is required in JSON mode'));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }

        let template: Template | null = null;
        if (!options.noTemplate && typeof options.template === 'string') {
          template = await findTemplateByName(vaultDir, typePath, options.template);
          if (!template) {
            printJson(jsonError(`Template not found: ${options.template}`));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
        }

        const result = await createNoteFromJson(
          schema,
          vaultDir,
          typePath,
          jsonInput!,
          template,
          { owner: options.owner, standalone: options.standalone, noInstances: options.instances === false }
        );

        const jsonOutput: Record<string, unknown> = { path: relative(vaultDir, result.path) };
        if (result.nameTransformed) {
          jsonOutput.nameTransformed = result.nameTransformed;
        }
        if (result.pathLengthWarning) {
          jsonOutput.pathLengthWarning = result.pathLengthWarning;
        }
        if (result.instances) {
          jsonOutput.instances = {
            created: result.instances.created.map(p => relative(vaultDir, p)),
            skipped: result.instances.skipped.map(p => relative(vaultDir, p)),
            errors: result.instances.errors,
          };
        }
        printJson(jsonSuccess(jsonOutput));

        if (options.open && result.path) {
          const { openNote, resolveAppMode } = await import('./open.js');
          await openNote(vaultDir, result.path, resolveAppMode(undefined, schema.config), schema.config, false);
        }
        return;
      }

      const resolvedPath = await resolveTypePath(schema, typePath);
      if (!resolvedPath) {
        printError('No type selected. Exiting.');
        process.exit(1);
      }

      const typeDef = getType(schema, resolvedPath);
      if (!typeDef) {
        printError(formatUnknownTypeError(schema, resolvedPath));
        process.exit(1);
      }

      // Normalize slash-notation to canonical type name
      const canonicalType = typeDef.name;

      const templateResolution = await resolveTemplateResolution(
        vaultDir,
        canonicalType,
        schema,
        options
      );

      const filePath = await createNoteInteractive(
        schema,
        vaultDir,
        canonicalType,
        typeDef,
        templateResolution,
        {
          owner: options.owner,
          standalone: options.standalone,
          noInstances: options.instances === false,
        }
      );

      if (options.open && filePath) {
        const { openNote, resolveAppMode } = await import('./open.js');
        await openNote(vaultDir, filePath, resolveAppMode(undefined, schema.config), schema.config, false);
      }
    } catch (err) {
      if (err instanceof ConcurrentNoteModificationError) {
        if (jsonMode) {
          printJson(jsonError(err.message, {
            code: ExitCodes.IO_ERROR,
            data: concurrentModificationData(resolvedVaultDir ?? process.cwd(), err),
          }));
          process.exit(ExitCodes.IO_ERROR);
        }
        printError(err.message);
        process.exit(ExitCodes.IO_ERROR);
      }
      if (err instanceof JsonCommandError) {
        if (!err.result.success) {
          err.result.code = err.exitCode;
        }
        printJson(err.result);
        process.exit(err.exitCode);
      }

      if (err instanceof OwnerResolutionError) {
        exitWithResolutionError(err.message, err.candidates, jsonMode);
      }

      if (err instanceof UserCancelledError) {
        console.log('Cancelled.');
        process.exit(1);
      }

      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Aborted.') {
        console.log('Aborted.');
        process.exit(1);
      }

      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

async function resolveTemplateResolution(
  vaultDir: string,
  resolvedPath: string,
  schema: LoadedSchema,
  options: NewCommandOptions
): Promise<InheritedTemplateResolution> {
  let templateResolution: InheritedTemplateResolution = createEmptyTemplateResolution();

  if (options.noTemplate || options.template === false) {
    return templateResolution;
  }

  if (typeof options.template === 'string') {
    templateResolution = await resolveTemplateWithInheritance(vaultDir, resolvedPath, schema, {
      templateName: options.template,
    });
    if (!templateResolution.template) {
      throw new Error(`Template not found: ${options.template}`);
    }
    return templateResolution;
  }

  templateResolution = await resolveTemplateWithInheritance(vaultDir, resolvedPath, schema, {});

  if (templateResolution.shouldPrompt && templateResolution.availableTemplates.length > 0) {
    const templateOptions = [
      ...templateResolution.availableTemplates.map((t: Template) =>
        t.description ? `${t.name} - ${t.description}` : t.name
      ),
      '[No template]',
    ];
    const selected = await promptSelection('Select template:', templateOptions);
    if (selected === null) {
      throw new UserCancelledError();
    }
    if (!selected.startsWith('[No template]')) {
      const selectedName = selected.split(' - ')[0]!;
      const selectedTemplate = templateResolution.availableTemplates.find((t: Template) => t.name === selectedName);
      if (selectedTemplate) {
        templateResolution = await resolveTemplateWithInheritance(vaultDir, resolvedPath, schema, {
          templateName: selectedName,
        });
      }
    } else {
      templateResolution = createEmptyTemplateResolution();
    }
  }

  return templateResolution;
}

function validateForkOptions(
  positionalType: string | undefined,
  options: NewCommandOptions
): void {
  const forkMode = options.fork !== undefined;
  const forkOnlyFlags = [
    options.label !== undefined ? '--label' : undefined,
    options.name !== undefined ? '--name' : undefined,
    options.output !== undefined ? '--output' : undefined,
  ].filter((flag): flag is string => Boolean(flag));

  if (!forkMode && forkOnlyFlags.length > 0) {
    throw new Error(`${forkOnlyFlags.join(', ')} can only be used with --fork <target>.`);
  }
  if (!forkMode) return;

  if (!options.fork?.trim()) throw new Error('--fork <target> cannot be empty.');
  if (options.output !== undefined && options.output !== 'text' && options.output !== 'json') {
    throw new Error(`Invalid --output format '${options.output}'. Expected text or json.`);
  }
  if (options.name !== undefined && !options.name.trim()) throw new Error('--name cannot be empty.');
  if (options.label !== undefined && !options.label.trim()) throw new Error('--label cannot be empty.');

  const conflicts = [
    positionalType !== undefined ? 'positional type' : undefined,
    options.type !== undefined ? '--type' : undefined,
    options.template !== undefined ? (options.template === false ? '--no-template' : '--template') : undefined,
    options.instances === false ? '--no-instances' : undefined,
    options.json !== undefined ? '--json' : undefined,
    options.jsonFile !== undefined ? '--json-file' : undefined,
    options.owner !== undefined ? '--owner' : undefined,
    options.standalone ? '--standalone' : undefined,
  ].filter((flag): flag is string => Boolean(flag));

  if (conflicts.length > 0) {
    throw new Error(`--fork cannot be combined with ${conflicts.join(', ')}.`);
  }
}

import { Command } from 'commander';
import { relative } from 'path';
import { loadSchema, getTypeDefByPath } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import { promptSelection, printError } from '../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import {
  createEmptyTemplateResolution,
  findTemplateByName,
  resolveTemplateWithInheritance,
  type InheritedTemplateResolution,
} from '../lib/template.js';
import type { LoadedSchema, Template } from '../types/schema.js';
import { UserCancelledError } from '../lib/errors.js';
import { createNoteFromJson } from './new/json-mode.js';
import { resolveTypePath } from './new/type-selection.js';
import { createNoteInteractive } from './new/interactive.js';
import type { NewCommandOptions } from './new/types.js';
import { JsonCommandError } from './new/errors.js';

export const newCommand = new Command('new')
  .description('Create a new note (interactive type navigation if type omitted)')
  .argument('[type]', 'Type of note to create (e.g., idea, task)')
  .option('-t, --type <type>', 'Type of note to create (alternative to positional argument)')
  .option('-o, --open', 'Open the note after creation (uses BWRB_DEFAULT_APP or system default)')
  .option('--json <frontmatter>', 'Create note non-interactively with JSON frontmatter')
  .option('--template <name>', 'Use a specific template (use "default" for default.md)')
  // NOTE: Commander maps --no-template to options.template === false.
  .option('--no-template', 'Skip template selection, use schema only')
  // NOTE: Commander maps --no-instances to options.instances === false.
  .option('--no-instances', 'Skip instance scaffolding (when template has instances)')
  .option('--owner <wikilink>', 'Owner note for owned types (e.g., "[[My Novel]]")')
  .option('--standalone', 'Create as standalone (skip owner selection for ownable types)')
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
  bwrb new task --json '{"name": "Fix bug", "status": "in-progress"}'
  bwrb new task --json '{"name": "Bug"}' --template bug-report

Body sections (JSON mode):
  bwrb new task --json '{"name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'
  The _body field accepts section names as keys, with string or string[] values.

Template management:
  Templates are managed with 'bwrb template' - see 'bwrb template --help'.

`)
  .action(async (positionalType: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;
    const typePath = options.type ?? positionalType;

    try {
      const globalOpts = getGlobalOpts(cmd);
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadSchema(vaultDir);

      if (jsonMode) {
        if (!typePath) {
          printJson(jsonError('Type path is required in JSON mode'));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }

        let template: Template | null = null;
        if (!options.noTemplate && options.template) {
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
          options.json!,
          template,
          { owner: options.owner, standalone: options.standalone, noInstances: options.instances === false }
        );

        const jsonOutput: Record<string, unknown> = { path: relative(vaultDir, result.path) };
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

      const typeDef = getTypeDefByPath(schema, resolvedPath);
      if (!typeDef) {
        printError(`Unknown type: ${resolvedPath}`);
        process.exit(1);
      }

      const templateResolution = await resolveTemplateResolution(
        vaultDir,
        resolvedPath,
        schema,
        options
      );

      const filePath = await createNoteInteractive(
        schema,
        vaultDir,
        resolvedPath,
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
      if (err instanceof JsonCommandError) {
        if (!err.result.success) {
          err.result.code = err.exitCode;
        }
        printJson(err.result);
        process.exit(err.exitCode);
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

  if (options.noTemplate) {
    return templateResolution;
  }

  if (options.template) {
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

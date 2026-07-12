import { Command } from 'commander';
import { relative } from 'path';
import { loadSchema, resolveTypeFromFrontmatter } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import { buildNoteIndex, resolveExactNoteQuery } from '../lib/navigation.js';
import { parseNote } from '../lib/frontmatter.js';
import { explainTransition, getTransitionGuardsForType, parseTransitionTrigger } from '../lib/transition-guards.js';
import { printJson, jsonError, ExitCodes } from '../lib/output.js';
import { printError } from '../lib/prompt.js';

export const explainCommand = new Command('explain')
  .description('Explain relation-backed transition requirements for a note')
  .argument('<query>', 'Exact note name or path')
  .requiredOption('--transition <trigger>', 'Transition as "field = value", or a unique configured value')
  .option('--output <format>', 'Output format: text or json', 'text')
  .action(async (query: string, options: { transition: string; output?: string }, command: Command) => {
    const global = getGlobalOpts(command);
    const json = (options.output ?? global.output) === 'json';
    try {
      if (options.output && !['text', 'json'].includes(options.output)) throw new Error(`Unknown output format: ${options.output}`);
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode: json };
      if (global.vault) vaultOptions.vault = global.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadSchema(vaultDir);
      const index = await buildNoteIndex(schema, vaultDir);
      const resolved = resolveExactNoteQuery(index, query);
      if (!resolved.exact) throw new Error(resolved.isAmbiguous ? `Ambiguous note: ${query}` : `No exact note found: ${query}`);
      const note = await parseNote(resolved.exact.path);
      const type = resolveTypeFromFrontmatter(schema, note.frontmatter);
      if (!type) throw new Error('Could not determine note type from frontmatter');
      let transition = parseTransitionTrigger(options.transition);
      if (!transition) {
        const matches = getTransitionGuardsForType(schema, type)
          .map((guard) => parseTransitionTrigger(guard.on)!)
          .filter((candidate) => candidate.value === options.transition);
        if (matches.length !== 1) throw new Error(`Transition value '${options.transition}' does not identify exactly one configured guard.`);
        transition = matches[0]!;
      }
      const explanation = await explainTransition(schema, vaultDir, type, note.frontmatter, transition);
      if (explanation.guards.length === 0) throw new Error(`No transition guard is configured for '${transition.field} = ${transition.value}'.`);
      if (json) {
        printJson({ success: true, data: { path: relative(vaultDir, resolved.exact.path), ...explanation } });
      } else {
        console.log(`${explanation.blocked ? 'Blocked' : 'Allowed'}: ${transition.field} = ${transition.value} (${relative(vaultDir, resolved.exact.path)})`);
        for (const guard of explanation.guards) for (const requirement of guard.requirements) {
          console.log(`  ${requirement.relation}: ${requirement.status} (${requirement.targets.length}/${requirement.min})`);
          for (const target of requirement.targets) console.log(`    ${target.target}: ${target.status}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (json) printJson(jsonError(message)); else printError(message);
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
  });

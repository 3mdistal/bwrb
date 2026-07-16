import { Command } from 'commander';
import { relative } from 'path';
import { loadSchema, getAttemptLoopForType, resolveTypeFromFrontmatter } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import { buildNoteIndex, resolveExactNoteQuery } from '../lib/navigation.js';
import { parseNote } from '../lib/frontmatter.js';
import { runAttemptLoop } from '../lib/attempt-loop.js';
import { printJson, jsonError, jsonSuccess, ExitCodes } from '../lib/output.js';
import { printError } from '../lib/prompt.js';
import { RevisionMismatchError } from '../lib/note-revision.js';
import { JsonCommandError } from './new/errors.js';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface RunOptions {
  expectedRevision: string;
  runId: string;
  attemptCommand: string;
  attemptArg: string[];
  output?: string;
}

const runCommand = new Command('run')
  .description('Run one bounded attempt -> attest -> evaluate -> retry workflow')
  .argument('<query>', 'Exact workflow note name or path')
  .requiredOption('--expected-revision <revision>', 'Require this opaque workflow revision before attempts begin')
  .requiredOption('--run-id <id>', 'Stable caller-supplied idempotency ID for this run')
  .requiredOption('--attempt-command <path>', 'Executable to invoke directly (no shell)')
  .option('--attempt-arg <value>', 'Argument passed to the executable; repeat for multiple arguments', collect, [])
  .option('--output <format>', 'Output format: text or json', 'text')
  .action(async (query: string, options: RunOptions, command: Command) => {
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
      if (!type) throw new Error('Could not determine workflow note type from frontmatter.');
      const configured = getAttemptLoopForType(schema, type);
      if (!configured) throw new Error(`Type '${type}' has no trait with an attempt_loop policy.`);

      const result = await runAttemptLoop({
        schema,
        vaultDir,
        workflow: resolved.exact,
        index,
        workflowType: type,
        policy: configured.attemptLoop,
        expectedRevision: options.expectedRevision,
        runId: options.runId,
        command: options.attemptCommand,
        args: options.attemptArg,
      });
      if (json) {
        printJson(jsonSuccess({ data: result }));
      } else {
        console.log(`${result.accepted ? 'Accepted' : 'Failed'}: ${result.stopReason} (${relative(vaultDir, resolved.exact.path)})`);
        console.log(`  run: ${result.runId}`);
        console.log(`  attempts: ${result.attempts.length}/${configured.attemptLoop.limits.max_iterations}`);
        console.log(`  tokens: ${result.tokensUsed}/${configured.attemptLoop.limits.max_tokens}`);
        console.log(`  revision: ${result.terminalRevision}`);
      }
      if (!result.accepted) process.exitCode = ExitCodes.VALIDATION_ERROR;
    } catch (error) {
      if (error instanceof JsonCommandError) {
        if (json) printJson(error.result);
        else printError('error' in error.result ? error.result.error : error.message);
        process.exitCode = error.exitCode;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const revisionData = error instanceof RevisionMismatchError
        ? { expectedRevision: error.expectedRevision, currentRevision: error.currentRevision }
        : {};
      if (json) printJson(jsonError(message, { code: ExitCodes.VALIDATION_ERROR, ...revisionData }));
      else printError(message);
      process.exitCode = ExitCodes.VALIDATION_ERROR;
    }
  });

export const workflowCommand = new Command('workflow')
  .description('Run explicit bounded workflows')
  .addCommand(runCommand);

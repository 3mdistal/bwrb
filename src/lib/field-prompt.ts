import {
  promptSelection,
  promptMultiSelect,
  promptInput,
  promptRequired,
  promptMultiInput,
  promptConfirm,
  printWarning,
} from './prompt.js';
import { queryByType, formatValue } from './vault.js';
import { expandStaticValue } from './local-date.js';
import { UserCancelledError } from './errors.js';
import {
  type Field,
  type LoadedSchema,
  getOptionValues,
  getOptionDescription,
} from '../types/schema.js';

/**
 * Sentinel returned by template-edit mode to signal that a default should be removed.
 */
export const CLEAR = 'CLEAR' as const;

/**
 * Mode-aware options for {@link promptField}.
 *
 * - `create`: the full new-note prompt UX (required vs optional, defaults,
 *   `multiple`, option hints, number re-prompt, boolean confirm).
 * - `template-default`: prompting for a template's default value, with `(skip)`
 *   semantics. Returns `undefined` when skipped.
 * - `template-edit`: editing a template's existing default, with `(keep)` /
 *   `(clear)` semantics. Returns the current value on keep and {@link CLEAR}
 *   on clear.
 */
export type FieldPromptOptions =
  | { mode: 'create' }
  | { mode: 'template-default' }
  | { mode: 'template-edit'; currentValue: unknown };

// ---------------------------------------------------------------------------
// Composable option-list builders
// ---------------------------------------------------------------------------

/**
 * Build the option list (and matching hints) for a `select` field, applying the
 * per-mode sentinel prefix. Returns the sentinel label used, if any, so callers
 * can compare the selection against it.
 */
export function buildSelectOptions(
  field: Field,
  selectOptions: string[],
  opts: FieldPromptOptions
): { options: string[]; hints?: string[]; skipLabel?: string } {
  if (opts.mode === 'create') {
    const valueHints = selectOptions.map(
      (value) => getOptionDescription(field.options, value) ?? ''
    );
    if (!field.required) {
      const defaultStr = field.default !== undefined ? String(field.default) : undefined;
      const skipLabel = defaultStr ? `(skip) [${defaultStr}]` : '(skip)';
      return { options: [skipLabel, ...selectOptions], hints: ['', ...valueHints], skipLabel };
    }
    return { options: selectOptions, hints: valueHints };
  }

  if (opts.mode === 'template-default') {
    return { options: ['(skip)', ...selectOptions], skipLabel: '(skip)' };
  }

  // template-edit
  return { options: ['(keep)', '(clear)', ...selectOptions] };
}

/**
 * Build the single-select option list for a `relation` field, applying the
 * per-mode sentinel prefix.
 */
export function buildRelationOptions(
  dynamicOptions: string[],
  field: Field,
  opts: FieldPromptOptions
): { options: string[]; skipLabel?: string } {
  if (opts.mode === 'create') {
    if (!field.required) {
      const defaultStr = field.default !== undefined ? String(field.default) : undefined;
      const skipLabel = defaultStr ? `(skip) [${defaultStr}]` : '(skip)';
      return { options: [skipLabel, ...dynamicOptions], skipLabel };
    }
    return { options: dynamicOptions };
  }

  if (opts.mode === 'template-default') {
    return { options: ['(skip)', ...dynamicOptions], skipLabel: '(skip)' };
  }

  // template-edit
  return { options: ['(keep)', '(clear)', ...dynamicOptions] };
}

// ---------------------------------------------------------------------------
// Shared field prompt
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a single field value.
 *
 * This is the single source of truth for interactive field prompting across the
 * `new` flow (`mode: 'create'`) and the `template` flow
 * (`mode: 'template-default'` for setting defaults, `mode: 'template-edit'` for
 * editing existing defaults). Each mode preserves its historical prompt
 * strings, option ordering, sentinel semantics, and return values exactly.
 */
export async function promptField(
  schema: LoadedSchema,
  vaultDir: string,
  fieldName: string,
  field: Field,
  opts: FieldPromptOptions
): Promise<unknown> {
  const label = field.label ?? fieldName;

  // Static values: only the create flow expands them; the template flows treat
  // such fields as non-prompting and skip them before reaching here.
  if (opts.mode === 'create' && field.value !== undefined) {
    return expandStaticValue(field.value, new Date(), schema.config.dateFormat);
  }

  switch (field.prompt) {
    case 'select':
      return promptSelectField(fieldName, field, opts);

    case 'relation':
      return promptRelationField(schema, vaultDir, fieldName, field, opts);

    case 'list':
      return promptListField(label, fieldName, field, opts);

    case 'text':
      // create mode has a dedicated text path; template modes share the
      // text/date/default branch.
      if (opts.mode === 'create') return promptTextFieldCreate(fieldName, field);
      return promptTextOrDateTemplate(label, opts);

    case 'date':
      if (opts.mode === 'create') return promptDateFieldCreate(label, field);
      return promptTextOrDateTemplate(label, opts);

    case 'boolean':
      if (opts.mode === 'create') return promptBooleanFieldCreate(label);
      return promptTextOrDateTemplate(label, opts);

    case 'number':
      if (opts.mode === 'create') return promptNumberFieldCreate(label, field);
      return promptTextOrDateTemplate(label, opts);

    default:
      if (opts.mode === 'create') return field.default;
      return promptTextOrDateTemplate(label, opts);
  }
}

// ---------------------------------------------------------------------------
// Per-type prompting
// ---------------------------------------------------------------------------

function selectMessage(label: string, fieldName: string, opts: FieldPromptOptions): string {
  if (opts.mode === 'create') return `Select ${fieldName}:`;
  if (opts.mode === 'template-default') return `Default ${label}:`;
  return `New ${label}:`;
}

async function promptSelectField(
  fieldName: string,
  field: Field,
  opts: FieldPromptOptions
): Promise<unknown> {
  const label = field.label ?? fieldName;

  if (!field.options || field.options.length === 0) {
    if (opts.mode === 'create') return field.default;
    if (opts.mode === 'template-default') return undefined;
    return opts.currentValue;
  }

  const selectOptions = getOptionValues(field.options);

  // create mode supports multi-select.
  if (opts.mode === 'create' && field.multiple) {
    const selected = await promptMultiSelect(`Select ${fieldName}:`, selectOptions);
    if (selected === null) throw new UserCancelledError();
    return selected.length > 0 ? selected : (field.default ?? []);
  }

  const { options, hints, skipLabel } = buildSelectOptions(field, selectOptions, opts);
  const selected = await promptSelection(selectMessage(label, fieldName, opts), options, hints);
  if (selected === null) throw new UserCancelledError();

  if (opts.mode === 'create') {
    if (skipLabel && selected === skipLabel) return field.default ?? '';
    return selected;
  }
  if (opts.mode === 'template-default') {
    if (selected === '(skip)') return undefined;
    return selected;
  }
  // template-edit
  if (selected === '(keep)') return opts.currentValue;
  if (selected === '(clear)') return CLEAR;
  return selected;
}

async function promptRelationField(
  schema: LoadedSchema,
  vaultDir: string,
  fieldName: string,
  field: Field,
  opts: FieldPromptOptions
): Promise<unknown> {
  const label = field.label ?? fieldName;

  if (!field.source) {
    if (opts.mode === 'create') return field.default;
    if (opts.mode === 'template-default') return undefined;
    return opts.currentValue;
  }

  const dynamicOptions = await queryByType(schema, vaultDir, field.source, field.filter);

  if (opts.mode === 'create') {
    if (dynamicOptions.length === 0) {
      printWarning(`No options available for ${fieldName}`);
      return field.default ?? '';
    }
    const { options, skipLabel } = buildRelationOptions(dynamicOptions, field, opts);
    const selected = await promptSelection(`Select ${fieldName}:`, options);
    if (selected === null) throw new UserCancelledError();
    if (skipLabel && selected === skipLabel) return field.default ?? '';
    return formatValue(selected, schema.config.linkFormat);
  }

  if (opts.mode === 'template-default') {
    if (dynamicOptions.length === 0) return undefined;
    const { options } = buildRelationOptions(dynamicOptions, field, opts);
    const selected = await promptSelection(`Default ${label}:`, options);
    if (selected === null) throw new UserCancelledError();
    if (selected === '(skip)') return undefined;
    return formatValue(selected, schema.config.linkFormat);
  }

  // template-edit
  if (field.multiple) {
    const actionOptions = ['(keep)', '(clear)', '(set empty [])'];
    if (dynamicOptions.length > 0) {
      actionOptions.push('(select values)');
    }
    const action = await promptSelection(`How to update ${label}:`, actionOptions);
    if (action === null) throw new UserCancelledError();
    if (action === '(keep)') return opts.currentValue;
    if (action === '(clear)') return CLEAR;
    if (action === '(set empty [])') return [];

    const selected = await promptMultiSelect(`Select ${label}:`, dynamicOptions);
    if (selected === null) throw new UserCancelledError();
    return formatUniqueRelationValues(selected, schema.config.linkFormat);
  }

  if (dynamicOptions.length === 0) return opts.currentValue;
  const { options } = buildRelationOptions(dynamicOptions, field, opts);
  const selected = await promptSelection(`New ${label}:`, options);
  if (selected === null) throw new UserCancelledError();
  if (selected === '(keep)') return opts.currentValue;
  if (selected === '(clear)') return CLEAR;
  return formatValue(selected, schema.config.linkFormat);
}

async function promptListField(
  label: string,
  fieldName: string,
  field: Field,
  opts: FieldPromptOptions
): Promise<unknown> {
  if (opts.mode === 'create') {
    const items = await promptMultiInput(field.label ?? fieldName);
    if (items === null) throw new UserCancelledError();
    if (field.list_format === 'comma-separated') {
      return items.join(', ');
    }
    return items;
  }

  if (opts.mode === 'template-default') {
    console.log(`Default ${label} (comma-separated values, or Enter to skip):`);
    const values = await promptMultiInput('');
    if (values === null) throw new UserCancelledError();
    if (values.length === 0) return undefined;
    return values;
  }

  // template-edit
  console.log(`New ${label} (comma-separated, Enter to keep, "clear" to remove):`);
  const input = await promptInput('');
  if (input === null) throw new UserCancelledError();
  if (!input.trim()) return opts.currentValue;
  if (input.toLowerCase() === 'clear') return CLEAR;
  return input.split(',').map((s) => s.trim()).filter(Boolean);
}

async function promptTextFieldCreate(fieldName: string, field: Field): Promise<unknown> {
  const label = field.label ?? fieldName;
  if (field.required) {
    const value = await promptRequired(label);
    if (value === null) throw new UserCancelledError();
    return value;
  }
  const defaultVal = typeof field.default === 'string' ? field.default : undefined;
  const value = await promptInput(label, defaultVal);
  if (value === null) throw new UserCancelledError();
  return value;
}

async function promptDateFieldCreate(label: string, field: Field): Promise<unknown> {
  const defaultVal = typeof field.default === 'string' ? field.default : undefined;
  const value = await promptInput(label, defaultVal);
  if (value === null) throw new UserCancelledError();
  return value;
}

async function promptBooleanFieldCreate(label: string): Promise<unknown> {
  const result = await promptConfirm(label);
  if (result === null) throw new UserCancelledError();
  return result;
}

async function promptNumberFieldCreate(label: string, field: Field): Promise<unknown> {
  const defaultVal = field.default !== undefined ? String(field.default) : undefined;
  while (true) {
    const value = await promptInput(label, defaultVal);
    if (value === null) throw new UserCancelledError();
    if (value === '') return field.default;
    const parsed = parseFloat(value);
    if (Number.isNaN(parsed)) {
      printWarning(`Invalid number: "${value}". Please enter a valid number.`);
      continue;
    }
    return parsed;
  }
}

/**
 * The shared text/date/default branch for the template modes. In template-default
 * mode `boolean`/`number` fields also land here (raw text prompt for the default),
 * matching the historical template behavior.
 */
async function promptTextOrDateTemplate(
  label: string,
  opts: Extract<FieldPromptOptions, { mode: 'template-default' } | { mode: 'template-edit' }>
): Promise<unknown> {
  if (opts.mode === 'template-default') {
    const input = await promptInput(`Default ${label} (or Enter to skip)`);
    if (input === null) throw new UserCancelledError();
    return input.trim() || undefined;
  }
  const input = await promptInput(`New ${label} (Enter to keep, "clear" to remove)`);
  if (input === null) throw new UserCancelledError();
  if (!input.trim()) return opts.currentValue;
  if (input.toLowerCase() === 'clear') return CLEAR;
  return input.trim();
}

function formatUniqueRelationValues(
  values: string[],
  linkFormat: 'wikilink' | 'markdown'
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const formatted = formatValue(value, linkFormat);
    if (!seen.has(formatted)) {
      seen.add(formatted);
      result.push(formatted);
    }
  }
  return result;
}

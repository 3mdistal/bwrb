import {
  promptSelection,
  promptMultiSelect,
  promptInput,
  promptRequired,
  promptMultiInput,
  promptConfirm,
  printWarning,
  printInfo,
} from '../../lib/prompt.js';
import { queryByType, formatValue } from '../../lib/vault.js';
import { expandStaticValue } from '../../lib/local-date.js';
import { extractSectionItems } from '../../lib/frontmatter.js';
import { UserCancelledError } from '../../lib/errors.js';
import type { BodySection, Field, LoadedSchema } from '../../types/schema.js';

export async function promptField(
  schema: LoadedSchema,
  vaultDir: string,
  fieldName: string,
  field: Field
): Promise<unknown> {
  if (field.value !== undefined) {
    return expandStaticValue(field.value, new Date(), schema.config.dateFormat);
  }

  switch (field.prompt) {
    case 'select': {
      if (!field.options || field.options.length === 0) return field.default;
      const selectOptions = field.options;

      if (field.multiple) {
        const selected = await promptMultiSelect(`Select ${fieldName}:`, selectOptions);
        if (selected === null) {
          throw new UserCancelledError();
        }
        return selected.length > 0 ? selected : (field.default ?? []);
      }

      let options: string[];
      let skipLabel: string | undefined;
      if (!field.required) {
        const defaultStr = field.default !== undefined ? String(field.default) : undefined;
        skipLabel = defaultStr ? `(skip) [${defaultStr}]` : '(skip)';
        options = [skipLabel, ...selectOptions];
      } else {
        options = selectOptions;
      }

      const selected = await promptSelection(`Select ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }

      if (skipLabel && selected === skipLabel) {
        return field.default ?? '';
      }
      return selected;
    }

    case 'relation': {
      if (!field.source) return field.default;
      const dynamicOptions = await queryByType(schema, vaultDir, field.source, field.filter);
      if (dynamicOptions.length === 0) {
        printWarning(`No options available for ${fieldName}`);
        return field.default ?? '';
      }

      let options: string[];
      let skipLabel: string | undefined;
      if (!field.required) {
        const defaultStr = field.default !== undefined ? String(field.default) : undefined;
        skipLabel = defaultStr ? `(skip) [${defaultStr}]` : '(skip)';
        options = [skipLabel, ...dynamicOptions];
      } else {
        options = dynamicOptions;
      }

      const selected = await promptSelection(`Select ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }

      if (skipLabel && selected === skipLabel) {
        return field.default ?? '';
      }
      return formatValue(selected, schema.config.linkFormat);
    }

    case 'text': {
      const label = field.label ?? fieldName;
      if (field.required) {
        const value = await promptRequired(label);
        if (value === null) {
          throw new UserCancelledError();
        }
        return value;
      }
      const defaultVal = typeof field.default === 'string' ? field.default : undefined;
      const value = await promptInput(label, defaultVal);
      if (value === null) {
        throw new UserCancelledError();
      }
      return value;
    }

    case 'list': {
      const label = field.label ?? fieldName;
      const items = await promptMultiInput(label);
      if (items === null) {
        throw new UserCancelledError();
      }
      if (field.list_format === 'comma-separated') {
        return items.join(', ');
      }
      return items;
    }

    case 'date': {
      const label = field.label ?? fieldName;
      const defaultVal = typeof field.default === 'string' ? field.default : undefined;
      const value = await promptInput(label, defaultVal);
      if (value === null) {
        throw new UserCancelledError();
      }
      return value;
    }

    case 'boolean': {
      const label = field.label ?? fieldName;
      const result = await promptConfirm(label);
      if (result === null) {
        throw new UserCancelledError();
      }
      return result;
    }

    case 'number': {
      const label = field.label ?? fieldName;
      const defaultVal = field.default !== undefined ? String(field.default) : undefined;
      while (true) {
        const value = await promptInput(label, defaultVal);
        if (value === null) {
          throw new UserCancelledError();
        }
        if (value === '') {
          return field.default;
        }
        const parsed = parseFloat(value);
        if (Number.isNaN(parsed)) {
          printWarning(`Invalid number: "${value}". Please enter a valid number.`);
          continue;
        }
        return parsed;
      }
    }

    default:
      return field.default;
  }
}

export async function promptBodySections(
  sections: BodySection[],
  templateBody?: string
): Promise<Map<string, string[]>> {
  const content = new Map<string, string[]>();

  for (const section of sections) {
    if (section.prompt === 'list' && section.prompt_label) {
      if (templateBody) {
        const existingItems = extractSectionItems(
          templateBody,
          section.title,
          section.content_type
        );

        if (existingItems.length > 0) {
          printInfo(`\n${section.title} (from template):`);
          for (const item of existingItems) {
            const prefix = section.content_type === 'checkboxes' ? '  - [ ]' : '  -';
            console.log(`${prefix} ${item}`);
          }
        }

        const label = `Additional ${section.prompt_label}`;
        const items = await promptMultiInput(label);
        if (items === null) {
          throw new UserCancelledError();
        }
        if (items.length > 0) {
          content.set(section.title, items);
        }
      } else {
        const items = await promptMultiInput(section.prompt_label);
        if (items === null) {
          throw new UserCancelledError();
        }
        if (items.length > 0) {
          content.set(section.title, items);
        }
      }
    }

    if (section.children && section.children.length > 0) {
      const childContent = await promptBodySections(section.children, templateBody);
      for (const [key, value] of childContent) {
        content.set(key, value);
      }
    }
  }

  return content;
}

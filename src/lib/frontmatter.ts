import matter from 'gray-matter';
import { stringify } from 'yaml';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { BodySection } from '../types/schema.js';

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

/**
 * Parse a markdown file's frontmatter and body.
 */
export async function parseNote(filePath: string): Promise<ParsedNote> {
  const content = await readFile(filePath, 'utf-8');
  const { data, content: body } = matter(content);
  return {
    frontmatter: data as Record<string, unknown>,
    body,
    raw: content,
  };
}

/**
 * Parse frontmatter from a string.
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const { data } = matter(content);
  return data as Record<string, unknown>;
}

/**
 * Serialize frontmatter to YAML string (without delimiters).
 * Always puts 'type' first if present.
 */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  order?: string[]
): string {
  const ordered: Record<string, unknown> = {};
  
  // Always put 'type' first if it exists
  if ('type' in data) {
    ordered['type'] = data['type'];
  }
  
  // If order is specified, add keys in that order
  if (order && order.length > 0) {
    for (const key of order) {
      if (key in data && key !== 'type') {
        ordered[key] = data[key];
      }
    }
  }
  
  // Add any remaining keys not yet in ordered
  for (const key of Object.keys(data)) {
    if (!(key in ordered)) {
      ordered[key] = data[key];
    }
  }
  
  return stringify(ordered).trimEnd();
}

/**
 * Build a complete markdown file with frontmatter and body.
 */
export function buildNoteContent(
  frontmatter: Record<string, unknown>,
  body: string,
  frontmatterOrder?: string[]
): string {
  const yaml = serializeFrontmatter(frontmatter, frontmatterOrder);
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * Write a note to disk, creating directories as needed.
 */
export async function writeNote(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  frontmatterOrder?: string[]
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const content = buildNoteContent(frontmatter, body, frontmatterOrder);
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Generate heading prefix based on level.
 */
function headingPrefix(level: number): string {
  return '#'.repeat(level);
}

/**
 * Generate body content from body section definitions.
 */
export function generateBodySections(sections: BodySection[]): string {
  let content = '';

  for (const section of sections) {
    const level = section.level ?? 2;
    const prefix = headingPrefix(level);
    content += `${prefix} ${section.title}\n`;

    // Add placeholder based on content type
    switch (section.content_type) {
      case 'bullets':
        content += '- \n';
        break;
      case 'checkboxes':
        content += '- [ ] \n';
        break;
      case 'paragraphs':
      default:
        content += '\n';
        break;
    }

    // Recursively add children
    if (section.children && section.children.length > 0) {
      content += generateBodySections(section.children);
    }
  }

  return content;
}

/**
 * Generate body content with prompted values for multi-input sections.
 */
export function generateBodyWithContent(
  sections: BodySection[],
  sectionContent: Map<string, string[]>
): string {
  let content = '';

  for (const section of sections) {
    const level = section.level ?? 2;
    const prefix = headingPrefix(level);
    content += `${prefix} ${section.title}\n`;

    // Check if we have content for this section
    const items = sectionContent.get(section.title);
    if (items && items.length > 0) {
      for (const item of items) {
        switch (section.content_type) {
          case 'checkboxes':
            content += `- [ ] ${item}\n`;
            break;
          case 'bullets':
            content += `- ${item}\n`;
            break;
          default:
            content += `${item}\n`;
            break;
        }
      }
      content += '\n';
    } else {
      // Add placeholder based on content type
      switch (section.content_type) {
        case 'bullets':
          content += '- \n';
          break;
        case 'checkboxes':
          content += '- [ ] \n';
          break;
        case 'paragraphs':
        default:
          content += '\n';
          break;
      }
    }

    // Recursively add children
    if (section.children && section.children.length > 0) {
      content += generateBodyWithContent(section.children, sectionContent);
    }
  }

  return content;
}

/**
 * Extract existing items from a body section in template content.
 * Returns the items found in the section (bullets, checkboxes, or paragraphs).
 */
export function extractSectionItems(
  templateBody: string,
  sectionTitle: string,
  contentType: BodySection['content_type']
): string[] {
  const items: string[] = [];
  const lines = templateBody.split('\n');
  
  // Find the section header (any heading level)
  const headerPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(sectionTitle)}\\s*$`, 'i');
  let inSection = false;
  
  for (const line of lines) {
    if (headerPattern.test(line)) {
      inSection = true;
      continue;
    }
    
    // Stop when we hit another heading
    if (inSection && /^#{1,6}\s+/.test(line)) {
      break;
    }
    
    if (inSection) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Extract content based on type
      if (contentType === 'checkboxes') {
        const match = trimmed.match(/^-\s*\[[ x]\]\s*(.+)$/i);
        if (match && match[1]) {
          items.push(match[1]);
        }
      } else if (contentType === 'bullets') {
        const match = trimmed.match(/^-\s+(.+)$/);
        if (match && match[1]) {
          items.push(match[1]);
        }
      } else {
        // paragraphs - any non-empty line
        items.push(trimmed);
      }
    }
  }
  
  return items;
}

/**
 * Merge prompted content into a template body.
 * For each section in sectionContent, finds the matching section in the template
 * and appends the new items. Sections not in template are added at the end.
 */
export function mergeBodySectionContent(
  templateBody: string,
  sections: BodySection[],
  sectionContent: Map<string, string[]>
): string {
  let result = templateBody;
  const sectionsInTemplate = new Set<string>();
  
  // Process each section that has prompted content
  for (const section of sections) {
    const items = sectionContent.get(section.title);
    if (!items || items.length === 0) continue;
    
    // Check if section exists in template
    const headerPattern = new RegExp(
      `(^#{1,6}\\s+${escapeRegex(section.title)}\\s*$)`,
      'im'
    );
    
    if (headerPattern.test(result)) {
      sectionsInTemplate.add(section.title);
      // Find the end of this section (before next heading or end of content)
      result = appendToSection(result, section.title, items, section.content_type);
    }
  }
  
  // Add sections not in template at the end
  const missingSections: string[] = [];
  for (const section of sections) {
    const items = sectionContent.get(section.title);
    if (!items || items.length === 0) continue;
    
    if (!sectionsInTemplate.has(section.title)) {
      missingSections.push(generateSectionWithItems(section, items));
    }
  }
  
  if (missingSections.length > 0) {
    // Ensure there's a newline before adding new sections
    if (!result.endsWith('\n')) {
      result += '\n';
    }
    result += '\n' + missingSections.join('\n');
  }
  
  return result;
}

/**
 * Append items to an existing section in the body.
 */
function appendToSection(
  body: string,
  sectionTitle: string,
  items: string[],
  contentType: BodySection['content_type']
): string {
  const lines = body.split('\n');
  const headerPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(sectionTitle)}\\s*$`, 'i');
  
  let insertIndex = -1;
  let inSection = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (headerPattern.test(line)) {
      inSection = true;
      continue;
    }
    
    if (inSection) {
      // Found next heading - insert before it
      if (/^#{1,6}\s+/.test(line)) {
        insertIndex = i;
        break;
      }
    }
  }
  
  // If no next heading found, insert at end
  if (inSection && insertIndex === -1) {
    insertIndex = lines.length;
  }
  
  if (insertIndex === -1) {
    // Section not found, return unchanged
    return body;
  }
  
  // Build the new items string
  const newItems = items.map(item => {
    switch (contentType) {
      case 'checkboxes':
        return `- [ ] ${item}`;
      case 'bullets':
        return `- ${item}`;
      default:
        return item;
    }
  });
  
  // Insert the new items
  lines.splice(insertIndex, 0, ...newItems);
  
  return lines.join('\n');
}

/**
 * Generate a complete section with items for sections not in template.
 */
function generateSectionWithItems(
  section: BodySection,
  items: string[]
): string {
  const level = section.level ?? 2;
  const prefix = '#'.repeat(level);
  let content = `${prefix} ${section.title}\n`;
  
  for (const item of items) {
    switch (section.content_type) {
      case 'checkboxes':
        content += `- [ ] ${item}\n`;
        break;
      case 'bullets':
        content += `- ${item}\n`;
        break;
      default:
        content += `${item}\n`;
        break;
    }
  }
  
  return content;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flatten all section titles from a body sections array (including nested children).
 */
function flattenSectionTitles(sections: BodySection[]): string[] {
  const titles: string[] = [];
  for (const section of sections) {
    titles.push(section.title);
    if (section.children) {
      titles.push(...flattenSectionTitles(section.children));
    }
  }
  return titles;
}

/**
 * Parse body input from JSON into a Map for use with generateBodyWithContent.
 * 
 * @param bodyInput - Object with section titles as keys, content as values
 * @param sections - Body section definitions from schema
 * @returns Map of section title to content items
 * @throws Error if section title is unknown or content type is invalid
 * 
 * @example
 * // Input
 * { "Steps": ["Step 1", "Step 2"], "Notes": "Some notes" }
 * // Returns
 * Map { "Steps" => ["Step 1", "Step 2"], "Notes" => ["Some notes"] }
 */
export function parseBodyInput(
  bodyInput: Record<string, unknown>,
  sections: BodySection[]
): Map<string, string[]> {
  const sectionContent = new Map<string, string[]>();
  const sectionTitles = new Set(flattenSectionTitles(sections));
  const availableTitles = Array.from(sectionTitles);

  for (const [title, content] of Object.entries(bodyInput)) {
    // Validate section exists in schema
    if (!sectionTitles.has(title)) {
      const suggestion = availableTitles.length > 0
        ? `. Available sections: ${availableTitles.join(', ')}`
        : '';
      throw new Error(`Unknown body section: "${title}"${suggestion}`);
    }

    // Skip null/undefined values
    if (content === null || content === undefined) {
      continue;
    }

    // Normalize content to string[]
    if (Array.isArray(content)) {
      // Filter out non-string items and convert others to strings
      const items = content
        .filter(item => item !== null && item !== undefined)
        .map(item => String(item));
      if (items.length > 0) {
        sectionContent.set(title, items);
      }
    } else if (typeof content === 'string') {
      if (content.trim()) {
        sectionContent.set(title, [content]);
      }
    } else {
      throw new Error(
        `Invalid content for section "${title}": expected string or string[], got ${typeof content}`
      );
    }
  }

  return sectionContent;
}

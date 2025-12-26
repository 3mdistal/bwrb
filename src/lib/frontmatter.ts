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
 */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  order?: string[]
): string {
  // If order is specified, reorder the keys
  if (order && order.length > 0) {
    const ordered: Record<string, unknown> = {};
    for (const key of order) {
      if (key in data) {
        ordered[key] = data[key];
      }
    }
    // Add any remaining keys not in order
    for (const key of Object.keys(data)) {
      if (!(key in ordered)) {
        ordered[key] = data[key];
      }
    }
    return stringify(ordered).trimEnd();
  }

  return stringify(data).trimEnd();
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

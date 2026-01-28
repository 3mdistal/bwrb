import { readFile } from 'fs/promises';
import { parseDocument, isMap, isSeq } from 'yaml';
import type { Document, ParsedNode, YAMLMap, Pair, YAMLSeq, Scalar } from 'yaml';
import { detectEol, normalizeYamlValue } from './value-utils.js';

export interface FrontmatterBlock {
  /** Index of the opening delimiter line start */
  blockStart: number;
  /** Index of the closing delimiter line end (includes newline if present) */
  blockEnd: number;
  /** Start index of the YAML content (just after opening delimiter line) */
  yamlStart: number;
  /** End index of the YAML content (start of closing delimiter line) */
  yamlEnd: number;
}

export interface StructuralFrontmatterInfo {
  raw: string;
  blocks: FrontmatterBlock[];
  frontmatterBlocks: FrontmatterBlock[];
  unterminated: boolean;
  primaryBlock: FrontmatterBlock | null;
  /** YAML content for the primary block (no delimiters) */
  yaml: string | null;
  /** Parsed YAML document for the primary block */
  doc: Document.Parsed | null;
  /** Best-effort frontmatter object (last-wins on duplicates) */
  frontmatter: Record<string, unknown>;
  /** YAML parse errors for the primary block */
  yamlErrors: string[];
  /** Whether the primary block starts at the top (ignoring leading whitespace/BOM) */
  atTop: boolean;
}

function stripBom(value: string): string {
  return value.startsWith('\uFEFF') ? value.slice(1) : value;
}

function isBlockAtTop(raw: string, block: FrontmatterBlock): boolean {
  const prefix = stripBom(raw.slice(0, block.blockStart));
  return prefix.trim().length === 0;
}

function isDelimiterLine(line: string): boolean {
  const withoutNewline = line.replace(/\r?\n$/, '');
  return withoutNewline.trim() === '---';
}

function splitLinesWithOffsets(raw: string): Array<{ start: number; end: number; text: string }> {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;

  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === '\n') {
      const end = i === raw.length ? i : i + 1;
      lines.push({ start, end, text: raw.slice(start, end) });
      start = end;
    }
  }

  return lines;
}

function findFrontmatterBlocks(raw: string): { blocks: FrontmatterBlock[]; unterminated: boolean } {
  const blocks: FrontmatterBlock[] = [];
  const lines = splitLinesWithOffsets(raw);

  let inBlock = false;
  let blockStart = 0;
  let yamlStart = 0;

  for (const line of lines) {
    if (!isDelimiterLine(line.text)) continue;

    if (!inBlock) {
      inBlock = true;
      blockStart = line.start;
      yamlStart = line.end;
      continue;
    }

    // Close block
    inBlock = false;
    blocks.push({
      blockStart,
      blockEnd: line.end,
      yamlStart,
      yamlEnd: line.start,
    });
  }

  return { blocks, unterminated: inBlock };
}

export function readStructuralFrontmatterFromRaw(raw: string): StructuralFrontmatterInfo {
  const { blocks, unterminated } = findFrontmatterBlocks(raw);
  const frontmatterBlocks: FrontmatterBlock[] = [];
  let primaryBlock: FrontmatterBlock | null = null;
  let yaml: string | null = null;
  let doc: Document.Parsed | null = null;
  let frontmatter: Record<string, unknown> = {};
  let yamlErrors: string[] = [];
  let atTop = true;

  for (const block of blocks) {
    const candidateYaml = raw.slice(block.yamlStart, block.yamlEnd);
    const candidateDoc = parseDocument(candidateYaml);
    const contents = candidateDoc.contents as ParsedNode | null;
    const blockAtTop = isBlockAtTop(raw, block);
    const isMapLike = contents === null || isMap(contents);
    const isFrontmatter = isMapLike && (contents !== null || blockAtTop);

    if (!isFrontmatter) {
      continue;
    }

    frontmatterBlocks.push(block);

    if (primaryBlock) {
      continue;
    }

    primaryBlock = block;
    yaml = candidateYaml;
    doc = candidateDoc;
    yamlErrors = candidateDoc.errors.map((e: { message: string }) => e.message);
    atTop = blockAtTop;

    try {
      const json = candidateDoc.toJSON() as unknown;
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        frontmatter = normalizeYamlValue(json) as Record<string, unknown>;
      } else {
        frontmatter = {};
      }
    } catch {
      frontmatter = {};

      if (contents && isMap(contents)) {
        const map = contents as YAMLMap;
        for (const pair of map.items as Pair[]) {
          const key = String((pair.key as Scalar | null | undefined)?.value ?? '');
          if (!key) continue;

          const valueNode = (pair as { value?: unknown }).value;
          if (valueNode && typeof valueNode === 'object') {
            const toJson = (valueNode as Record<string, unknown>)['toJSON'];
            if (typeof toJson === 'function') {
              try {
                frontmatter[key] = normalizeYamlValue((toJson as () => unknown)());
                continue;
              } catch {
                // Fall through
              }
            }

            if ('value' in (valueNode as Record<string, unknown>)) {
              frontmatter[key] = normalizeYamlValue((valueNode as Record<string, unknown>)['value']);
              continue;
            }
          }

          frontmatter[key] = normalizeYamlValue(valueNode ?? null);
        }
      }
    }
  }

  return {
    raw,
    blocks,
    frontmatterBlocks,
    unterminated,
    primaryBlock,
    yaml,
    doc,
    frontmatter,
    yamlErrors,
    atTop,
  };
}

export async function readStructuralFrontmatter(filePath: string): Promise<StructuralFrontmatterInfo> {
  const raw = await readFile(filePath, 'utf-8');
  return readStructuralFrontmatterFromRaw(raw);
}

export function replacePrimaryYaml(
  raw: string,
  block: FrontmatterBlock,
  newYaml: string
): string {
  const eol = detectEol(raw);
  const normalizedYaml = newYaml.replace(/\r\n/g, '\n').trimEnd();
  const yamlBody = normalizedYaml.replace(/\n/g, eol) + eol;
  return raw.slice(0, block.yamlStart) + yamlBody + raw.slice(block.yamlEnd);
}

export function movePrimaryBlockToTop(raw: string, block: FrontmatterBlock): string {
  const prefix = raw.slice(0, block.blockStart);
  const blockText = raw.slice(block.blockStart, block.blockEnd);
  const suffix = raw.slice(block.blockEnd);

  const remaining = prefix + suffix;

  // Preserve BOM if present
  if (remaining.startsWith('\uFEFF')) {
    return '\uFEFF' + blockText + remaining.slice(1);
  }

  return blockText + remaining;
}

export function getLastPairForKey(map: YAMLMap, key: string): Pair | null {
  let found: Pair | null = null;
  for (const pair of map.items as Pair[]) {
    const k = (pair.key as Scalar | null | undefined)?.value;
    if (k !== undefined && String(k) === key) {
      found = pair;
    }
  }
  return found;
}

export function getAllPairsForKey(map: YAMLMap, key: string): { pair: Pair; index: number }[] {
  const matches: { pair: Pair; index: number }[] = [];
  const items = map.items as Pair[];
  for (let i = 0; i < items.length; i++) {
    const pair = items[i]!;
    const k = (pair.key as Scalar | null | undefined)?.value;
    if (k !== undefined && String(k) === key) {
      matches.push({ pair, index: i });
    }
  }
  return matches;
}

export function getStringSequenceItem(seq: YAMLSeq, index: number): Scalar | null {
  if (!isSeq(seq)) return null;
  const item = (seq.items ?? [])[index];
  if (!item) return null;
  if (typeof (item as Scalar).value === 'string') {
    return item as Scalar;
  }
  return null;
}

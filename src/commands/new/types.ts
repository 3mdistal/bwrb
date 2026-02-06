import type { LoadedSchema, ResolvedType, Template } from '../../types/schema.js';
import type { OwnerNoteRef } from '../../lib/vault.js';

export interface NewCommandOptions {
  open?: boolean;
  json?: string;
  type?: string;
  template?: string;
  noTemplate?: boolean;
  instances?: boolean;
  owner?: string;
  standalone?: boolean;
}

export type CreationMode = 'interactive' | 'json';

export type OwnershipMode =
  | { kind: 'pooled' }
  | { kind: 'owned'; owner: OwnerNoteRef; fieldName: string };

export interface PlannedNoteContent {
  frontmatter: Record<string, unknown>;
  body: string;
  orderedFields: string[];
  itemName: string;
}

export interface NoteCreationResult {
  path: string;
  instances?: {
    created: string[];
    skipped: string[];
    errors: Array<{ type: string; filename?: string | undefined; message: string }>;
  };
}

export interface WritePlanArgs {
  schema: LoadedSchema;
  vaultDir: string;
  typePath: string;
  typeDef: ResolvedType;
  ownership: OwnershipMode;
  mode: CreationMode;
  content: PlannedNoteContent;
  template?: Template | null;
}

export interface JsonNoteInputResult {
  frontmatter: Record<string, unknown>;
  bodyInput?: Record<string, unknown>;
}

export interface FileExistsStrategy {
  onExists: (filePath: string, vaultDir: string) => Promise<void>;
}

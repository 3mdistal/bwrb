import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSchema, canTypeBeOwned, getOwnerTypes, getOwnedFields } from '../../../src/lib/schema.js';
import {
  buildOwnershipIndex,
  isNoteOwned,
  findDeclaredOwner,
  getDeclaredOwners,
  isDeclaredOwnershipAmbiguous,
  canReference,
  validateNewOwned,
  extractWikilinkReferences,
} from '../../../src/lib/ownership.js';
import { runAudit } from '../../../src/lib/audit/detection.js';

// Test vault with ownership schema
const createTestVault = () => {
  const vaultDir = join(tmpdir(), `bwrb-ownership-test-${Date.now()}`);
  const bwrbDir = join(vaultDir, '.bwrb');
  
  mkdirSync(bwrbDir, { recursive: true });
  
  // Create a v2 schema with ownership
  const schema = {
    version: 2,
    types: {
      meta: {
        fields: {
          status: { prompt: 'select', options: ['raw', 'active', 'done'], default: 'raw' },
        },
      },
      draft: {
        extends: 'meta',
        output_dir: 'drafts',
        fields: {
          research: {
            prompt: 'relation',
            source: 'research',
            format: 'wikilink',
            multiple: true,
            owned: true,
          },
          related: {
            prompt: 'relation',
            source: 'research',
            format: 'wikilink',
            multiple: true,
            // NOT owned - shared references
          },
        },
      },
      research: {
        extends: 'meta',
        output_dir: 'research',
      },
      project: {
        extends: 'meta',
        output_dir: 'projects',
        fields: {
          notes: {
            prompt: 'relation',
            source: 'research',
            format: 'wikilink',
            multiple: true,
            owned: true,
          },
        },
      },
    },
  };
  
  writeFileSync(join(bwrbDir, 'schema.json'), JSON.stringify(schema, null, 2));
  
  return vaultDir;
};

const createNote = (vaultDir: string, path: string, frontmatter: Record<string, unknown>) => {
  const fullPath = join(vaultDir, path);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  
  const formatValue = (v: unknown): string => {
    if (typeof v === 'string' && v.includes('[[')) {
      // Quote wikilinks so YAML doesn't interpret [[ as array start
      return `"${v}"`;
    }
    return String(v);
  };
  
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map(item => `  - ${formatValue(item)}`).join('\n')}`;
      }
      return `${k}: ${formatValue(v)}`;
    })
    .join('\n');
  
  const content = `---\n${yaml}\n---\n\nNote content.\n`;
  writeFileSync(fullPath, content);
};

describe('Ownership Schema Support', () => {
  let vaultDir: string;
  
  beforeEach(() => {
    vaultDir = createTestVault();
  });
  
  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });
  
  describe('canTypeBeOwned', () => {
    it('should return true for types that can be owned', async () => {
      const schema = await loadSchema(vaultDir);
      expect(canTypeBeOwned(schema, 'research')).toBe(true);
    });
    
    it('should return false for types that cannot be owned', async () => {
      const schema = await loadSchema(vaultDir);
      expect(canTypeBeOwned(schema, 'draft')).toBe(false);
      expect(canTypeBeOwned(schema, 'meta')).toBe(false);
    });
  });
  
  describe('getOwnerTypes', () => {
    it('should return all types that can own a child type', async () => {
      const schema = await loadSchema(vaultDir);
      const owners = getOwnerTypes(schema, 'research');
      
      // Both draft and project can own research
      expect(owners).toHaveLength(2);
      expect(owners.map(o => o.ownerType).sort()).toEqual(['draft', 'project']);
    });
    
    it('should return empty array for types with no owners', async () => {
      const schema = await loadSchema(vaultDir);
      const owners = getOwnerTypes(schema, 'draft');
      expect(owners).toHaveLength(0);
    });
    
    it('should sort owners alphabetically', async () => {
      const schema = await loadSchema(vaultDir);
      const owners = getOwnerTypes(schema, 'research');
      
      const ownerNames = owners.map(o => o.ownerType);
      expect(ownerNames).toEqual([...ownerNames].sort());
    });
  });
  
  describe('getOwnedFields', () => {
    it('should return owned fields for an owner type', async () => {
      const schema = await loadSchema(vaultDir);
      const fields = getOwnedFields(schema, 'draft');
      
      expect(fields).toHaveLength(1);
      expect(fields[0]?.fieldName).toBe('research');
      expect(fields[0]?.childType).toBe('research');
      expect(fields[0]?.multiple).toBe(true);
    });
    
    it('should not include non-owned fields', async () => {
      const schema = await loadSchema(vaultDir);
      const fields = getOwnedFields(schema, 'draft');
      
      // 'related' field is not owned
      expect(fields.find(f => f.fieldName === 'related')).toBeUndefined();
    });
  });
});

describe('Ownership Index Building', () => {
  let vaultDir: string;
  
  beforeEach(() => {
    vaultDir = createTestVault();
  });
  
  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });
  
  it('should build empty index for vault with no owned notes', async () => {
    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);
    
    expect(index.ownedNotes.size).toBe(0);
    expect(index.ownerToOwned.size).toBe(0);
  });
  
  it('should index owned notes in folder structure', async () => {
    // Create a draft with owned research
    mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
    });
    createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
      type: 'research',
      status: 'raw',
    });
    
    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);
    
    expect(index.ownedNotes.size).toBe(1);
    
    const ownedInfo = index.ownedNotes.get('drafts/My Novel/research/Character Notes.md');
    expect(ownedInfo).toBeDefined();
    expect(ownedInfo?.ownerPath).toBe('drafts/My Novel/My Novel.md');
    expect(ownedInfo?.ownerType).toBe('draft');
    expect(ownedInfo?.fieldName).toBe('research');
  });
  
  it('should track multiple owned notes per owner', async () => {
    // Create a draft with multiple owned research notes
    mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
    });
    createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
      type: 'research',
      status: 'raw',
    });
    createNote(vaultDir, 'drafts/My Novel/research/World Building.md', {
      type: 'research',
      status: 'raw',
    });
    
    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);
    
    expect(index.ownedNotes.size).toBe(2);
    
    const owned = index.ownerToOwned.get('drafts/My Novel/My Novel.md');
    expect(owned?.size).toBe(2);
  });

  // declaredOwned is built from the owner's frontmatter `owned` field, so it
  // resolves the owner of an owned note even when the note has been moved out of
  // its `<owner-dir>/<field>/` folder — the case audit needs to restore a
  // genuinely-misplaced owned note (#702/#703).
  it('records declared ownership from the owner frontmatter, keyed by note name', async () => {
    mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
    // Owner declares ownership of a note that does NOT live under research/.
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
      research: ['[[Stray Notes]]'],
    });

    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);

    // Not physically present anywhere, so the location index is empty...
    expect(index.ownedNotes.size).toBe(0);

    // ...but the declared-owner lookup resolves it (case-insensitive).
    const declared = findDeclaredOwner(index, 'Stray Notes');
    expect(declared).toBeDefined();
    expect(declared?.ownerPath).toBe('drafts/My Novel/My Novel.md');
    expect(declared?.ownerType).toBe('draft');
    expect(declared?.fieldName).toBe('research');
    expect(findDeclaredOwner(index, 'stray notes')).toBeDefined();
    expect(findDeclaredOwner(index, 'Unknown')).toBeUndefined();
  });

  // A declared `owned` wikilink may be written path-qualified, aliased, or both.
  // The declaredOwned key must normalize to the bare basename so a lookup by the
  // misplaced note's basename still resolves the owner (the #734 defect).
  it.each([
    ['path-qualified', '[[research/Stray Notes]]'],
    ['aliased', '[[Stray Notes|My Alias]]'],
    ['path + alias', '[[research/Stray Notes|My Alias]]'],
  ])('resolves a declared owned note linked with a %s wikilink', async (_label, link) => {
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
      research: [link],
    });

    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);

    // Lookup is by the note's plain basename — it must resolve regardless of how
    // the owner wrote the link.
    const declared = findDeclaredOwner(index, 'Stray Notes');
    expect(declared).toBeDefined();
    expect(declared?.ownerPath).toBe('drafts/My Novel/My Novel.md');
    expect(declared?.fieldName).toBe('research');
    // Stored note name is the normalized basename, not the raw path/alias.
    expect(declared?.notePath).toBe('Stray Notes');
    // Case-insensitive lookup still works.
    expect(findDeclaredOwner(index, 'stray notes')).toBeDefined();
  });

  // #734 (defect A): when TWO distinct owners declare the same basename, the
  // declaredOwned map can only keep one (arbitrary) owner. The ambiguity must be
  // recorded separately so audit refuses to auto-restore the note under a
  // guessed owner.
  it('flags a basename declared by two distinct owners as ambiguous', async () => {
    // Both a draft (via `research`) and a project (via `notes`) declare ownership
    // of the same note name "Shared Notes".
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
      research: ['[[Shared Notes]]'],
    });
    createNote(vaultDir, 'projects/Big Project/Big Project.md', {
      type: 'project',
      status: 'active',
      notes: ['[[Shared Notes]]'],
    });

    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);

    // Ambiguity is recorded (case-insensitive, all wikilink forms).
    expect(isDeclaredOwnershipAmbiguous(index, 'Shared Notes')).toBe(true);
    expect(isDeclaredOwnershipAmbiguous(index, 'shared notes')).toBe(true);
    // A name declared by only one owner is NOT ambiguous.
    expect(isDeclaredOwnershipAmbiguous(index, 'Unknown')).toBe(false);
  });

  // The same owner listing a basename more than once (or under two of its own
  // fields) is NOT a conflict — only DISTINCT owners create ambiguity.
  it('does not flag a basename declared twice by the SAME owner as ambiguous', async () => {
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
      research: ['[[Stray Notes]]', '[[Stray Notes]]'],
    });

    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);

    expect(isDeclaredOwnershipAmbiguous(index, 'Stray Notes')).toBe(false);
    expect(findDeclaredOwner(index, 'Stray Notes')).toBeDefined();
  });

  // `getDeclaredOwners` exposes EVERY distinct declaring owner (with the field
  // that declared it) so callers can re-evaluate ambiguity AFTER filtering by
  // the audited note's resolved child type (#734 follow-up).
  it('returns all distinct declaring owners (each with its declaring field) for a basename', async () => {
    // Both draft (via `research`) and project (via `notes`) declare "Shared Notes".
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
      research: ['[[Shared Notes]]'],
    });
    createNote(vaultDir, 'projects/Big Project/Big Project.md', {
      type: 'project',
      status: 'active',
      notes: ['[[Shared Notes]]'],
    });

    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);

    const owners = getDeclaredOwners(index, 'Shared Notes');
    expect(owners).toHaveLength(2);
    // Both declaring fields are preserved (the data the type filter relies on).
    expect(owners.map(o => o.fieldName).sort()).toEqual(['notes', 'research']);
    expect(owners.map(o => o.ownerType).sort()).toEqual(['draft', 'project']);
    // Case-insensitive, all wikilink forms.
    expect(getDeclaredOwners(index, 'shared notes')).toHaveLength(2);
    // Unknown basenames resolve to an empty list.
    expect(getDeclaredOwners(index, 'Unknown')).toEqual([]);
  });

  it('deduplicates the SAME owner declaring a basename more than once', async () => {
    createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
      type: 'draft',
      status: 'active',
      research: ['[[Stray Notes]]', '[[Stray Notes]]'],
    });

    const schema = await loadSchema(vaultDir);
    const index = await buildOwnershipIndex(schema, vaultDir);

    expect(getDeclaredOwners(index, 'Stray Notes')).toHaveLength(1);
  });
});

describe('Ownership Validation', () => {
  let vaultDir: string;
  
  beforeEach(() => {
    vaultDir = createTestVault();
  });
  
  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });
  
  describe('isNoteOwned', () => {
    it('should return undefined for non-owned notes', async () => {
      // Create a standalone research note (not owned)
      createNote(vaultDir, 'research/Fantasy Tropes.md', {
        type: 'research',
        status: 'raw',
      });
      
      const schema = await loadSchema(vaultDir);
      const index = await buildOwnershipIndex(schema, vaultDir);
      
      expect(isNoteOwned(index, 'research/Fantasy Tropes.md')).toBeUndefined();
    });
    
    it('should return owner info for owned notes', async () => {
      mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
      createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
        type: 'draft',
        status: 'active',
      });
      createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
        type: 'research',
        status: 'raw',
      });
      
      const schema = await loadSchema(vaultDir);
      const index = await buildOwnershipIndex(schema, vaultDir);
      
      const info = isNoteOwned(index, 'drafts/My Novel/research/Character Notes.md');
      expect(info).toBeDefined();
      expect(info?.ownerPath).toBe('drafts/My Novel/My Novel.md');
    });
  });
  
  describe('canReference', () => {
    it('should allow referencing non-owned notes', async () => {
      createNote(vaultDir, 'research/Fantasy Tropes.md', {
        type: 'research',
        status: 'raw',
      });
      
      const schema = await loadSchema(vaultDir);
      const index = await buildOwnershipIndex(schema, vaultDir);
      
      const result = canReference(
        index,
        'some/other/note.md',
        'research/Fantasy Tropes.md'
      );
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
    
    it('should allow owner to reference its owned notes', async () => {
      mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
      createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
        type: 'draft',
        status: 'active',
      });
      createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
        type: 'research',
        status: 'raw',
      });
      
      const schema = await loadSchema(vaultDir);
      const index = await buildOwnershipIndex(schema, vaultDir);
      
      const result = canReference(
        index,
        'drafts/My Novel/My Novel.md',
        'drafts/My Novel/research/Character Notes.md'
      );
      
      expect(result.valid).toBe(true);
    });
    
    it('should reject non-owners referencing owned notes', async () => {
      mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
      createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
        type: 'draft',
        status: 'active',
      });
      createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
        type: 'research',
        status: 'raw',
      });
      createNote(vaultDir, 'drafts/Other Draft.md', {
        type: 'draft',
        status: 'raw',
      });
      
      const schema = await loadSchema(vaultDir);
      const index = await buildOwnershipIndex(schema, vaultDir);
      
      const result = canReference(
        index,
        'drafts/Other Draft.md',
        'drafts/My Novel/research/Character Notes.md'
      );
      
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.type).toBe('referencing_owned');
    });
  });
  
  describe('validateNewOwned', () => {
    it('should allow creating new owned notes', async () => {
      const schema = await loadSchema(vaultDir);
      const index = await buildOwnershipIndex(schema, vaultDir);
      
      const result = validateNewOwned(
        index,
        'drafts/My Novel/research/New Note.md',
        'drafts/My Novel/My Novel.md'
      );
      
      expect(result.valid).toBe(true);
    });
    
    it('should reject if note is already owned by different owner', async () => {
      mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
      createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
        type: 'draft',
        status: 'active',
      });
      createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
        type: 'research',
        status: 'raw',
      });
      
      const schema = await loadSchema(vaultDir);
      const index = await buildOwnershipIndex(schema, vaultDir);
      
      // Try to claim the same note for a different owner
      const result = validateNewOwned(
        index,
        'drafts/My Novel/research/Character Notes.md',
        'drafts/Other Draft/Other Draft.md'
      );
      
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.type).toBe('already_owned');
    });
  });
});

describe('Wikilink Extraction', () => {
  it('should extract single wikilink', () => {
    const refs = extractWikilinkReferences('[[My Note]]');
    expect(refs).toEqual(['My Note']);
  });
  
  it('should extract multiple wikilinks', () => {
    const refs = extractWikilinkReferences('See [[Note 1]] and [[Note 2]]');
    expect(refs).toEqual(['Note 1', 'Note 2']);
  });
  
  it('should extract from quoted wikilinks', () => {
    const refs = extractWikilinkReferences('"[[Quoted Note]]"');
    expect(refs).toEqual(['Quoted Note']);
  });
  
  it('should extract from arrays', () => {
    const refs = extractWikilinkReferences(['[[Note 1]]', '[[Note 2]]']);
    expect(refs).toEqual(['Note 1', 'Note 2']);
  });
  
  it('should return empty for non-wikilink values', () => {
    const refs = extractWikilinkReferences('plain text');
    expect(refs).toEqual([]);
  });
  
  it('should return empty for non-string values', () => {
    const refs = extractWikilinkReferences(123);
    expect(refs).toEqual([]);
  });
});

describe('Ownership Audit Integration', () => {
  let vaultDir: string;
  
  beforeEach(() => {
    vaultDir = createTestVault();
  });
  
  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });
  
  describe('owned-note-referenced detection', () => {
    it('should detect when a non-owner references an owned note', async () => {
      // Create an owner with an owned note
      mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
      createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
        type: 'draft',
        status: 'active',
        research: '[[Character Notes]]',
      });
      createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
        type: 'research',
        status: 'raw',
      });
      
      // Create another draft that tries to reference the owned note
      createNote(vaultDir, 'drafts/Other Draft.md', {
        type: 'draft',
        status: 'raw',
        related: '[[Character Notes]]', // 'related' is not an owned field, so this is an illegal reference
      });
      
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      
      // Find the issue for Other Draft
      const otherDraftResult = results.find(r => r.relativePath.includes('Other Draft'));
      expect(otherDraftResult).toBeDefined();
      
      const ownershipIssue = otherDraftResult?.issues.find(i => i.code === 'owned-note-referenced');
      expect(ownershipIssue).toBeDefined();
      expect(ownershipIssue?.field).toBe('related');
      expect(ownershipIssue?.ownerPath).toBe('drafts/My Novel/My Novel.md');
    });
    
    it('should not flag owner referencing its own owned notes', async () => {
      // Create an owner with an owned note
      mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
      createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
        type: 'draft',
        status: 'active',
        research: '[[Character Notes]]', // Owner referencing its owned note - valid
      });
      createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
        type: 'research',
        status: 'raw',
      });
      
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      
      // The owner should have no ownership violations
      const novelResult = results.find(r => r.relativePath.includes('My Novel/My Novel'));
      
      // Either no result (no issues) or no ownership issues
      if (novelResult) {
        const ownershipIssues = novelResult.issues.filter(i => i.code === 'owned-note-referenced');
        expect(ownershipIssues).toHaveLength(0);
      }
    });
    
    it('should not flag standalone notes being referenced', async () => {
      // Create a standalone research note (not in an owner's folder)
      mkdirSync(join(vaultDir, 'research'), { recursive: true });
      createNote(vaultDir, 'research/Fantasy Tropes.md', {
        type: 'research',
        status: 'raw',
      });
      
      // Another note references the standalone note
      mkdirSync(join(vaultDir, 'drafts'), { recursive: true });
      createNote(vaultDir, 'drafts/My Draft.md', {
        type: 'draft',
        status: 'raw',
        related: '[[Fantasy Tropes]]', // Referencing standalone - valid
      });
      
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      
      // No ownership issues
      const draftResult = results.find(r => r.relativePath.includes('My Draft'));
      
      if (draftResult) {
        const ownershipIssues = draftResult.issues.filter(i => i.code === 'owned-note-referenced');
        expect(ownershipIssues).toHaveLength(0);
      }
    });
  });
  
  describe('multiple references in single field', () => {
    it('should detect multiple owned note references', async () => {
      // Create an owner with multiple owned notes
      mkdirSync(join(vaultDir, 'drafts', 'My Novel', 'research'), { recursive: true });
      createNote(vaultDir, 'drafts/My Novel/My Novel.md', {
        type: 'draft',
        status: 'active',
      });
      createNote(vaultDir, 'drafts/My Novel/research/Character Notes.md', {
        type: 'research',
        status: 'raw',
      });
      createNote(vaultDir, 'drafts/My Novel/research/World Building.md', {
        type: 'research',
        status: 'raw',
      });
      
      // Another draft references both owned notes
      createNote(vaultDir, 'drafts/Other Draft.md', {
        type: 'draft',
        status: 'raw',
        related: ['[[Character Notes]]', '[[World Building]]'],
      });
      
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      
      // Find the issue for Other Draft
      const otherDraftResult = results.find(r => r.relativePath.includes('Other Draft'));
      expect(otherDraftResult).toBeDefined();
      
      const ownershipIssues = otherDraftResult?.issues.filter(i => i.code === 'owned-note-referenced');
      // Should find 2 issues, one for each owned note reference
      expect(ownershipIssues?.length).toBe(2);
    });
  });
});

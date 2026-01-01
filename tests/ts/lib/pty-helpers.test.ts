/**
 * Tests for the PTY helpers, specifically the includeTemplates functionality.
 */

import { describe, it, expect } from 'vitest';
import {
  createTempVault,
  cleanupTempVault,
  copyFixtureTemplates,
  vaultFileExists,
  readVaultFile,
  MINIMAL_SCHEMA,
  TempVaultFile,
} from './pty-helpers.js';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('copyFixtureTemplates', () => {
  it('should copy all templates when types is undefined', async () => {
    const vaultPath = await createTempVault();
    try {
      await copyFixtureTemplates(vaultPath);
      
      // Check that idea template exists
      const ideaDefault = await vaultFileExists(vaultPath, '.pika/templates/idea/default.md');
      expect(ideaDefault).toBe(true);
      
      // Check that objective/task templates exist
      const taskDefault = await vaultFileExists(vaultPath, '.pika/templates/objective/task/default.md');
      expect(taskDefault).toBe(true);
      
      const taskBugReport = await vaultFileExists(vaultPath, '.pika/templates/objective/task/bug-report.md');
      expect(taskBugReport).toBe(true);
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });

  it('should copy only specified types when types array is provided', async () => {
    const vaultPath = await createTempVault();
    try {
      await copyFixtureTemplates(vaultPath, ['idea']);
      
      // Idea template should exist
      const ideaDefault = await vaultFileExists(vaultPath, '.pika/templates/idea/default.md');
      expect(ideaDefault).toBe(true);
      
      // Objective templates should NOT exist
      const taskDefault = await vaultFileExists(vaultPath, '.pika/templates/objective/task/default.md');
      expect(taskDefault).toBe(false);
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });

  it('should handle non-existent types gracefully', async () => {
    const vaultPath = await createTempVault();
    try {
      // Should not throw when type doesn't exist
      await copyFixtureTemplates(vaultPath, ['nonexistent-type']);
      
      // Templates directory should exist but be empty
      const templatesDir = path.join(vaultPath, '.pika', 'templates');
      const entries = await fs.readdir(templatesDir);
      expect(entries.length).toBe(0);
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });

  it('should preserve template content correctly', async () => {
    const vaultPath = await createTempVault();
    try {
      await copyFixtureTemplates(vaultPath, ['idea']);
      
      const content = await readVaultFile(vaultPath, '.pika/templates/idea/default.md');
      expect(content).toContain('type: template');
      expect(content).toContain('template-for: idea');
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });
});

describe('createTempVault with includeTemplates', () => {
  it('should include all templates when includeTemplates is true', async () => {
    const vaultPath = await createTempVault([], MINIMAL_SCHEMA, true);
    try {
      const ideaDefault = await vaultFileExists(vaultPath, '.pika/templates/idea/default.md');
      expect(ideaDefault).toBe(true);
      
      const taskDefault = await vaultFileExists(vaultPath, '.pika/templates/objective/task/default.md');
      expect(taskDefault).toBe(true);
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });

  it('should include only specified templates when includeTemplates is array', async () => {
    const vaultPath = await createTempVault([], MINIMAL_SCHEMA, ['idea']);
    try {
      const ideaDefault = await vaultFileExists(vaultPath, '.pika/templates/idea/default.md');
      expect(ideaDefault).toBe(true);
      
      const taskDefault = await vaultFileExists(vaultPath, '.pika/templates/objective/task/default.md');
      expect(taskDefault).toBe(false);
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });

  it('should not include templates when includeTemplates is undefined', async () => {
    const vaultPath = await createTempVault();
    try {
      const ideaDefault = await vaultFileExists(vaultPath, '.pika/templates/idea/default.md');
      expect(ideaDefault).toBe(false);
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });

  it('should create both files and templates', async () => {
    const files: TempVaultFile[] = [
      { path: 'Ideas/Test.md', content: '---\ntype: idea\n---\n' },
    ];
    const vaultPath = await createTempVault(files, MINIMAL_SCHEMA, true);
    try {
      // Custom file should exist
      const testFile = await vaultFileExists(vaultPath, 'Ideas/Test.md');
      expect(testFile).toBe(true);
      
      // Templates should also exist
      const ideaDefault = await vaultFileExists(vaultPath, '.pika/templates/idea/default.md');
      expect(ideaDefault).toBe(true);
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });

  it('should allow files to override templates', async () => {
    // Create a custom template that overrides the fixture one
    const files: TempVaultFile[] = [
      { 
        path: '.pika/templates/idea/default.md', 
        content: '---\ntype: template\ncustom: true\n---\nCustom body\n',
      },
    ];
    // Templates are copied first, then files are written on top
    const vaultPath = await createTempVault(files, MINIMAL_SCHEMA, true);
    try {
      const content = await readVaultFile(vaultPath, '.pika/templates/idea/default.md');
      expect(content).toContain('custom: true');
      expect(content).toContain('Custom body');
    } finally {
      await cleanupTempVault(vaultPath);
    }
  });
});

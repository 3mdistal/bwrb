/**
 * Vitest setup file for test isolation and PTY cleanup.
 *
 * This file:
 * 1. Sets BWRB_VAULT to the fixture vault to prevent tests from
 *    accidentally reading a developer's real vault
 * 2. Ensures orphaned PTY processes are killed:
 *    - After each test (via afterEach hook)
 *    - On process interrupt (Ctrl+C) via SIGINT/SIGTERM handlers
 *    - On uncaught exceptions
 *
 * The afterEach hook handles normal test completion and timeouts,
 * but signal handlers are needed for user interrupts (Ctrl+C)
 * which bypass vitest's lifecycle hooks entirely.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach } from 'vitest';
import { killAllPtyProcesses } from './lib/pty-helpers.js';

// Set BWRB_VAULT to fixture vault as a safety net.
// This ensures tests that forget --vault don't accidentally use the developer's real vault.
// Individual tests can still override via --vault flag or by creating temp vaults.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.BWRB_VAULT = path.resolve(__dirname, '../fixtures/vault');

// Kill any orphaned PTY processes after each test
afterEach(() => {
  killAllPtyProcesses();
});

// Handle process interrupts (Ctrl+C) - vitest lifecycle doesn't run on SIGINT
process.once('SIGINT', () => {
  killAllPtyProcesses();
  process.exit(130); // Standard exit code for SIGINT
});

process.once('SIGTERM', () => {
  killAllPtyProcesses();
  process.exit(143); // Standard exit code for SIGTERM
});

// Clean up on uncaught exceptions before crashing
process.once('uncaughtException', (err) => {
  console.error('Uncaught exception in tests:', err);
  killAllPtyProcesses();
  process.exit(1);
});

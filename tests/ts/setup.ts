/**
 * Vitest setup file for PTY test cleanup.
 *
 * Ensures orphaned PTY processes are killed:
 * 1. After each test (via afterEach hook)
 * 2. On process interrupt (Ctrl+C) via SIGINT/SIGTERM handlers
 * 3. On uncaught exceptions
 *
 * The afterEach hook handles normal test completion and timeouts,
 * but signal handlers are needed for user interrupts (Ctrl+C)
 * which bypass vitest's lifecycle hooks entirely.
 */

import { afterEach } from 'vitest';
import { killAllPtyProcesses } from './lib/pty-helpers.js';

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

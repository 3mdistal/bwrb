/**
 * Vitest setup file for PTY test cleanup.
 * 
 * Ensures orphaned PTY processes are killed after each test,
 * even if the test times out (when vitest aborts the test
 * without running the finally block).
 */

import { afterEach } from 'vitest';
import { killAllPtyProcesses } from './lib/pty-helpers.js';

// Kill any orphaned PTY processes after each test
afterEach(() => {
  killAllPtyProcesses();
});

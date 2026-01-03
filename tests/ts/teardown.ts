/**
 * Vitest global teardown for PTY process cleanup.
 *
 * Runs after all tests complete to ensure no orphaned PTY processes remain.
 * This is a safety net - individual tests should clean up via afterEach,
 * but this catches any processes that slip through.
 */

import { killAllPtyProcesses } from './lib/pty-helpers.js';

export default async function teardown(): Promise<void> {
  killAllPtyProcesses();
}

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import {
  DashboardsFileSchema,
  type DashboardDefinition,
  type DashboardsFile,
} from '../types/schema.js';

/**
 * Dashboard Persistence Layer
 * ===========================
 *
 * Dashboards are saved `bwrb list` queries stored in .bwrb/dashboards.json.
 * This module provides CRUD operations for managing dashboards.
 */

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the path to the dashboards.json file.
 */
export function getDashboardsPath(vaultDir: string): string {
  return join(vaultDir, '.bwrb', 'dashboards.json');
}

// ============================================================================
// Load / Save
// ============================================================================

/**
 * Load and validate dashboards from .bwrb/dashboards.json.
 * Returns an empty dashboards object if the file doesn't exist.
 *
 * @throws Error if file exists but contains invalid JSON or fails schema validation
 */
export async function loadDashboards(vaultDir: string): Promise<DashboardsFile> {
  const path = getDashboardsPath(vaultDir);

  if (!existsSync(path)) {
    return { dashboards: {} };
  }

  const content = await readFile(path, 'utf-8');
  const parsed = JSON.parse(content);
  return DashboardsFileSchema.parse(parsed);
}

/**
 * Save dashboards to .bwrb/dashboards.json.
 * Creates the .bwrb directory and file if they don't exist.
 * Validates the data before writing.
 *
 * @throws Error if validation fails
 */
export async function saveDashboards(
  vaultDir: string,
  dashboards: DashboardsFile
): Promise<void> {
  // Validate before saving
  DashboardsFileSchema.parse(dashboards);

  const path = getDashboardsPath(vaultDir);

  // Ensure .bwrb directory exists
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, JSON.stringify(dashboards, null, 2) + '\n', 'utf-8');
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get a single dashboard by name.
 * Returns null if the dashboard doesn't exist.
 */
export async function getDashboard(
  vaultDir: string,
  name: string
): Promise<DashboardDefinition | null> {
  const data = await loadDashboards(vaultDir);
  return data.dashboards[name] ?? null;
}

/**
 * List all dashboard names, sorted alphabetically.
 */
export async function listDashboards(vaultDir: string): Promise<string[]> {
  const data = await loadDashboards(vaultDir);
  return Object.keys(data.dashboards).sort((a, b) => a.localeCompare(b));
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new dashboard.
 *
 * @throws Error if a dashboard with this name already exists
 */
export async function createDashboard(
  vaultDir: string,
  name: string,
  definition: DashboardDefinition
): Promise<void> {
  const data = await loadDashboards(vaultDir);

  if (data.dashboards[name] !== undefined) {
    throw new Error(`Dashboard "${name}" already exists`);
  }

  data.dashboards[name] = definition;
  await saveDashboards(vaultDir, data);
}

/**
 * Update an existing dashboard.
 *
 * @throws Error if the dashboard doesn't exist
 */
export async function updateDashboard(
  vaultDir: string,
  name: string,
  definition: DashboardDefinition
): Promise<void> {
  const data = await loadDashboards(vaultDir);

  if (data.dashboards[name] === undefined) {
    throw new Error(`Dashboard "${name}" does not exist`);
  }

  data.dashboards[name] = definition;
  await saveDashboards(vaultDir, data);
}

/**
 * Delete a dashboard.
 *
 * @throws Error if the dashboard doesn't exist
 */
export async function deleteDashboard(
  vaultDir: string,
  name: string
): Promise<void> {
  const data = await loadDashboards(vaultDir);

  if (data.dashboards[name] === undefined) {
    throw new Error(`Dashboard "${name}" does not exist`);
  }

  delete data.dashboards[name];
  await saveDashboards(vaultDir, data);
}

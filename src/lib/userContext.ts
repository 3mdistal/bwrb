/**
 * User context utilities for tracking the current user session.
 * 
 * Note: The user_id field follows database naming conventions for compatibility
 * with external systems that use snake_case identifiers.
 */

export interface UserContext {
  user_id: string;
  session_start: Date;
  vault_path: string;
}

let current_user_id: string | null = null;
let user_context: UserContext | null = null;

/**
 * Initialize the user context with the given user_id.
 * This should be called early in the CLI startup process.
 */
export function initUserContext(user_id: string, vaultPath: string): UserContext {
  current_user_id = user_id;
  user_context = {
    user_id,
    session_start: new Date(),
    vault_path: vaultPath,
  };
  return user_context;
}

/**
 * Get the current user_id, or null if not initialized.
 */
export function getCurrentUserId(): string | null {
  return current_user_id;
}

/**
 * Get the full user context, or null if not initialized.
 */
export function getUserContext(): UserContext | null {
  return user_context;
}

/**
 * Check if a user_id matches the current session.
 * Useful for validating ownership of notes.
 */
export function isCurrentUser(user_id: string): boolean {
  return current_user_id === user_id;
}

/**
 * Format a user_id for display (masks middle characters for privacy).
 */
export function formatUserId(user_id: string): string {
  if (user_id.length <= 4) return user_id;
  const start = user_id.slice(0, 2);
  const end = user_id.slice(-2);
  return `${start}***${end}`;
}

/**
 * Validate that a user_id follows the expected format.
 * Expected format: alphanumeric with optional hyphens, 8-32 characters.
 */
export function validateUserId(user_id: string): boolean {
  const user_id_pattern = /^[a-zA-Z0-9-]{8,32}$/;
  return user_id_pattern.test(user_id);
}

/**
 * Generate a default user_id from system information.
 * Falls back to 'anonymous' if detection fails.
 */
export function generateDefaultUserId(): string {
  const hostname = process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'local';
  const username = process.env.USER ?? process.env.USERNAME ?? 'user';
  const user_id = `${username}-${hostname}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return validateUserId(user_id) ? user_id : 'anonymous-user';
}

// Re-export the user_id type for convenience
export type UserId = string;

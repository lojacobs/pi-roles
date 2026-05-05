/**
 * Internal debug logger for pi-roles.
 *
 * Only writes to disk when PI_ROLES_DEBUG is set (to any non-empty value).
 * Output goes to /tmp/pi-roles-debug.log with timestamps.
 *
 * This is NOT a user-facing log. It exists so developers (and users who
 * explicitly opt in) can trace why title generation, role resolution, or
 * model application fails without polluting the TUI.
 */

import { appendFileSync } from "node:fs";

const ENABLED = process.env.PI_ROLES_DEBUG && process.env.PI_ROLES_DEBUG.length > 0;
const LOG_PATH = process.env.PI_ROLES_DEBUG_PATH || "/tmp/pi-roles-debug.log";

function now(): string {
  return new Date().toISOString();
}

export function debugLog(label: string, message: string, extra?: unknown): void {
  if (!ENABLED) return;
  try {
    const line = extra !== undefined
      ? `[${now()}] [${label}] ${message} | extra=${JSON.stringify(extra)}\n`
      : `[${now()}] [${label}] ${message}\n`;
    appendFileSync(LOG_PATH, line);
  } catch {
    // If logging itself fails, stay silent — don't break the extension.
  }
}

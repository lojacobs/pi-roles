/**
 * Settings loader for the `pi-roles` namespace.
 *
 * Pi's own `SettingsManager` isn't exposed on `ExtensionContext`, so we read
 * the JSON files ourselves. Locations mirror Pi's convention:
 *   - project: `<cwd-or-ancestor>/.pi/settings.json`
 *   - user:    `~/.pi/agent/settings.json`
 *
 * Project wins on field-level merge — same precedence Pi applies to its own
 * settings. Unknown fields and parse errors are tolerated; we only care about
 * the `pi-roles` sub-object and only fields covered by `PiRolesSettingsSchema`
 * are honored downstream.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Value } from "typebox/value";
import { PiRolesSettingsSchema, type PiRolesSettings } from "./schemas.ts";
import { debugLog } from "./debug.ts";

const NAMESPACE = "pi-roles";

function findProjectSettingsFile(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".pi", "settings.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function userSettingsFile(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function readNamespace(path: string | null): Partial<PiRolesSettings> {
  if (!path || !existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    debugLog("settings", `failed to parse ${path}`);
    // A corrupt settings.json shouldn't take pi-roles down. Pi itself reports
    // its own load error via SettingsManager; we follow suit by silently
    // falling back to defaults rather than throwing on session_start.
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const raw = (parsed as Record<string, unknown>)[NAMESPACE];
  if (!raw || typeof raw !== "object") return {};
  // Validate but don't throw — coerce/discard unknown fields. Cast is safe
  // because additionalProperties: true on the schema, and Check confirmed
  // every present field matches.
  if (!Value.Check(PiRolesSettingsSchema, raw)) return {};
  return raw as PiRolesSettings;
}

/**
 * Load and merge pi-roles settings. Project values take precedence; absent
 * fields fall back to the documented defaults at the call site.
 */
export function loadSettings(cwd: string): PiRolesSettings {
  const user = readNamespace(userSettingsFile());
  const project = readNamespace(findProjectSettingsFile(cwd));
  return { ...user, ...project };
}

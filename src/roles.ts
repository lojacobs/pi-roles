/**
 * Role discovery, frontmatter parsing, and `extends` chain resolution.
 *
 * This module is filesystem-aware and pure with respect to Pi APIs — nothing
 * here touches `pi.*` or `ctx.*`. That keeps it trivially testable and lets
 * `apply.ts` own all of the side-effecting integration with the agent.
 *
 * The two entry points downstream code uses:
 *   - `discoverRoles(cwd, scope)` — find role files on disk plus the bundled
 *     built-in role-assistant.
 *   - `resolveRole(name, all)`     — turn a `RawRole` into a `ResolvedRole` by
 *     walking the `extends` chain and merging according to the documented
 *     precedence (child wins, parent body prepended).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { Value } from "typebox/value";
import {
  BUILTIN_ROLE_ASSISTANT_NAME,
  RoleFrontmatterSchema,
  type RawRole,
  type ResolvedRole,
  type RoleFrontmatter,
  type RoleScope,
  type RoleSource,
  type ToolsDirective,
} from "./schemas.ts";
import { debugLog } from "./debug.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown for every user-facing problem the loader catches: malformed
 * frontmatter, mismatched name/filename, missing parent in `extends`, cycle in
 * `extends`. The message is meant to be shown directly in the TUI, so keep it
 * actionable and include file paths when you have them.
 */
export class RoleResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleResolutionError";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A role file that exists on disk but was hidden by a higher-priority role of
 * the same name. We surface these in `/role list` so users notice when a
 * project role is shadowing a user-level one (or vice-versa).
 */
export interface ShadowedEntry {
  name: string;
  source: RoleSource;
  path: string;
}

export interface DiscoveryResult {
  /** Roles that won shadowing, keyed by `frontmatter.name`. */
  roles: RawRole[];
  /** Roles that lost shadowing, in discovery order. */
  shadowed: ShadowedEntry[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Walk up from `start` looking for a directory containing `.pi/roles/`. We
 * use the same lookup pattern Pi itself uses for `.pi/` — first hit wins,
 * stop at the filesystem root. Returns the absolute path to the roles dir,
 * or `null` if none exists in any ancestor.
 */
function findProjectRolesDir(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".pi", "roles");
    if (isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function userRolesDir(): string {
  return join(homedir(), ".pi", "agent", "roles");
}

/**
 * Resolve the bundled built-in roles directory relative to this file. We use
 * `import.meta.url` rather than `__dirname` because the package ships as ESM
 * and Pi loads sources via jiti without bundling.
 */
function builtInRolesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "resources", "roles");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List `.md` files in a directory (non-recursive, skipping dotfiles). Returns
 * an empty array if the directory doesn't exist — pi-roles installs work
 * fine without any of the three role directories present.
 */
function listRoleFiles(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .map((name) => join(dir, name));
}

/**
 * Discover role files across all three sources, applying shadowing rules.
 *
 * Precedence (highest first): project > user > built-in. The first occurrence
 * of a name wins; later occurrences are recorded as `shadowed` so `/role list`
 * can show the conflict.
 *
 * `scope` filters which user-writable directories we look at (`user`,
 * `project`, or `both`). The built-in roles are always included regardless of
 * scope — otherwise the fallback `role-assistant` would vanish under
 * `roleScope: "project"`.
 */
export function discoverRoles(cwd: string, scope: RoleScope): DiscoveryResult {
  const buckets: Array<{ source: RoleSource; files: string[] }> = [];

  if (scope === "project" || scope === "both") {
    const projectDir = findProjectRolesDir(cwd);
    buckets.push({ source: "project", files: projectDir ? listRoleFiles(projectDir) : [] });
  }
  if (scope === "user" || scope === "both") {
    buckets.push({ source: "user", files: listRoleFiles(userRolesDir()) });
  }
  buckets.push({ source: "built-in", files: listRoleFiles(builtInRolesDir()) });

  const roles: RawRole[] = [];
  const shadowed: ShadowedEntry[] = [];
  const seen = new Set<string>();

  for (const bucket of buckets) {
    for (const file of bucket.files) {
      const raw = loadRoleFile(file, bucket.source);
      if (seen.has(raw.frontmatter.name)) {
        shadowed.push({ name: raw.frontmatter.name, source: bucket.source, path: file });
        continue;
      }
      seen.add(raw.frontmatter.name);
      roles.push(raw);
    }
  }

  return { roles, shadowed };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Frontmatter delimiter regex. Matches `---` on its own line at the very
 * start of the file, then captures the YAML block, then a closing `---` on
 * its own line. Tolerates Windows line endings and trailing whitespace on
 * the delimiter line.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Read a role file from disk and produce a `RawRole`. Throws
 * `RoleResolutionError` for any user-facing problem (malformed frontmatter,
 * schema violation, mismatched name).
 *
 * Exported for tests; production callers go through `discoverRoles`.
 */
export function loadRoleFile(path: string, source: RoleSource): RawRole {
  const text = readFileSync(path, "utf8");
  return parseRoleSource(text, path, source);
}

export function parseRoleSource(text: string, path: string, source: RoleSource): RawRole {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    throw new RoleResolutionError(
      `${path}: missing or malformed frontmatter. Expected '---' delimited YAML at the top of the file.`,
    );
  }
  const yamlBlock = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    debugLog("roles", `YAML parse error in ${path}`, detail);
    throw new RoleResolutionError(`${path}: invalid YAML in frontmatter — ${detail}`);
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RoleResolutionError(`${path}: frontmatter must be a YAML mapping.`);
  }

  if (!Value.Check(RoleFrontmatterSchema, parsed)) {
    const errors = [...Value.Errors(RoleFrontmatterSchema, parsed)];
    const first = errors[0];
    const where = first ? first.instancePath || "(root)" : "(root)";
    const why = first ? first.message : "schema validation failed";
    throw new RoleResolutionError(`${path}: invalid frontmatter at ${where} — ${why}`);
  }

  const frontmatter = parsed as RoleFrontmatter;

  const expectedName = basenameWithoutExt(path);
  if (frontmatter.name !== expectedName) {
    throw new RoleResolutionError(
      `${path}: frontmatter 'name' is "${frontmatter.name}" but filename implies "${expectedName}". They must match.`,
    );
  }

  return { source, path, frontmatter, body };
}

function basenameWithoutExt(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.md$/, "");
}

// ---------------------------------------------------------------------------
// Tools tri-state
// ---------------------------------------------------------------------------

/**
 * Normalize a frontmatter `tools` value into the tri-state `ToolsDirective`.
 *
 * Why this is a tri-state: we need `inherit` (do nothing on apply / let
 * `extends` parent decide) to be distinguishable from `set: []` (explicitly
 * disable all tools). YAML collapses `tools:` and `tools: ~` to `null`, and
 * the field is `undefined` when missing. Both `null` and `""` mean
 * "explicitly empty"; `undefined` means "inherit".
 *
 * MCP `mcp:*` entries are kept verbatim here — runtime filtering against
 * pi-mcp-adapter's installed tools happens in `apply.ts` because that's where
 * we have access to `pi.getAllTools()`.
 */
export function normalizeTools(value: string | null | undefined): ToolsDirective {
  if (value === undefined) return { kind: "inherit" };
  if (value === null) return { kind: "set", names: [] };
  const names = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { kind: "set", names };
}

// ---------------------------------------------------------------------------
// extends resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a role by name into a `ResolvedRole`, walking the `extends` chain
 * and merging fields per the documented precedence:
 *
 *   - `description`, `model`, `thinking`, `intercom`: child wins; if child
 *     omits a field, the nearest ancestor that sets it wins.
 *   - `tools`: child's `ToolsDirective` wins unless it's `inherit`, in which
 *     case the parent's directive applies. Walking continues up until a
 *     non-`inherit` directive is found; if none, defaults to `inherit`.
 *   - `body`: parent body is prepended to child body, separated by a blank
 *     line + `---` + blank line. This applies recursively, so a 3-level
 *     chain produces grandparent → parent → child in order.
 *
 * Cycles throw a `RoleResolutionError` listing the full chain so the user
 * can see exactly which file points back at which.
 *
 * Missing `extends` parents are also a hard error — silently dropping them
 * would leave the user with a role that quietly doesn't behave the way the
 * frontmatter promises.
 */
export function resolveRole(name: string, all: RawRole[]): ResolvedRole {
  const byName = new Map<string, RawRole>();
  for (const r of all) byName.set(r.frontmatter.name, r);

  const leaf = byName.get(name);
  if (!leaf) {
    debugLog("roles", `role not found: ${name}`);
    throw new RoleResolutionError(
      `Role "${name}" not found. Run /role list to see available roles.`,
    );
  }

  // Walk leaf -> root, building an ordered list (leaf first). Detect cycles.
  const chain: RawRole[] = [];
  const seen = new Set<string>();
  let cursor: RawRole | undefined = leaf;
  while (cursor) {
    if (seen.has(cursor.frontmatter.name)) {
      const cyclePath = [...chain.map((r) => r.frontmatter.name), cursor.frontmatter.name];
      throw new RoleResolutionError(
        `Cycle detected in 'extends' chain: ${cyclePath.join(" -> ")}`,
      );
    }
    seen.add(cursor.frontmatter.name);
    chain.push(cursor);

    const parentName = cursor.frontmatter.extends;
    if (!parentName) break;
    const parent = byName.get(parentName);
    if (!parent) {
      debugLog("roles", `extends not found: ${cursor.frontmatter.name} -> ${parentName}`);
      throw new RoleResolutionError(
        `Role "${cursor.frontmatter.name}" extends "${parentName}", but no such role was found.`,
      );
    }
    cursor = parent;
  }

  // Merge from root down to leaf so the leaf's values win on overlap.
  const ordered = [...chain].reverse();

  let description: string | undefined;
  let model: string | undefined;
  let thinking: ResolvedRole["thinking"];
  let intercom: ResolvedRole["intercom"];
  let tools: ToolsDirective = { kind: "inherit" };
  const bodies: string[] = [];

  for (const role of ordered) {
    const fm = role.frontmatter;
    if (fm.description) description = fm.description;
    if (fm.model !== undefined) model = fm.model;
    if (fm.thinking !== undefined) thinking = fm.thinking;
    if (fm.intercom !== undefined) intercom = fm.intercom;
    const directive = normalizeTools(fm.tools);
    if (directive.kind === "set") tools = directive;
    if (role.body.length > 0) bodies.push(role.body);
  }

  // Schema guarantees leaf.frontmatter.description is non-empty; merge can
  // only widen, so this is just a defensive default.
  const finalDescription = description ?? leaf.frontmatter.description;

  return {
    name: leaf.frontmatter.name,
    description: finalDescription,
    model,
    thinking,
    tools,
    intercom,
    body: bodies.join("\n\n---\n\n"),
    source: leaf.source,
    path: leaf.path,
    // chain[] is leaf-first per the field contract.
    extendsChain: chain.map((r) => r.frontmatter.name),
  };
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Helper for callers that just want "the role-assistant if nothing else is
 * available". Returns the built-in by name from a discovery result, or
 * `undefined` if it isn't present (which would only happen if the bundled
 * resources directory was deleted).
 */
export function findBuiltInAssistant(roles: RawRole[]): RawRole | undefined {
  return roles.find(
    (r) => r.frontmatter.name === BUILTIN_ROLE_ASSISTANT_NAME && r.source === "built-in",
  );
}

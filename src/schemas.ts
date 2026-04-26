/**
 * TypeBox schemas for pi-roles.
 *
 * These define:
 *   - The role frontmatter contract (parsed from YAML in `.md` files).
 *   - The pi-roles settings contract (read from `settings.json`).
 *   - The persisted "active role" state (stored via `pi.appendEntry` so it
 *     survives `/reload`).
 *
 * Everything that touches role data downstream imports from this file. If you
 * need to extend a contract, change it here first.
 *
 * We use `typebox` (1.x), not `@sinclair/typebox` 0.34 — pi-mono migrated and
 * its docs explicitly tell new extensions to depend on the `typebox` root
 * package. See pi-mono CHANGELOG for the migration notes.
 */

import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Pi's thinking levels, mirrored from `ThinkingLevel` in @mariozechner/pi-ai.
 *
 * We don't import the type directly because we want to validate user-supplied
 * frontmatter and produce friendly error messages instead of letting Pi
 * complain later.
 */
export const ThinkingLevelSchema = Type.Union(
  [
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
  ],
  { description: "Reasoning effort level. 'off' for non-reasoning models." },
);
export type ThinkingLevelValue = Static<typeof ThinkingLevelSchema>;

/**
 * Intercom integration mode for a role or for the global default.
 *
 * - off:     no intercom tool, no prompt addendum.
 * - receive: targetable by other sessions, no proactive sends.
 * - send:    can send to other sessions, no inbound coordination expected.
 * - both:    full bidirectional coordination.
 */
export const IntercomModeSchema = Type.Union(
  [
    Type.Literal("off"),
    Type.Literal("receive"),
    Type.Literal("send"),
    Type.Literal("both"),
  ],
  { description: "Per-role intercom mode. Defaults to global intercomMode setting when omitted." },
);
export type IntercomMode = Static<typeof IntercomModeSchema>;

/**
 * Discovery scope for role files.
 *
 * - user:    only ~/.pi/agent/roles/
 * - project: only <repo>/.pi/roles/
 * - both:    both, with project taking priority on name collision (and
 *            built-in resources at lowest priority always).
 */
export const RoleScopeSchema = Type.Union(
  [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
  { description: "Which scopes to search when discovering roles." },
);
export type RoleScope = Static<typeof RoleScopeSchema>;

/**
 * Where a discovered role came from. Used in /role list output and for
 * shadowing detection. 'built-in' refers to roles bundled with the pi-roles
 * package (currently only `role-assistant`).
 */
export const RoleSourceSchema = Type.Union(
  [Type.Literal("project"), Type.Literal("user"), Type.Literal("built-in")],
  { description: "Origin of a discovered role file." },
);
export type RoleSource = Static<typeof RoleSourceSchema>;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Role frontmatter as it appears at the top of a role .md file.
 *
 * Notes on the design:
 *
 * - `tools` is intentionally kept as a raw string here. We need to distinguish
 *   three states downstream:
 *     - field absent in YAML  -> inherit from parent or keep current
 *     - field present but ""  -> explicitly disable all tools
 *     - field present with    -> override exactly these tools
 *       a value
 *   YAML parsers collapse `tools:` (no value) and `tools: ~` to `null`, and
 *   we get `undefined` when the field is missing from the object entirely.
 *   The schema accepts `string | null`, and `roles.ts` handles the tri-state
 *   semantics. Don't try to encode "absent" inside this schema — JSON Schema
 *   can't distinguish `undefined` from "not validated", which is why we
 *   handle this in code rather than in the type.
 *
 * - `model` is a free string here; resolution against
 *   `ctx.modelRegistry.find(provider, id)` happens in `apply.ts`. Keeping it
 *   loose lets users use either `provider/id` or just `id` syntax, matching
 *   Pi's `--model` flag.
 *
 * - `name` is required and must equal the filename without extension. We
 *   enforce that in `roles.ts` after parsing, not at the schema level.
 */
export const RoleFrontmatterSchema = Type.Object(
  {
    /** Unique identifier; must match the filename without `.md`. */
    name: Type.String({ minLength: 1, description: "Role identifier; matches the filename." }),

    /** One-line description shown in /role list and pickers. */
    description: Type.String({
      minLength: 1,
      description: "Short human-readable description of what the role is for.",
    }),

    /**
     * Model identifier in `provider/id` or `id` form. Resolved against Pi's
     * model registry at apply time. If the model isn't available, we warn
     * and keep the session's current model.
     */
    model: Type.Optional(Type.String({ description: "Model id; e.g. 'anthropic/claude-opus-4-7'." })),

    /** Reasoning level. Clamped to model capabilities by Pi. */
    thinking: Type.Optional(ThinkingLevelSchema),

    /**
     * Tool list as a raw, comma-separated string. Empty string means "no
     * tools". Use the `mcp:server-name` syntax for MCP tools (requires
     * pi-mcp-adapter at runtime). Parse and tri-state semantics live in
     * `roles.ts`. We accept `null` because YAML's `tools:` (no value)
     * deserializes to that.
     */
    tools: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "Comma-separated tool names. Empty/null = no tools. Use mcp:server-name for MCP tools.",
      }),
    ),

    /** Per-role intercom mode override. Falls back to global `intercomMode`. */
    intercom: Type.Optional(IntercomModeSchema),

    /**
     * Name of a parent role to inherit from. Resolved against the same scope
     * the child was loaded from, then user, then built-in. Cycles are a hard
     * error.
     */
    extends: Type.Optional(
      Type.String({ minLength: 1, description: "Parent role name to inherit from." }),
    ),
  },
  {
    additionalProperties: true,
    description:
      "Role frontmatter. Unknown fields are tolerated for forward compatibility; check warnings.",
  },
);
export type RoleFrontmatter = Static<typeof RoleFrontmatterSchema>;

// ---------------------------------------------------------------------------
// Resolved role
// ---------------------------------------------------------------------------

/**
 * The `tools` field after tri-state normalization. This is what apply.ts
 * actually consumes.
 *
 * - `{ kind: "inherit" }` -> field absent in frontmatter; do nothing on
 *   apply unless an `extends` chain provides a different value.
 * - `{ kind: "set", names: [] }` -> explicitly empty; pass [] to setActiveTools.
 * - `{ kind: "set", names: [...] }` -> explicit list; pass through to
 *   setActiveTools (after stripping mcp:* entries when pi-mcp-adapter is not
 *   installed).
 */
export type ToolsDirective =
  | { kind: "inherit" }
  | { kind: "set"; names: string[] };

/**
 * A fully-resolved role: frontmatter + body, with `extends` chain merged in.
 *
 * `RawRole` is what we get from disk before merging. `ResolvedRole` is what
 * apply.ts consumes. The conversion happens in `roles.ts`.
 */
export interface RawRole {
  /** Where the role was loaded from. */
  source: RoleSource;
  /** Absolute path to the .md file (or a synthetic path for built-in roles). */
  path: string;
  /** Parsed frontmatter, validated against RoleFrontmatterSchema. */
  frontmatter: RoleFrontmatter;
  /** Markdown body — the system prompt. */
  body: string;
}

export interface ResolvedRole {
  /** Final name (always equals frontmatter.name). */
  name: string;
  /** Final description. */
  description: string;
  /** Final model id, or undefined to keep current. */
  model?: string;
  /** Final thinking level, or undefined to keep current. */
  thinking?: ThinkingLevelValue;
  /** Final tools directive after merging the extends chain. */
  tools: ToolsDirective;
  /** Final intercom mode, or undefined to fall back to global. */
  intercom?: IntercomMode;
  /** Final system prompt body (parent body prepended to child body when extending). */
  body: string;
  /** Source of the leaf role file (always the file the user requested by name). */
  source: RoleSource;
  /** Path of the leaf role file. */
  path: string;
  /** Names of all parent roles in resolution order, leaf-first. Useful for diagnostics. */
  extendsChain: string[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The pi-roles section of Pi's settings.json. Project settings beat global
 * per Pi's standard precedence.
 *
 * All fields are optional; unset fields fall back to the documented defaults
 * (see README "Settings reference"). The schema is permissive so that
 * settings written by future versions don't break older code.
 */
export const PiRolesSettingsSchema = Type.Object(
  {
    /** "user" | "project" | "both". Default: "both". */
    roleScope: Type.Optional(RoleScopeSchema),

    /**
     * Default role name applied when no --role / PI_ROLE is supplied.
     * Default: "role-assistant" (the built-in fallback).
     * If set to a missing role, we warn and use the built-in role-assistant.
     */
    defaultRole: Type.Optional(Type.String({ minLength: 1 })),

    /** Default intercom mode for roles that don't set `intercom:`. Default: "off". */
    intercomMode: Type.Optional(IntercomModeSchema),

    /**
     * Model used to summarize the first user message into the session-name
     * intent. Default: a small/cheap model when one is available, falling
     * back to the session's current model.
     */
    titleModel: Type.Optional(Type.String({ minLength: 1 })),

    /** Whether to surface a warning when an mcp:* tool can't be resolved. Default: true. */
    warnOnMissingMcp: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: true,
    description: "pi-roles section of Pi's settings.json.",
  },
);
export type PiRolesSettings = Static<typeof PiRolesSettingsSchema>;

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/**
 * State persisted via `pi.appendEntry("pi-roles:active-role", ...)`. Read on
 * `session_start` (with reason="reload" or "resume") to restore the active
 * role after a reload, since extension memory is wiped on /reload.
 *
 * `appliedAt` is the leaf role's source/path so we can re-resolve the chain
 * fresh on restore — the extends parents may have been edited in the
 * meantime.
 *
 * `intent` carries the session-intent summary we generated for the title, so
 * a /role swap mid-session can keep the intent and just replace the role
 * prefix in the session name without re-summarizing.
 */
export const ActiveRoleStateSchema = Type.Object(
  {
    name: Type.String(),
    /** Source of the LEAF role file when it was applied. */
    source: RoleSourceSchema,
    /** Path of the LEAF role file. */
    path: Type.String(),
    /** Cached session-intent summary for the title. May be empty pre-first-message. */
    intent: Type.Optional(Type.String()),
    /** Unix ms timestamp; for diagnostics only. */
    appliedAt: Type.Number(),
  },
  { additionalProperties: false },
);
export type ActiveRoleState = Static<typeof ActiveRoleStateSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Custom entry type used with `pi.appendEntry`. Centralized here so that
 * any place reading entries back (session_start handlers, diagnostics) uses
 * the same key.
 */
export const ACTIVE_ROLE_ENTRY_TYPE = "pi-roles:active-role" as const;

/**
 * Custom message type used by `pi.sendMessage` for user-visible role
 * notifications ("Switched to role X"). Centralized so we can register a
 * consistent message renderer.
 */
export const ROLE_NOTIFICATION_MESSAGE_TYPE = "pi-roles:notification" as const;

/**
 * Status key for `ctx.ui.setStatus(STATUS_KEY, ...)`. Single key so updates
 * replace the previous status atomically.
 */
export const STATUS_KEY = "pi-roles" as const;

/**
 * Name of the built-in default role. Acts as the lowest-priority fallback
 * when no defaultRole is configured and no --role / PI_ROLE is supplied.
 */
export const BUILTIN_ROLE_ASSISTANT_NAME = "role-assistant" as const;

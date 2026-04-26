/**
 * pi-roles extension entry point.
 *
 * Wires together discovery (roles.ts), application (apply.ts), and settings
 * (settings.ts) into the three Pi integration points the role lifecycle
 * actually needs:
 *
 *   - `session_start` — restore from persisted state on reload/resume,
 *     otherwise resolve a role name from the precedence chain (pendingReset
 *     > --role > PI_ROLE > settings.defaultRole > built-in role-assistant)
 *     and apply it.
 *   - `before_agent_start` — re-inject the active role's body as the system
 *     prompt every turn (Pi rebuilds the prompt per turn; this is the
 *     stable hook).
 *   - `/role` command — list, current, reload, switch (with optional
 *     --reset to clear history first).
 *
 * The module-scoped state below is the source of truth for "what role is
 * live in this extension instance". Pi reloads spin up a fresh module, at
 * which point we restore from the most recent `pi-roles:active-role` entry
 * in the session log.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { applyRole, effectiveIntercomMode, resetSession, type RoleNotificationDetails } from "./apply.ts";
import { intercomPromptAddendum, isIntercomAvailable } from "./intercom.ts";
import { discoverRoles, findBuiltInAssistant, resolveRole, RoleResolutionError } from "./roles.ts";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  BUILTIN_ROLE_ASSISTANT_NAME,
  ROLE_NOTIFICATION_MESSAGE_TYPE,
  type ActiveRoleState,
  type PiRolesSettings,
  type RawRole,
  type ResolvedRole,
} from "./schemas.ts";
import { loadSettings } from "./settings.ts";

const FLAG_NAME = "role";
const ENV_VAR = "PI_ROLE";
const SUBCOMMANDS = ["list", "current", "reload"] as const;

interface RuntimeState {
  /** Live role applied to this session, or null before first apply. */
  activeRole: ResolvedRole | null;
  /** Set by `/role <name> --reset` so the next session_start (reason="new") applies it. */
  pendingRoleAfterReset: string | null;
  /** Cached discovery result for the current cwd; refreshed on session_start and on `/role reload`. */
  roles: RawRole[];
  /** Cached settings for the current cwd; refreshed on session_start. */
  settings: PiRolesSettings;
  /** Carried across role swaps so the session-name intent survives a role change. */
  intent: string | undefined;
}

export default function (pi: ExtensionAPI): void {
  const state: RuntimeState = {
    activeRole: null,
    pendingRoleAfterReset: null,
    roles: [],
    settings: {},
    intent: undefined,
  };

  // --------------------------------------------------------------------- flag
  pi.registerFlag(FLAG_NAME, {
    type: "string",
    description: "Launch as the named pi-roles role (e.g. --role architect).",
  });

  // ----------------------------------------------------------------- renderer
  // Render "Switched to role X" notifications as a single dim line. Without
  // this, the custom message type would surface as raw JSON in the TUI.
  pi.registerMessageRenderer<RoleNotificationDetails>(ROLE_NOTIFICATION_MESSAGE_TYPE, () => {
    // Returning `undefined` lets Pi fall back to the default custom-message
    // renderer, which prints `content`. That's exactly what we want — the
    // content string ("Switched to role X") is already user-facing. The
    // renderer is registered so `display: true` doesn't get treated as a
    // raw-JSON dump if a future Pi version starts requiring an explicit
    // renderer for custom types.
    return undefined;
  });

  // --------------------------------------------------------------- session_start
  pi.on("session_start", async (event, ctx) => {
    state.settings = loadSettings(ctx.cwd);
    const discovery = discoverRoles(ctx.cwd, state.settings.roleScope ?? "both");
    state.roles = discovery.roles;

    const restored = findRestoredState(ctx);

    // Restore precedence:
    //   - On reload/resume, prefer the persisted active-role entry.
    //   - On startup/new/fork, resolve fresh from the chain (the persisted
    //     entry from a previous session is irrelevant here).
    let targetName: string | undefined;
    let preservedIntent: string | undefined;
    let silent = false;

    if (state.pendingRoleAfterReset) {
      targetName = state.pendingRoleAfterReset;
      state.pendingRoleAfterReset = null;
      // intent is intentionally cleared on --reset (session is a fresh start).
    } else if ((event.reason === "reload" || event.reason === "resume") && restored) {
      targetName = restored.name;
      preservedIntent = restored.intent;
      silent = true;
    } else {
      targetName = pickInitialRoleName(pi, state.settings, state.roles);
      // First-application is silent — the user knows what they launched
      // with; a banner here would be noise.
      silent = event.reason === "startup";
    }

    state.intent = preservedIntent;
    await applyResolved(pi, ctx, state, targetName, { silent, preservedIntent });
  });

  // ----------------------------------------------------------- before_agent_start
  // Pi composes the system prompt every turn and chains extension overrides.
  // We always start from the chain's current value (event.systemPrompt) and
  // append our role body, so other extensions can still contribute.
  pi.on("before_agent_start", async (event) => {
    if (!state.activeRole) return;
    const base = event.systemPrompt ?? "";
    const body = state.activeRole.body;
    const mode = effectiveIntercomMode(state.activeRole, state.settings.intercomMode);
    const addendum =
      mode !== "off" && isIntercomAvailable(pi)
        ? intercomPromptAddendum(mode, pi.getSessionName())
        : "";
    const parts = [base, body, addendum].filter((p) => p && p.length > 0);
    if (parts.length === 0) return;
    return { systemPrompt: parts.join("\n\n") };
  });

  // ---------------------------------------------------------------- /role
  pi.registerCommand("role", {
    description: "Switch session role. /role list | current | reload | <name> [--reset]",
    getArgumentCompletions: (prefix) => roleCompletions(prefix, state.roles),
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (!sub || sub === "list") {
        return handleList(ctx, state);
      }
      if (sub === "current") {
        return handleCurrent(ctx, state);
      }
      if (sub === "reload") {
        return handleReload(pi, ctx, state);
      }

      const wantsReset = tokens.includes("--reset");
      const name = sub;

      if (wantsReset) {
        // Set the pending pointer FIRST: ctx.newSession() invalidates
        // session-bound captured state and synchronously fires session_start
        // before returning, so we can't apply the role after newSession()
        // resolves and expect mid-session ordering to hold.
        state.pendingRoleAfterReset = name;
        const result = await resetSession(ctx);
        if (result.cancelled) {
          state.pendingRoleAfterReset = null;
          ctx.ui.notify(`Role switch to "${name}" cancelled.`, "info");
        }
        return;
      }

      await applyResolved(pi, ctx, state, name, { silent: false, preservedIntent: state.intent });
    },
  });
}

// ---------------------------------------------------------------------------
// Role-name resolution
// ---------------------------------------------------------------------------

/**
 * Pick the role to launch with on a fresh session_start (no pendingReset, no
 * persisted state to restore). Precedence per BUILD-STATUS.md:
 *
 *   --role flag > PI_ROLE env > settings.defaultRole > built-in role-assistant
 *
 * If a configured `defaultRole` doesn't exist, we fall through to the
 * built-in rather than failing — a missing role shouldn't lock the user out
 * of the session.
 */
export function pickInitialRoleName(
  pi: ExtensionAPI,
  settings: PiRolesSettings,
  roles: RawRole[],
): string {
  const flagValue = pi.getFlag(FLAG_NAME);
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;

  const env = process.env[ENV_VAR];
  if (env && env.length > 0) return env;

  const configured = settings.defaultRole;
  if (configured && roles.some((r) => r.frontmatter.name === configured)) {
    return configured;
  }

  return BUILTIN_ROLE_ASSISTANT_NAME;
}

/**
 * Find the most recent `pi-roles:active-role` entry on the active branch.
 * Returns undefined when none exists or when entries can't be enumerated
 * (e.g. session_start hasn't fully bound the session manager yet).
 */
function findRestoredState(
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
): ActiveRoleState | undefined {
  let entries;
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return undefined;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === "custom" && e.customType === ACTIVE_ROLE_ENTRY_TYPE) {
      return (e.data ?? undefined) as ActiveRoleState | undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Apply wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve a role name + apply it + update in-memory state. Centralized so
 * session_start, /role <name>, and /role reload share identical error
 * handling and warning surfacing.
 */
async function applyResolved(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  state: RuntimeState,
  name: string,
  options: { silent: boolean; preservedIntent: string | undefined },
): Promise<void> {
  let resolved: ResolvedRole;
  try {
    resolved = resolveRole(name, state.roles);
  } catch (err) {
    // Fall back to built-in assistant if the requested role is missing or
    // broken. Surface the underlying error so the user can fix the file.
    const message = err instanceof RoleResolutionError ? err.message : String(err);
    if (ctx.hasUI) {
      ctx.ui.notify(`pi-roles: ${message} Falling back to ${BUILTIN_ROLE_ASSISTANT_NAME}.`, "warning");
    }
    const fallback = findBuiltInAssistant(state.roles);
    if (!fallback) {
      // Built-in is missing too — bail without changing session state.
      return;
    }
    resolved = resolveRole(BUILTIN_ROLE_ASSISTANT_NAME, state.roles);
  }

  const result = await applyRole(
    resolved,
    {
      pi,
      ctx,
      warnOnMissingMcp: state.settings.warnOnMissingMcp ?? true,
      intercomMode: state.settings.intercomMode,
    },
    options,
  );

  state.activeRole = resolved;
  state.intent = result.state.intent;

  if (ctx.hasUI && result.warnings.length > 0 && !options.silent) {
    // The notification message already mentions the warning count; surface
    // the actual text via ui.notify so the user sees what to fix without
    // expanding the message.
    for (const w of result.warnings) ctx.ui.notify(`pi-roles: ${w}`, "warning");
  }
}

// ---------------------------------------------------------------------------
// /role subcommands
// ---------------------------------------------------------------------------

async function handleList(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (state.roles.length === 0) {
    ctx.ui.notify(
      "pi-roles: no roles found. Create one in .pi/roles/ or ~/.pi/agent/roles/.",
      "info",
    );
    return;
  }
  const lines = state.roles
    .slice()
    .sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name))
    .map((r) => {
      const marker = state.activeRole?.name === r.frontmatter.name ? "* " : "  ";
      return `${marker}${r.frontmatter.name} (${r.source}) — ${r.frontmatter.description}`;
    });
  ctx.ui.notify(["Available roles:", ...lines].join("\n"), "info");
}

async function handleCurrent(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (!state.activeRole) {
    ctx.ui.notify("pi-roles: no role active.", "info");
    return;
  }
  const r = state.activeRole;
  const chain = r.extendsChain.length > 1 ? ` (extends: ${r.extendsChain.slice(1).join(" → ")})` : "";
  ctx.ui.notify(`pi-roles: ${r.name}${chain} — ${r.description}\n${r.path}`, "info");
}

async function handleReload(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  const previous = state.activeRole?.name ?? pickInitialRoleName(pi, state.settings, state.roles);
  // Re-discover so an edited or newly-added role file shows up.
  state.settings = loadSettings(ctx.cwd);
  const discovery = discoverRoles(ctx.cwd, state.settings.roleScope ?? "both");
  state.roles = discovery.roles;
  await applyResolved(pi, ctx, state, previous, {
    silent: false,
    preservedIntent: state.intent,
  });
}

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

/**
 * Provide tab completions for `/role <here>`. Combines built-in subcommands
 * with discovered role names; case-insensitive prefix match.
 */
export function roleCompletions(prefix: string, roles: RawRole[]): AutocompleteItem[] | null {
  const needle = prefix.toLowerCase();
  const items: AutocompleteItem[] = [];

  for (const sub of SUBCOMMANDS) {
    if (sub.toLowerCase().startsWith(needle)) {
      items.push({ value: sub, label: sub, description: subcommandDescription(sub) });
    }
  }
  for (const r of roles) {
    if (r.frontmatter.name.toLowerCase().startsWith(needle)) {
      items.push({
        value: r.frontmatter.name,
        label: r.frontmatter.name,
        description: `${r.source} — ${r.frontmatter.description}`,
      });
    }
  }
  return items.length > 0 ? items : null;
}

function subcommandDescription(sub: (typeof SUBCOMMANDS)[number]): string {
  switch (sub) {
    case "list":
      return "Show all available roles.";
    case "current":
      return "Show the active role.";
    case "reload":
      return "Re-read the active role file from disk.";
  }
}

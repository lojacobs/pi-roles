/**
 * Side-effecting application of a `ResolvedRole` to a live Pi session.
 *
 * Everything in this module touches `pi.*` or `ctx.*`. Resolution and parsing
 * is in `roles.ts`; this is the layer that mutates session state. Keeping the
 * boundary tight makes both halves trivially testable: `roles.ts` is a pure
 * filesystem reader, and `apply.ts` is a pure pi-side mutator that you can
 * test by passing a fake `ExtensionAPI`.
 *
 * Intentionally NOT done here:
 *   - Setting the system prompt. Pi rebuilds the prompt every turn and the
 *     only stable place to inject ours is `before_agent_start` (chained
 *     across extensions). `applyRole` therefore returns warnings only; the
 *     caller (index.ts) is responsible for stashing `role.body` in the
 *     in-memory active-role pointer that the `before_agent_start` handler
 *     reads.
 *   - The actual `/role <name> --reset` command. `resetSession` here is the
 *     primitive that wraps `ctx.newSession()`, but the lifecycle (set
 *     pendingRoleAfterReset, wait for the next `session_start`) lives in
 *     the command handler in index.ts.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  ROLE_NOTIFICATION_MESSAGE_TYPE,
  STATUS_KEY,
  type ActiveRoleState,
  type IntercomMode,
  type ResolvedRole,
  type ToolsDirective,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Caller-supplied dependencies. We don't accept `pi` and `ctx` separately
 * because callers always have both; bundling them keeps signatures short.
 */
export interface ApplyContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Whether to surface a warning when an mcp:* tool can't be resolved. */
  warnOnMissingMcp: boolean;
  /** Optional global default; merged in `effectiveIntercomMode`. */
  intercomMode?: IntercomMode;
}

export interface ApplyOptions {
  /** Suppress the "Switched to role X" sendMessage notification. */
  silent?: boolean;
  /**
   * If we're applying mid-session (vs. on `session_start`), pass the prior
   * intent so the session-name prefix can be swapped while the trailing
   * intent is preserved. Phase 5 supplies this from persisted state.
   */
  preservedIntent?: string;
}

export interface ApplyResult {
  warnings: string[];
  /**
   * The state object we passed to `pi.appendEntry`, returned for callers
   * that want to mirror it in their own in-memory pointer without a
   * round-trip through the session log.
   */
  state: ActiveRoleState;
}

/**
 * Notification payload sent via `pi.sendMessage(ROLE_NOTIFICATION_MESSAGE_TYPE, ...)`.
 * index.ts registers a renderer for this message type so the user sees a
 * compact "Switched to role X" line in the TUI.
 */
export interface RoleNotificationDetails {
  name: string;
  source: ResolvedRole["source"];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Split a model identifier into `provider` and `id`. The frontmatter accepts
 * either `provider/id` or bare `id`; the bare form requires us to scan all
 * registered models for a unique match in `applyModel`.
 *
 * Why not require provider/id? The `--model` flag in Pi accepts either form,
 * so role frontmatter mirrors that for ergonomics. The cost is a O(N) scan
 * over registered models when the bare form is used, which is negligible.
 */
export function parseModelId(raw: string): { provider?: string; id: string } {
  const idx = raw.indexOf("/");
  if (idx <= 0 || idx === raw.length - 1) return { id: raw };
  return { provider: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

/**
 * Look up a model by `provider/id` or bare `id`. Bare-id lookup picks the
 * first match across providers; if multiple providers ship the same model id
 * (e.g. claude-opus-4-7 served from both anthropic and a proxy), the user
 * should fully qualify.
 */
export function findModelInRegistry(
  registry: ExtensionContext["modelRegistry"],
  raw: string,
): { model: ReturnType<typeof registry.find>; ambiguous: boolean } {
  const { provider, id } = parseModelId(raw);
  if (provider) {
    return { model: registry.find(provider, id), ambiguous: false };
  }
  const matches = registry.getAll().filter((m) => m.id === id);
  return { model: matches[0], ambiguous: matches.length > 1 };
}

/**
 * Decide the effective intercom mode for a role. Per-role wins; otherwise
 * fall back to the settings default; otherwise "off".
 */
export function effectiveIntercomMode(
  role: ResolvedRole,
  globalDefault: IntercomMode | undefined,
): IntercomMode {
  return role.intercom ?? globalDefault ?? "off";
}

/**
 * Filter a `ToolsDirective` against the runtime toolset. Returns:
 *   - the final list of tool names to pass to `pi.setActiveTools`
 *   - any warnings to surface to the user
 *   - whether the directive is `inherit` (caller should leave tools alone)
 *
 * Filtering rules:
 *   - `mcp:*` entries require a corresponding registered tool. If missing,
 *     drop them and (when `warnOnMissingMcp`) emit one warning per dropped
 *     entry — these are typically silent footguns ("why is my MCP tool not
 *     available?") so we err on the side of being noisy.
 *   - Non-`mcp:*` names that aren't recognized are passed through with a
 *     soft warning. Other extensions register tools later than us, and we
 *     can't reliably detect that timing — so we trust the user's list.
 *   - When `intercomMode !== "off"` and the `intercom` tool is registered,
 *     ensure `intercom` is in the active list (we add it if absent).
 */
export function filterToolsForRuntime(
  directive: ToolsDirective,
  availableToolNames: ReadonlySet<string>,
  intercomMode: IntercomMode,
  intercomAvailable: boolean,
  warnOnMissingMcp: boolean,
): { kind: "set"; names: string[]; warnings: string[] } | { kind: "inherit"; warnings: string[] } {
  const warnings: string[] = [];

  if (directive.kind === "inherit") {
    // We may still need to ensure intercom is present, but we shouldn't
    // mutate the active toolset out from under the user when they didn't
    // ask us to. Inheritance is a true "leave it alone".
    return { kind: "inherit", warnings };
  }

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const name of directive.names) {
    if (seen.has(name)) continue;
    seen.add(name);

    if (name.startsWith("mcp:")) {
      if (availableToolNames.has(name)) {
        kept.push(name);
      } else if (warnOnMissingMcp) {
        warnings.push(
          `Tool "${name}" is not registered (pi-mcp-adapter may not be installed or the server is not configured). Skipping.`,
        );
      }
      continue;
    }

    if (!availableToolNames.has(name)) {
      warnings.push(
        `Tool "${name}" is not registered. Passing through; another extension may register it later.`,
      );
    }
    kept.push(name);
  }

  if (intercomMode !== "off" && intercomAvailable && !seen.has("intercom")) {
    kept.push("intercom");
  }

  return { kind: "set", names: kept, warnings };
}

/**
 * Compose a session name from a role name and an optional intent string.
 * "<role> — <intent>" when intent is non-empty; just "<role>" otherwise.
 * The em-dash mirrors what pi-intercom expects for session targeting.
 */
export function composeSessionName(roleName: string, intent: string | undefined): string {
  const trimmed = (intent ?? "").trim();
  return trimmed.length > 0 ? `${roleName} — ${trimmed}` : roleName;
}

// ---------------------------------------------------------------------------
// Side-effecting orchestration
// ---------------------------------------------------------------------------

/**
 * Apply a `ResolvedRole` to the live Pi session.
 *
 * Order matters and is non-trivial:
 *   1. Model first — switching model can clamp the thinking level, so we
 *      do it before setting thinking. If the model can't be resolved, we
 *      warn and continue with the existing model (better than refusing to
 *      apply the role at all).
 *   2. Thinking level — Pi clamps to model capabilities, so we just pass
 *      the user-requested level and trust Pi to handle "high on a model
 *      that only supports low".
 *   3. Tools — filter against the runtime toolset, then call
 *      `setActiveTools`. We always overwrite; the `inherit` case skips
 *      this step entirely.
 *   4. Footer — `setStatus` so the role name shows in the status bar.
 *   5. Session name — `setSessionName` with the composed "role — intent"
 *      string. If we have a `preservedIntent` we use it, otherwise the
 *      first user message will trigger Phase 5's title generator.
 *   6. Persist — `appendEntry` so `/reload` and `session_start` with
 *      reason="reload"|"resume" can restore the active role.
 *   7. Notify — `sendMessage` with the role-notification customType
 *      unless `silent` is set (e.g. on initial session_start).
 *
 * Warnings are accumulated and returned. Callers decide whether to surface
 * them as `ctx.ui.notify` toasts or fold them into the notification message.
 */
export async function applyRole(
  role: ResolvedRole,
  applyCtx: ApplyContext,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const { pi, ctx } = applyCtx;
  const warnings: string[] = [];

  // 1. Model
  if (role.model) {
    const lookup = findModelInRegistry(ctx.modelRegistry, role.model);
    if (!lookup.model) {
      warnings.push(
        `Model "${role.model}" not found in registry. Keeping current model.`,
      );
    } else {
      if (lookup.ambiguous) {
        warnings.push(
          `Model id "${role.model}" matches multiple providers; using "${lookup.model.provider}/${lookup.model.id}". Use provider/id to disambiguate.`,
        );
      }
      const ok = await pi.setModel(lookup.model);
      if (!ok) {
        warnings.push(
          `Model "${lookup.model.provider}/${lookup.model.id}" has no API key configured. Keeping current model.`,
        );
      }
    }
  }

  // 2. Thinking level
  if (role.thinking !== undefined) {
    pi.setThinkingLevel(role.thinking);
  }

  // 3. Tools
  const intercomMode = effectiveIntercomMode(role, applyCtx.intercomMode);
  const allTools = pi.getAllTools();
  const availableNames = new Set(allTools.map((t) => t.name));
  const intercomAvailable = availableNames.has("intercom");
  const filtered = filterToolsForRuntime(
    role.tools,
    availableNames,
    intercomMode,
    intercomAvailable,
    applyCtx.warnOnMissingMcp,
  );
  warnings.push(...filtered.warnings);
  if (filtered.kind === "set") {
    pi.setActiveTools(filtered.names);
  }
  if (intercomMode !== "off" && !intercomAvailable) {
    warnings.push(
      `Role requests intercom mode "${intercomMode}" but the intercom tool is not registered. Install pi-intercom to enable.`,
    );
  }

  // 4. Footer status
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, role.name);
  }

  // 5. Session name
  pi.setSessionName(composeSessionName(role.name, options.preservedIntent));

  // 6. Persist
  const state: ActiveRoleState = {
    name: role.name,
    source: role.source,
    path: role.path,
    intent: options.preservedIntent,
    appliedAt: Date.now(),
  };
  pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, state);

  // 7. Notify
  if (!options.silent) {
    const display =
      warnings.length === 0
        ? `Switched to role ${role.name}`
        : `Switched to role ${role.name} (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`;
    pi.sendMessage<RoleNotificationDetails>({
      customType: ROLE_NOTIFICATION_MESSAGE_TYPE,
      content: display,
      display: true,
      details: { name: role.name, source: role.source, warnings },
    });
  }

  return { warnings, state };
}

// ---------------------------------------------------------------------------
// --reset helper
// ---------------------------------------------------------------------------

/**
 * Clear conversation history before applying a new role. Returns the same
 * `{ cancelled }` shape `ctx.newSession()` returns; callers should bail out
 * when `cancelled` is true (the user aborted at a confirm prompt).
 *
 * Why this is its own function: `ctx.newSession()` invalidates session-bound
 * captured state per Pi's docs, and the safe pattern is "wait for idle, call
 * newSession, then let session_start re-apply the role". The command handler
 * stores the desired role name in a module-scoped `pendingRoleAfterReset`
 * variable and reads it on the subsequent `session_start` event with reason
 * "new". This helper just wraps the prelude of that flow so the command
 * handler stays readable.
 */
export async function resetSession(ctx: ExtensionCommandContext): Promise<{ cancelled: boolean }> {
  await ctx.waitForIdle();
  return ctx.newSession();
}

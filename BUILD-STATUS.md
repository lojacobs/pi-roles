# pi-roles — build status & resume notes

**Phase 1 (Foundation) — ✅ complete.**
**Phase 2 (Discovery + parse) — ✅ complete.** `src/roles.ts`, `test/roles.test.ts` (23 tests).
**Phase 3 (Apply + reset) — ✅ complete.** `src/apply.ts`, `test/apply.test.ts` (32 tests).
**Phase 4 (Main entry + commands) — ✅ complete.** `src/index.ts`, `src/settings.ts`, `test/index.test.ts` (12 tests).
**Phase 6 (Built-in role-assistant) — ✅ complete.** `resources/roles/role-assistant.md`, `src/role-assistant.ts`, `test/role-assistant.test.ts` (5 tests).
**Phase 7 (Intercom integration) — ✅ complete.** `src/intercom.ts`, `test/intercom.test.ts` (7 tests). `before_agent_start` in `index.ts` now composes role body + intercom addendum.
**Phase 8 (Examples + tests) — ✅ complete.** `examples/architect.md`, `examples/orchestrator.md`, `test/examples.test.ts` (3 tests). 82 tests passing total.
**Phase 5 (title generation) — pending.** Still blocked on pi-ai API verification (see "Things still to verify" section below).

### Verified-against-pi-coding-agent-0.70.2 corrections (from Phase 3 work)

These override anything in the Phase-2/3 sections below. The numbered notes here win on conflict.

1. **`pi.appendEntry(customType, data)` is synchronous** (`AppendEntryHandler = (customType, data?) => void`). Don't `await` it.
2. **`ctx.ui.notify(message, type?)` accepts only `"info" | "warning" | "error"`** — there is no `"success"` variant. For role-switch confirmation use `pi.sendMessage` with a registered `MessageRenderer<T>` for `ROLE_NOTIFICATION_MESSAGE_TYPE`.
3. **`pi.sendMessage`'s `display` field is `boolean`**, not a string. Use `display: true` to surface the message in the TUI.
4. **`ModelRegistry.find(provider, modelId)` requires both arguments.** For bare-id lookups (no `provider/`), iterate `getAll()` and filter by `id`. `apply.ts` exposes `findModelInRegistry()` which encapsulates this and flags ambiguity (multiple providers serving the same id).
5. **Phase 3 owns no system-prompt logic.** `applyRole` mutates session state and persists `ActiveRoleState`; the in-memory `ResolvedRole` pointer that the `before_agent_start` handler reads is owned by `index.ts` (Phase 4). `applyRole` returns the freshly-persisted `ActiveRoleState` so callers can mirror it without round-tripping through the session log.
6. **`AutocompleteItem` requires `label`** (in addition to `value` and optional `description`). Both `value` and `label` are populated as the role/subcommand name in `roleCompletions`.
7. **`SettingsManager` is not exposed on `ExtensionContext`.** pi-roles reads its own `pi-roles` namespace from `~/.pi/agent/settings.json` and `<project>/.pi/settings.json` directly via `src/settings.ts`. Project values win field-level merge. Parse failures degrade to defaults silently.
8. **Persisted `ActiveRoleState` recovery** uses `ctx.sessionManager.getEntries()` and walks the array right-to-left for the last `CustomEntry` whose `customType === ACTIVE_ROLE_ENTRY_TYPE`. There is no convenience `getEntriesByCustomType` API — the manual scan is the supported path.
9. **`--reset` ordering**: set `pendingRoleAfterReset` *before* calling `ctx.newSession()` because `newSession` synchronously fires `session_start` with reason `"new"` before resolving. The session_start handler reads and clears the pointer. On cancellation, restore to `null`.
10. **`before_agent_start` chains, doesn't replace.** Pi composes the system prompt every turn and chains extension overrides. We start from `event.systemPrompt` and append our role body (`base + "\n\n" + body`), so other prompt-injecting extensions coexist non-destructively.
11. **Fallback-on-resolution-error**: a missing or broken requested role does not fail the session — `applyResolved` notifies the user and falls back to the built-in `role-assistant`. Only complete absence of the built-in causes a no-op.

This document captures everything a follow-up session needs to continue without re-fetching the pi-mono / pi-subagents / pi-intercom / pi-mcp-adapter sources. The verified API surface is locked into `src/schemas.ts` and into the facts table below.

---

## Files produced in Phase 1

| File | Purpose |
|---|---|
| `README.md` | Public contract — usage, frontmatter, settings, all design choices documented. **This is what gets published.** |
| `package.json` | Pi extension manifest. `pi.extensions: ["./src/index.ts"]`, peer deps on `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `typebox`. Runtime dep on `yaml`. Name TBD on npm — search showed no collision. |
| `tsconfig.json` | Strict TS, ES2022, bundler resolution, `allowImportingTsExtensions` (Pi loads via jiti, no compile step). |
| `LICENSE` | MIT. |
| `.gitignore` | Standard Node + TS + Pi local state. |
| `CHANGELOG.md` | Keep-a-Changelog format, Unreleased + 0.1.0 placeholder seeded with the full feature list. |
| `src/schemas.ts` | **Source of truth.** TypeBox 1.x schemas for: `RoleFrontmatter`, `PiRolesSettings`, `ActiveRoleState`, plus `ResolvedRole` / `RawRole` / `ToolsDirective` interfaces and constants (`ACTIVE_ROLE_ENTRY_TYPE`, `STATUS_KEY`, `BUILTIN_ROLE_ASSISTANT_NAME`). |

Three places in `package.json` say `REPLACE_ME` — fill in the actual GitHub user/org before publishing.

---

## Verified Pi API facts

These were checked against `pi-mono/main` on April 26 2026. They are the only Pi APIs Phase 2+ should rely on. Anything not in this list should be re-verified before use.

### Extension surface

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";  // <-- not "@sinclair/typebox"

export default function (pi: ExtensionAPI) { ... }
```

### Used APIs (all confirmed exist)

- `pi.registerFlag(name, { description, type, default? })` — `pi.getFlag("--role")` reads the value.
- `pi.registerCommand(name, { description, handler, getArgumentCompletions })` — `getArgumentCompletions(prefix) => AutocompleteItem[] | null` powers Tab.
- `pi.on("session_start", handler)` — event has `reason: "startup" | "new" | "resume" | "fork" | "reload"` and `previousSessionFile?`. Apply role here.
- `pi.on("before_agent_start", handler)` — return `{ systemPrompt: string, message?: ... }`. **System prompt is replaced per-turn**, so we re-apply on every `before_agent_start` from the in-memory active role state. Chained across extensions — read `event.systemPrompt` to start from the prior chain value if you ever need to compose.
- `pi.setSessionName(name)` / `pi.getSessionName()` — sets the displayed session name. Pi-intercom uses this to identify sessions.
- `pi.setModel(model)` — takes a `Model` object, returns `Promise<boolean>` (false if no API key). Get model via `ctx.modelRegistry.find(provider, id)`.
- `pi.setThinkingLevel(level)` / `pi.getThinkingLevel()` — clamped to model capabilities.
- `pi.setActiveTools(names: string[])` — switches active tool set.
- `pi.getAllTools()` — returns `{ name, description, parameters, sourceInfo }[]`. Use to filter mcp:* entries when pi-mcp-adapter is/isn't installed.
- `pi.appendEntry(customType, data)` — persistent state across `/reload`. We use `ACTIVE_ROLE_ENTRY_TYPE = "pi-roles:active-role"`.
- `pi.events` — extension event bus. pi-intercom and pi-subagents use this for inter-extension comms; we don't need to call it directly.
- `pi.sendMessage({ customType, content, display, details })` — for user-visible "switched to role X" notifications. Combine with `pi.registerMessageRenderer("pi-roles:notification", ...)` for nice TUI rendering.

### Command-only context (only available in `registerCommand` handlers, NOT in event handlers)

- `ctx.newSession(options?)` — clears history. **This is what powers `--reset`.** Returns `{ cancelled: boolean }`.
- `ctx.waitForIdle()` — wait for streaming to finish before mutating state.
- `ctx.reload()` — full extension reload. We don't call this; users call `/reload` manually.

### UI helpers (use `ctx.ui.*` from any handler; check `ctx.hasUI` first in non-interactive modes)

- `ctx.ui.setStatus(key, text | undefined)` — footer status. We use `STATUS_KEY = "pi-roles"`. Composes with `pi-powerline-footer`.
- `ctx.ui.setTitle(text)` — terminal title bar.
- `ctx.ui.notify(text, "info" | "success" | "warning" | "error")` — toast.
- `ctx.ui.confirm(title, body)`, `ctx.ui.select(prompt, options)`, `ctx.ui.input(prompt, placeholder?)`, `ctx.ui.editor(prompt, initial?)` — interactive dialogs.

### Frontmatter parsing

- Use `yaml` (npm) for frontmatter parsing. Standard pattern:
  ```ts
  import { parse as parseYaml } from "yaml";
  // Parse `---\n<yaml>\n---\n<body>` separator pattern.
  ```
- pi-subagents itself uses YAML; we mirror their convention.

### MCP tools

- The `mcp:server-name` syntax inside the `tools` field is the established convention from pi-subagents.
- pi-mcp-adapter registers MCP servers as direct tools when configured with `directTools`. To check if pi-mcp-adapter is installed at runtime: scan `pi.getAllTools()` for any tool whose `sourceInfo.source` references the mcp adapter, or just attempt to set the tool and check the result.
- When `pi-mcp-adapter` isn't installed, strip `mcp:*` entries before calling `setActiveTools`. Surface a warning if `warnOnMissingMcp` is true (default).

### pi-intercom

- pi-intercom registers a tool literally called `intercom` when loaded. To detect it: `pi.getAllTools().some(t => t.name === "intercom")`.
- Session targeting in pi-intercom uses `pi.getSessionName()` — which is exactly what we set via the title flow. So intercom integration is essentially free.
- Per-role intercom mode controls (a) whether `intercom` is in the active tool set, and (b) whether we inject a small prompt addendum telling the model how/when to use it. The addendum text is in `src/intercom.ts` (Phase 7).

### pi-powerline-footer

- We don't depend on it. Pi's native footer reads from `ctx.ui.setStatus`, and pi-powerline-footer is itself an extension that augments the same footer. Coexistence is automatic.

---

## Open implementation questions resolved (do not re-ask)

1. ✅ **TypeBox 1.x** (root `typebox` package), not Zod, not `@sinclair/typebox` 0.34.
2. ✅ **`mcp:server-name` inside `tools`**, not a separate `mcp:` field. Mirrors pi-subagents.
3. ✅ **Built-in `role-assistant` at lowest priority**; configurable `defaultRole` setting overrides.
4. ✅ **`/role <name>` preserves history; `--reset` clears it** via `ctx.newSession()`.
5. ✅ **Tools tri-state**: set / explicit-empty / inherit (encoded as `ToolsDirective` in schemas.ts).
6. ✅ **Markdown body merge for `extends`**: parent prepended to child.
7. ✅ **Session naming**: `<role-name> — <intent>`, intent generated async on first user message via `titleModel`. Role-name prefix updates on swap; intent persists.
8. ✅ **Footbar via `ctx.ui.setStatus`** — no ANSI escape custom rendering, no powerline-footer dependency.
9. ✅ **Cycle detection in `extends`**: hard error at load time.
10. ✅ **role-assistant prints the `--reset` command for the user**; never auto-resets.

---

## Phase 2 — Discovery + parse

**Files to produce:** `src/types.ts` (small shared types), `src/roles.ts` (the bulk).

### `src/types.ts`

Tiny — just non-schema types. Could include:
- `RoleResolutionError` class (for cycle detection, missing parent, missing model).
- Helper aliases that don't fit in schemas.ts.

Honestly might not even need a separate file — could inline in roles.ts. Decide based on size.

### `src/roles.ts` responsibilities

1. **Discovery**:
   - Resolve project dir: walk up from `ctx.cwd` looking for `.pi/roles/`.
   - Resolve user dir: `~/.pi/agent/roles/`.
   - Resolve built-in dir: `<package>/resources/roles/` — use `import.meta.url` + `node:url` to find it.
   - Honor `roleScope` setting.
   - Return `{ roles: RawRole[], shadowed: { name, source, path }[] }` — keep shadowed entries for `/role list` display.

2. **Frontmatter parsing**:
   - Split on `---\n...\n---\n` markers (handle Windows line endings).
   - Parse YAML block with `yaml` package.
   - Validate against `RoleFrontmatterSchema` using TypeBox's `Value.Check` / `Value.Decode`.
   - On validation failure: throw with file path + field name in message.
   - **TypeBox 1.x error field is `instancePath`, not `path`.** `Value.Errors(schema, value)` yields `TValidationError` objects whose location field is `instancePath` (JSON-Pointer style — `/extends`, `/thinking`, etc.) and the human-readable text is `error.message`. The original BUILD-STATUS.md draft said `error.path`; that does not exist on the typebox 1.x error union (verified against typebox 1.1.33).
   - Enforce `name === filename without .md`.

3. **Tools tri-state normalization**:
   - field absent in parsed object → `{ kind: "inherit" }`.
   - field present, value is `null` or `""` → `{ kind: "set", names: [] }`.
   - field present with content → `{ kind: "set", names: parseToolList(value) }`.
   - `parseToolList` splits on commas, trims, drops empties. Don't filter `mcp:*` here — that happens in `apply.ts` based on runtime detection.

4. **`extends` resolution** (the tricky one):
   - Build a map of `name -> RawRole` from discovery results.
   - For a given starting role, walk parents recursively.
   - Track seen names; if we revisit one, throw a cycle error with the chain.
   - Merge:
     - Start with parent's resolved fields.
     - Override `description`, `model`, `thinking`, `intercom` if child sets them.
     - For `tools`: child's `ToolsDirective` wins UNLESS it's `inherit`, in which case use parent's.
     - For `body`: `parent.body + "\n\n---\n\n" + child.body` (both trimmed).
   - Return `ResolvedRole` (not `RawRole`).

5. **Public API**:
   ```ts
   export function discoverRoles(cwd: string, scope: RoleScope): {
     roles: RawRole[];
     shadowed: ShadowedEntry[];
   };

   export function resolveRole(name: string, all: RawRole[]): ResolvedRole;
   ```

### Tests for Phase 2 (`test/roles.test.ts`)

- Parses minimal frontmatter ✓
- Parses full frontmatter ✓
- Rejects role with mismatched name/filename
- Rejects invalid thinking value
- Tri-state: absent → inherit, empty → set:[], "a, b" → set:["a", "b"]
- extends: single-level inheritance overrides correctly
- extends: chained 3-deep inheritance
- extends: cycle detection throws with helpful message
- extends: missing parent throws
- Body merge: parent + child concatenated with separator
- Discovery: project beats user beats built-in for same name
- Discovery: returns shadowed entries

---

## Phase 3 — Apply + reset

**Files:** `src/apply.ts`, `src/reload.ts` (or roll into apply.ts).

### `src/apply.ts` responsibilities

```ts
export interface ApplyContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext; // for modelRegistry, ui
  warnOnMissingMcp: boolean;
}

export async function applyRole(
  role: ResolvedRole,
  applyCtx: ApplyContext,
  options?: { silent?: boolean }
): Promise<{ warnings: string[] }>;
```

Steps:
1. Resolve model (if `role.model`):
   - Parse `provider/id` form. If no `/`, search across providers.
   - Call `ctx.modelRegistry.find(provider, id)`.
   - If found: `await pi.setModel(model)`. If `false`, warn.
   - If not found: warn, continue without changing model.
2. Set thinking (if `role.thinking`): `pi.setThinkingLevel(role.thinking)`.
3. Resolve tools (if `role.tools.kind === "set"`):
   - Filter `mcp:*` entries: keep only if a tool with that name exists in `pi.getAllTools()`.
   - Filter built-in tools: warn if a name isn't recognized but pass through (extensions may register more later).
   - Call `pi.setActiveTools(filteredNames)`.
   - If `intercomMode !== "off"` and intercom is installed, ensure `intercom` is in the list.
4. Persist active state: `pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, { name, source, path, intent: previousIntent, appliedAt: Date.now() })`.
5. Update footer: `ctx.ui.setStatus(STATUS_KEY, role.name)`.
6. Update session name: `pi.setSessionName(\`\${role.name} — \${intent || "starting"}\`)` (intent from prior state if available).
7. Return warnings list for display.

Note: the **system prompt is set via `before_agent_start`** (not here directly), because Pi's prompt replacement is per-turn. We just store `role.body` in the live in-memory active-role state, and the `before_agent_start` handler returns it.

### `--reset` flow

In the `/role` command handler:
```ts
if (args.includes("--reset")) {
  await ctx.waitForIdle();
  const result = await ctx.newSession();
  if (result.cancelled) { /* notify */ return; }
  // session_start fires with reason "new"; apply the role there OR apply directly here.
}
```

**Watch out:** docs say `ctx.newSession()` + `ctx.fork()` + `ctx.switchSession()` invalidate captured pre-replacement session-bound objects. Use `withSession` if mutating after the call. Or simpler: store the role-to-apply in a module-scoped variable and apply on the subsequent `session_start` with reason `"new"`.

---

## Phase 4 — Main entry + commands

**File:** `src/index.ts`.

Skeleton:
```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverRoles, resolveRole } from "./roles.ts";
import { applyRole } from "./apply.ts";
import { ACTIVE_ROLE_ENTRY_TYPE, STATUS_KEY, BUILTIN_ROLE_ASSISTANT_NAME } from "./schemas.ts";

export default function (pi: ExtensionAPI) {
  let activeRole: ResolvedRole | null = null;
  let pendingRoleAfterReset: string | null = null;

  pi.registerFlag("role", { type: "string", description: "Launch as the named pi-roles role." });

  pi.on("session_start", async (event, ctx) => {
    // 1. Restore from appendEntry if reason is "reload" or "resume".
    // 2. Otherwise resolve: --role > PI_ROLE > settings.defaultRole > role-assistant.
    // 3. If pendingRoleAfterReset (set by /role <n> --reset), use it.
    // 4. Apply.
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!activeRole) return;
    return { systemPrompt: activeRole.body };
  });

  pi.registerCommand("role", {
    description: "Switch session role. /role list | current | reload | <n> [--reset]",
    getArgumentCompletions: (prefix) => { /* read from discoverRoles */ },
    handler: async (args, ctx) => { /* dispatch to subcommand handlers */ },
  });
}
```

The `getArgumentCompletions` provider is critical for UX — make sure it includes built-in subcommands (`list`, `current`, `reload`) AND discovered role names.

---

## Phase 5 — Session naming + footbar

**File:** `src/title.ts`.

Generate a ≤10-word intent summary from the first user message. Use `@mariozechner/pi-ai`'s `complete` (or whatever the current API is — verify before writing) with the configured `titleModel`. Fire-and-forget on the `before_agent_start` of the *first* user turn (track via a flag in the active-role state).

Update session name as `pi.setSessionName(\`\${roleName} — \${intent}\`)`.

On `/role <n>` swap (no reset): replace `roleName` prefix in the existing name; preserve intent.
On `--reset`: clear intent so next message regenerates it.

**Footbar** is just `ctx.ui.setStatus(STATUS_KEY, role.name)` — already wired in `applyRole`. The `title.ts` file is purely about session-name generation.

---

## Phase 6 — Built-in role-assistant

**Files:** `resources/roles/role-assistant.md`, `src/role-assistant.ts` (loader).

### `resources/roles/role-assistant.md`

The system prompt body should:
1. Greet the user.
2. List available roles (with markers and the `/role <n>` command for each).
3. Offer to help build a new role.
4. If the user says yes:
   - Ask: name, description, intended behavior, tools needed, model preference, thinking level, parent role to extend (optional), intercom mode (optional).
   - Draft the .md file content.
   - Show it for review.
   - Ask: project scope or user scope?
   - Use the `write` tool to save it.
   - Print: `Run /role <new-name> --reset to start using it.`

The role-assistant frontmatter:
```yaml
---
name: role-assistant
description: Helps you pick or build a role. Default fallback role.
# No model — use whatever the user has.
# No thinking — use default.
# No tools restriction — needs read, write, edit at least.
---
```

### `src/role-assistant.ts`

Loader that returns the built-in role-assistant content from the bundled `resources/roles/role-assistant.md`. Include a function to expose it as a third "scope" in discovery.

---

## Phase 7 — Intercom (optional)

**File:** `src/intercom.ts`.

```ts
export function isIntercomAvailable(pi: ExtensionAPI): boolean {
  return pi.getAllTools().some(t => t.name === "intercom");
}

export function effectiveIntercomMode(role: ResolvedRole, settings: PiRolesSettings): IntercomMode {
  return role.intercom ?? settings.intercomMode ?? "off";
}

export function intercomPromptAddendum(mode: IntercomMode, sessionName: string): string {
  // Return injected text per mode. For "off", empty string.
}
```

In `apply.ts`, after computing the active tool set, conditionally add `intercom` if `mode !== "off"` AND `isIntercomAvailable()`.

In `before_agent_start`, append the `intercomPromptAddendum` to the system prompt.

---

## Phase 8 — Examples + tests

**Files:** `examples/architect.md`, `examples/orchestrator.md`, `test/roles.test.ts`, `test/schemas.test.ts`.

Examples:
- `architect.md`: minimal — just `name`, `description`, `model`, `thinking`, body. No `tools`, no `extends`, no `intercom`.
- `orchestrator.md`: full — includes `extends: base-orchestrator` (or some parent), `tools` with `mcp:*` entries, `intercom: off`.

Tests covered above in Phase 2 + per-phase. Use vitest, no real LLM calls.

---

## Things still to verify before Phase 5 (title generation)

`@mariozechner/pi-ai` is the LLM client. Need to check the current API for making a completion call from inside an extension — looked at the docs but didn't pin down the exact import. Quick search for `complete` or `streamText` in pi-ai npm page should resolve it. Don't write title.ts without that check.

Also: confirm `pi.appendEntry` is the right persistence mechanism for active-role state versus, say, settings — `appendEntry` writes to the session log, settings would persist across new sessions. We want session-scoped, so `appendEntry` is correct.

---

## Resume command

In a fresh session, attach the contents of `/mnt/user-data/outputs/pi-roles/` and say:

> "Continue building pi-roles from BUILD-STATUS.md. Phase 1 is done — start with Phase 2 (Discovery + parse). The README and src/schemas.ts are the contracts to honor."

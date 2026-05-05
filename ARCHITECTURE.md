# pi-roles — Architecture

## Purpose

`pi-roles` is a Pi coding-agent extension that turns a top-level Pi session into a named,
role-driven agent. Each role is a Markdown file with YAML frontmatter — same convention as
`pi-subagents` — defining the system prompt, model, thinking level, active tool set, and
optional intercom mode for that session. Roles are hot-swappable mid-session without
restarting Pi.

The extension ships **one** built-in role (`role-assistant`) and is otherwise agnostic of
which roles exist. Roles are user content, not extension code.

## Architecture Overview

```
                         Pi coding-agent runtime
                        ┌──────────────────────┐
                        │   before_agent_start  │ ◄── system prompt returned per turn
                        │   session_start       │ ◄── role restored / resolved
                        │   /role command       │ ◄── user-driven role swap
                        │   --role flag         │ ◄── launch-time role selection
                        └──────────┬───────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │        src/index.ts         │  entry point, orchestrates lifecycle
                    │   (RuntimeState + wiring)   │
                    └───┬──────┬──────┬──────┬────┘
                        │      │      │      │
              ┌─────────▼┐ ┌──▼──┐ ┌─▼────┐┌▼─────────┐
              │ roles.ts │ │apply│ │title ││intercom  │
              │(discovery│ │ .ts │ │ .ts  ││  .ts     │
              │ + parse) │ │     │ │      ││          │
              └─────┬────┘ └──┬──┘ └──┬───┘└────┬─────┘
                    │         │       │         │
              ┌─────▼──┐ ┌───▼───┐ ┌─▼────┐    │
              │schemas │ │settings│ │role- │    │
              │  .ts   │ │  .ts   │ │assist│    │
              │(TypeBox│ │(JSON   │ │ant.ts│    │
              │ source │ │loader) │ │      │    │
              │of truth│ └───────┘ └──────┘    │
              └────────┘                       │
                                   ┌───────────▼──────────┐
                                   │   Peer extensions    │
                                   │  pi-intercom         │
                                   │  pi-mcp-adapter      │
                                   │  pi-subagents        │
                                   └──────────────────────┘
```

### Trust boundaries

| Boundary | What crosses it |
|---|---|
| **User → Disk** | Role `.md` files, `settings.json` — user owns these entirely |
| **Disk → `roles.ts`** | File reads (sync), YAML parse, TypeBox validation — all trustless: malformed input is rejected with a hard error |
| **`roles.ts` → `apply.ts`** | `ResolvedRole` objects — validated, merged, normalized |
| **`apply.ts` → Pi runtime** | Calls to `pi.setModel`, `pi.setThinkingLevel`, `pi.setActiveTools`, `pi.setSessionName`, `pi.appendEntry` — all sandboxed within the Pi extension host |
| **Pi runtime → LLM** | System prompt = role body + optional intercom addendum. The model receives exactly the role definition the user authored; no extension code leaks into the prompt |
| **`pi-intercom` (optional)** | `intercom` tool added to active set; prompt addendum injected into system prompt. pi-roles never speaks the intercom wire protocol — it only opts roles in or out |

## Module Inventory

### `src/schemas.ts` — Source of truth

All TypeBox schemas and TypeScript interfaces shared across the codebase. Nothing here
touches the filesystem or Pi APIs.

| Export | Kind | Purpose |
|---|---|---|
| `RoleFrontmatterSchema` | TypeBox schema | Validates YAML frontmatter from role `.md` files; tolerates `additionalProperties` for forward compatibility |
| `ThinkingLevelSchema` | TypeBox union | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `IntercomModeSchema` | TypeBox union | `off` / `receive` / `send` / `both` |
| `RoleScopeSchema` | TypeBox union | `user` / `project` / `both` |
| `PiRolesSettingsSchema` | TypeBox schema | Settings namespace under `settings.json` → `"pi-roles"` |
| `ActiveRoleStateSchema` | TypeBox schema | Shape persisted via `pi.appendEntry` for `/reload` survival |
| `RawRole` | TS interface | Parsed role from disk before `extends` resolution |
| `ResolvedRole` | TS interface | Fully resolved role with `extends` chain merged |
| `ToolsDirective` | TS union | Tri-state: `{ kind: "inherit" }` or `{ kind: "set", names: string[] }` |
| Constants | `const` | `ACTIVE_ROLE_ENTRY_TYPE`, `ROLE_NOTIFICATION_MESSAGE_TYPE`, `STATUS_KEY`, `BUILTIN_ROLE_ASSISTANT_NAME` |

### `src/roles.ts` — Discovery + parsing + `extends` resolution

**Pure with respect to Pi APIs.** Only touches `node:fs`, `node:os`, `node:path`, `yaml`,
and `typebox/value`. Trivially testable.

| Responsibility | Key function(s) |
|---|---|
| **Discovery** — walk project → user → built-in directories, apply shadowing | `discoverRoles(cwd, scope)` |
| **Frontmatter parsing** — split `---` delimiters, parse YAML, validate against `RoleFrontmatterSchema`, enforce `name === filename` | `loadRoleFile(path, source)`, `parseRoleSource(text, path, source)` |
| **Tri-state tools** — `undefined` → inherit, `null`/`""` → explicit empty, string → parsed list | `normalizeTools(value)` |
| **`extends` resolution** — walk parent chain root→leaf, merge fields (child wins), prepend body, detect cycles | `resolveRole(name, all)` |

**Error strategy:** Throws `RoleResolutionError` for every user-facing problem. The message is
shown directly in the TUI — no stack traces leak. Callers in `index.ts` catch and fall back
to the built-in `role-assistant` on resolution failure.

**Discovery precedence:** project > user > built-in. First match for a given `name` wins;
later matches are recorded as `shadowed` and surfaced in `/role list`.

### `src/apply.ts` — Side-effecting application to a live Pi session

**Pure Pi mutator.** Everything here touches `pi.*` or `ctx.*`. Resolution and parsing
is fully owned by `roles.ts`; this module only mutates session state.

| Responsibility | Key function(s) |
|---|---|
| **Model resolution** — parse `provider/id`, scan registry, handle bare-id ambiguity | `parseModelId(raw)`, `findModelInRegistry(registry, raw)` |
| **Intercom mode** — per-role > global default > `"off"` | `effectiveIntercomMode(role, globalDefault)` |
| **Tool filtering** — resolve `mcp:*` entries against runtime toolset, add `intercom` when mode ≠ off | `filterToolsForRuntime(directive, ...)` |
| **Session name** — compose `<intent> - <role>` (with `"Intent not defined"` placeholder when intent is empty) | `composeSessionName(roleName, intent)` |
| **Full apply** — model → thinking → tools → footer → session name → persist → notify | `applyRole(role, ctx, options)` |
| **Reset** — wrap `ctx.newSession()` (the `/role <name> --reset` primitive) | `resetSession(ctx)` |

**Apply order is intentional:** Model first (Pi may clamp thinking on model switch), then
thinking, then tools. Footer, session name, and persistence are non-blocking and order
among themselves doesn't matter.

**System prompt is NOT set here.** Pi rebuilds the prompt per turn; the `before_agent_start`
handler in `index.ts` returns the role body. `applyRole` stashes warnings and returns the
persisted `ActiveRoleState` for the caller to mirror in its in-memory pointer.

### `src/index.ts` — Main entry + lifecycle wiring

The Pi extension entry point (`export default function(pi: ExtensionAPI)`). Owns:

| Concern | Implementation |
|---|---|
| **Module-scoped `RuntimeState`** | `activeRole`, `pendingRoleAfterReset`, `roles[]`, `shadowed[]`, `settings`, `intent`, `titleInFlight` |
| **`session_start` handler** | Restore from `appendEntry` (reload/resume) or resolve from precedence chain (pendingReset > `--role` > `PI_ROLE` > `defaultRole` > built-in). Calls `applyResolved`. |
| **`before_agent_start` handler** | Returns `{ systemPrompt: role.body + intercom addendum }`. **Full replacement** — ignores Pi's default coding-assistant framing. Triggers fire-and-forget title generation on first user prompt. |
| **`/role` command** | Dispatches `list`, `current`, `reload`, or `<name> [--reset]`. Tab-completes role names against discovery. |
| **`--role` flag** | Registered as a Pi flag; read in `pickInitialRoleName`. |
| **Message renderer** | Registered for `pi-roles:notification` custom type so `Switched to role X` surfaces cleanly. |

**`--reset` ordering constraint:** `pendingRoleAfterReset` is set *before* `ctx.newSession()`
because `newSession` synchronously fires `session_start` (reason `"new"`) before resolving.
The handler reads and clears the pointer; on cancellation, it's restored to `null`.

### `src/title.ts` — Session-name intent generation

Fire-and-forget summarization of the first user message into a ≤10-word intent string.
Session name becomes `<intent> - <role>`.

| Concern | Detail |
|---|---|
| **Trigger** | `before_agent_start` when `state.intent` is empty AND a prompt is present |
| **Model selection** | `settings.titleModel` > `ctx.model` (session's current model). Fails silently if neither is available. |
| **System prompt** | Hardcoded directive — noun phrases, 5–10 words, no quotes, no prefixes |
| **Output sanitization** | `extractTitle()` strips quotes, terminal punctuation, newlines; truncates to 10 words |
| **Concurrency** | `titleInFlight` flag prevents duplicate calls |
| **Race tolerance** | Re-checks `state.intent` and `state.activeRole` after await; drops stale results |
| **Side effects on success** | Sets `state.intent`, calls `pi.setSessionName`, calls `ctx.ui.setStatus` (footer refresh), calls `pi.appendEntry` for persistence across `/reload` |

### `src/settings.ts` — Settings loader

Reads `pi-roles` namespace from `settings.json` (project + user). Project wins on field-level
merge. Parse failures degrade to `{}` silently — a corrupt settings file shouldn't prevent
pi-roles from loading.

### `src/intercom.ts` — pi-intercom integration helpers

Two responsibilities, both conditional on pi-intercom being installed:

1. **Detection** — `isIntercomAvailable(pi)` checks `pi.getAllTools()` for a tool named `intercom`
2. **Prompt addendum** — `intercomPromptAddendum(mode, sessionName)` returns a short mode-specific
   directive appended to the system prompt

Tool inclusion in the active set is handled by `apply.ts` (adds `intercom` when mode ≠ `off`).
This module is pure prompt-side logic.

### `src/role-assistant.ts` — Built-in role accessor

Resolves the absolute path to `resources/roles/role-assistant.md` relative to `import.meta.url`.
Exposes `loadBuiltInRoleAssistant()` for tests and for direct loading when full discovery
isn't needed. The real loader (`loadRoleFile`) lives in `roles.ts`; this module only adds
path resolution and an existence check.

### `resources/roles/role-assistant.md` — The built-in fallback

A Markdown role file (YAML frontmatter + system prompt body) that:
1. Greets the user and lists available roles
2. Shows exact `/role <name>` commands
3. Walks the user through building a new role interactively
4. Writes the new role file to the chosen scope directory

Lowest discovery priority — drop a same-named file in user or project scope to override.

## Data Flow

### Session start (no persisted state)

```
pi --role architect
  │
  ▼
session_start (reason="startup")
  │
  ├─► refreshFromDisk(cwd)
  │     ├─ loadSettings(cwd)          → PiRolesSettings
  │     └─ discoverRoles(cwd, scope)  → RawRole[]
  │
  ├─► pickInitialRoleName(pi, settings, roles)
  │     precedence: --role > PI_ROLE > defaultRole > role-assistant
  │
  └─► applyResolved(pi, ctx, state, "architect", options)
        │
        ├─► resolveRole("architect", roles)        → ResolvedRole
        │     └─ walk extends chain, merge fields
        │
        └─► applyRole(resolved, applyCtx, options)  → ApplyResult
              ├─ pi.setModel(...)
              ├─ pi.setThinkingLevel(...)
              ├─ pi.setActiveTools(...)
              ├─ ctx.ui.setStatus(STATUS_KEY, "Intent not defined - architect")
              ├─ pi.setSessionName("Intent not defined - architect")
              ├─ pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, state)
              └─ pi.sendMessage(notification)
```

### Per-turn system prompt

```
before_agent_start fires
  │
  ├─► If !state.intent && first user prompt:
  │     void generateAndApplyTitle(...)    [fire-and-forget]
  │       └─ on success: pi.setSessionName("Design auth schema - architect")
  │                      ctx.ui.setStatus(STATUS_KEY, "Design auth schema - architect")
  │
  └─► composeSystemPrompt(state, pi)
        │
        ├─ activeRole.body
        ├─ + intercomPromptAddendum (if intercom mode ≠ off)
        │
        └─► return { systemPrompt: body + addendum }
```

### Mid-session role swap

```
/role planner
  │
  ├─► refreshFromDisk(ctx.cwd)        [always re-reads from disk]
  │
  └─► applyResolved(pi, ctx, state, "planner", { preservedIntent })
        │  └─ same applyRole flow as session start, but:
        │      - silent=false (show notification)
        │      - preservedIntent carries over the existing intent string
        │      - pi.setSessionName("Design auth schema - planner")
        │
        └─ state.activeRole updated, state.intent preserved
```

### /role <name> --reset

```
/role planner --reset
  │
  ├─► state.pendingRoleAfterReset = "planner"
  │
  ├─► resetSession(ctx)
  │     ├─ await ctx.waitForIdle()
  │     └─ ctx.newSession()
  │           │
  │           └─► synchronously fires session_start (reason="new")
  │                 │
  │                 ├─ reads pendingRoleAfterReset → "planner"
  │                 ├─ clears state.intent (fresh session)
  │                 └─ applyResolved("planner", ...)
  │
  └─► if cancelled: state.pendingRoleAfterReset = null
```

### Reload/resume (extension memory wiped)

```
session_start (reason="reload" | "resume")
  │
  ├─► findRestoredState(ctx)
  │     └─ walk ctx.sessionManager.getEntries() right-to-left
  │         for most recent customType === "pi-roles:active-role"
  │         → ActiveRoleState { name, source, path, intent }
  │
  └─► applyResolved(name, { silent: true, preservedIntent })
        └─ re-resolves the extends chain fresh from disk
           (parent roles may have been edited in the meantime)
```

## Dependencies

### Runtime (bundled or peer)

| Package | Version | Role |
|---|---|---|
| `@mariozechner/pi-coding-agent` | `*` (peer) | Extension host — `ExtensionAPI`, `ExtensionContext`, events, commands, flags |
| `@mariozechner/pi-agent-core` | `*` (peer) | Session management (`getEntries`, `newSession`) |
| `@mariozechner/pi-ai` | `*` (peer) | `complete()` for title generation |
| `@mariozechner/pi-tui` | `*` (optional peer) | `AutocompleteItem` type for tab completions |
| `typebox` | `^1.0.0` (peer) | Schema validation — the `typebox` root package (1.x), NOT `@sinclair/typebox` |
| `yaml` | `^2.5.0` (direct) | YAML frontmatter parsing |

### Build

| Package | Role |
|---|---|
| `tsup` | Bundle to ESM (`dist/index.js` + `.d.ts`) |
| `typescript` | Type-checking (`tsc --noEmit`) |
| `vitest` | Test runner (125 tests across 7 suites) |

### Peer extensions (optional, detected at runtime)

| Extension | Detection method | Integration |
|---|---|---|
| `pi-intercom` | `pi.getAllTools().some(t => t.name === "intercom")` | Tool added to active set; prompt addendum injected |
| `pi-mcp-adapter` | `pi.getAllTools()` for `mcp:*` tool names | MCP tools resolved in `filterToolsForRuntime`; dropped with warning when absent |
| `pi-subagents` | Not directly integrated | Composes architecturally — pi-roles for top-level sessions, pi-subagents for sub-agent dispatch |
| `pi-powerline-footer` | Not directly integrated | Coexists via `ctx.ui.setStatus` — both use the same Pi footer API |

## Cross-Cutting Concerns

### Settings model

Settings are read from two files, merged with project priority:

```
~/.pi/agent/settings.json  →  user defaults
<cwd>/.pi/settings.json     →  project overrides (ancestor-walk, first hit wins)
```

Only the `"pi-roles"` key is read. Parse failures degrade to `{}` silently.
Unknown fields are tolerated (`additionalProperties: true` on all schemas).

Settings are re-read on every `session_start`, every `/role` invocation, and every
`/role reload`. No caching between operations.

### Error handling strategy

| Error class | When | Behavior |
|---|---|---|
| `RoleResolutionError` | Invalid YAML, schema violation, name/filename mismatch, cycle in `extends`, missing parent | Surface in TUI via `ctx.ui.notify("warning")`, fall back to built-in `role-assistant` |
| Model not found / no API key | `applyRole` model resolution | Warn, continue with existing model |
| `mcp:*` tool not registered | `filterToolsForRuntime` | Drop entry silently (or warn if `warnOnMissingMcp: true`) |
| `settings.json` parse failure | `loadSettings` | Return `{}`, proceed with defaults |
| Title generation failure | `generateAndApplyTitle` catch block | Swallow — best effort, next prompt retries |
| Complete absence of built-in `role-assistant` resource | `findBuiltInAssistant` | No-op — session starts without a role (Pi default system prompt) |

**Principle:** A broken role file should never prevent pi-roles from loading.
The built-in `role-assistant` is the universal fallback; if even that is missing,
pi-roles degrades gracefully to a no-op.

### System prompt replacement

The `before_agent_start` handler returns `{ systemPrompt: <role body> }` and intentionally
ignores `event.systemPrompt` (Pi's default coding-assistant framing + any prior extensions
in the chain). The founding goal is that the role body is **authoritative** — a non-coding
role (marketing, research, ops) must not inherit the default "expert coding assistant" voice.

Subsequent extensions in the chain see pi-roles' value as their `event.systemPrompt` and
may compose if they choose. This is Pi's documented chaining model.

### Tools tri-state semantics

The `tools` frontmatter field has three states, distinguished in code (not in the TypeBox
schema, because JSON Schema can't distinguish `undefined` from "not validated"):

| YAML | `tools` value | `ToolsDirective` | Meaning |
|---|---|---|---|
| Field absent | `undefined` | `{ kind: "inherit" }` | Inherit from `extends` parent, or keep session default |
| `tools:` or `tools: ~` | `null` | `{ kind: "set", names: [] }` | Explicitly disable all tools |
| `tools: read, bash` | `"read, bash"` | `{ kind: "set", names: ["read", "bash"] }` | Exactly these tools |

### `extends` chain resolution

1. Build leaf-first ordered list by walking `extends` pointers (detect cycles)
2. Reverse to root-first
3. Merge: child's explicit values win; parent body is **prepended** to child body
4. `tools` follows the tri-state: `set` overrides, `inherit` walks up, `empty` is terminal
5. `name` is never inherited — always the leaf's own filename

## Non-Goals (explicitly out of scope)

- **Spawning sub-agents.** That's `pi-subagents`. Compose the two.
- **Defining built-in roles beyond `role-assistant`.** Roles are user content.
- **Managing parallel sessions.** Use multiple terminals or `tmux` + `pi-intercom`.
- **Persisting active role across Pi restarts** (except via `--role` / `PI_ROLE` / `defaultRole`).
- **Restricting which tools a role can request.** If a role lists `bash`, it gets `bash`.
  Pair with `permission-gate.ts` or similar for permission boundaries.
- **Caching role files.** `/role <name>` always re-reads from disk. No staleness, ever.

## Risks & Known Limitations

| Risk | Mitigation |
|---|---|
| **Model resolution fails silently** — user's `model:` field points to a model they don't have an API key for | Warn in notification; keep current model. Visible in `/role current` output. |
| **`mcp:*` entries silently dropped** when `pi-mcp-adapter` isn't installed | `warnOnMissingMcp` defaults to `true`; one warning per dropped entry |
| **Title generation latency** — hitting a model for intent summarization adds cost | Fire-and-forget; the agent loop starts immediately. Title model is typically a cheap model (`gpt-4o-mini`). |
| **Stale intent after `--reset` race** — title generation in flight when reset happens | Re-check `state.intent` and `state.activeRole` after await; drop stale result. Worst case is one cosmetic glitch for one prompt. |
| **`--reset` + `newSession` ordering** — `pendingRoleAfterReset` must be set before `newSession` because `session_start` fires synchronously | Enforced in the command handler; cancellation path restores `null`. |
| **Extension memory wiped on `/reload`** — all module-scoped state is lost | `pi.appendEntry` persistence + `session_start` restore from session log. Intent and active role survive `/reload`. |
| **No runtime cache invalidation** for role files — if a parent role is edited while a child is active, the child's in-memory resolved state is stale | `/role reload` or `/role <same-name>` re-reads the full chain from disk. Users iterating on roles are expected to use these. |
| **Pi API surface instability** — the extension depends on Pi internal APIs that may change between versions | Version pin in `package.json` `engines`; the BUILD-STATUS.md documents the verified API surface against pi-mono as of April 2026. |

## Layout on Disk

```
pi-roles/
  src/
    index.ts            Extension entry point, lifecycle wiring
    schemas.ts          TypeBox schemas, TS interfaces, constants
    roles.ts            Discovery, parsing, extends resolution
    apply.ts            Side-effecting application to Pi session
    title.ts            Session-name intent generation
    intercom.ts         pi-intercom integration helpers
    settings.ts         settings.json loader
    role-assistant.ts   Built-in role-assistant path resolver
  test/
    *.test.ts           Vitest test suites (125 tests)
  resources/
    roles/
      role-assistant.md  The one built-in role
  examples/
    architect.md         Minimal reference role
    orchestrator.md      Fully-loaded reference role
  dist/                  tsup ESM output (not committed)
  openspec/              Spec-driven change proposals (OpenSpec)
  .beads/                Issue tracker (beads/bd)
  .pi/                   Pi runtime state (roles, agents, skills, prompts)
  package.json           Pi extension manifest
  tsconfig.json          Strict TS, ES2022, bundler resolution
  tsup.config.ts         Build config
  README.md              Public documentation
  BUILD-STATUS.md        Build-phase tracking & verified Pi API facts
  CHANGELOG.md           Keep-a-Changelog format
```

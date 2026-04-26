# pi-roles

> Role-based session configuration for [pi coding agent](https://github.com/badlogic/pi-mono). Launch a session as a named role (architect, planner, marketing-strategist, …) and hot-swap roles mid-session — without restarting Pi.

`pi-roles` is to **top-level pi sessions** what [`pi-subagents`](https://github.com/nicobailon/pi-subagents) is to **sub-agents**: same `.md` + YAML frontmatter convention, same project/user scope rules, drop-in flow. The extension is **agnostic of which roles exist** — roles are just markdown files you create.

```bash
pi --role architect              # launch as architect
PI_ROLE=planner pi               # or via env

/role list                       # inside the session
/role planner                    # swap role mid-session, keep history
/role planner --reset            # swap role and clear history
/role current
/role reload                     # re-read the active role file from disk
```

When you swap roles, the session's **system prompt, model, thinking level, and active tool set** are replaced according to the new role's definition. Conversation history is preserved by default.

---

## Install

```bash
pi install npm:pi-roles
```

Then restart pi. The extension is auto-discovered; the `--role` flag and `/role` command become available.

To try without installing:

```bash
pi -e git:github.com/lojacobs/pi-roles
```

---

## Why this exists

When you build a multi-agent dev workflow with specialized roles — architect (design), planner (decompose), orchestrator (dispatch), or any equivalent for marketing, research, ops — the *top-level* role is a property of the whole session, not of an individual sub-agent dispatch. You want different system prompts, different models, different tool restrictions per role, and you want to switch between them without restarting.

`pi-roles` is the cleanest way to do that. No shell aliases, no separate workspace directories, no forking pi-subagents into something it isn't.

---

## Role files

Roles are markdown files with YAML frontmatter, identical in shape to `pi-subagents` agent files:

```markdown
---
name: architect
description: Defines the WHAT. Owns architecture and specs. Never codes.
model: anthropic/claude-opus-4-7
thinking: high
tools: read, grep, find, ls, write, edit
intercom: send             # optional, per-role override
extends: base-reviewer     # optional, role inheritance
---

# Role

You are the Architect. Your job is to define WHAT the system should
do, never HOW to build it...

(everything below the frontmatter is the system prompt body)
```

### Frontmatter reference

| Field | Required | Behavior when omitted |
|---|---|---|
| `name` | yes | — must match the filename without `.md` |
| `description` | yes | — shown in `/role list` and selectors |
| `model` | no | keeps the session's current model |
| `thinking` | no | keeps the session's current thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `tools` | no — see below | inherits from parent (if `extends`) or keeps current active set |
| `intercom` | no | falls back to the global `intercomMode` setting |
| `extends` | no | role inherits from another role |

#### `tools` — the tri-state

Three explicit states with three different meanings:

| YAML | Meaning |
|---|---|
| `tools: read, bash` | **set** — exactly these tools, nothing else |
| `tools:` (present, empty) | **disable all tools** — read-only conversation, no actions |
| field absent | **inherit** — from parent role (`extends`), else keep session default |

You can also include MCP tool refs in the same field, mirroring `pi-subagents`:

```yaml
tools: read, grep, mcp:chrome-devtools, mcp:github
```

`mcp:server-name` entries require [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) to be installed. If it's not, the entry is logged and skipped — the role still loads.

#### `model` — provider/id format

Matches Pi's CLI `--model` syntax:

```yaml
model: anthropic/claude-opus-4-7
model: openai/gpt-5
model: deepseek/deepseek-v4-pro
```

If the model isn't available (no API key, unknown provider), the role load surfaces a warning and the session keeps its current model.

#### `intercom` — per-role override

Values: `off`, `receive`, `send`, `both`. Defaults to the global `intercomMode` setting (which itself defaults to `off`). See [pi-intercom integration](#pi-intercom-integration) below.

#### `extends` — role inheritance

```yaml
extends: architect
```

A child role inherits everything from its parent and overrides selectively. Chains are supported (`A extends B extends C`); cycles are detected at load time and produce a hard error.

**Merge rules:**

- `model`, `thinking`, `description`, `intercom`: child wins if set, else parent value.
- `tools`: see the tri-state above. **Set overrides; empty disables; absent inherits.**
- Markdown body: parent's body is **prepended** to child's body with a separator. Useful for "stricter variant" patterns (`architect-strict extends architect`).
- `name`: never inherited — always the child's own filename.

---

## Discovery

Roles are looked up in this order, **first match wins** for any given name:

| Scope | Path | Marker in `/role list` |
|---|---|---|
| project | `<repo>/.pi/roles/<name>.md` (or any ancestor) | `[project]` |
| user | `~/.pi/agent/roles/<name>.md` | `[user]` |
| built-in | bundled with the package | `[built-in]` |

When a project-scope role shadows a user-scope role of the same name, the user-scope entry is listed under a separate "Shadowed" heading in `/role list` output so you know it exists but won't load.

The default `roleScope` is `both` (project + user + built-in). Override via settings:

```json
// ~/.pi/agent/settings.json
{
  "pi-roles": {
    "roleScope": "both",        // "user" | "project" | "both"
    "defaultRole": "architect", // optional; falls back to role-assistant
    "intercomMode": "off",      // "off" | "receive" | "send" | "both"
    "titleModel": "openai/gpt-4o-mini"
  }
}
```

---

## Built-in `role-assistant`

`pi-roles` ships **one** built-in role: `role-assistant`. It's the default fallback when no `defaultRole` is configured and you don't pass `--role` or `PI_ROLE`.

The role-assistant:

1. Lists the roles available on your machine (project + user + built-in) on its first turn.
2. Shows the exact command to switch to one (e.g. `/role architect`).
3. Offers to help you build a **new** role: it asks the questions, drafts the markdown, shows it for your approval, writes it to project or user scope (your choice), and then prints the command for you to launch it (`/role <new-name> --reset`).

You can override the built-in by dropping a `role-assistant.md` into your project or user roles directory — the same priority rules apply.

You can also set any other role as your default:

```json
{ "pi-roles": { "defaultRole": "architect" } }
```

If `defaultRole` points to a missing role, the built-in `role-assistant` is used and a warning is shown.

---

## Slash command

`/role <subcommand>` — Tab-completes role names against the current scope.

| Form | Behavior |
|---|---|
| `/role <name>` | Switch to `<name>`. **Preserves history.** Re-reads the file from disk (no caching). |
| `/role <name> --reset` | Switch to `<name>` **and** clear history (equivalent to `/new` + apply role). |
| `/role list` | List discovered roles with scope markers and shadowing info. |
| `/role current` | Show the currently active role's name, extends chain, description, and source path. |
| `/role reload` | Re-read the **currently active** role's file from disk and re-apply. Useful while you're iterating on a prompt. |

---

## CLI flag and env var

```bash
pi --role architect "Help me design the auth schema"
PI_ROLE=architect pi
```

Resolution order: `--role` > `PI_ROLE` > `defaultRole` setting > built-in `role-assistant`.

---

## Session name and footbar

Each session is named `<role-name>` (and, once the title-generation phase ships, `<role-name> — <intent>`, where `<intent>` is a short summary of your first user message). The role-name prefix updates when you `/role` to a different role.

The session name is set via Pi's native `pi.setSessionName()` API, so:

- It shows in Pi's session selector and `/resume` listings.
- [`pi-intercom`](https://github.com/nicobailon/pi-intercom) automatically uses it as the session target — making cross-session messaging work out of the box.

The role indicator also appears in Pi's footer (via `ctx.ui.setStatus`), composing cleanly with [`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer) if you have it installed. No extra dependency required.

**Title generation model** (planned). The `titleModel` setting is reserved for the future intent-summarization step; it has no effect today. The current release sets the session name to the bare role name and updates the prefix on swap.

---

## pi-intercom integration

[`pi-intercom`](https://github.com/nicobailon/pi-intercom) is an **optional peer dependency**. `pi-roles` works without it; intercom features are no-ops when it's not installed.

When it **is** installed, the global `intercomMode` setting controls whether roles get the `intercom` tool added to their active tool set, plus a small system-prompt addendum telling the LLM how and when to use it:

| Mode | Behavior |
|---|---|
| `off` | Default. No intercom tools, no prompt mentions. |
| `receive` | Role can be targeted by other sessions but won't proactively send. |
| `send` | Role can send to other sessions but doesn't expect inbound coordination. |
| `both` | Full bidirectional coordination — `intercom` tool active, prompt encourages use. |

Per-role override via the `intercom:` frontmatter field. Common pattern: `architect` and `planner` set `intercom: both`, `orchestrator` sets `intercom: off` (you don't want the orchestrator distracted by chatter while it dispatches).

**Inter-session messaging is always between named sessions on the same machine** — `pi-roles` only opts roles in or out, it doesn't manage the broker, the protocol, or the message store. That's all `pi-intercom`.

---

## pi-mcp-adapter integration

When [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) is installed, you can list MCP tools alongside built-ins in the `tools` field with the `mcp:server-name` syntax:

```yaml
tools: read, grep, write, mcp:chrome-devtools, mcp:github
```

This mirrors `pi-subagents`'s convention exactly, so muscle memory transfers. If `pi-mcp-adapter` isn't installed, the `mcp:*` entries are logged and skipped — the role still loads with its built-in tools.

The first time you use a new MCP server, its tool metadata is cold-cached; you may need to restart Pi once for direct MCP tools to become available. This is a `pi-mcp-adapter` behavior, not something `pi-roles` controls.

---

## Hot reload

`/role reload` re-reads the **currently active** role's file from disk and re-applies it. This is for iterating on a prompt without restarting your session.

`/role <name>` (without `--reset`) also always re-reads from disk — there's no hidden cache between switches.

For roles with `extends`, the entire chain is re-resolved on every load.

If you have Pi's [auto-reload](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#ctxreload) feature wired up via `/reload`, that triggers a full extension reload as well — your role re-applies from scratch.

---

## Settings reference

```json
// ~/.pi/agent/settings.json (global) or .pi/settings.json (project)
{
  "pi-roles": {
    "roleScope": "both",
    "defaultRole": "role-assistant",
    "intercomMode": "off",
    "titleModel": "openai/gpt-4o-mini",
    "warnOnMissingMcp": true
  }
}
```

| Key | Default | Description |
|---|---|---|
| `roleScope` | `"both"` | Discovery scope. `"user"`, `"project"`, or `"both"`. |
| `defaultRole` | `"role-assistant"` | Role applied at session start when no `--role` or `PI_ROLE`. |
| `intercomMode` | `"off"` | Default intercom behavior for roles that don't set it explicitly. |
| `titleModel` | `null` (auto) | Model used for session-intent summarization. Falls back to a small built-in or session's current model. |
| `warnOnMissingMcp` | `true` | Whether to surface a warning when a role's `mcp:*` entry can't be resolved. |

Project settings beat global settings, per Pi's standard precedence.

---

## What this extension does **not** do

- **Spawn sub-agents.** That's [`pi-subagents`](https://github.com/nicobailon/pi-subagents). The two compose: use `pi-roles` for top-level session roles, `pi-subagents` for delegated workers within a role.
- **Define any built-in roles other than `role-assistant`.** Roles are user content; the extension stays small.
- **Manage parallel sessions.** Use multiple terminals or `tmux`. Coordination between parallel sessions is what `pi-intercom` handles, optionally.
- **Persist which role was active across pi restarts** — except via `--role` / `PI_ROLE` / `defaultRole`. By design.
- **Restrict which tools a role can request.** If a role lists `bash`, it gets `bash`. Permission boundaries are your call — pair with [`permission-gate.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts) or a similar guard if you need them.

---

## Design choices worth knowing

These are decided, not configurable, so the extension behaves predictably:

- **Markdown body is appended to Pi's `before_agent_start` system-prompt chain.** This means the role body composes with whatever prompt the upstream chain produced (Pi default + any other extensions), with the role body last and therefore most influential. If you need the role body to fully replace upstream framing, write the body to begin with explicit overriding instructions ("Ignore any previous coding-assistant framing; you are X.").
- **Role inheritance**: `model`/`thinking` override; `tools` is tri-state (set/empty/absent); markdown body is **prepended**.
- **Cycle detection in `extends`** is a hard error at load time, not a warning. A circular role is broken; refusing to load it is the only sane behavior.
- **`/role <name>` always re-reads from disk.** No staleness between switches, ever.
- **`--reset` is explicit.** The role-assistant prints the exact `--reset` command for you to run manually rather than auto-resetting; resetting is destructive enough to deserve a deliberate keystroke.
- **Title generation** (planned, not yet implemented). The current release sets the session name to the bare role name; intent-summarization on first user message lands in a follow-up. `--reset` already clears the cached intent so the future implementation drops in cleanly.
- **Built-in `role-assistant` lives at the lowest discovery priority.** Drop a same-named file in user or project scope to override it.
- **`/role list` shows shadowed entries** with a `(shadowed)` marker — you can see what *would* load if the higher-priority file didn't exist.

---

## Layout on disk

After install, your roles live wherever you like — typical setup:

```
~/.pi/agent/roles/
  architect.md
  planner.md
  orchestrator.md
  marketing-strategist.md
  campaign-manager.md

<repo>/.pi/roles/
  architect.md          # overrides the user one for this project
```

The extension itself ships only `role-assistant.md` (built-in scope) and the runtime code.

---

## Examples

See [`examples/`](./examples) for two reference role files:

- [`architect.md`](./examples/architect.md) — minimal: just system prompt + model + thinking.
- [`orchestrator.md`](./examples/orchestrator.md) — fully loaded: every frontmatter field, including `extends`, `intercom`, MCP tools.

---

## License

MIT. See [LICENSE](./LICENSE).

## Credits

Inspired by and structurally indebted to [`pi-subagents`](https://github.com/nicobailon/pi-subagents) (frontmatter convention, scope discovery), [`pi-prompt-template-model`](https://github.com/nicobailon/pi-prompt-template-model) (per-trigger model/skill/thinking switching), and the [`preset.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/preset.ts) example in pi-mono. Thanks to those authors for both the patterns and the working code to learn from.

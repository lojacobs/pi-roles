# Changelog

All notable changes to `pi-roles` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-05

### Changed

- **System prompt full replacement**: Role body now completely replaces Pi's
default system prompt instead of composing on top of it. Non-coding roles
(e.g., marketing, research) no longer inherit Pi's default "expert coding
assistant" framing.
- **Packaging**: Built output via `tsup`; entry point changed from
`src/index.ts` to `dist/index.js`; `main`/`exports`/`types` fields added;
`.npmignore` added.
- **`/role list` format**: Source scope displayed as `[name]` instead of
`(name)`; shadowed roles (lower-precedence duplicates) listed separately.
- **`/role <name>` re-reads from disk**: Every `/role` invocation now
refreshes role discovery and settings before resolving — edits to role
files are picked up without an explicit `/role reload`.
- **`composeSystemPrompt` extracted**: Moved from inline in
`before_agent_start` to a testable exported function with explicit
replacement contract.

### Added

- **Session naming (Phase 5)**: Session name composed as
`<role> — <intent>` with intent (~5–10 word summary) generated
asynchronously from the first user message. Agent loop starts immediately
while title generation runs out-of-band. Configurable via `titleModel`
setting.
- **`titleInFlight` guard**: Prevents concurrent title generation when
`before_agent_start` fires repeatedly before the first generation resolves.
- **Shadowed role tracking**: `/role list` shows roles shadowed at
lower-precedence scopes.
- **`tsup.config.ts`**: Build configuration for ESM output with type
declarations.
- **Tests**: 37 tests for session-naming module (`test/title.test.ts`);
6 tests for `composeSystemPrompt` replacement contract
(`test/index.test.ts`).

## [0.1.0] - TBD

### Added

- Initial release.
- `--role <name>` CLI flag and `PI_ROLE` env var for launching pi as a named role.
- `/role` slash command with `list`, `current`, `reload`, and `<name>` subcommands.
- `--reset` flag on `/role <name>` to clear history before applying the new role (equivalent to `/new` + apply).
- Tab autocompletion for role names.
- Role frontmatter spec: `name`, `description`, `model`, `thinking`, `tools`, `intercom`, `extends`. Markdown body becomes the system prompt.
- Discovery from project (`<repo>/.pi/roles/`), user (`~/.pi/agent/roles/`), and built-in scopes, with project-first precedence.
- `defaultRole` setting, falling back to a built-in `role-assistant` that lists available roles and walks you through building new ones.
- Role inheritance via `extends`, with chained resolution, cycle detection, and tri-state `tools` semantics (set / explicit-empty / inherit).
- Markdown body inheritance: parent body prepended to child body.
- Hot reload via `/role reload` (re-reads currently active role file from disk).
- Session naming as `<role> — <intent>`, with intent generated asynchronously from the first user message.
- Role indicator in Pi's footer via `ctx.ui.setStatus`, composing with `pi-powerline-footer`.
- Optional `pi-intercom` integration: per-role and global `intercomMode` (`off` / `receive` / `send` / `both`), prompt addendum, tool list opt-in. No-op when `pi-intercom` is not installed.
- Optional `pi-mcp-adapter` integration: `mcp:server-name` entries inside the `tools` field, mirroring `pi-subagents` convention. No-op when `pi-mcp-adapter` is not installed.
- Two example role files (`examples/architect.md`, `examples/orchestrator.md`).

[Unreleased]: https://github.com/lojacobs/pi-roles/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lojacobs/pi-roles/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lojacobs/pi-roles/releases/tag/v0.1.0

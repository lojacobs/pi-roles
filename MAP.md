# MAP — pi-roles file index

Quick-reference for agents working in this repo. Read this first (it's ~300 tokens),
then open only the files you need.

## Source (8 files, ~19K tok)

| File | Tokens | Purpose |
|---|---|---|
| `src/schemas.ts` | ~3.2K | **Source of truth.** TypeBox schemas + TS interfaces for roles, settings, persisted state. No side effects. |
| `src/roles.ts` | ~3.5K | **Discovery + parse + extends.** Pure fs/parse — no Pi APIs. `discoverRoles`, `loadRoleFile`, `resolveRole`. |
| `src/apply.ts` | ~3.3K | **Apply to live session.** Model/tools/thinking mutation. `applyRole`, `resetSession`, `filterToolsForRuntime`. |
| `src/index.ts` | ~4.3K | **Extension entry point.** Lifecycle wiring: `session_start`, `before_agent_start`, `/role` command, `--role` flag. |
| `src/title.ts` | ~2.6K | **Session-name intent.** Fire-and-forget summarization via `pi-ai` `complete()`. |
| `src/intercom.ts` | ~0.7K | **pi-intercom helpers.** Detection (`isIntercomAvailable`) + prompt addendum per mode. |
| `src/settings.ts` | ~0.6K | **settings.json loader.** Reads `"pi-roles"` namespace, project-over-user merge. |
| `src/role-assistant.ts` | ~0.5K | **Built-in role path resolver.** Tiny wrapper around `loadRoleFile` for the bundled role-assistant. |

## Tests (7 files, ~14K tok)

| File | Tokens | Covers |
|---|---|---|
| `test/title.test.ts` | ~4.7K | Title extraction, model resolution, prompt composition (37 tests) |
| `test/apply.test.ts` | ~3.3K | Model parsing, tool filtering, session naming, apply orchestration (32 tests) |
| `test/roles.test.ts` | ~2.6K | Frontmatter parsing, tri-state tools, extends chain, discovery, shadowing (23 tests) |
| `test/index.test.ts` | ~1.9K | Flag/env/defaultRole precedence, composeSystemPrompt, completions (12 tests) |
| `test/examples.test.ts` | ~0.6K | Example files parse without errors (3 tests) |
| `test/role-assistant.test.ts` | ~0.5K | Built-in role loads and resolves (5 tests) |
| `test/intercom.test.ts` | ~0.4K | Intercom detection and addendum composition (7 tests) |

## Resources & Examples (3 files, ~2K tok)

| File | Tokens | Purpose |
|---|---|---|
| `resources/roles/role-assistant.md` | ~1.3K | Built-in fallback role. Greets, lists roles, builds new ones interactively. |
| `examples/architect.md` | ~0.4K | Minimal reference role (model + thinking only). |
| `examples/orchestrator.md` | ~0.4K | Full reference role (extends, intercom, MCP tools). |

## Config (3 files, ~0.7K tok)

| File | Tokens | Purpose |
|---|---|---|
| `package.json` | ~0.5K | Pi extension manifest. Peer deps, pi.extensions entry, scripts, files. |
| `tsconfig.json` | ~0.2K | Strict TS, ES2022, bundler resolution, `allowImportingTsExtensions`. |
| `tsup.config.ts` | ~0.04K | Build: ESM bundle to `dist/`, emit `.d.ts`. |

## Docs (5 files, ~21K tok)

| File | Tokens | Purpose |
|---|---|---|
| `README.md` | ~4.9K | **Public contract.** Usage, frontmatter reference, settings, design choices. |
| `ARCHITECTURE.md` | ~7.1K | **Cross-cutting design.** Module map, data flows, trust boundaries, risks. |
| `BUILD-STATUS.md` | ~7.6K | **Build phases + verified Pi APIs.** The 11 correction notes are authoritative over earlier drafts. |
| `CHANGELOG.md` | ~0.6K | Keep-a-Changelog, 0.1.0 feature list. |
| `AGENTS.md` | ~1.6K | Project conventions: spec-driven workflow, beads, escalation tags, role permissions. |

## Meta (2 files, ~0.3K tok)

| File | Tokens | Purpose |
|---|---|---|
| `LICENSE` | ~0.3K | MIT. |
| `.gitignore` | negligible | Standard Node + Pi local state. |

---

## What to read, by role

### Architect
1. `ARCHITECTURE.md` — you own this. Update it when cross-cutting concerns change.
2. `src/schemas.ts` — the contract. Every spec change flows through here.
3. `AGENTS.md` — workflow conventions, escalation tags.
4. `BUILD-STATUS.md` — verified Pi API surface (read correction notes 1–11 first).

### Planner
1. `ARCHITECTURE.md` — module boundaries and data flows to plan against.
2. `src/schemas.ts` — to understand what shapes exist.
3. `AGENTS.md` — escalation tags, beads conventions.
4. `package.json` + `tsconfig.json` — build constraints.

### Orchestrator
1. `AGENTS.md` — this defines your dispatch flow, escalation rules, commit policy.
2. `ARCHITECTURE.md` — trust boundaries, risks section.
3. `BUILD-STATUS.md` — if a coder hits a Pi API issue, check correction notes first.
4. `test/` directory (skim names) — to know what test suites gate each module.

### Coder (senior / junior)
1. The source file you're editing + its corresponding `test/*.test.ts`.
2. `src/schemas.ts` — if adding/changing a shape.
3. `AGENTS.md` — hard constraints (never commit, never edit openspec, never edit ARCHITECTURE.md).
4. `package.json` — scripts: `npm test`, `npm run typecheck`, `npm run build`.

### Reviewer
1. The diff of the changed files.
2. `src/schemas.ts` — validate that schema changes are backward-compatible.
3. `AGENTS.md` — role permission table (verify the coder didn't cross boundaries).

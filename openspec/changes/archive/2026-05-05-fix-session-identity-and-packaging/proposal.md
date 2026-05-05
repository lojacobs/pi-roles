## Why

Three issues need addressing before the 0.2.0 release:

1. **Package install UX**: The package publishes under `@lojacobs/pi-roles` (personal scope). Users expect `pi install npm:pi-roles` — dropping the scope reads as a community extension, not a personal fork.
2. **Footer/status bar bug**: The footer renders session name as `"role — role"` (role shown twice, no intent) because `ctx.ui.setStatus` receives only the role name while `pi.setSessionName` renders the role name in the title bar. Expected: `"Intent not defined - <role>"` before intent generation, `"<intent> - <role>"` after.
3. **Intercom session-name staleness**: On the first turn, `intercomPromptAddendum()` receives just the bare role name (or `"(unnamed session)"`), while mid-turn title generation updates the registry. The model sees a stale or empty name. With the placeholder format, the first turn always gets a stable `<placeholder> - <role>` string.

## What Changes

- **Drop npm scope**: Rename package from `@lojacobs/pi-roles` to `pi-roles`, bump to `0.2.0`.
- **Flip session-name ordering**: Canonical format becomes `<intent> - <role>` (intent first, hyphen separator) — applies to footer, title bar, and intercom identity consistently.
- **Intent placeholder**: When intent is not yet generated, use `"Intent not defined"` instead of omitting the intent half entirely.
- **Footer uses composed identity**: `ctx.ui.setStatus` now shows the full `<intent/holder> - <role>` string, not just the bare role name.
- **Footer refreshed after title generation**: `title.ts` now calls `ctx.ui.setStatus` alongside `pi.setSessionName` so the footer updates synchronously when the intent is generated.
- **Intercom addendum always has a stable name**: The addendum sees `"Intent not defined - <role>"` from turn one instead of just the bare role or `"(unnamed session)"`.

## Capabilities

### New Capabilities
- `session-identity`: How pi-roles composes and surfaces the session's visible identity — the footer status, the session name for intercom targeting, and the title bar — in a single canonical ordering that stays in lockstep across all surfaces.
- `package-distribution`: The npm package name, version, and install UX for pi-roles.

## Impact

- **Breaking**: npm install path changes from `@lojacobs/pi-roles` → `pi-roles`. Existing installs using scoped name will break on next update.
- **Non-breaking behavioral**: Footer and title bar now show intent-first ordering. Users will see `"Intent not defined - architect"` at session start instead of `"architect"`.
- **Files touched**: `package.json`, `CHANGELOG.md`, `src/apply.ts`, `src/title.ts`, `test/apply.test.ts` (or equivalent test file), `ARCHITECTURE.md`.

# Tasks: fix-session-identity-and-packaging

Epic: `pi-roles-qy0`

## T1: Add INTENT_PLACEHOLDER + composeFooterStatus + flip composeSessionName format

**Files:** `src/apply.ts`, `src/schemas.ts`
**Depends on:** —

1. Add exported constant `INTENT_PLACEHOLDER = "Intent not defined"` to `src/schemas.ts` (alongside `STATUS_KEY`).
2. Update `composeSessionName` in `src/apply.ts`:
   - Flip ordering to `<intent> - <role>` (hyphen separator, not em-dash).
   - When intent is empty/whitespace/undefined, use `INTENT_PLACEHOLDER` instead of returning bare role name.
   - Import `INTENT_PLACEHOLDER` from `./schemas.ts`.
3. Add `composeFooterStatus(roleName: string, intent: string | undefined): string` to `src/apply.ts`:
   - Identical output to `composeSessionName` for the same inputs.
   - Delegates to the same internal logic; separate function for call-site clarity.
   - Export it.
4. In `applyRole` (step 4 — footer status), replace `role.name` with `composeFooterStatus(role.name, options.preservedIntent)`.

Verify: `composeFooterStatus("architect", undefined)` → `"Intent not defined - architect"`, `composeSessionName("architect", "fix bug")` → `"fix bug - architect"`.

## T2: Wire footer refresh in title.ts

**Files:** `src/title.ts`
**Depends on:** T1

1. Import `composeFooterStatus` and `STATUS_KEY` from `./apply.ts` and `./schemas.ts`.
2. After `pi.setSessionName(...)` in `generateAndApplyTitle` (line ~248), add:
   ```ts
   if (ctx.hasUI) {
     ctx.ui.setStatus(STATUS_KEY, composeFooterStatus(state.activeRole.name, intent));
   }
   ```
   Guard: `ctx.hasUI` check matches `applyRole` convention; `state.activeRole` is non-null here (re-checked after await).
3. Update docstrings referencing the old `<role> — <intent>` format to `<intent> - <role>`.

## T3: Update + add tests

**Files:** `test/apply.test.ts`, `test/title.test.ts`
**Depends on:** T1, T2

### apply.test.ts

1. Add `INTENT_PLACEHOLDER` and `composeFooterStatus` to imports from `../src/apply.ts` and `../src/schemas.ts`.
2. Update `composeSessionName` assertions:
   - `composeSessionName("architect", undefined)` → `"Intent not defined - architect"` (not `"architect"`)
   - `composeSessionName("architect", "")` → `"Intent not defined - architect"`
   - `composeSessionName("architect", "   ")` → `"Intent not defined - architect"`
   - `composeSessionName("architect", "designing schema")` → `"designing schema - architect"` (not `"architect — designing schema"`)
3. Add `describe("composeFooterStatus", ...)`:
   - `composeFooterStatus("architect", undefined)` → `"Intent not defined - architect"`
   - `composeFooterStatus("architect", "")` → `"Intent not defined - architect"`
   - `composeFooterStatus("architect", "   ")` → `"Intent not defined - architect"`
   - `composeFooterStatus("architect", "Design widget")` → `"Design widget - architect"`
4. Add `INTENT_PLACEHOLDER` assertion: `INTENT_PLACEHOLDER === "Intent not defined"`.
5. Update `applyRole` integration tests:
   - `setStatus` calls now receive `composeFooterStatus` output, not bare `role.name`.
   - `setSessionName` calls now receive intent-first format.

### title.test.ts

1. In `generateAndApplyTitle` "happy path" test, update `setSessionName` expectation from `"architect — Refactor login flow"` to `"Refactor login flow - architect"`.
2. Add a `hasUI` fake context so the test can verify footer refresh: mock `ctx.ui = { setStatus: vi.fn() }` and verify `setStatus(STATUS_KEY, "Refactor login flow - architect")` is called.
   - If the existing fake `ExtensionContext` doesn't have `hasUI` / `ui.setStatus`, extend it minimally.
3. Update the docstring reference from em-dash to hyphen.

## T4: Package distribution — unscope name + version bump + CHANGELOG

**Files:** `package.json`, `CHANGELOG.md`
**Depends on:** —

1. `package.json`: change `"name"` from `"@lojacobs/pi-roles"` to `"pi-roles"`, change `"version"` from `"0.1.0"` to `"0.2.0"`.
2. `CHANGELOG.md`: add `## [0.2.0] - 2026-05-05` section above the `[Unreleased]` header:
   ```
   ### Changed
   - Session identity format flipped from `<role> — <intent>` to `<intent> - <role>` with `INTENT_PLACEHOLDER` ("Intent not defined") when intent is absent.
   - Footer status bar now shows the full composed identity string instead of bare role name.
   - Footer refreshes immediately after title generation (no longer waits for next `before_agent_start`).
   - npm package name changed from `@lojacobs/pi-roles` to `pi-roles`.
   ```
3. Update the bottom links: add `[0.2.0]: https://github.com/lojacobs/pi-roles/compare/v0.1.0...v0.2.0`.
4. Run `npm run typecheck && npm run test` — all green before handoff.

## Dependency graph

```
T1 ──→ T2 ──→ T3
T4  (independent)
```

T1 and T4 can start in parallel. T2 depends on T1 (imports `composeFooterStatus`). T3 depends on T1 and T2 (tests both).
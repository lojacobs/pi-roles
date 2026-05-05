## Context

Currently, `pi-roles` has three surfaces that display or use the session identity:

1. **Footer** (`ctx.ui.setStatus`) — shows only the role name (e.g., `"architect"`)
2. **Title bar / session name** (`pi.setSessionName`) — shows `<role> — <intent>` when intent exists, `<role>` otherwise (em-dash separator)
3. **Intercom addendum** (`intercomPromptAddendum`) — embeds `pi.getSessionName()` which reflects whatever `pi.setSessionName` last set

These surfaces are out of sync: the footer shows one thing, the title bar shows another (and on first turn, the intercom addendum may get a stale or empty name because title generation is fire-and-forget).

Additionally, the npm package name uses a personal scope (`@lojacobs/pi-roles`).

## Goals / Non-Goals

**Goals:**
- One canonical identity format: `<intent> - <role>` with hyphen separator.
- When intent is absent, use `"Intent not defined"` as a sentinel placeholder.
- All three surfaces (footer, session name, intercom addendum) use the same composed string.
- The npm package drops the personal scope: `pi-roles`.

**Non-Goals:**
- Changing the title generation mechanism itself (fire-and-forget stays).
- Blocking the first turn on title generation.
- Changing the em-dash in any other context (the `switch` notification message, the `description` in `/role list` output).

## Decisions

### 1. Hyphen separator replacing em-dash

The em-dash (`—`, U+2014) was chosen originally to match pi-intercom's session-targeting convention. In practice, pi-intercom uses `pi.getSessionName()` verbatim and does not parse the separator. The hyphen (`-`, U+002D) is ASCII, unambiguous in all terminals, and matches the natural "heading — subheading" pattern users expect from pi-intercom docs.

### 2. `"Intent not defined"` as empty-intent sentinel

Three options considered:

| Option | Example (role="architect") | Chosen? |
|---|---|---|
| Omit intent entirely | `"architect"` | No — surfaces are inconsistent; footer already shows role alone |
| Empty placeholder | `" - architect"` | No — looks like a rendering bug |
| Explicit placeholder | `"Intent not defined - architect"` | **Yes** — clear, honest about state, debuggable |

The sentinel is also localizable in the future if needed (single constant `INTENT_PLACEHOLDER`).

### 3. Single helper vs. two helpers

`composeFooterStatus(roleName, intent)` and `composeSessionName(roleName, intent)` produce the same output but are separate functions. This is intentional:
- `composeSessionName` is already a public export with existing callers and tests.
- Keeping two names makes the call sites self-documenting: the footer helper is explicitly for the footer, the session-name helper for the title bar/intercom.
- Both delegate to the same internal logic; they don't diverge.

### 4. Footer refresh in title.ts

Currently, `title.ts` only calls `pi.setSessionName` after generating an intent. Adding `ctx.ui.setStatus` there keeps the footer in sync without waiting for the next `before_agent_start` cycle. It's a best-effort update — if it fails, the next `before_agent_start` will re-apply the correct status from the session name.

## Risks / Trade-offs

- **Placeholder visible to the user**: `"Intent not defined"` is intentionally prominent — it signals that the session is in a pre-intent state. Users may ask "what does that mean?" The answer: it means pi-roles hasn't summarized your first message yet. It resolves to the real intent within ~2 seconds on the first turn.
- **Intercom addendum exposes placeholder**: Other sessions targeting this session via intercom will see `"Intent not defined - architect"` as the targetable name on the first turn. This is an improvement over the current behavior where they see just `"architect"` or `"(unnamed session)"`, but it's still not ideal. After title generation (~2s), the name resolves.

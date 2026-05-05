# session-identity Specification

## Purpose
TBD - created by archiving change fix-session-identity-and-packaging. Update Purpose after archive.
## Requirements
### Requirement: Canonical session identity format

The session identity string — used for the title bar (via `pi.setSessionName`), the footer status bar (via `ctx.ui.setStatus`), and the intercom addendum (via `pi.getSessionName`) — SHALL follow the format `<intent> - <role>` where:
- `intent` is the generated session-intent summary, or the sentinel `"Intent not defined"` when no intent has been generated yet.
- `role` is the active role's `name` field.
- The separator is a single ASCII hyphen surrounded by single spaces (` - `).

#### Scenario: Footer before first user message
- **WHEN** a session starts with role `architect` and no intent has been generated
- **THEN** the footer status shows `"Intent not defined - architect"`

#### Scenario: Footer after title generation
- **WHEN** a session starts with role `architect` and title generation produces intent `"Design auth schema"`
- **THEN** the footer status shows `"Design auth schema - architect"`

#### Scenario: Session name before first user message
- **WHEN** a session starts with role `planner` and no intent has been generated
- **THEN** `pi.setSessionName` is called with `"Intent not defined - planner"`

#### Scenario: Session name after title generation
- **WHEN** a session starts with role `planner` and title generation produces intent `"Plan database migration"`
- **THEN** `pi.setSessionName` is called with `"Plan database migration - planner"`

#### Scenario: Mid-session role swap preserves intent
- **WHEN** the active role is `architect` with intent `"Design auth schema"` and the user runs `/role planner`
- **THEN** `pi.setSessionName` is called with `"Design auth schema - planner"` (intent carried forward, role swapped)

#### Scenario: Intercom addendum receives stable identity from first turn
- **WHEN** `composeSystemPrompt` runs on the first turn of a session with role `architect` and intercom mode `both`
- **THEN** the intercom addendum embeds the session name `"Intent not defined - architect"` (never `"architect"` alone, never `"(unnamed session)"`)

---

### Requirement: Footer refreshes synchronously with session name after title generation

When `generateAndApplyTitle` successfully generates an intent, it SHALL update both `pi.setSessionName` and `ctx.ui.setStatus` so the footer reflects the new intent immediately, without waiting for the next `before_agent_start` cycle.

#### Scenario: Footer updates after title generation
- **WHEN** the first user message is `"fix the login bug"` and title generation completes with intent `"Fix login bug"`
- **THEN** both `pi.setSessionName("Fix login bug - architect")` and `ctx.ui.setStatus(STATUS_KEY, "Fix login bug - architect")` are called before `generateAndApplyTitle` returns

---

### Requirement: Intent placeholder is a single defined constant

The sentinel string for an absent intent SHALL be defined as a single exported constant (`INTENT_PLACEHOLDER`) with value `"Intent not defined"`. Both `composeSessionName` and `composeFooterStatus` SHALL reference this constant.

#### Scenario: Placeholder is consistent across helpers
- **WHEN** `composeSessionName("architect", undefined)` and `composeFooterStatus("architect", undefined)` are called
- **THEN** both return `"Intent not defined - architect"` (identical output)

---

### Requirement: composeFooterStatus helper

A new exported function `composeFooterStatus(roleName: string, intent: string | undefined): string` SHALL return the canonical `<intent> - <role>` string, using `INTENT_PLACEHOLDER` when intent is empty or whitespace-only.

#### Scenario: Footer status with undefined intent
- **WHEN** `composeFooterStatus("architect", undefined)` is called
- **THEN** it returns `"Intent not defined - architect"`

#### Scenario: Footer status with empty string intent
- **WHEN** `composeFooterStatus("architect", "")` is called
- **THEN** it returns `"Intent not defined - architect"`

#### Scenario: Footer status with whitespace-only intent
- **WHEN** `composeFooterStatus("architect", "   ")` is called
- **THEN** it returns `"Intent not defined - architect"`

#### Scenario: Footer status with real intent
- **WHEN** `composeFooterStatus("architect", "Design widget")` is called
- **THEN** it returns `"Design widget - architect"`


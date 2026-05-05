# Project conventions

This file is auto-loaded by Pi at session start. It applies to every role (Architect, Planner, Orchestrator) and to every sub-agent (coders, reviewer). Role-specific instructions live in the role's `SYSTEM.md` (sessions) or in the agent's frontmatter file (sub-agents). Conventions below are shared.

## Repository layout

```
ARCHITECTURE.md                       # Cross-cutting concerns (infra, deployment, shared auth)
openspec/
  specs/<capability>/spec.md          # Canonical, current capability specs
  changes/<change-id>/
    proposal.md                       # Why + What changes + Impact
    design.md                         # (optional) Technical decisions
    tasks.md                          # Checklist mirroring bd issues
    specs/<capability>/spec.md        # Spec deltas (ADDED/MODIFIED/REMOVED)
modules/<module>/                     # Code modules. No architecture docs here — specs live in openspec/.
.beads/                               # Beads database (Dolt)
.pi/
  agents/<name>.md                    # pi-subagents definitions (coder-senior, coder-junior, reviewer)
```

## Spec-driven workflow

1. **Architect** creates `openspec/changes/<id>/` (proposal + spec deltas), validates with `openspec validate <id> --strict`, comments `[ARCH→PLANNER]` on a `bd` epic.
2. **Planner** reads the change, decomposes into `bd` tasks, mirrors them in `tasks.md`, wires dependencies.
3. **Orchestrator** pulls ready `bd` tasks, dispatches to coder sub-agents, gates through reviewer, commits, merges.
4. **Architect** archives the change (`openspec archive <id>`) when all tasks are merged. Spec deltas move into `openspec/specs/`.

## Beads conventions

- **Issue types**: `epic` (one per OpenSpec change), `task` (planner-decomposed), `chore` (discovered during execution), `bug` (defect), `feature` (rare — usually wrapped in an epic).
- **Priority**: 0 critical / 1 high / 2 default / 3 cleanup / 4 backlog.
- **Status flow**: `open` → `in_progress` (set by Orchestrator on dispatch) → `closed` (set by Orchestrator after merge). `open` can also mean "blocked on escalation" — check comments.
- **Dependencies**: `parent-child` for epic/task hierarchy. `blocks` for hard ordering. `discovered-from` to link a chore back to the task that surfaced it.

## Escalation tags

All escalations are `bd` comments with one of these tags as the first token. Greppable by design.

| Tag | From → To | Used when |
|---|---|---|
| `[ARCH→PLANNER]` | Architect → Planner | New or updated proposal ready to plan |
| `[PLAN→ORCH]` | Planner → Orchestrator | Optional flag on a task (time-sensitive, watch out for X) |
| `[ESCALATE→PLANNER]` | Orchestrator → Planner | Task envelope wrong, coder blocked twice, review failed thrice, semantic merge conflict |
| `[ESCALATE→ARCHITECT]` | Planner → Architect | Spec is silent/contradictory on a load-bearing decision |
| `[ORCH→ARCH]` | Orchestrator → Architect | Epic complete, ready to archive |

The Orchestrator never escalates directly to the Architect on substance — it goes through the Planner.

## Roles and what each can / cannot do

| Role | Codes? | Modifies specs? | Modifies tasks? | Commits? |
|---|---|---|---|---|
| Architect | No | Yes (openspec/, ARCHITECTURE.md) | No (only comments on epic) | No |
| Planner | No | No | Yes (creates bd tasks, tasks.md only) | No |
| Orchestrator | No | No | No (only comments) | Yes (after review) |
| Coder (senior/junior) | Yes | No | No | No |
| Reviewer | No | No | No | No |

## Style

- Lean files, cross-references over duplication.
- Solo-operator scale: avoid premature complexity, but don't trade away security or testability for speed.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

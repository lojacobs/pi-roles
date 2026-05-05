/**
 * Phase 5 — session-name intent generation.
 *
 * The session name is composed as `<intent> - <role>` with hyphen. Role-name handling
 * lives in apply.ts (`composeSessionName`); this module is responsible for
 * the *intent* half — a 5–10 word summary of what the user is trying to
 * accomplish, generated from the first user message of a session.
 *
 * Trigger: `before_agent_start` in index.ts fires this off (fire-and-forget)
 * whenever `state.intent` is empty and a prompt is present. We don't block
 * the agent loop on title generation — Pi's `before_agent_start` handler
 * returns the role body immediately while we summarize asynchronously and
 * update the session name out-of-band.
 *
 * Why not generate eagerly on `applyRole`? Because we don't have a user
 * message yet at apply time. The first prompt is what reveals intent, and
 * Pi only surfaces it via the BeforeAgentStartEvent. Until that fires, the
 * session name shows `<intent> - <role>` via INTENT_PLACEHOLDER.
 *
 * Why fire-and-forget rather than blocking? Title generation hits a (cheap)
 * model and adds noticeable latency to the first turn. Blocking would mean
 * the user waits on a non-essential cosmetic step before the actual agent
 * starts working. Worse: a slow/failing title model would turn into a hang.
 *
 * Side effects on success:
 *   1. `state.intent` set to the generated text (preserved across role swaps
 *      via index.ts → apply.ts `preservedIntent` plumbing).
 *   2. `pi.setSessionName(composeSessionName(intent, roleName))` — yields
 *      `<intent> - <role>` — so pi-intercom session targeting and the TUI
 *      title bar reflect what the user actually wants.
 *   3. `pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, ...)` so a `/reload` or resume
 *      restores the title without re-summarizing.
 *
 * Concurrency: a `titleInFlight` flag prevents duplicate calls when
 * `before_agent_start` fires repeatedly before the first generation
 * resolves. Race tolerance is intentionally lax — if a `--reset` happens
 * mid-flight, we may apply a stale intent for one prompt before the user's
 * next message regenerates. That's preferable to the complexity of a
 * generation-token cancellation scheme.
 */

import { complete, type AssistantMessage, type Context, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { composeFooterStatus, composeSessionName, findModelInRegistry } from "./apply.ts";
import { debugLog } from "./debug.ts";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  STATUS_KEY,
  type ActiveRoleState,
  type ResolvedRole,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * System prompt for the title model. Intentionally directive: examples
 * matter more than rules for small models, and the format constraints
 * (no quotes, no trailing punctuation, no prefix) are exactly the things
 * we sanitize away in `extractTitle` if the model disobeys.
 */
export const TITLE_SYSTEM_PROMPT = [
  "You generate a short session title from the user's first message in a chat session.",
  "",
  "Rules:",
  "- 5 to 10 words. Capture the user's intent — what they want done.",
  "- Use noun phrases or short imperatives.",
  "- No quotes. No prefixes like \"Title:\". No trailing punctuation. No newlines.",
  "- Be specific. Prefer \"Debug websocket reconnect bug\" over \"Debug a bug\".",
  "- Output ONLY the title text. No explanation.",
].join("\n");

/** Hard cap. The model is asked for ≤10 words; we enforce it on output. */
const MAX_WORDS = 10;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Sanitize raw model output into a clean intent string.
 *
 * Steps, in order:
 *   1. Trim and take the first non-empty line. Some models occasionally
 *      emit a title plus an explanation; we keep only the title.
 *   2. Strip wrapping quotes. Includes straight (`"`, `'`), smart (`“ ”`,
 *      `‘ ’`), and backticks. Common LLM tic.
 *   3. Strip trailing terminal punctuation (`. ! ? , ;`). Mirrors the rule
 *      we gave the model.
 *   4. Collapse internal whitespace runs to single spaces.
 *   5. Truncate to MAX_WORDS and re-strip trailing punctuation in case the
 *      truncation cut mid-clause.
 *
 * Returns "" for empty input. Callers must check before persisting — when
 * intent is empty, composeSessionName uses INTENT_PLACEHOLDER, leaving the
 * session name as `<intent> - <role>`.
 */
export function extractTitle(raw: string): string {
  if (!raw) return "";
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return "";
  let s = firstLine.trim();

  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["`", "`"],
  ];
  for (const [open, close] of quotePairs) {
    if (s.length > open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length).trim();
      break;
    }
  }

  s = s.replace(/[.!?,;]+$/u, "").trim();
  s = s.replace(/\s+/g, " ");

  const words = s.split(" ");
  if (words.length > MAX_WORDS) {
    s = words.slice(0, MAX_WORDS).join(" ");
    s = s.replace(/[.!?,;]+$/u, "").trim();
  }

  return s;
}

/**
 * Pull text out of an AssistantMessage and feed it through `extractTitle`.
 * `complete()` returns content blocks of mixed types — text, thinking, and
 * tool calls. We only want plain text; thinking blocks are model-internal
 * scratch space and tool calls shouldn't appear here (we provide no tools)
 * but we filter defensively in case a future model emits one anyway.
 */
export function extractTitleFromMessage(message: AssistantMessage): string {
  const text = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ");
  return extractTitle(text);
}

/**
 * Pick the model used to summarize. Precedence:
 *   1. `settings.titleModel` if set AND resolvable in the registry.
 *   2. The session's current model (`ctx.model`).
 *
 * We deliberately fall back rather than failing — title generation is best
 * effort. A typo in `titleModel` shouldn't disable titles entirely; it
 * should just degrade to using whatever the user is already paying for.
 *
 * The current model may itself be undefined if Pi hasn't bound one yet
 * (race during startup); in that case we return undefined and the caller
 * skips title generation for this turn.
 *
 * Note that the user-facing `ExtensionContext` exposes the current model
 * as a `model` property — not the `getModel()` method that lives on the
 * internal `ExtensionContextActions` interface.
 */
export function resolveTitleModel(
  ctx: Pick<ExtensionContext, "modelRegistry" | "model">,
  configured: string | undefined,
): Model<any> | undefined {
  if (configured && configured.length > 0) {
    const lookup = findModelInRegistry(ctx.modelRegistry, configured);
    if (lookup.model) return lookup.model;
  }
  return ctx.model;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Mutable state slice the orchestrator reads and writes. Keeps the dependency
 * on `RuntimeState` (defined in index.ts) loose — title.ts shouldn't import
 * from index.ts because index.ts imports title.ts.
 */
export interface TitleStateRef {
  intent: string | undefined;
  titleInFlight: boolean;
  activeRole: ResolvedRole | null;
}

export interface TitleArgs {
  /** First (or current) user message — typically `event.prompt` from `before_agent_start`. */
  prompt: string;
  /** Reference into the runtime state object owned by index.ts. */
  state: TitleStateRef;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** From `settings.titleModel`. */
  configuredTitleModel: string | undefined;
  /**
   * Test seam. Defaults to `complete` from `@mariozechner/pi-ai`. Tests pass
   * a fake to avoid hitting a real model; production callers leave it unset.
   */
  completeFn?: (model: Model<any>, context: Context) => Promise<AssistantMessage>;
}

/**
 * Generate an intent summary from a user prompt and apply it to the live
 * session. Designed to be called fire-and-forget (`void generateAndApplyTitle(...)`).
 *
 * Guards (in order, return early):
 *   - `state.intent` already set → nothing to do.
 *   - `state.titleInFlight` → another invocation is already running.
 *   - `state.activeRole` is null → no role to attach the intent to.
 *   - `prompt` is empty/whitespace → nothing to summarize.
 *   - No model resolvable → can't generate.
 *
 * On success, mutates state and writes through to Pi:
 *   - state.intent = <generated>
 *   - pi.setSessionName(composeSessionName(intent, roleName)) — results in
 *     `<intent> - <role>` in the TUI
 *   - pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, { ...current, intent })
 *
 * On error, swallows. The next `before_agent_start` will retry because
 * `state.intent` is still empty.
 */
export async function generateAndApplyTitle(args: TitleArgs): Promise<void> {
  const { prompt, state, pi, ctx, configuredTitleModel } = args;
  const completeFn = args.completeFn ?? complete;

  if (state.intent) return;
  if (state.titleInFlight) return;
  if (!state.activeRole) return;
  const trimmed = prompt.trim();
  if (!trimmed) return;

  const model = resolveTitleModel(ctx, configuredTitleModel);
  if (!model) return;

  state.titleInFlight = true;
  try {
    const message = await completeFn(model, {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: trimmed, timestamp: Date.now() }],
    });
    const intent = extractTitleFromMessage(message);
    if (!intent) return;

    // Re-check after the await: another path (e.g. a synchronous /role
    // swap) may have set intent or cleared the active role. Don't clobber.
    if (state.intent) return;
    if (!state.activeRole) return;

    state.intent = intent;
    pi.setSessionName(composeSessionName(intent, state.activeRole.name));
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, composeFooterStatus(state.activeRole.name, intent));
    }
    const persisted: ActiveRoleState = {
      name: state.activeRole.name,
      source: state.activeRole.source,
      path: state.activeRole.path,
      intent,
      appliedAt: Date.now(),
    };
    pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, persisted);
  } catch (err) {
    debugLog("title", "generateAndApplyTitle failed", err instanceof Error ? err.message : String(err));
  } finally {
    state.titleInFlight = false;
  }
}

/**
 * Phase 5 tests for src/title.ts.
 *
 * Covers:
 *   - `extractTitle` (pure): trimming, quote-stripping, punctuation removal,
 *     whitespace collapse, word-count truncation, multi-line handling.
 *   - `extractTitleFromMessage`: text-block extraction, mixed-content
 *     filtering.
 *   - `resolveTitleModel`: configured-vs-fallback precedence.
 *   - `generateAndApplyTitle`: every guard short-circuits correctly; success
 *     path mutates state + writes through to Pi; error path is swallowed and
 *     resets the in-flight flag for retry.
 *
 * The LLM call is mocked via the `completeFn` test seam — we never hit a
 * real model.
 */

import { describe, expect, it, vi } from "vitest";
import {
  TITLE_SYSTEM_PROMPT,
  extractTitle,
  extractTitleFromMessage,
  generateAndApplyTitle,
  resolveTitleModel,
  type TitleStateRef,
} from "../src/title.ts";
import { ACTIVE_ROLE_ENTRY_TYPE, type ResolvedRole } from "../src/schemas.ts";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Context, Model } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe("extractTitle", () => {
  it("returns empty string for empty input", () => {
    expect(extractTitle("")).toBe("");
    expect(extractTitle("   ")).toBe("");
    expect(extractTitle("\n\n")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(extractTitle("  hello world  ")).toBe("hello world");
  });

  it("strips wrapping straight double quotes", () => {
    expect(extractTitle('"refactor login flow"')).toBe("refactor login flow");
  });

  it("strips wrapping single quotes", () => {
    expect(extractTitle("'refactor login flow'")).toBe("refactor login flow");
  });

  it("strips wrapping smart quotes", () => {
    expect(extractTitle("“refactor login flow”")).toBe("refactor login flow");
  });

  it("strips wrapping backticks", () => {
    expect(extractTitle("`refactor login flow`")).toBe("refactor login flow");
  });

  it("does not strip non-matching quote pairs", () => {
    expect(extractTitle("\"refactor login flow'")).toBe("\"refactor login flow'");
  });

  it("strips trailing terminal punctuation", () => {
    expect(extractTitle("refactor login flow.")).toBe("refactor login flow");
    expect(extractTitle("refactor login flow!")).toBe("refactor login flow");
    expect(extractTitle("refactor login flow?")).toBe("refactor login flow");
    expect(extractTitle("refactor login flow,")).toBe("refactor login flow");
    expect(extractTitle("refactor login flow;")).toBe("refactor login flow");
    expect(extractTitle("refactor login flow...")).toBe("refactor login flow");
  });

  it("collapses internal whitespace", () => {
    expect(extractTitle("refactor   the   login    flow")).toBe("refactor the login flow");
    expect(extractTitle("refactor\tthe\tlogin\tflow")).toBe("refactor the login flow");
  });

  it("truncates to 10 words", () => {
    const long = "a b c d e f g h i j k l m";
    expect(extractTitle(long)).toBe("a b c d e f g h i j");
  });

  it("re-strips punctuation after word truncation", () => {
    const long = "design new onboarding flow, after we lock down auth changes";
    // 10 words: "design new onboarding flow, after we lock down auth changes"
    // First 10 words have no trailing punct, but we want to ensure cleanup
    // works if truncation lands just before a punctuation token.
    expect(extractTitle(long)).toBe("design new onboarding flow, after we lock down auth changes");
  });

  it("re-strips punctuation when truncation lands on a terminal mark", () => {
    // Input has 10 visible words plus a trailing period the model accidentally
    // included after the 10th. After splitting and slicing we get exactly the
    // 10 words; the trailing period clean-up should remove it.
    const long = "design new onboarding flow after we lock down auth changes. and more";
    expect(extractTitle(long)).toBe("design new onboarding flow after we lock down auth changes");
  });

  it("takes first non-empty line of multi-line input", () => {
    expect(extractTitle("refactor login flow\n\nbecause cookies are bad")).toBe(
      "refactor login flow",
    );
  });

  it("preserves em-dashes (used in the session-name composition)", () => {
    // Unlikely in titles, but if a model emits one we should not destroy it.
    expect(extractTitle("ship roles — phase 5")).toBe("ship roles — phase 5");
  });

  it("strips quotes then trailing punct in the same pass", () => {
    expect(extractTitle('"refactor login flow."')).toBe("refactor login flow");
  });

  it("leaves leading punctuation alone (rare, but honest)", () => {
    // Trailing only — leading is the model's choice.
    expect(extractTitle("- refactor login flow")).toBe("- refactor login flow");
  });
});

// ---------------------------------------------------------------------------
// extractTitleFromMessage
// ---------------------------------------------------------------------------

describe("extractTitleFromMessage", () => {
  function makeMessage(content: AssistantMessage["content"]): AssistantMessage {
    return {
      role: "assistant",
      content,
      api: {} as any,
      provider: {} as any,
      model: "fake",
      usage: {} as any,
      stopReason: "stop",
      timestamp: 0,
    };
  }

  it("extracts title from a single text block", () => {
    expect(
      extractTitleFromMessage(makeMessage([{ type: "text", text: "refactor login" }])),
    ).toBe("refactor login");
  });

  it("joins multiple text blocks with a space", () => {
    expect(
      extractTitleFromMessage(
        makeMessage([
          { type: "text", text: "refactor" },
          { type: "text", text: "login flow" },
        ]),
      ),
    ).toBe("refactor login flow");
  });

  it("ignores thinking and tool blocks", () => {
    expect(
      extractTitleFromMessage(
        makeMessage([
          { type: "thinking", thinking: "let me think...", thinkingSignature: "" } as any,
          { type: "text", text: "refactor login" },
          { type: "toolCall", id: "x", name: "y", arguments: {} } as any,
        ]),
      ),
    ).toBe("refactor login");
  });

  it("returns empty string if message has no text blocks", () => {
    expect(extractTitleFromMessage(makeMessage([]))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveTitleModel
// ---------------------------------------------------------------------------

describe("resolveTitleModel", () => {
  function makeCtxWith(
    models: { provider: string; id: string }[],
    currentModel: Model<any> | undefined,
  ): Pick<ExtensionContext, "modelRegistry" | "model"> {
    return {
      modelRegistry: {
        find: vi.fn((provider: string, id: string) =>
          models.find((m) => m.provider === provider && m.id === id),
        ),
        getAll: vi.fn(() => models),
      } as unknown as ExtensionContext["modelRegistry"],
      model: currentModel,
    };
  }

  it("returns configured model when present in registry", () => {
    const ctx = makeCtxWith([{ provider: "anthropic", id: "claude-haiku" }], undefined);
    expect(resolveTitleModel(ctx, "anthropic/claude-haiku")).toMatchObject({
      provider: "anthropic",
      id: "claude-haiku",
    });
  });

  it("falls back to current model when configured model is missing", () => {
    const current = { provider: "openai", id: "gpt-x" } as unknown as Model<any>;
    const ctx = makeCtxWith([], current);
    expect(resolveTitleModel(ctx, "anthropic/missing")).toBe(current);
  });

  it("uses current model when configured is empty/undefined", () => {
    const current = { provider: "openai", id: "gpt-x" } as unknown as Model<any>;
    const ctx = makeCtxWith([], current);
    expect(resolveTitleModel(ctx, undefined)).toBe(current);
    expect(resolveTitleModel(ctx, "")).toBe(current);
  });

  it("returns undefined when nothing is resolvable", () => {
    const ctx = makeCtxWith([], undefined);
    expect(resolveTitleModel(ctx, undefined)).toBeUndefined();
    expect(resolveTitleModel(ctx, "anthropic/missing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateAndApplyTitle
// ---------------------------------------------------------------------------

describe("generateAndApplyTitle", () => {
  function makeRole(overrides: Partial<ResolvedRole> = {}): ResolvedRole {
    return {
      name: "architect",
      description: "An architect.",
      body: "body",
      source: "project",
      path: "/v/architect.md",
      extendsChain: ["architect"],
      tools: { kind: "inherit" },
      ...overrides,
    };
  }

  function makeState(overrides: Partial<TitleStateRef> = {}): TitleStateRef {
    return {
      intent: undefined,
      titleInFlight: false,
      activeRole: makeRole(),
      ...overrides,
    };
  }

  function makePi(): {
    pi: ExtensionAPI;
    setSessionName: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
  } {
    const setSessionName = vi.fn();
    const appendEntry = vi.fn();
    const pi = { setSessionName, appendEntry } as unknown as ExtensionAPI;
    return { pi, setSessionName, appendEntry };
  }

  function makeCtx(opts: { currentModel?: Model<any> | undefined } = {}): ExtensionContext {
    // Use `'in'` so that an explicit `currentModel: undefined` actually means
    // "no current model" rather than falling through to the default.
    const fakeModel = { provider: "p", id: "m" } as unknown as Model<any>;
    const resolved = "currentModel" in opts ? opts.currentModel : fakeModel;
    return {
      modelRegistry: {
        find: vi.fn(() => undefined),
        getAll: vi.fn(() => []),
      },
      model: resolved,
    } as unknown as ExtensionContext;
  }

  function makeAssistantMessage(text: string): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: {} as any,
      provider: {} as any,
      model: "fake",
      usage: {} as any,
      stopReason: "stop",
      timestamp: 0,
    };
  }

  it("happy path: sets state.intent, calls setSessionName, persists via appendEntry", async () => {
    const state = makeState();
    const { pi, setSessionName, appendEntry } = makePi();
    const completeFn = vi.fn(async () => makeAssistantMessage("Refactor login flow"));

    await generateAndApplyTitle({
      prompt: "I need to refactor my broken login flow with cookies",
      state,
      pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });

    expect(state.intent).toBe("Refactor login flow");
    expect(state.titleInFlight).toBe(false);
    expect(setSessionName).toHaveBeenCalledWith("architect — Refactor login flow");
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(
      ACTIVE_ROLE_ENTRY_TYPE,
      expect.objectContaining({
        name: "architect",
        source: "project",
        path: "/v/architect.md",
        intent: "Refactor login flow",
      }),
    );
  });

  it("forwards system prompt + user message to the LLM", async () => {
    const completeFn = vi.fn(
      async (_m: Model<any>, _c: Context) => makeAssistantMessage("title"),
    );
    await generateAndApplyTitle({
      prompt: "  do the thing  ",
      state: makeState(),
      pi: makePi().pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    const [, ctxArg] = completeFn.mock.calls[0]!;
    expect(ctxArg.systemPrompt).toBe(TITLE_SYSTEM_PROMPT);
    expect(ctxArg.messages).toHaveLength(1);
    expect(ctxArg.messages[0]).toMatchObject({ role: "user", content: "do the thing" });
  });

  it("guard: skips when intent is already set", async () => {
    const state = makeState({ intent: "existing intent" });
    const completeFn = vi.fn();
    const { pi, setSessionName, appendEntry } = makePi();
    await generateAndApplyTitle({
      prompt: "anything",
      state,
      pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(completeFn).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(state.intent).toBe("existing intent");
  });

  it("guard: skips when titleInFlight is true", async () => {
    const state = makeState({ titleInFlight: true });
    const completeFn = vi.fn();
    await generateAndApplyTitle({
      prompt: "anything",
      state,
      pi: makePi().pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(completeFn).not.toHaveBeenCalled();
    // We didn't enter the try block, so titleInFlight stays true (caller's
    // contract: they own resetting it if they set it externally).
    expect(state.titleInFlight).toBe(true);
  });

  it("guard: skips when activeRole is null", async () => {
    const state = makeState({ activeRole: null });
    const completeFn = vi.fn();
    await generateAndApplyTitle({
      prompt: "anything",
      state,
      pi: makePi().pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(completeFn).not.toHaveBeenCalled();
    expect(state.intent).toBeUndefined();
  });

  it("guard: skips when prompt is empty/whitespace", async () => {
    const completeFn = vi.fn();
    const args = (prompt: string) => ({
      prompt,
      state: makeState(),
      pi: makePi().pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    await generateAndApplyTitle(args(""));
    await generateAndApplyTitle(args("   "));
    await generateAndApplyTitle(args("\n\t"));
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("guard: skips when no model is resolvable", async () => {
    const completeFn = vi.fn();
    const { pi, setSessionName, appendEntry } = makePi();
    const state = makeState();
    await generateAndApplyTitle({
      prompt: "do the thing",
      state,
      pi,
      ctx: makeCtx({ currentModel: undefined }),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(completeFn).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
    // titleInFlight should never have flipped.
    expect(state.titleInFlight).toBe(false);
  });

  it("LLM returns empty title → state untouched, in-flight reset", async () => {
    const state = makeState();
    const { pi, setSessionName, appendEntry } = makePi();
    const completeFn = vi.fn(async () => makeAssistantMessage("   "));
    await generateAndApplyTitle({
      prompt: "do the thing",
      state,
      pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(state.intent).toBeUndefined();
    expect(state.titleInFlight).toBe(false);
    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("LLM throws → swallowed, state untouched, in-flight reset", async () => {
    const state = makeState();
    const { pi, setSessionName, appendEntry } = makePi();
    const completeFn = vi.fn(async () => {
      throw new Error("API down");
    });
    await expect(
      generateAndApplyTitle({
        prompt: "do the thing",
        state,
        pi,
        ctx: makeCtx(),
        configuredTitleModel: undefined,
        completeFn,
      }),
    ).resolves.toBeUndefined();
    expect(state.intent).toBeUndefined();
    expect(state.titleInFlight).toBe(false);
    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("sets titleInFlight=true during the LLM call", async () => {
    const state = makeState();
    let observed: boolean | undefined;
    const completeFn = vi.fn(async () => {
      observed = state.titleInFlight;
      return makeAssistantMessage("something");
    });
    await generateAndApplyTitle({
      prompt: "do the thing",
      state,
      pi: makePi().pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(observed).toBe(true);
    expect(state.titleInFlight).toBe(false);
  });

  it("race: if state.intent gets set during the LLM call, doesn't clobber", async () => {
    const state = makeState();
    const { pi, setSessionName, appendEntry } = makePi();
    const completeFn = vi.fn(async () => {
      // Simulate another path setting intent while we're awaiting.
      state.intent = "external intent";
      return makeAssistantMessage("our intent");
    });
    await generateAndApplyTitle({
      prompt: "do the thing",
      state,
      pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(state.intent).toBe("external intent");
    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("race: if activeRole gets cleared during the LLM call, skip", async () => {
    const state = makeState();
    const { pi, setSessionName, appendEntry } = makePi();
    const completeFn = vi.fn(async () => {
      state.activeRole = null;
      return makeAssistantMessage("an intent");
    });
    await generateAndApplyTitle({
      prompt: "do the thing",
      state,
      pi,
      ctx: makeCtx(),
      configuredTitleModel: undefined,
      completeFn,
    });
    expect(state.intent).toBeUndefined();
    expect(setSessionName).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("uses configured title model when resolvable", async () => {
    const titleModel = { provider: "anthropic", id: "claude-haiku" } as unknown as Model<any>;
    const ctx = {
      modelRegistry: {
        find: vi.fn((p: string, id: string) =>
          p === "anthropic" && id === "claude-haiku" ? titleModel : undefined,
        ),
        getAll: vi.fn(() => [titleModel]),
      },
    } as unknown as ExtensionContext;
    const completeFn = vi.fn(
      async (_m: Model<any>, _c: Context) => makeAssistantMessage("title"),
    );
    await generateAndApplyTitle({
      prompt: "do the thing",
      state: makeState(),
      pi: makePi().pi,
      ctx,
      configuredTitleModel: "anthropic/claude-haiku",
      completeFn,
    });
    expect(completeFn).toHaveBeenCalledTimes(1);
    expect(completeFn.mock.calls[0]![0]).toBe(titleModel);
  });
});

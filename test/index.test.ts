/**
 * Phase 4 tests for src/index.ts.
 *
 * Most of index.ts is integration glue around Pi events that's only worth
 * testing end-to-end. The pieces with non-trivial logic — role-name
 * precedence and the autocompletion provider — are exported and tested
 * here directly.
 */

import { describe, expect, it } from "vitest";
import { composeSystemPrompt, pickInitialRoleName, roleCompletions } from "../src/index.ts";
import { parseRoleSource, resolveRole } from "../src/roles.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiRolesSettings, RawRole, ResolvedRole } from "../src/schemas.ts";
import { INTERCOM_TOOL_NAME } from "../src/intercom.ts";

function makePi(flags: Record<string, string | boolean | undefined> = {}): ExtensionAPI {
  return {
    getFlag: (name: string) => flags[name],
  } as unknown as ExtensionAPI;
}

function makeRole(name: string, description = "test"): RawRole {
  return parseRoleSource(
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    `/v/${name}.md`,
    "project",
  );
}

const ENV_BACKUP = process.env.PI_ROLE;
function withEnv(value: string | undefined, fn: () => void): void {
  if (value === undefined) delete process.env.PI_ROLE;
  else process.env.PI_ROLE = value;
  try {
    fn();
  } finally {
    if (ENV_BACKUP === undefined) delete process.env.PI_ROLE;
    else process.env.PI_ROLE = ENV_BACKUP;
  }
}

// ---------------------------------------------------------------------------
// pickInitialRoleName
// ---------------------------------------------------------------------------

describe("pickInitialRoleName", () => {
  const roles = [makeRole("architect"), makeRole("planner")];

  it("--role flag wins over env, settings, and built-in", () => {
    withEnv("planner", () => {
      const settings: PiRolesSettings = { defaultRole: "planner" };
      expect(pickInitialRoleName(makePi({ role: "architect" }), settings, roles)).toBe(
        "architect",
      );
    });
  });

  it("PI_ROLE env wins when no flag", () => {
    withEnv("planner", () => {
      const settings: PiRolesSettings = { defaultRole: "architect" };
      expect(pickInitialRoleName(makePi(), settings, roles)).toBe("planner");
    });
  });

  it("settings.defaultRole used when no flag/env", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), { defaultRole: "architect" }, roles)).toBe(
        "architect",
      );
    });
  });

  it("falls back to built-in when defaultRole missing from disk", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), { defaultRole: "ghost" }, roles)).toBe(
        "role-assistant",
      );
    });
  });

  it("falls back to built-in when nothing is set", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), {}, roles)).toBe("role-assistant");
    });
  });

  it("ignores empty flag string", () => {
    withEnv("planner", () => {
      expect(pickInitialRoleName(makePi({ role: "" }), {}, roles)).toBe("planner");
    });
  });
});

// ---------------------------------------------------------------------------
// roleCompletions
// ---------------------------------------------------------------------------

describe("roleCompletions", () => {
  const roles = [
    makeRole("architect", "Designs"),
    makeRole("planner", "Plans"),
    makeRole("orchestrator", "Coordinates"),
  ];

  it("empty prefix returns subcommands + all roles", () => {
    const items = roleCompletions("", roles);
    expect(items).not.toBeNull();
    const values = items!.map((i) => i.value);
    expect(values).toContain("list");
    expect(values).toContain("current");
    expect(values).toContain("reload");
    expect(values).toContain("architect");
    expect(values).toContain("planner");
    expect(values).toContain("orchestrator");
  });

  it("prefix narrows results", () => {
    const items = roleCompletions("arc", roles);
    expect(items?.map((i) => i.value)).toEqual(["architect"]);
  });

  it("prefix matches subcommand", () => {
    const items = roleCompletions("re", roles);
    expect(items?.map((i) => i.value)).toEqual(["reload"]);
  });

  it("case insensitive", () => {
    const items = roleCompletions("ARC", roles);
    expect(items?.map((i) => i.value)).toEqual(["architect"]);
  });

  it("returns null when no match", () => {
    expect(roleCompletions("zzz", roles)).toBeNull();
  });

  it("each item has label and description", () => {
    const items = roleCompletions("a", roles);
    expect(items![0]).toMatchObject({
      value: expect.any(String),
      label: expect.any(String),
      description: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// composeSystemPrompt — replacement contract
// ---------------------------------------------------------------------------

describe("composeSystemPrompt", () => {
  function resolveSingle(name: string, body: string, intercom?: string): ResolvedRole {
    const fm = `---\nname: ${name}\ndescription: x${intercom ? `\nintercom: ${intercom}` : ""}\n---\n${body}`;
    return resolveRole(name, [parseRoleSource(fm, `/v/${name}.md`, "project")]);
  }

  function piWith(toolNames: string[], sessionName?: string): ExtensionAPI {
    return {
      getAllTools: () => toolNames.map((name) => ({ name, description: "", parameters: {} as any, sourceInfo: {} as any })),
      getSessionName: () => sessionName,
    } as unknown as ExtensionAPI;
  }

  it("returns undefined when no active role", () => {
    expect(composeSystemPrompt({ activeRole: null, settings: {} }, piWith([]))).toBeUndefined();
  });

  it("returns role body verbatim, ignoring any upstream system prompt", () => {
    const role = resolveSingle("architect", "You are an architect. Design only.");
    const result = composeSystemPrompt({ activeRole: role, settings: {} }, piWith([]));
    expect(result).toEqual({ systemPrompt: "You are an architect. Design only." });
    // The critical assertion: we didn't compose with Pi's default. There is
    // no path in this function that reads upstream prompt content.
    expect(result?.systemPrompt).not.toMatch(/coding assistant/);
  });

  it("appends intercom addendum when mode!=off and intercom tool is registered", () => {
    const role = resolveSingle("architect", "Body.", "send");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([INTERCOM_TOOL_NAME], "architect"),
    );
    expect(result?.systemPrompt).toMatch(/^Body\.\n\n## intercom/);
    expect(result?.systemPrompt).toContain("architect");
  });

  it("omits addendum when intercom tool is not registered", () => {
    const role = resolveSingle("architect", "Body.", "send");
    const result = composeSystemPrompt({ activeRole: role, settings: {} }, piWith([]));
    expect(result).toEqual({ systemPrompt: "Body." });
  });

  it("omits addendum when intercom mode resolves to off", () => {
    const role = resolveSingle("architect", "Body.");
    const result = composeSystemPrompt(
      { activeRole: role, settings: { intercomMode: "off" } },
      piWith([INTERCOM_TOOL_NAME]),
    );
    expect(result).toEqual({ systemPrompt: "Body." });
  });

  it("global settings.intercomMode applies when role doesn't override", () => {
    const role = resolveSingle("architect", "Body.");
    const result = composeSystemPrompt(
      { activeRole: role, settings: { intercomMode: "both" } },
      piWith([INTERCOM_TOOL_NAME], "architect"),
    );
    expect(result?.systemPrompt).toMatch(/intercom \(both modes\)/);
  });
});

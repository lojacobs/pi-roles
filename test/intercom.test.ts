import { describe, expect, it } from "vitest";
import { intercomPromptAddendum, isIntercomAvailable, INTERCOM_TOOL_NAME } from "../src/intercom.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function piWithTools(names: string[]): ExtensionAPI {
  return {
    getAllTools: () => names.map((name) => ({ name, description: "", parameters: {} as any, sourceInfo: {} as any })),
  } as unknown as ExtensionAPI;
}

describe("isIntercomAvailable", () => {
  it("true when intercom tool is registered", () => {
    expect(isIntercomAvailable(piWithTools(["read", INTERCOM_TOOL_NAME]))).toBe(true);
  });
  it("false otherwise", () => {
    expect(isIntercomAvailable(piWithTools(["read", "write"]))).toBe(false);
  });
});

describe("intercomPromptAddendum", () => {
  it("off → empty string", () => {
    expect(intercomPromptAddendum("off", "any")).toBe("");
  });
  it("receive mentions targetability and session id", () => {
    const out = intercomPromptAddendum("receive", "architect — design");
    expect(out).toMatch(/receive mode/);
    expect(out).toContain("architect — design");
  });
  it("send mentions outbound usage", () => {
    const out = intercomPromptAddendum("send", "planner");
    expect(out).toMatch(/send mode/);
    expect(out).toContain("planner");
  });
  it("both mentions bidirectional", () => {
    const out = intercomPromptAddendum("both", "orch");
    expect(out).toMatch(/both modes/);
    expect(out).toContain("orch");
  });
  it("undefined session id falls back to placeholder", () => {
    const out = intercomPromptAddendum("receive", undefined);
    expect(out).toContain("(unnamed session)");
  });
});

/**
 * Phase 6 tests: the bundled `role-assistant.md` exists, parses, and
 * surfaces in `discoverRoles` results so the fallback path works.
 */

import { describe, expect, it } from "vitest";
import { discoverRoles, findBuiltInAssistant, resolveRole } from "../src/roles.ts";
import { builtInRoleAssistantPath, loadBuiltInRoleAssistant } from "../src/role-assistant.ts";
import { BUILTIN_ROLE_ASSISTANT_NAME } from "../src/schemas.ts";
import { existsSync } from "node:fs";

describe("built-in role-assistant", () => {
  it("file exists at the resolved path", () => {
    expect(existsSync(builtInRoleAssistantPath())).toBe(true);
  });

  it("parses without errors", () => {
    const role = loadBuiltInRoleAssistant();
    expect(role.frontmatter.name).toBe(BUILTIN_ROLE_ASSISTANT_NAME);
    expect(role.frontmatter.description).toBeTruthy();
    expect(role.body.length).toBeGreaterThan(0);
    expect(role.source).toBe("built-in");
  });

  it("has no model/thinking/tools restrictions (fallback inherits everything)", () => {
    const role = loadBuiltInRoleAssistant();
    expect(role.frontmatter.model).toBeUndefined();
    expect(role.frontmatter.thinking).toBeUndefined();
    // tools field absent → inherit (don't restrict the user's available tools)
    expect(role.frontmatter.tools).toBeUndefined();
  });

  it("appears in discoverRoles output as built-in", () => {
    // Use a tmp cwd that has no project .pi/roles so we don't pick up
    // unrelated roles from this dev checkout.
    const result = discoverRoles("/tmp", "user");
    const found = findBuiltInAssistant(result.roles);
    expect(found).toBeDefined();
    expect(found!.source).toBe("built-in");
  });

  it("resolveRole on the built-in returns a usable ResolvedRole", () => {
    const result = discoverRoles("/tmp", "user");
    const resolved = resolveRole(BUILTIN_ROLE_ASSISTANT_NAME, result.roles);
    expect(resolved.name).toBe(BUILTIN_ROLE_ASSISTANT_NAME);
    expect(resolved.body.length).toBeGreaterThan(0);
    expect(resolved.tools).toEqual({ kind: "inherit" });
  });
});

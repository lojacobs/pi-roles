/**
 * Phase 8 sanity tests: the bundled example role files parse, validate, and
 * (for orchestrator) resolve their `extends` chain end-to-end.
 *
 * These guard against the README drifting from a broken example — if either
 * file breaks the parser, this test fails before the docs go out the door.
 */

import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoleFile, resolveRole } from "../src/roles.ts";

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples");

describe("examples", () => {
  it("architect.md parses with expected fields", () => {
    const r = loadRoleFile(resolve(examplesDir, "architect.md"), "project");
    expect(r.frontmatter.name).toBe("architect");
    expect(r.frontmatter.model).toBe("anthropic/claude-opus-4-7");
    expect(r.frontmatter.thinking).toBe("high");
    expect(r.frontmatter.tools).toBeUndefined(); // inherits
    expect(r.frontmatter.extends).toBeUndefined();
    expect(r.body.length).toBeGreaterThan(0);
  });

  it("orchestrator.md parses with full feature surface", () => {
    const r = loadRoleFile(resolve(examplesDir, "orchestrator.md"), "project");
    expect(r.frontmatter.name).toBe("orchestrator");
    expect(r.frontmatter.extends).toBe("architect");
    expect(r.frontmatter.tools).toContain("mcp:fs");
    expect(r.frontmatter.tools).toContain("mcp:github");
    expect(r.frontmatter.intercom).toBe("both");
  });

  it("orchestrator resolves with architect as parent (body merged, extendsChain populated)", () => {
    const arch = loadRoleFile(resolve(examplesDir, "architect.md"), "project");
    const orch = loadRoleFile(resolve(examplesDir, "orchestrator.md"), "project");
    const resolved = resolveRole("orchestrator", [arch, orch]);
    expect(resolved.extendsChain).toEqual(["orchestrator", "architect"]);
    expect(resolved.body).toContain("architect");
    expect(resolved.body).toContain("orchestrator");
    expect(resolved.tools).toMatchObject({
      kind: "set",
      names: expect.arrayContaining(["read", "mcp:fs", "mcp:github"]),
    });
    expect(resolved.intercom).toBe("both");
  });
});

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { evaluateRules, restrictPermission } from "../src/policy.ts"
import type { Rule } from "../src/types.ts"

const root = process.cwd()
const allow: Rule[] = [{ action: "*", resource: "*", effect: "allow" }]

describe("workflow permission intersection", () => {
  test("protects Git administration from scoped writers even with broad ownership", () => {
    expect(restrictPermission("allow", allow, "implementer", "write", [".git/config"], ["**"], root)).toBe("deny")
    expect(restrictPermission("allow", allow, "implementer", "edit", ["nested/.git"], ["**"], root)).toBe("deny")
  })
  test("evaluates native last-match rules while retaining an explicit default", () => {
    const rules: Rule[] = [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "src/*", effect: "allow" }]
    expect(evaluateRules(rules, "read", "src/a.ts")).toBe("allow")
    expect(evaluateRules(rules, "shell", "echo x")).toBe("deny")
    expect(evaluateRules([], "read", "src/a.ts")).toBe("ask")
    expect(evaluateRules([], "read", "src/a.ts", "deny")).toBe("deny")
  })

  test("never upgrades a native deny or permission wait", () => {
    expect(restrictPermission("deny", allow, "explorer", "read", ["src/a.ts"], undefined, root)).toBe("deny")
    expect(restrictPermission("ask", allow, "explorer", "read", ["src/a.ts"], undefined, root)).toBe("ask")
    expect(restrictPermission("allow", [{ action: "read", resource: "*", effect: "ask" }], "explorer", "read", ["src/a.ts"], undefined, root)).toBe("ask")
    expect(restrictPermission("allow", [{ action: "read", resource: "*", effect: "deny" }], "explorer", "read", ["src/a.ts"], undefined, root)).toBe("deny")
  })

  test("does not translate previous tool permission names", () => {
    const rules: Rule[] = [...allow, { action: "ultra_check", resource: "*", effect: "deny" }, { action: "ultraopencode_check", resource: "*", effect: "deny" }]
    expect(restrictPermission("allow", rules, "verifier", "gigacode_check", ["*"], undefined, root)).toBe("allow")
  })

  test("checks every resource and denies read-only mutations and unknown unsafe actions", () => {
    expect(restrictPermission("allow", allow, "reviewer", "write", ["src/a.ts"], ["**"], root)).toBe("deny")
    expect(restrictPermission("allow", allow, "researcher", "shell", ["echo x"], undefined, root)).toBe("deny")
    expect(restrictPermission("allow", allow, "planner", "dangerous_custom_action", ["*"], undefined, root)).toBe("deny")
    expect(restrictPermission("allow", allow, "implementer", "edit", ["src/a.ts", "README.md"], ["src/**"], root)).toBe("deny")
    expect(restrictPermission("allow", allow, "implementer", "edit", ["src/a.ts"], ["src/**"], root)).toBe("allow")
    expect(restrictPermission("allow", allow, "implementer", "edit", ["src/a.ts"], [], root)).toBe("deny")
  })

  test("applies relative captured path rules to absolute native resources", () => {
    const policy: Rule[] = [...allow, { action: "write", resource: "private/**", effect: "deny" }]
    expect(restrictPermission("allow", policy, "implementer", "write", [join(root, "private", "key.txt")], ["**"], root)).toBe("deny")
    const narrowlyAllowed: Rule[] = [{ action: "write", resource: join(root, "src", "a.ts"), effect: "allow" }]
    expect(restrictPermission("allow", narrowlyAllowed, "implementer", "write", [join(root, "src", "a.ts")], ["src/**"], root)).toBe("allow")
  })

  test("protects scope, metadata, and nested delegation", () => {
    expect(restrictPermission("allow", allow, "implementer", "write", ["../outside.txt"], ["**"], root)).toBe("deny")
    expect(restrictPermission("allow", allow, "implementer", "write", [".gigacode/state.sqlite"], ["**"], root)).toBe("deny")
    expect(restrictPermission("allow", allow, "reviewer", "read", ["../outside.txt"], undefined, root)).toBe("deny")
    expect(restrictPermission("allow", allow, "implementer", "subagent", ["explorer"], undefined, root)).toBe("deny")
    expect(restrictPermission("allow", allow, "supervisor", "subagent", ["explorer"], undefined, root)).toBe("allow")
    expect(restrictPermission("allow", allow, "supervisor", "edit", ["src/a.ts"], ["**"], root)).toBe("deny")
    expect(restrictPermission("allow", allow, "verifier", "shell", ["bun test"], undefined, root)).toBe("allow")
  })

  test("resolves existing symlink parents before allowing a scoped write", () => {
    const fixtures = join(root, ".spike")
    mkdirSync(fixtures, { recursive: true })
    const testRoot = mkdtempSync(join(fixtures, "policy-"))
    const project = join(testRoot, "project")
    const elsewhere = join(testRoot, "elsewhere")
    mkdirSync(project)
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(project, "link"), process.platform === "win32" ? "junction" : "dir")
    expect(restrictPermission("allow", allow, "implementer", "write", ["link/new.txt"], ["**"], project)).toBe("deny")
  })

  test("denies unresolved dangling links while allowing ordinary new project paths", () => {
    const fixtures = join(root, ".spike")
    mkdirSync(fixtures, { recursive: true })
    const testRoot = mkdtempSync(join(fixtures, "policy-dangling-"))
    const project = join(testRoot, "project")
    const elsewhere = join(testRoot, "absent-outside")
    mkdirSync(project)
    symlinkSync(elsewhere, join(project, "link"), process.platform === "win32" ? "junction" : "dir")
    expect(restrictPermission("allow", allow, "implementer", "write", ["link/new.txt"], ["**"], project)).toBe("deny")
    expect(restrictPermission("allow", allow, "implementer", "write", ["new-directory/new.txt"], ["**"], project)).toBe("allow")
    expect(existsSync(elsewhere)).toBe(false)
    expect(existsSync(join(project, "new-directory"))).toBe(false)
  })
})

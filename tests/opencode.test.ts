import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { checkedInput, checkOutcome, visibleTools } from "../src/opencode.ts"

describe("native adapter boundaries", () => {
  test("decodes real native schemas and refuses an unsupported validator", async () => {
    expect(await checkedInput({ name: "probe", input: Schema.Struct({ count: Schema.Number }) } as any, { count: 3 })).toEqual({ count: 3 })
    await expect(checkedInput({ name: "probe", input: Schema.Struct({ count: Schema.Number }) } as any, { count: "3" })).rejects.toThrow()
    await expect(checkedInput({ name: "probe", input: {} } as any, {})).rejects.toThrow("Unsupported")
  })
  test("workers cannot expose raw shell, delegation or codemode escape hatches", () => {
    const tools = Object.fromEntries(["read", "write", "edit", "shell", "execute", "subagent", "ultra_submit", "ultra_check", "ultra_execute", "ultra_start", "third_party"].map(name => [name, {}]))
    expect(Object.keys(visibleTools(tools, "reviewer"))).toEqual(["read", "ultra_submit"])
    expect(Object.keys(visibleTools(tools, "implementer"))).toEqual(["read", "write", "edit", "ultra_submit"])
    expect(Object.keys(visibleTools(tools, "verifier"))).toEqual(["read", "ultra_submit", "ultra_check"])
    expect(Object.keys(visibleTools(tools, "supervisor"))).toEqual(["ultra_execute"])
    expect(visibleTools({ "third_party.read": {}, "third_party.write": {}, "third_party.ultra_execute": {} }, "implementer")).toEqual({})
  })
  test("a model assertion or missing native exit is never a passed check", () => {
    expect(checkOutcome({ exit: 0 })).toBe("passed")
    expect(checkOutcome({ exit: 1 })).toBe("failed")
    expect(checkOutcome({ passed: true })).toBe("unknown")
    expect(checkOutcome({ exit: null })).toBe("unknown")
  })
})

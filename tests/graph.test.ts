import { describe, expect, test } from "bun:test"
import { validatePlan } from "../src/graph.ts"
import { parseConfig } from "../src/config.ts"
import type { Plan, TaskSpec } from "../src/types.ts"

const config = parseConfig({ models: { roles: { planner: "a/base#deep" } } })
const reader = (id: string, dependencies: string[] = []): TaskSpec => ({ id, title: id, role: "explorer", stage: "discovery", instructions: "Inspect relevant code", dependencies, writes: false })
const plan = (): Plan => ({ revision: 1, rationale: "Independent discovery precedes design", criteria: [{ id: "goal", description: "The requested behavior works", required: true, kind: "assessment" }], tasks: [reader("first"), reader("second", ["first"])] })

describe("validated workflow graphs", () => {
  test("accepts a DAG and snapshots the supplied object", () => {
    const input = plan()
    const result = validatePlan(input, "plan", config)
    input.tasks[0]!.instructions = "mutated"
    expect(result.tasks[0]!.instructions).toBe("Inspect relevant code")
  })

  test("rejects cycles, dangling dependencies, duplicate IDs and schema typos", () => {
    const inputs = [
      { ...plan(), tasks: [reader("a", ["b"]), reader("b", ["a"])] },
      { ...plan(), tasks: [reader("a", ["missing"])] },
      { ...plan(), tasks: [reader("a"), reader("a")] },
      { ...plan(), tasks: [{ ...reader("a"), dependency: [] }] },
      { ...plan(), tasks: [reader("a", ["a"])] },
      { ...plan(), revision: 0 },
      { ...plan(), tasks: [reader("a", ["b", "b"]), reader("b")] },
      { ...plan(), criteria: [{ id: "goal", description: "x", required: "yes", kind: "assessment" }] },
    ]
    for (const input of inputs) expect(() => validatePlan(input, "plan", config)).toThrow()
  })

  test("enforces plan-only and role capability boundaries", () => {
    const writer: TaskSpec = { ...reader("writer"), role: "implementer", stage: "implementation", writes: true, ownedPaths: ["src/**"] }
    expect(() => validatePlan({ ...plan(), tasks: [writer] }, "plan", config)).toThrow()
    expect(validatePlan({ ...plan(), tasks: [writer] }, "execute", config).tasks[0]!.writes).toBe(true)
    expect(() => validatePlan({ ...plan(), tasks: [{ ...writer, role: "reviewer" }] }, "execute", config)).toThrow()
    expect(() => validatePlan({ ...plan(), tasks: [{ ...writer, ownedPaths: [] }] }, "execute", config)).toThrow()
    expect(() => validatePlan({ ...plan(), tasks: [{ ...writer, writes: false }] }, "execute", config)).toThrow()
    expect(() => validatePlan({ ...plan(), tasks: [{ ...reader("manager"), role: "supervisor" }] }, "execute", config)).toThrow()
  })

  test("rejects absolute, traversal, and runtime metadata writer paths", () => {
    for (const path of ["../other/**", "/tmp/**", "C:\\outside\\**", "\\\\server\\share", "src/../outside", ".ultracode/**", "~/.ssh/**"]) {
      const task = { ...reader("writer"), role: "implementer", stage: "implementation", writes: true, ownedPaths: [path] }
      expect(() => validatePlan({ ...plan(), tasks: [task] }, "execute", config)).toThrow()
    }
  })

  test("preserves required acceptance criteria across revisions", () => {
    const previous = plan().criteria
    for (const criteria of [[], [{ ...previous[0]!, required: false }], [{ ...previous[0]!, description: "An easier requirement" }], [{ ...previous[0]!, kind: "check" }]]) {
      expect(() => validatePlan({ ...plan(), revision: 2, criteria }, "plan", config, previous)).toThrow()
    }
    expect(validatePlan({ ...plan(), revision: 2 }, "plan", config, previous).revision).toBe(2)
  })

  test("rejects excessive graph work, unconfigured checks, and unauthorized model overrides", () => {
    expect(() => validatePlan(plan(), "plan", parseConfig({ limits: { attempts: 1 } }))).toThrow()
    expect(() => validatePlan({ ...plan(), tasks: [{ ...reader("a"), checkIds: ["invented"] }] }, "execute", config)).toThrow()
    expect(() => validatePlan({ ...plan(), tasks: [{ ...reader("a"), model: "unapproved/model" }] }, "plan", config)).toThrow()
    expect(validatePlan({ ...plan(), tasks: [{ ...reader("a"), model: "a/base#deep" }] }, "plan", config).tasks[0]!.model).toBe("a/base#deep")
    expect(validatePlan({ ...plan(), tasks: [{ ...reader("a"), model: "captured/model" }] }, "plan", config, undefined, ["captured/model"]).tasks[0]!.model).toBe("captured/model")
  })
})

import { describe, expect, test } from "bun:test"
import { validateExecutionCoverage, validatePlan } from "../src/graph.ts"
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
    for (const path of ["../other/**", "/tmp/**", "C:\\outside\\**", "\\\\server\\share", "src/../outside", ".ultraopencode/**", ".ultracode/**", "~/.ssh/**"]) {
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

  test("separate verifier assignments are useful work while reordered identical check assignments are duplicates", () => {
    const checkConfig = parseConfig({ checks: [
      { id: "test", command: "bun test", criterionIds: ["verification"] },
      { id: "lint", command: "bun run lint", criterionIds: ["verification"] },
    ] })
    const writer: TaskSpec = { ...reader("write"), role: "implementer", stage: "implementation", writes: true, ownedPaths: ["src/**"] }
    const verifier = (id: string, checkIds: string[]): TaskSpec => ({ id, title: id, role: "verifier", stage: "verification", instructions: "Run the assigned configured checks against the candidate", dependencies: ["write"], writes: false, checkIds })
    const input: Plan = { ...plan(), criteria: [...plan().criteria, { id: "verification", description: "Native commands establish verification", required: true, kind: "check" }], tasks: [writer, verifier("tests", ["test"]), verifier("lint", ["lint"])] }
    expect(validatePlan(input, "execute", checkConfig).tasks).toHaveLength(3)
    expect(() => validatePlan({ ...input, tasks: [writer, verifier("first", ["test", "lint"]), verifier("second", ["lint", "test"])] }, "execute", checkConfig)).toThrow("duplicate work")
    expect(() => validatePlan({ ...input, tasks: [writer, verifier("first", []), { ...verifier("second", []), checkIds: undefined }] }, "execute", checkConfig)).toThrow("duplicate work")
  })
})

describe("execution coverage admission", () => {
  const machineConfig = parseConfig({ checks: [{ id: "test", command: "bun test", criterionIds: ["verification"] }] })
  const writer = (id = "write", dependencies: string[] = []): TaskSpec => ({ id, title: id, role: "implementer", stage: "implementation", instructions: `Change ${id} behavior and its regression tests`, dependencies, writes: true, ownedPaths: [`src/${id}.ts`, `tests/${id}.test.ts`] })
  const review = (dependencies: string[] = ["write"], id = "review"): TaskSpec => ({ id, title: id, role: "reviewer", stage: "review", instructions: "Independently inspect the changed behavior", dependencies, writes: false })
  const verify = (dependencies: string[] = ["write"], id = "verify", checkIds = ["test"]): TaskSpec => ({ id, title: id, role: "verifier", stage: "verification", instructions: `Run ${checkIds.join(", ")} native checks against the candidate`, dependencies, writes: false, checkIds })
  const execution = (tasks: TaskSpec[], checks = machineConfig): Plan => validatePlan({
    revision: 1, rationale: "Use only workers needed to change, independently review and verify the behavior",
    criteria: [
      { id: "request", description: "The requested behavior works", required: true, kind: "assessment" },
      ...checks.checks.flatMap(check => check.criterionIds).map(id => ({ id, description: "Configured verification establishes correctness", required: true, kind: "check" })),
    ], tasks,
  }, "execute", checks)

  test("admits the minimal writer, independent reviewer and final verifier without reporting workers", () => {
    const input = execution([writer(), review(), verify()])
    const before = structuredClone(input)
    expect(() => validateExecutionCoverage(input, machineConfig)).not.toThrow()
    expect(input).toEqual(before)
    expect(input.tasks).toHaveLength(3)
  })

  test("rejects execution without an admitted writer or independent review", () => {
    expect(() => validateExecutionCoverage(execution([reader("inspect")]), machineConfig)).toThrow("writer")
    expect(() => validateExecutionCoverage(execution([writer(), verify()]), machineConfig)).toThrow("review")
    const selfAssessment = { ...review(), role: "synthesizer" as const }
    expect(() => validateExecutionCoverage(execution([writer(), selfAssessment, verify()]), machineConfig)).toThrow("review")
  })

  test("rejects a reviewer that can run before or alongside the writer", () => {
    expect(() => validateExecutionCoverage(execution([writer(), review([]), verify()]), machineConfig)).toThrow("review")
    expect(() => validateExecutionCoverage(execution([review([]), writer("write", ["review"]), verify()]), machineConfig)).toThrow("review")
  })

  test("rejects missing final checks and verification that can run alongside the writer", () => {
    expect(() => validateExecutionCoverage(execution([writer(), review()]), machineConfig)).toThrow("test")
    expect(() => validateExecutionCoverage(execution([writer(), review(), verify([], "early")]), machineConfig)).toThrow("test")
  })

  test("a TDD RED verifier cannot replace verification after the implementation writer", () => {
    const testWriter = writer("tests")
    testWriter.ownedPaths = ["tests/**"]
    const red = verify(["tests"], "red")
    const implementation = writer("write", ["red"])
    const reviewed = review(["write"])
    expect(() => validateExecutionCoverage(execution([testWriter, red, implementation, reviewed]), machineConfig)).toThrow("test")
    expect(() => validateExecutionCoverage(execution([testWriter, red, implementation, reviewed, verify(["write"], "green")]), machineConfig)).not.toThrow()
  })

  test("review and final verification must cover every writer, including transitive dependencies", () => {
    const first = writer("first"), second = writer("second")
    expect(() => validateExecutionCoverage(execution([first, second, review(["first"]), verify(["first", "second"])]), machineConfig)).toThrow("review")
    expect(() => validateExecutionCoverage(execution([first, second, review(["first", "second"]), verify(["first"])]), machineConfig)).toThrow("test")
    const handoff = reader("inspect", ["first", "second"])
    expect(() => validateExecutionCoverage(execution([first, second, handoff, review(["inspect"]), verify(["inspect"])]), machineConfig)).not.toThrow()
  })

  test("each required configured check needs final coverage even when checks are split between verifiers", () => {
    const checkConfig = parseConfig({ checks: [
      { id: "test", command: "bun test", criterionIds: ["tests"] },
      { id: "typecheck", command: "bun run typecheck", criterionIds: ["types"] },
    ] })
    expect(() => validateExecutionCoverage(execution([writer(), review(), verify()], checkConfig), checkConfig)).toThrow("typecheck")
    expect(() => validateExecutionCoverage(execution([writer(), review(), verify(), verify(["write"], "types", ["typecheck"])], checkConfig), checkConfig)).not.toThrow()
  })

  test("explicit check assignments require final coverage even for optional check criteria", () => {
    const input = execution([writer(), review(), verify([], "early")])
    input.criteria.find(criterion => criterion.id === "verification")!.required = false
    expect(() => validateExecutionCoverage(input, machineConfig)).toThrow("test")
  })

  test("without configured checks a writer and independent review are admitted without inventing a verifier", () => {
    const noChecks = parseConfig({ checks: [] })
    expect(() => validateExecutionCoverage(execution([writer(), review()], noChecks), noChecks)).not.toThrow()
    expect(() => validateExecutionCoverage(execution([writer()], noChecks), noChecks)).toThrow("review")
  })
})

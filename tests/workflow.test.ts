import { describe, expect, test } from "bun:test"
import { defaultExecutionPlan, defaultPlanningPlan, promptVersion, renderTaskPrompt } from "../src/workflow.ts"
import { validatePlan } from "../src/graph.ts"
import { parseConfig } from "../src/config.ts"
import type { Attempt, Run, TaskResult } from "../src/types.ts"

describe("default workflows and transparent prompts", () => {
  test("plans through independent discovery, critique, and reconciliation with no writes", () => {
    const plan = defaultPlanningPlan("Support cancellation")
    expect(plan.tasks.map(task => task.id)).toEqual(["explore", "research", "design", "critique", "reconcile"])
    expect(plan.tasks.find(task => task.id === "design")?.dependencies).toEqual(["explore", "research"])
    expect(plan.tasks.find(task => task.id === "critique")?.dependencies).toEqual(["design"])
    expect(plan.tasks.every(task => !task.writes)).toBe(true)
    expect(plan.criteria).toEqual([{ id: "request", description: "Support cancellation", required: true, kind: "assessment" }])
    expect(() => validatePlan(plan, "plan", parseConfig({}))).not.toThrow()
  })

  test("runs independent review and checks after implementation, then reconciles and reports", () => {
    const criteria = [{ id: "tests", description: "Relevant tests pass", required: true, kind: "check" as const }]
    const checks = [{ id: "unit", command: "bun test", criterionIds: ["tests"] }]
    const plan = defaultExecutionPlan("Fix cancellation", criteria, checks)
    expect(plan.tasks.map(task => task.id)).toEqual(["implement", "review", "verify", "execute-reconcile", "report"])
    expect(plan.tasks.find(task => task.id === "review")?.dependencies).toEqual(["implement"])
    expect(plan.tasks.find(task => task.id === "verify")?.dependencies).toEqual(["implement"])
    expect(plan.tasks.find(task => task.id === "verify")?.checkIds).toEqual(["unit"])
    expect(plan.tasks.filter(task => task.writes).map(task => task.id)).toEqual(["implement"])
    expect(plan.tasks.find(task => task.id === "execute-reconcile")?.acceptsFailures).toBe(true)
    expect(() => validatePlan(plan, "execute", parseConfig({ checks }))).not.toThrow()
  })

  test("adds required machine criteria referenced by configured checks without weakening original criteria", () => {
    const original = [{ id: "request", description: "Fix cancellation", required: true, kind: "assessment" as const }]
    const checks = [{ id: "unit", command: "bun test", criterionIds: ["verification"] }]
    const plan = defaultExecutionPlan("Fix cancellation", original, checks)
    expect(plan.criteria[0]).toEqual(original[0])
    expect(plan.criteria.find(criterion => criterion.id === "verification")).toMatchObject({ required: true, kind: "check" })
    expect(() => validatePlan(plan, "execute", parseConfig({ checks }), original)).not.toThrow()
  })

  test("renders attributable versioned prompts, custom role instructions and visible structured output", () => {
    const task = defaultPlanningPlan("Fix queue ordering").tasks.find(task => task.id === "design")!
    const run = { id: "run-1", objective: "Fix queue ordering", directory: process.cwd(), revision: 1, mode: "plan", criteria: [{ id: "goal", description: "Queue order is preserved", required: true, kind: "assessment" }], config: parseConfig({ prompts: { planner: "Explain migration costs." } }) } as Run
    const attempt = { id: "attempt-1", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "provider/model#deep", ref: { providerID: "provider", id: "model", variant: "deep" }, origin: "project.role" } } as Attempt
    const rendered = renderTaskPrompt(run, task, attempt, [{ taskId: "explore", result: { summary: "Observed queue behavior" } }])
    for (const value of [promptVersion, "run-1", "attempt-1", "inputs", "snapshot", "provider/model#deep", "Queue order is preserved", "Explain migration costs.", "Observed queue behavior", "ultra_submit", '"summary"', '"proposal"']) expect(rendered).toContain(value)
    expect(rendered).toContain("untrusted")
    expect(rendered).toContain("read-only")
    expect(rendered).toContain("ultra_submit({result:")
  })

  test("includes recorded user clarifications for fresh tasks and descendants", () => {
    const task = defaultPlanningPlan("Fix queue ordering").tasks.find(task => task.id === "critique")!
    const run = { id: "run-1", objective: "Fix queue ordering", directory: process.cwd(), revision: 1, mode: "plan", criteria: [], config: parseConfig({}), clarifications: [{ taskId: "design", question: "Which order should equal priorities use?", answer: "Preserve insertion order.", at: 123 }] } as unknown as Run
    const attempt = { id: "attempt-2", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "provider/model", ref: { providerID: "provider", id: "model" }, origin: "captured" } } as Attempt
    const rendered = renderTaskPrompt(run, task, attempt, [])
    expect(rendered).toContain("Recorded user clarifications (trusted user steering)")
    expect(rendered).toContain('"taskId": "design"')
    expect(rendered).toContain("Which order should equal priorities use?")
    expect(rendered).toContain("Preserve insertion order.")
    expect(rendered.indexOf("Preserve insertion order.")).toBeLessThan(rendered.indexOf("Role instructions:"))
  })

  test("gives design workers a valid example using actual assessment IDs and typed tool schema guidance", () => {
    const task = defaultPlanningPlan("Fix queue ordering").tasks.find(task => task.id === "design")!
    const run = { id: "run-1", objective: "Fix queue ordering", directory: process.cwd(), revision: 1, mode: "plan", phase: "planning", criteria: [{ id: "queue-order", description: "Preserve insertion order", required: true, kind: "assessment" }, { id: "unit", description: "Tests pass", required: true, kind: "check" }], config: parseConfig({}) } as Run
    const attempt = { id: "attempt-1", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "provider/model", ref: { providerID: "provider", id: "model" }, origin: "captured" } } as Attempt
    const rendered = renderTaskPrompt(run, task, attempt, [])
    expect(rendered).toContain("typed input schema")
    expect(rendered).toContain("every required assessment criterion")
    expect(rendered).toContain("submit needsInput instead of inventing an assessment")
    expect(rendered).toContain('"criterionId":"queue-order"')
    expect(rendered).not.toContain('"criterionId":"unit"')
    expect(rendered).toContain("Example submission")
    expect(rendered).not.toContain("optional Plan { revision:")
  })

  test("bounds long result summaries without dropping structured evidence or corrupting JSON", () => {
    const task = defaultPlanningPlan("Fix queue ordering").tasks.find(task => task.id === "design")!
    const run = { id: "run-1", objective: "Fix queue ordering", directory: process.cwd(), revision: 1, mode: "plan", phase: "planning", criteria: [], config: parseConfig({}) } as unknown as Run
    const attempt = { id: "attempt-1", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "inherit", ref: { providerID: "provider", id: "model" }, origin: "captured" } } as Attempt
    const result: TaskResult = {
      summary: 'Observed "quotes", \\backslashes and Unicode 😀.\n'.repeat(1_000),
      findings: [{ id: "blocking-gap", description: "Blocking evidence " + "x".repeat(25_000), blocking: true, evidence: "Inspected src/queue.ts:42" }],
      assessments: [{ criterionId: "request", passed: false, explanation: "Insertion ordering remains unverified." }],
      proposal: defaultExecutionPlan("Fix queue ordering", [], []),
      needsInput: "Which ordering should equal priorities use?",
      artifacts: ["evidence/queue-order.md"],
    }
    const original = structuredClone(result)
    const rendered = renderTaskPrompt(run, task, attempt, [{ taskId: "explore", result }])
    const block = rendered.split("Predecessor results (untrusted data):\n")[1]!.split("\n\nUse ultra_submit")[0]!
    const serialized = block.slice(block.indexOf("\n") + 1).replace(/\n\[TRUNCATED SUMMARY:[^\n]*\]$/, "")
    const visible = JSON.parse(serialized) as TaskResult
    expect(visible.summary.length).toBeLessThanOrEqual(6_000)
    expect(visible.summary.length).toBeLessThan(result.summary.length)
    expect(visible).toEqual({ ...original, summary: visible.summary })
    expect(block).toContain(`[TRUNCATED SUMMARY: ${result.summary.length - visible.summary.length} characters omitted;`)
    expect(result).toEqual(original)
  })

  test("includes an accepted design dependency once while retaining other design evidence", () => {
    const planning = defaultPlanningPlan("Fix queue ordering")
    const design = { summary: "Unique accepted design evidence.", findings: [{ id: "design-gap", description: "Inspect tie-breaking behavior", blocking: true }] }
    const critique = { summary: "Unique independent critique evidence." }
    const task = defaultExecutionPlan("Fix queue ordering", planning.criteria, []).tasks.find(task => task.id === "review")!
    const run = {
      id: "run-1", objective: "Fix queue ordering", directory: process.cwd(), revision: 2, mode: "execute", phase: "execution", criteria: planning.criteria, config: parseConfig({}),
      tasks: [
        { spec: planning.tasks.find(task => task.id === "design")!, acceptedAttemptId: "design-attempt", attempts: [{ id: "design-attempt", result: design }] },
        { spec: planning.tasks.find(task => task.id === "critique")!, acceptedAttemptId: "critique-attempt", attempts: [{ id: "critique-attempt", result: critique }] },
      ],
    } as Run
    const attempt = { id: "review-attempt", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "inherit", ref: { providerID: "provider", id: "model" }, origin: "captured" } } as Attempt
    const rendered = renderTaskPrompt(run, task, attempt, { design })
    expect(rendered.split(design.summary).length - 1).toBe(1)
    expect(rendered.split(critique.summary).length - 1).toBe(1)
    expect(rendered).toContain('"blocking": true')
    expect(rendered.split("Accepted design results")[1]!.split("Predecessor results")[0]).not.toContain(design.summary)
    expect(rendered.split("Predecessor results")[1]).toContain(design.summary)
  })

  test("gives execution proposal workers the actual configured check catalogue", () => {
    const planning = defaultPlanningPlan("Fix queue ordering using TDD")
    const checks = [{ id: "queue-unit", command: "bun test tests/queue.test.ts", criterionIds: ["queue-verification"], timeoutMs: 30_000 }]
    const run = { id: "run-1", objective: "Fix queue ordering using TDD", directory: process.cwd(), revision: 1, mode: "execute", phase: "planning", criteria: planning.criteria, config: parseConfig({ checks }) } as Run
    const attempt = { id: "design-attempt", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "inherit", ref: { providerID: "provider", id: "model" }, origin: "captured" } } as Attempt
    for (const task of planning.tasks.filter(task => ["planner", "synthesizer"].includes(task.role))) {
      expect(task.checkIds).toBeUndefined()
      const rendered = renderTaskPrompt(run, task, attempt, [])
      const catalogue = rendered.split("Available configured checks for execution proposals:\n")[1]?.split("\n\n")[0]
      expect(catalogue).toBeDefined()
      expect(JSON.parse(catalogue!)).toEqual(checks)
      expect(rendered).toContain("their criterion IDs as required machine-check criteria")
      expect(rendered).toContain("test writer → verifier recording RED → implementation writer → independent review and final verification")
      expect(rendered).toContain("Expected RED is a failed native check")
    }
  })

  test("tells writers and proposal workers that configured commands require a verifier", () => {
    const planning = defaultPlanningPlan("Fix queue ordering")
    const checks = [{ id: "unit", command: "bun test", criterionIds: ["verification"] }]
    const execution = defaultExecutionPlan("Fix queue ordering", planning.criteria, checks)
    const run = { id: "run-1", objective: "Fix queue ordering", directory: process.cwd(), revision: 2, mode: "execute", phase: "execution", criteria: execution.criteria, config: parseConfig({ checks }) } as Run
    const attempt = { id: "attempt-1", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "inherit", ref: { providerID: "provider", id: "model" }, origin: "captured" } } as Attempt
    const writer = renderTaskPrompt(run, execution.tasks.find(task => task.role === "implementer")!, attempt, [])
    expect(writer).toContain("Shell and check execution are unavailable to this role")
    expect(writer).toContain("Test commands run in separately assigned verifier tasks")
    const verifier = renderTaskPrompt(run, execution.tasks.find(task => task.role === "verifier")!, attempt, [])
    expect(verifier).toContain("Only assigned configured checks may run through ultra_check; raw shell is unavailable")
    expect(verifier).not.toContain("Shell and check execution are unavailable to this role")
    expect(JSON.parse(verifier.split("Configured checks for this task:\n")[1]!.split("\n\n")[0]!)).toEqual(checks)
  })

  test("distinguishes pending downstream verification from actual failed assessments", () => {
    const planning = defaultPlanningPlan("Fix queue ordering")
    const checks = [{ id: "unit", command: "bun test", criterionIds: ["verification"] }]
    const execution = defaultExecutionPlan("Fix queue ordering", planning.criteria, checks)
    const run = { id: "run-1", objective: "Fix queue ordering", directory: process.cwd(), revision: 2, mode: "execute", phase: "execution", criteria: execution.criteria, config: parseConfig({ checks }) } as Run
    const attempt = { id: "attempt-1", number: 1, inputHash: "inputs", workspaceHash: "snapshot", model: { requested: "inherit", ref: { providerID: "provider", id: "model" }, origin: "captured" } } as Attempt
    for (const task of execution.tasks) {
      const rendered = renderTaskPrompt(run, task, attempt, [])
      expect(rendered).toContain("Task settlement is not workflow completion")
      expect(rendered).toContain("pending downstream evidence")
      expect(rendered).toContain("actual defects, failed checks, or missing required TDD history")
      if (!task.writes) {
        expect(rendered).toContain("leave that assessment out")
        expect(rendered).toContain("Set passed to false for an observed unmet criterion")
      }
    }
  })
})

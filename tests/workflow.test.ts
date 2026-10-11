import { describe, expect, test } from "bun:test"
import { defaultExecutionPlan, defaultPlanningPlan, renderTaskPrompt } from "../src/workflow.ts"
import { validatePlan } from "../src/graph.ts"
import { parseConfig } from "../src/config.ts"
import type { Attempt, Run } from "../src/types.ts"

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
    for (const value of ["ultra/1", "run-1", "attempt-1", "inputs", "snapshot", "provider/model#deep", "Queue order is preserved", "Explain migration costs.", "Observed queue behavior", "ultra_submit", '"summary"', '"proposal"']) expect(rendered).toContain(value)
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
})

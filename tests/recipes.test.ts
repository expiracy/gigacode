import { expect, test } from "bun:test"
import { recipeNames, recipeWorkflow } from "../src/recipes.ts"
import { validatePlan } from "../src/graph.ts"
import { parseConfig } from "../src/config.ts"

test("deep review joins independent behavioral and failure investigations without write capabilities", () => {
  const workflow = recipeWorkflow("deep-review", "Review the duration parser")
  const plan = validatePlan({ ...workflow, revision: 1, criteria: [] }, "plan", parseConfig({}))
  expect(plan.tasks).toHaveLength(3)
  const branches = plan.tasks.filter(task => !task.dependencies.length)
  expect(branches.map(task => task.role)).toEqual(["reviewer", "reviewer"])
  expect(new Set(branches.map(task => task.instructions)).size).toBe(2)
  expect(plan.tasks.at(-1)!.dependencies).toEqual(branches.map(task => task.id))
  expect(plan.tasks.every(task => !task.writes && !task.checkIds?.length)).toBe(true)
  expect(plan.tasks.at(-1)!.role).toBe("synthesizer")
})

test("bug investigation combines an independent execution trace and regression analysis into a root-cause design", () => {
  const workflow = recipeWorkflow("bug-investigation", "Investigate zero-duration rejection")
  const plan = validatePlan({ ...workflow, revision: 1, criteria: [] }, "plan", parseConfig({}))
  expect(plan.tasks.map(task => task.role)).toEqual(["explorer", "explorer", "planner"])
  expect(plan.tasks.at(-1)!.dependencies).toEqual(["trace", "regressions"])
  expect(plan.tasks.every(task => !task.writes)).toBe(true)
})

test.each([...recipeNames])("%s keeps its distinct read-only graph without copying the objective into each task", recipe => {
  const objective = "Preserve the exact public contract and user constraints. ".repeat(500)
  const workflow = recipeWorkflow(recipe, objective)
  expect(workflow.tasks).toHaveLength(3)
  expect(workflow.tasks.every(task => !task.writes && !task.checkIds?.length && !task.instructions.includes(objective))).toBe(true)
  const branches = workflow.tasks.filter(task => !task.dependencies.length)
  expect(branches).toHaveLength(2)
  expect(new Set(branches.map(task => task.instructions)).size).toBe(2)
  expect(workflow.tasks.at(-1)!.dependencies).toEqual(branches.map(task => task.id))
})

test("cross-checked research independently checks primary contracts and contrary evidence before reconciliation", () => {
  const workflow = recipeWorkflow("cross-checked-research", "Resolve versioned timeout semantics")
  const plan = validatePlan({ ...workflow, revision: 1, criteria: [] }, "plan", parseConfig({}))
  expect(plan.tasks.map(task => task.role)).toEqual(["researcher", "researcher", "synthesizer"])
  expect(plan.tasks.at(-1)!.dependencies).toEqual(["primary", "crosscheck"])
  workflow.tasks[0]!.dependencies.push("report")
  expect(recipeWorkflow("cross-checked-research", "Resolve versioned timeout semantics").tasks[0]!.dependencies).toEqual([])
  expect(() => recipeWorkflow("invented" as any, "Review")).toThrow("Unknown recipe")
})

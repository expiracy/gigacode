import { identifier, modelReference, nonempty, roles, stages, strictRecord } from "./config.ts"
import type { Config, Criterion, Plan, Role, Stage, TaskSpec } from "./types.ts"

function paths(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map(value => {
    const path = nonempty(value, label).replaceAll("\\", "/")
    if (/^(?:\/|~|[A-Za-z]:)/.test(path) || path.split("/").some(part => part === ".." || part === ".ultracode") || /[\0\r\n]/.test(path)) {
      throw new Error(`Unsafe owned path: ${path}`)
    }
    return path.replace(/^\.\//, "")
  })
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate paths`)
  return result
}

function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = value.map(value => identifier(value, label))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate IDs`)
  return result
}

export function validatePlan(input: unknown, mode: "plan" | "execute", config: Config, previousCriteria?: Criterion[], authorizedModels: string[] = []): Plan {
  const source = strictRecord(input, ["revision", "tasks", "criteria", "rationale"], "plan")
  if (!Number.isSafeInteger(source.revision) || (source.revision as number) < 1) throw new Error("Plan revision must be a positive integer")
  if (!Array.isArray(source.tasks) || source.tasks.length === 0) throw new Error("Plan must contain tasks")
  if (source.tasks.length > config.limits.attempts) throw new Error("Plan exceeds the worker attempt budget")
  if (!Array.isArray(source.criteria)) throw new Error("Plan criteria must be an array")
  const criteria: Criterion[] = source.criteria.map(value => {
    const item = strictRecord(value, ["id", "description", "required", "kind"], "criterion")
    if (typeof item.required !== "boolean" || !["check", "assessment"].includes(String(item.kind))) throw new Error("Criterion required/kind is invalid")
    return { id: identifier(item.id, "Criterion ID"), description: nonempty(item.description, "Criterion description"), required: item.required, kind: item.kind as Criterion["kind"] }
  })
  if (new Set(criteria.map(item => item.id)).size !== criteria.length) throw new Error("Duplicate criterion ID")
  for (const previous of previousCriteria ?? []) {
    if (!previous.required) continue
    const current = criteria.find(item => item.id === previous.id)
    if (!current || !current.required || current.description !== previous.description || current.kind !== previous.kind) {
      throw new Error(`Required criterion ${previous.id} cannot be removed, weakened, or redefined`)
    }
  }
  const approvedModels = new Set(["inherit", ...authorizedModels, config.models.default, ...Object.values(config.models.roles ?? {}), ...Object.values(config.models.stages ?? {})].filter((reference): reference is string => typeof reference === "string"))
  const tasks: TaskSpec[] = source.tasks.map(value => {
    const item = strictRecord(value, ["id", "title", "role", "stage", "instructions", "dependencies", "writes", "ownedPaths", "acceptsFailures", "model", "checkIds", "comparison"], "task")
    const task: TaskSpec = {
      id: identifier(item.id, "Task ID"), title: nonempty(item.title, "Task title"), role: item.role as Role, stage: item.stage as Stage,
      instructions: nonempty(item.instructions, "Task instructions"), dependencies: ids(item.dependencies, "Task dependencies"), writes: item.writes as boolean,
    }
    if (!roles.includes(task.role) || !stages.includes(task.stage) || typeof task.writes !== "boolean") throw new Error(`Task ${task.id} role/stage/writes is invalid`)
    if (task.role === "supervisor") throw new Error("Supervisor is a reserved scheduler role, not a graph worker")
    if (task.role === "implementer" && !task.writes) throw new Error(`Task ${task.id} implementation capabilities require writer admission`)
    if (item.ownedPaths !== undefined) task.ownedPaths = paths(item.ownedPaths, `Task ${task.id} ownedPaths`)
    if (item.acceptsFailures !== undefined) {
      if (typeof item.acceptsFailures !== "boolean") throw new Error("acceptsFailures must be boolean")
      task.acceptsFailures = item.acceptsFailures
    }
    if (item.model !== undefined) {
      task.model = modelReference(item.model)
      if (!approvedModels.has(task.model)) throw new Error(`Task ${task.id} model override was not authorized: ${task.model}`)
    }
    if (item.checkIds !== undefined) {
      task.checkIds = ids(item.checkIds, `Task ${task.id} checkIds`)
      if (task.role !== "verifier" || task.stage !== "verification") throw new Error("Only verifier tasks may execute configured checks")
      for (const id of task.checkIds) {
        const check = config.checks.find(check => check.id === id)
        if (!check) throw new Error(`Task ${task.id} references an unconfigured check: ${id}`)
        if (check.criterionIds.some(id => !criteria.some(criterion => criterion.id === id))) throw new Error(`Check ${id} references an absent criterion`)
      }
    }
    if (item.comparison !== undefined) task.comparison = nonempty(item.comparison, "Task comparison purpose")
    if (task.writes && (task.role !== "implementer" || task.stage !== "implementation" || !task.ownedPaths?.length)) throw new Error(`Task ${task.id} writes require an implementation role and owned paths`)
    if (mode === "plan" && (task.writes || task.role === "implementer" || task.stage === "implementation" || task.stage === "verification" || task.checkIds?.length)) throw new Error(`Task ${task.id} exceeds design-only scope`)
    return task
  })
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("Duplicate task ID")
  const byID = new Map(tasks.map(task => [task.id, task]))
  const visited = new Set<string>()
  const active = new Set<string>()
  const visit = (task: TaskSpec) => {
    if (active.has(task.id)) throw new Error(`Task dependency cycle includes ${task.id}`)
    if (visited.has(task.id)) return
    active.add(task.id)
    for (const id of task.dependencies) {
      const dependency = byID.get(id)
      if (!dependency) throw new Error(`Task ${task.id} has missing dependency ${id}`)
      visit(dependency)
    }
    active.delete(task.id)
    visited.add(task.id)
  }
  for (const task of tasks) visit(task)
  const work = new Map<string, TaskSpec>()
  for (const task of tasks) {
    const signature = JSON.stringify([task.role, task.stage, task.instructions, [...task.dependencies].sort(), task.writes, task.ownedPaths, [...(task.checkIds ?? [])].sort()])
    const previous = work.get(signature)
    if (previous && !task.comparison && !previous.comparison) throw new Error(`Tasks ${previous.id} and ${task.id} duplicate work without a comparison purpose`)
    work.set(signature, task)
  }
  return { revision: source.revision as number, tasks, criteria, rationale: nonempty(source.rationale, "Plan rationale") }
}

/** Require independent review and final native check coverage for a structurally validated execution graph. */
export function validateExecutionCoverage(plan: Plan, config: Config): void {
  const writers = plan.tasks.filter(task => task.writes)
  if (!writers.length) throw new Error("Execution requires at least one scoped implementation writer")
  const byID = new Map(plan.tasks.map(task => [task.id, task]))
  const dependencies = new Map<string, Set<string>>()
  const followsEveryWriter = (task: TaskSpec) => {
    let ancestors = dependencies.get(task.id)
    if (!ancestors) {
      ancestors = new Set<string>()
      const pending = [...task.dependencies]
      while (pending.length) {
        const id = pending.pop()!
        if (ancestors.has(id)) continue
        ancestors.add(id)
        pending.push(...byID.get(id)!.dependencies)
      }
      dependencies.set(task.id, ancestors)
    }
    return writers.every(writer => ancestors.has(writer.id))
  }
  if (!plan.tasks.some(task => task.role === "reviewer" && task.stage === "review" && followsEveryWriter(task))) {
    throw new Error("Execution requires independent review after every writer")
  }
  // Match the completion gate: required criterion coverage and explicit assignments both require native evidence.
  const requiredChecks = config.checks.filter(check => check.criterionIds.some(id => plan.criteria.some(criterion => criterion.id === id && criterion.required)) || plan.tasks.some(task => task.checkIds?.includes(check.id)))
  for (const check of requiredChecks) {
    if (!plan.tasks.some(task => task.role === "verifier" && task.stage === "verification" && task.checkIds?.includes(check.id) && followsEveryWriter(task))) {
      throw new Error(`Execution check ${check.id} requires a verifier after every writer`)
    }
  }
}

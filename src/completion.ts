import type { CheckEvidence, Run, TaskResult, TaskSpec } from "./types.ts"

const unresolved = (finding: NonNullable<TaskResult["findings"]>[number]) => finding.blocking && !(finding.evidence?.trim() && ["fixed", "rejected"].includes(finding.disposition ?? ""))

export function acceptedResults(run: Run) {
  return run.tasks.filter(task => task.status === "succeeded").map(task => ({ task, attempt: task.attempts.find(attempt => attempt.id === task.acceptedAttemptId)! }))
}

export function planningEvidenceComplete(run: Run, results = acceptedResults(run)): boolean {
  const planningCriteria = run.plans[0]!.criteria.filter(criterion => criterion.required && criterion.kind === "assessment")
  const assessments = results.flatMap(item => item.attempt.result?.assessments ?? [])
  const assessment = planningCriteria.length > 0 && planningCriteria.every(criterion => assessments.some(value => value.criterionId === criterion.id && value.passed) && !assessments.some(value => value.criterionId === criterion.id && !value.passed))
  const blockers = results.flatMap(item => item.attempt.result?.findings ?? []).some(unresolved)
  return assessment && !blockers
}

type CompletionDecision = { type: "terminal"; status: "partial" | "succeeded"; text: string } | { type: "repair" }

/** Evaluate settled execution evidence without mutating state or performing host operations. */
export function executionCompletion(run: Run, workspaceHash: string): CompletionDecision {
  const results = acceptedResults(run)
  const failed = run.tasks.some(task => ["failed", "blocked", "cancelled"].includes(task.status))
  if (run.parallel && !run.parallel.integratedHash) return { type: "terminal", status: "partial", text: "Parallel integration remains unresolved; source changes and isolated worktrees are retained" }
  const plan = run.plans.at(-1)!
  // A repair revision appends its graph to history; only that revision's new tasks provide final proof.
  const historicalIds = new Set(run.repairRound > 0 ? run.plans.at(-2)?.tasks.map(task => task.id) : [])
  const currentSpecs = plan.tasks.filter(task => !historicalIds.has(task.id))
  const currentIds = new Set(currentSpecs.map(task => task.id)), writers = currentSpecs.filter(task => task.writes).map(task => task.id)
  const currentResults = results.filter(item => currentIds.has(item.task.spec.id))
  const byId = new Map(run.tasks.map(task => [task.spec.id, task.spec]))
  const afterWriters = (task: TaskSpec) => {
    const ancestors = new Set<string>()
    const visit = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency) }
    for (const dependency of task.dependencies) visit(dependency)
    return writers.every(id => ancestors.has(id))
  }
  const currentReviews = currentResults.filter(item => item.task.spec.role === "reviewer" && item.task.spec.stage === "review" && item.attempt.workspaceHash === workspaceHash && afterWriters(item.task.spec))
  // Contract findings can remain relevant after a writer changes files; a hash change does not resolve them.
  const blocking = currentResults.filter(item => !item.task.spec.writes).flatMap(item => item.attempt.result?.findings ?? []).filter(unresolved)
  const candidateHash = run.candidateHash ?? run.workspaceHash
  const freshChecks = currentResults.filter(item => item.task.spec.role === "verifier" && item.task.spec.stage === "verification" && afterWriters(item.task.spec)).flatMap(item => item.attempt.checks.filter(check => item.task.spec.checkIds?.includes(check.checkId))).filter(check => check.workspaceHash === candidateHash && candidateHash === workspaceHash)
  const lastChecks = new Map<string, CheckEvidence>()
  for (const check of freshChecks.toSorted((left, right) => left.finishedAt - right.finishedAt)) lastChecks.set(check.checkId, check)
  const checks = [...lastChecks.values()].filter(check => check.outcome === "passed" && check.exit === 0)
  const failedCheck = [...lastChecks.values()].some(check => check.outcome !== "passed" || check.exit !== 0)
  const requiredChecks = run.config.checks.filter(check => check.criterionIds.some(id => run.criteria.some(criterion => criterion.id === id && criterion.required)) || run.tasks.some(task => task.spec.checkIds?.includes(check.id)))
  const nativeChecksCovered = requiredChecks.length > 0 && requiredChecks.every(check => lastChecks.get(check.id)?.outcome === "passed" && lastChecks.get(check.id)?.exit === 0)
  const assessments = currentResults.filter(item => !item.task.spec.writes && item.attempt.workspaceHash === workspaceHash).flatMap(item => item.attempt.result?.assessments ?? [])
  const covered = run.criteria.filter(item => item.required).every(criterion => criterion.kind === "check" ? checks.some(check => check.criterionIds.includes(criterion.id)) : assessments.some(item => item.criterionId === criterion.id && item.passed) && !assessments.some(item => item.criterionId === criterion.id && !item.passed))
  if (!requiredChecks.length && !failed && currentReviews.length > 0 && !blocking.length && covered) {
    return { type: "terminal", status: "partial", text: "No configured native checks establish completion; the reviewed candidate is retained without unnecessary repair" }
  }
  if (!failed && !failedCheck && nativeChecksCovered && currentReviews.length > 0 && !blocking.length && covered && run.criteria.some(item => item.required && item.kind === "check")) {
    return { type: "terminal", status: "succeeded", text: "Required assessments and fresh native checks passed" }
  }
  if (run.repairRound < run.config.limits.repairRounds && (failed || failedCheck || !nativeChecksCovered || blocking.length || !covered)) {
    return { type: "repair" }
  }
  return { type: "terminal", status: "partial", text: "Required verification or review remains unresolved" }
}

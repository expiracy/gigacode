import type { CheckEvidence, Finding, ModelSelection, Run, TaskStatus } from "./types.ts"
import { sanitizeEventData } from "./redaction.ts"
import { currentResult } from "./results.ts"

export interface WorkflowTask {
  id: string; title: string; role: string; stage: string; status: TaskStatus; dependencies: string[]
  attempts: number; sessionId?: string; model?: ModelSelection
  result?: { summary: string; current: boolean }
  waits: string[]; blockers: Finding[]; question?: string; error?: string
  checks: (Pick<CheckEvidence, "id" | "checkId" | "outcome" | "exit" | "command" | "finishedAt" | "output"> & { current: boolean })[]
}
export interface WorkflowRun {
  id: string; parentSessionId: string; directory: string; generation: number; revision: number
  status: Run["status"]; phase: Run["phase"]; objective: string; supervisorSessionId?: string
  tasks: WorkflowTask[]; errors: string[]; omittedErrors: number
  usage: { workers: number; attempts: number; tokens: number | null; cost: number | null; tokenObservations: number; costObservations: number; activeMs: number; elapsedMs: number; limits: Run["config"]["limits"] }
}
export interface WorkflowSnapshot { sessionId: string; runs: WorkflowRun[] }

/** A durable UI snapshot, without captured prompts or native event payloads. */
export function workflowView(run: Run, now = Date.now()): WorkflowRun {
  const preview = (value: string, limit: number) => {
    const text = String(sanitizeEventData(value))
    return text.length <= limit ? text : `${text.slice(0, limit)}\n[${text.length - limit} characters omitted; inspect or export for full evidence]`
  }
  const attempts = run.tasks.flatMap(task => task.attempts)
  const candidate = run.candidateHash ?? run.workspaceHash
  const historicalIds = new Set(run.repairRound > 0 ? run.plans.at(-2)?.tasks.map(task => task.id) : [])
  const finalSpecs = (run.plans.at(-1)?.tasks ?? []).filter(task => !historicalIds.has(task.id))
  const writers = finalSpecs.filter(spec => spec.writes)
  const byId = new Map(run.tasks.map(task => [task.spec.id, task.spec]))
  const tokens = attempts.flatMap(attempt => typeof attempt.tokens === "number" && Number.isFinite(attempt.tokens) && attempt.tokens >= 0 ? [attempt.tokens] : [])
  const costs = attempts.flatMap(attempt => typeof attempt.cost === "number" && Number.isFinite(attempt.cost) && attempt.cost >= 0 ? [attempt.cost] : [])
  const view: WorkflowRun = {
    id: run.id, parentSessionId: run.parentSessionId, directory: run.directory, generation: run.generation, revision: run.revision,
    status: run.status, phase: run.phase, objective: preview(run.objective, 1500), supervisorSessionId: run.supervisorSessionId,
    errors: run.errors.slice(-6).map(error => preview(error, 1000)), omittedErrors: Math.max(0, run.errors.length - 6),
    tasks: run.tasks.map(task => {
      const attempt = task.attempts.at(-1)
      const accepted = task.attempts.find(value => value.id === task.acceptedAttemptId)
      const current = !!accepted && currentResult(run, task, accepted)
      const currentGraph = run.phase === "planning" || finalSpecs.some(spec => spec.id === task.spec.id)
      const ancestors = new Set<string>()
      const visit = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency) }
      for (const dependency of task.spec.dependencies) visit(dependency)
      const finalVerification = run.phase === "execution" && task.spec.role === "verifier" && task.spec.stage === "verification" && currentGraph && writers.every(writer => ancestors.has(writer.id))
      const question = accepted?.result?.needsInput
      const answered = question && run.clarifications?.some(value => value.taskId === task.spec.id && value.question === question && value.at >= (accepted!.finishedAt ?? accepted!.createdAt))
      return { id: task.spec.id, title: preview(task.spec.title, 200), role: task.spec.role, stage: task.spec.stage, status: task.status,
        dependencies: [...task.spec.dependencies], attempts: task.attempts.length, sessionId: attempt?.sessionId, model: attempt?.model,
        waits: [...(task.status === "waiting_permission" ? ["Permission approval"] : []), ...task.spec.dependencies.flatMap(id => {
          const dependency = run.tasks.find(value => value.spec.id === id)
          return dependency?.status === "succeeded" || task.spec.acceptsFailures && dependency && ["failed", "cancelled", "blocked", "skipped"].includes(dependency.status) ? [] : [`${id}: ${dependency?.status ?? "unavailable"}`]
        })],
        blockers: (currentGraph ? accepted?.result?.findings ?? [] : []).filter(finding => finding.blocking && !(finding.evidence?.trim() && ["fixed", "rejected"].includes(finding.disposition ?? ""))).map(finding => ({ ...finding, description: preview(finding.description, 2000), ...(finding.evidence ? { evidence: preview(finding.evidence, 2000) } : {}) })),
        ...(question && !answered ? { question: preview(question, 2000) } : {}), ...(attempt?.error ? { error: preview(attempt.error, 1000) } : {}),
        ...(accepted?.result ? { result: { summary: preview(accepted.result.summary, 2000), current } } : {}),
        checks: task.attempts.flatMap(value => value.checks.map(check => ({ id: check.id, checkId: check.checkId, outcome: check.outcome, exit: check.exit, command: preview(check.command, 1000), finishedAt: check.finishedAt, output: preview(check.output, 2000), current: finalVerification && current && value === accepted && value === attempt && !!task.spec.checkIds?.includes(check.checkId) && check.workspaceHash === candidate }))),
      }
    }),
    usage: { workers: attempts.filter(attempt => ["reserved", "running", "waiting_permission", "cancelling", "ambiguous"].includes(attempt.status)).length,
      attempts: attempts.length, tokens: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null, cost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
      tokenObservations: tokens.length, costObservations: costs.length,
      activeMs: run.activeMs + (run.activeSince ? Math.max(0, now - run.activeSince) : 0), elapsedMs: Math.max(0, now - run.createdAt), limits: { ...run.config.limits } },
  }
  const lastChecks = new Map(view.tasks.flatMap(task => task.checks).filter(check => check.current).toSorted((left, right) => left.finishedAt - right.finishedAt).map(check => [check.checkId, check]))
  for (const task of view.tasks) for (const check of task.checks) check.current &&= lastChecks.get(check.checkId) === check
  return sanitizeEventData(view) as WorkflowRun
}

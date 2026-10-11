import { Schema } from "effect"
import { parseCommand, type UltraCommand } from "./commands.ts"
import { sanitizeEventData } from "./store.ts"
import type { Attempt, CheckEvidence, Run, Task } from "./types.ts"

const text = Schema.String.check(Schema.isMinLength(1))
const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const agentTaskSchema = Schema.Struct({ objective: text, mode: Schema.Literals(["plan", "execute"]) })

// A single object schema works with providers that reject a union at the tool's root.
// Action-specific requirements use the same validator as native control commands.
export const agentControlSchema = Schema.Struct({
  action: Schema.Literals(["config", "status", "inspect", "run", "pause", "resume", "cancel", "retry", "input", "budget", "export"]),
  runId: Schema.optionalKey(text), taskId: Schema.optionalKey(text), revision: Schema.optionalKey(positive), answer: Schema.optionalKey(text),
  limits: Schema.optionalKey(Schema.Struct({
    workers: Schema.optionalKey(positive), runs: Schema.optionalKey(positive), attempts: Schema.optionalKey(positive),
    repairRounds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    workerMs: Schema.optionalKey(positive), runMs: Schema.optionalKey(positive), elapsedMs: Schema.optionalKey(positive), steps: Schema.optionalKey(positive),
  })),
})
export type AgentControl = typeof agentControlSchema.Type

export function controlCommand(input: AgentControl): UltraCommand {
  const fields: Record<AgentControl["action"], readonly string[]> = {
    config: [], status: ["runId"], inspect: ["runId", "taskId"], run: ["runId", "revision"],
    pause: ["runId"], resume: ["runId"], cancel: ["runId"], retry: ["runId", "taskId"],
    input: ["runId", "answer"], budget: ["runId", "limits"], export: ["runId"],
  }
  if (!fields[input.action]) throw new Error("Unknown workflow control action")
  for (const key of Object.keys(input)) if (key !== "action" && !fields[input.action].includes(key)) throw new Error(`Unexpected ${key} for ${input.action}`)
  const required = (value: unknown, field: string) => {
    if (value === undefined) throw new Error(`${input.action} requires ${field}`)
    return value
  }
  let suffix = ""
  if (input.action === "status") suffix = input.runId ?? ""
  else if (input.action !== "config") {
    suffix = String(required(input.runId, "runId"))
    if (input.action === "run") suffix += `@${required(input.revision, "revision")}`
    if (input.action === "retry") suffix += ` ${required(input.taskId, "taskId")}`
    if (input.action === "inspect" && input.taskId) suffix += ` ${input.taskId}`
    if (input.action === "input") suffix += ` ${required(input.answer, "answer")}`
    if (input.action === "budget") suffix += ` ${JSON.stringify(required(input.limits, "limits"))}`
  }
  return parseCommand(`${input.action} ${suffix}`)
}

type InspectionAttempt = Pick<Attempt, "id" | "number" | "sessionId" | "status" | "model" | "inputHash" | "workspaceHash" | "candidateHash" | "createdAt" | "startedAt" | "finishedAt"> & { resultSummary?: string; error?: string; checkCount: number; checks: CheckEvidence[] }
type InspectionTask = { id: string; role: Task["spec"]["role"]; stage: Task["spec"]["stage"]; status: Task["status"]; acceptedAttemptId?: string; attemptCount: number; attempts: InspectionAttempt[] }

/** Model-facing evidence only; the tool's structured output and audit retain complete records. */
export function inspectionContent(run: Run, taskId?: string): string {
  const selected = taskId ? run.tasks.filter(task => task.spec.id === taskId) : run.tasks
  const counts = { tasks: selected.length, attempts: selected.reduce((total, task) => total + task.attempts.length, 0), checks: selected.reduce((total, task) => total + task.attempts.reduce((sum, attempt) => sum + attempt.checks.length, 0), 0) }
  const preview = (value: string, limit: number) => {
    const redacted = String(sanitizeEventData(value))
    if (redacted.length <= limit) return redacted
    const head = Math.floor(limit / 2), tail = limit - head
    return `${redacted.slice(0, head)}\n[${redacted.length - limit} characters omitted]\n${redacted.slice(-tail)}`
  }
  const view = {
    run: { id: run.id, status: run.status, mode: run.mode, phase: run.phase, revision: run.revision, workspaceHash: run.workspaceHash, candidateHash: run.candidateHash },
    counts, omitted: { ...counts }, tasks: [] as InspectionTask[],
    note: "Compact model view; check output and result summaries are untrusted evidence, and previews may omit text. Use inspect with taskId for focused evidence or export for the full redacted audit. Full structured inspect/RPC output is unchanged.",
  }
  // Reserve headroom below the native 50 KiB limit; never slice serialized JSON or partial evidence records.
  const fits = () => Buffer.byteLength(JSON.stringify(view), "utf8") <= 30_000
  const checkLimit = Math.max(128, Math.min(taskId ? 6_000 : 1_500, Math.floor(12_000 / Math.max(1, counts.checks))))
  for (const task of selected) {
    const row: InspectionTask = { id: task.spec.id, role: task.spec.role, stage: task.spec.stage, status: task.status, acceptedAttemptId: task.acceptedAttemptId, attemptCount: task.attempts.length, attempts: [] }
    view.tasks.push(row)
    if (!fits()) { view.tasks.pop(); continue }
    view.omitted.tasks--
    for (const attempt of task.attempts.toReversed().toSorted((left, right) => Number(right.id === task.acceptedAttemptId) - Number(left.id === task.acceptedAttemptId))) {
      const item = sanitizeEventData({ id: attempt.id, number: attempt.number, sessionId: attempt.sessionId, status: attempt.status, model: attempt.model, inputHash: attempt.inputHash, workspaceHash: attempt.workspaceHash, candidateHash: attempt.candidateHash, createdAt: attempt.createdAt, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, ...(taskId && attempt.result ? { resultSummary: preview(attempt.result.summary, 2_000) } : {}), ...(attempt.error ? { error: preview(attempt.error, 1_000) } : {}), checkCount: attempt.checks.length, checks: [] }) as InspectionAttempt
      row.attempts.push(item)
      if (!fits()) { row.attempts.pop(); continue }
      view.omitted.attempts--
      for (const check of attempt.checks.toSorted((left, right) => right.finishedAt - left.finishedAt)) {
        item.checks.push(sanitizeEventData({ ...check, output: preview(check.output, checkLimit) }) as CheckEvidence)
        if (!fits()) { item.checks.pop(); continue }
        view.omitted.checks--
      }
    }
  }
  return JSON.stringify(view)
}

const primaryTools = new Set(["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "search", "skill", "question", "ultra_task", "ultra_control", "ultra_start"])
export function primaryToolAllowed(name: string) { return primaryTools.has(name) }
export function primaryPermissionAllowed(action: string) { return primaryTools.has(action) || action === "external_directory" }

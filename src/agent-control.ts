import { Schema } from "effect"
import { parseCommand, type UltraCommand } from "./commands.ts"

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

const primaryTools = new Set(["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "search", "skill", "question", "ultra_task", "ultra_control", "ultra_start"])
export function primaryToolAllowed(name: string) { return primaryTools.has(name) }
export function primaryPermissionAllowed(action: string) { return primaryTools.has(action) || action === "external_directory" }

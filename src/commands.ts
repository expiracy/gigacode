import { parseConfig, strictRecord } from "./config.ts"
import { recipeName, type RecipeName } from "./recipes.ts"
import type { Limits } from "./types.ts"

export type UltraCommand =
  | { type: "start" | "plan"; task: string; recipe?: RecipeName }
  | { type: "run"; id: string; revision: number }
  | { type: "status"; id?: string }
  | { type: "inspect"; id: string; taskId?: string }
  | { type: "pause" | "resume" | "cancel" | "export"; id: string }
  | { type: "retry"; id: string; taskId: string }
  | { type: "input"; id: string; answer: string }
  | { type: "budget"; id: string; limits: Partial<Limits> }
  | { type: "config" | "on" | "off" }

export const commandUsage = "Usage: /ultraopencode start|plan <task>; plan --recipe <deep-review|bug-investigation|cross-checked-research> <task>; run <id>@<revision>; status [id]; inspect <id> [task]; pause|resume|cancel|export <id>; retry <id> <task>; input <id> <answer>; budget <id> <limits-json>; config|on|off"

function id(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error(`Invalid run/task ID. ${commandUsage}`)
  return value
}

export function parseCommand(text: string): UltraCommand {
  if (typeof text !== "string") throw new Error(commandUsage)
  let input = text.trim()
  if (/^\/ultraopencode(?:\s|$)/.test(input)) input = input.replace(/^\/ultraopencode\s*/, "")
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input)
  if (!match) throw new Error(commandUsage)
  const verb = match[1]!
  const rest = match[2] ?? ""
  if (verb === "start" || verb === "plan" || verb === "--") {
    if (!rest.trim()) throw new Error(`A task is required. ${commandUsage}`)
    if (/^--recipe(?:\s|$)/.test(rest)) {
      if (verb !== "plan") throw new Error("Recipes permit read-only plan mode only")
      const selection = /^--recipe\s+(\S+)\s+([\s\S]+)$/.exec(rest)
      if (!selection || !selection[2]!.trim()) throw new Error(`A recipe and task are required. ${commandUsage}`)
      return { type: "plan", recipe: recipeName(selection[1]), task: selection[2]! }
    }
    return { type: verb === "--" ? "start" : verb, task: rest }
  }
  const arguments_ = rest ? rest.split(/\s+/) : []
  if (verb === "input" || verb === "budget") {
    const supplied = /^(\S+)\s+([\s\S]+)$/.exec(rest)
    if (!supplied || !supplied[2]!.trim()) throw new Error(commandUsage)
    const runId = id(supplied[1])
    if (verb === "input") return { type: "input", id: runId, answer: supplied[2]! }
    const value = JSON.parse(supplied[2]!)
    const limits = strictRecord(value, Object.keys(parseConfig({}).limits), "limits")
    if (!Object.keys(limits).length) throw new Error("At least one budget limit is required")
    parseConfig({ limits })
    return { type: "budget", id: runId, limits: limits as Partial<Limits> }
  }
  switch (verb) {
    case "run": {
      if (arguments_.length !== 1) throw new Error(commandUsage)
      const revision = /^([^@]+)@([1-9]\d*)$/.exec(arguments_[0]!)
      if (!revision || !Number.isSafeInteger(Number(revision[2]))) throw new Error(`Use an exact saved revision. ${commandUsage}`)
      return { type: "run", id: id(revision[1]), revision: Number(revision[2]) }
    }
    case "status":
      if (arguments_.length > 1) throw new Error(commandUsage)
      return arguments_.length ? { type: "status", id: id(arguments_[0]) } : { type: "status" }
    case "inspect":
      if (arguments_.length < 1 || arguments_.length > 2) throw new Error(commandUsage)
      return { type: "inspect", id: id(arguments_[0]), ...(arguments_[1] ? { taskId: id(arguments_[1]) } : {}) }
    case "retry":
      if (arguments_.length !== 2) throw new Error(commandUsage)
      return { type: "retry", id: id(arguments_[0]), taskId: id(arguments_[1]) }
    case "pause": case "resume": case "cancel": case "export":
      if (arguments_.length !== 1) throw new Error(commandUsage)
      return { type: verb, id: id(arguments_[0]) }
    case "config": case "on": case "off":
      if (arguments_.length) throw new Error(commandUsage)
      return { type: verb }
    default: throw new Error(`Unknown ultraopencode command: ${verb}. ${commandUsage}`)
  }
}

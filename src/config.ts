import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AvailableModel, CheckSpec, Config, Limits, ModelOptions, ModelRef, ModelSelection, Role, Run, Stage, TaskSpec } from "./types.ts"

export const roles: Role[] = ["supervisor", "explorer", "researcher", "planner", "implementer", "reviewer", "verifier", "synthesizer"]
export const stages: Stage[] = ["discovery", "design", "implementation", "review", "verification", "reporting"]

export const defaultConfig: Config = {
  models: { default: "inherit", roles: {}, stages: {} },
  limits: { workers: 4, runs: 2, attempts: 24, repairRounds: 2, workerMs: 600_000, runMs: 2_700_000, elapsedMs: 86_400_000, steps: 24, contextChars: 64_000 },
  checks: [],
  parallelWrites: false,
  autoThreshold: 80,
  prompts: {},
}

/** Explicit allowlists catch configuration typos and keep credentials out of runtime options. */
export function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`)
  return record
}

export function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a nonempty string`)
  return value
}

export function identifier(value: unknown, label: string): string {
  const id = nonempty(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new Error(`${label} must be a stable identifier without spaces or path separators`)
  return id
}

export function modelReference(value: unknown): string {
  const reference = nonempty(value, "Model reference")
  if (reference === "inherit") return reference
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s#]+(?:#[^\s#]+)?$/.test(reference)) {
    throw new Error(`Invalid model reference: ${reference}; use provider/model or provider/model#variant`)
  }
  return reference
}

export function modelRef(reference: string, inherited?: ModelRef): ModelRef {
  modelReference(reference)
  if (reference === "inherit") {
    if (!inherited) throw new Error("Inherited model is unavailable")
    return { ...inherited }
  }
  const separator = reference.indexOf("/")
  const providerID = reference.slice(0, separator)
  const [id, variant] = reference.slice(separator + 1).split("#")
  return { providerID, id: id!, ...(variant === undefined ? {} : { variant }) }
}

function models(value: unknown): ModelOptions {
  const input = strictRecord(value, ["default", "roles", "stages"], "models")
  const result: ModelOptions = {}
  if (input.default !== undefined) result.default = modelReference(input.default)
  for (const [field, allowed] of [["roles", roles], ["stages", stages]] as const) {
    if (input[field] === undefined) continue
    const entries = strictRecord(input[field], allowed, `models.${field}`)
    result[field] = {}
    for (const [name, reference] of Object.entries(entries)) {
      (result[field] as Record<string, string>)[name] = modelReference(reference)
    }
  }
  return result
}

function integer(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`)
  return value
}

export type ConfigOptions = Omit<Partial<Config>, "limits"> & { limits?: Partial<Limits> }

/** Validate one layer without supplying defaults or changing omitted-check discovery. */
export function parseConfigOptions(options: unknown): ConfigOptions {
  const input = strictRecord(options === undefined ? {} : options, ["models", "limits", "checks", "parallelWrites", "autoThreshold", "prompts"], "configuration")
  const result: ConfigOptions = {}
  if (input.models !== undefined) result.models = models(input.models)
  if (input.limits !== undefined) {
    const overrides = strictRecord(input.limits, Object.keys(defaultConfig.limits), "limits")
    result.limits = {}
    for (const [name, value] of Object.entries(overrides)) {
      result.limits[name as keyof Limits] = integer(value, `limits.${name}`, name === "repairRounds" ? 0 : 1)
    }
  }
  if (input.parallelWrites !== undefined) {
    if (typeof input.parallelWrites !== "boolean") throw new Error("parallelWrites must be a boolean")
    result.parallelWrites = input.parallelWrites
  }
  if (input.autoThreshold !== undefined) result.autoThreshold = integer(input.autoThreshold, "autoThreshold", 1)
  if (input.prompts !== undefined) {
    const overrides = strictRecord(input.prompts, roles, "prompts")
    result.prompts = {}
    for (const [role, text] of Object.entries(overrides)) {
      const prompt = nonempty(text, `prompts.${role}`)
      if (prompt.length > 64_000) throw new Error(`prompts.${role} exceeds 64000 characters`)
      result.prompts[role as Role] = prompt
    }
  }
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) throw new Error("checks must be an array")
    const ids = new Set<string>()
    result.checks = input.checks.map((value, index): CheckSpec => {
      const check = strictRecord(value, ["id", "command", "criterionIds", "timeoutMs"], `checks[${index}]`)
      const id = identifier(check.id, "Check ID")
      if (ids.has(id)) throw new Error(`Duplicate check ID: ${id}`)
      ids.add(id)
      if (!Array.isArray(check.criterionIds)) throw new Error(`Check ${id} criterionIds must be an array`)
      const criterionIds = check.criterionIds.map(value => identifier(value, `Check ${id} criterion ID`))
      if (new Set(criterionIds).size !== criterionIds.length) throw new Error(`Duplicate criterion IDs in check ${id}`)
      return {
        id,
        command: nonempty(check.command, `Check ${id} command`),
        criterionIds,
        ...(check.timeoutMs === undefined ? {} : { timeoutMs: integer(check.timeoutMs, `Check ${id} timeoutMs`) }),
      }
    })
  }
  return result
}

/** Validate every source before merging; arrays replace and named option maps inherit. */
export function mergeConfigOptions(...layers: unknown[]): ConfigOptions {
  const validated = layers.map(parseConfigOptions)
  const result: ConfigOptions = {}
  for (const layer of validated) {
    if (layer.models !== undefined) {
      const inherited = result.models ?? {}
      result.models = { ...inherited, ...layer.models }
      if (layer.models.roles !== undefined) result.models.roles = { ...inherited.roles, ...layer.models.roles }
      if (layer.models.stages !== undefined) result.models.stages = { ...inherited.stages, ...layer.models.stages }
    }
    if (layer.limits !== undefined) result.limits = { ...result.limits, ...layer.limits }
    if (layer.prompts !== undefined) result.prompts = { ...result.prompts, ...layer.prompts }
    if (layer.checks !== undefined) result.checks = layer.checks
    if (layer.parallelWrites !== undefined) result.parallelWrites = layer.parallelWrites
    if (layer.autoThreshold !== undefined) result.autoThreshold = layer.autoThreshold
  }
  return result
}

export function parseConfig(options: unknown): Config {
  return mergeConfigOptions(defaultConfig, options) as Config
}

/** Global/native options < exact-directory project override < explicit preview options. */
export async function loadProjectConfig(options: unknown, directory: string, overrides?: unknown): Promise<Config> {
  const base = parseConfigOptions(options)
  const path = join(directory, "ultracode.json")
  let project: ConfigOptions | undefined
  try {
    project = parseConfigOptions(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    // Some runtimes include file contents in JSON syntax errors and their causes.
    if (error instanceof SyntaxError) throw new Error(`Cannot load project configuration ${path}: invalid JSON`)
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot load project configuration ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const merged = mergeConfigOptions(base, project, overrides)
  const config = parseConfig(merged)
  if (merged.checks !== undefined) return config
  try {
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
    const runner = existsSync(join(directory, "bun.lock")) || existsSync(join(directory, "bun.lockb")) ? "bun" : "npm"
    for (const id of ["test", "typecheck", "lint"]) if (typeof pkg.scripts?.[id] === "string") config.checks.push({ id, command: `${runner} run ${id}`, criterionIds: ["verification"] })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  return config
}

export function resolveModel(task: TaskSpec, run: Pick<Run, "modelOptions" | "capturedModel" | "config">, catalog: AvailableModel[]): ModelSelection {
  const selections: [string, string | undefined][] = [
    ["task", task.model],
    ["run.stage", run.modelOptions.stages?.[task.stage]],
    ["run.role", run.modelOptions.roles?.[task.role]],
    ["project.stage", run.config.models.stages?.[task.stage]],
    ["project.role", run.config.models.roles?.[task.role]],
    ["run.default", run.modelOptions.default],
    ["project.default", run.config.models.default],
  ]
  const [origin, selected] = selections.find(([, reference]) => reference !== undefined) ?? ["captured", "inherit"]
  const requested = modelReference(selected)
  const ref = modelRef(requested, run.capturedModel)
  const available = catalog.find(model => model.providerID === ref.providerID && model.id === ref.id)
  if (!available) throw new Error(`Model ${ref.providerID}/${ref.id} is not available; no fallback was selected`)
  if (ref.variant !== undefined && !available.variants.includes(ref.variant)) throw new Error(`Variant ${ref.variant} is not available for ${ref.providerID}/${ref.id}`)
  if (available.tools === false) throw new Error(`Model ${ref.providerID}/${ref.id} does not support workflow tools`)
  return { ref, origin, requested }
}

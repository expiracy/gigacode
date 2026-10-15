#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { ArtifactStore } from "../src/artifacts.ts"
import { loadProjectConfig, parseConfigOptions } from "../src/config.ts"
import { SQLiteStore } from "../src/store.ts"
import { sanitizeEventData } from "../src/redaction.ts"
import { defaultExecutionPlan, defaultPlanningPlan } from "../src/workflow.ts"
import { recipeName, recipeWorkflow, type RecipeName } from "../src/recipes.ts"
import { validatePlan } from "../src/graph.ts"
import { supportedVersions } from "../src/compatibility.ts"
import { runtimeDirectory } from "../src/paths.ts"
import { globalConfigDirectory, parseNativeConfiguration, productionPluginDirectory } from "./install.ts"
import type { Config, Run } from "../src/types.ts"

export const localHelp = `UltraOpenCode local CLI

bun run ultraopencode help
bun run ultraopencode validate [--config <ultraopencode-options.json>] [--global-config <directory>]
bun run ultraopencode render [--execute | --recipe <name>] [--global-config <directory>] <objective>
bun run ultraopencode list
bun run ultraopencode status [run-id]
bun run ultraopencode inspect <run-id> [task-id]
bun run ultraopencode export <run-id>

Every command accepts --project <directory>. Status reads saved snapshots; it does
not reconnect, dispatch workers, or modify run state. Use /ultraopencode inside OpenCode
to start, pause, resume, cancel, retry, or execute a workflow. validate checks option
syntax; model availability and native permissions are checked in the live host.
Read-only recipes: deep-review, bug-investigation, cross-checked-research.

validate and render read global OpenCode plugin options and optional ultraopencode.json;
--config is applied last. A native project registration replaces the same global
registration's entire options object. Use ultraopencode.json for partial overrides.
These offline previews read selected config directories directly, without native
ancestor or include discovery. --global-config selects an isolated config directory.

list, status, inspect, and export also accept --state <state.sqlite> to select a
shared project database for a worktree. --project still filters the run directory.
Exports are written to artifacts beside the selected database.`

export interface LocalResult { exitCode: number; output: string }
const json = (value: unknown) => JSON.stringify(sanitizeEventData(value), null, 2)
const samePath = (left: string, right: string) => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

interface NativeRegistration { target: string; options: unknown }

function ambiguousRegistrations(): Error {
  return new Error("Ambiguous UltraOpenCode plugin registrations use different package aliases; move project options to ultraopencode.json and retain one UltraOpenCode registration before offline preview")
}

async function nativeOptions(directory: string): Promise<NativeRegistration | undefined> {
  const paths = [join(directory, "opencode.json"), join(directory, "opencode.jsonc")].filter(existsSync)
  if (paths.length > 1) throw new Error(`Both opencode.json and opencode.jsonc exist in ${directory}; select a single configuration for offline preview`)
  const path = paths[0]
  if (!path) return undefined
  const source = await readFile(path, "utf8")
  let native: Record<string, any>
  try { native = parseNativeConfiguration(source) }
  catch { throw new Error(`Invalid native OpenCode configuration: ${path}`) }
  if (native.plugins === undefined) return undefined
  if (!Array.isArray(native.plugins)) throw new Error(`plugins must be a native OpenCode 2 array: ${path}`)
  let selected: NativeRegistration | undefined
  for (const plugin of native.plugins) {
    if (typeof plugin !== "string" && (!plugin || typeof plugin !== "object" || Array.isArray(plugin) || typeof plugin.package !== "string")) throw new Error(`Existing plugin entries must use a native package string or {package, options?} shape: ${path}`)
    const packageName = typeof plugin === "string" ? plugin : plugin.package
    const packagePath = packageName.startsWith("file://") ? fileURLToPath(packageName) : resolve(directory, packageName)
    // The former package is read only to support profiles awaiting installer migration.
    if (packageName === "open-ultra-code" || packageName === "ultra-open-code" || [productionPluginDirectory, join(productionPluginDirectory, "index.ts"), join(productionPluginDirectory, "index.js")].some(known => samePath(packagePath, known))) {
      const target = packageName === "open-ultra-code" || packageName === "ultra-open-code" ? `package:${packageName}` : `local:${packagePath}`
      if (selected && selected.target !== target) throw ambiguousRegistrations()
      selected = { target, options: typeof plugin === "string" ? undefined : plugin.options }
    }
  }
  return selected && { ...selected, options: parseConfigOptions(selected.options) }
}

async function configuration(directory: string, configDirectory: string, explicit?: string): Promise<Config> {
  const [global, project, override] = await Promise.all([
    nativeOptions(configDirectory),
    nativeOptions(directory),
    explicit ? readFile(resolve(explicit), "utf8").then(parseNativeConfiguration) : undefined,
  ])
  if (global && project && global.target !== project.target) throw ambiguousRegistrations()
  return loadProjectConfig((project ?? global)?.options, directory, override)
}

function summary(run: Run) {
  return { id: run.id, status: run.status, mode: run.mode, phase: run.phase, revision: run.revision, objective: run.objective, updatedAt: run.updatedAt, tasks: run.tasks.map(task => ({ id: task.spec.id, status: task.status, attempts: task.attempts.length })) }
}

/** Offline inspection only: genuine native invocation contexts are never fabricated. */
export async function executeLocalCommand(args: string[], options: { directory?: string; configDirectory?: string } = {}): Promise<LocalResult> {
  let store: SQLiteStore | undefined
  try {
    const input: string[] = []
    let directory = options.directory ?? process.cwd()
    let configPath: string | undefined
    let globalPath: string | undefined
    let statePath: string | undefined
    let execute = false
    let recipe: RecipeName | undefined
    for (let index = 0; index < args.length; index++) {
      const value = args[index]!
      if (value === "--project" || value === "--config" || value === "--state" || value === "--global-config") {
        const next = args[++index]
        if (!next) throw new Error(`Missing ${value} argument`)
        if (value === "--project") directory = next
        else if (value === "--config") configPath = next
        else if (value === "--global-config") globalPath = next
        else statePath = next
      } else if (value === "--recipe") {
        recipe = recipeName(args[++index])
      } else if (value === "--execute") execute = true
      else if (value.startsWith("--")) throw new Error(`Unknown local option: ${value}`)
      else input.push(value)
    }
    const [verb = "help", ...arguments_] = input
    if (recipe && (verb !== "render" || execute)) throw new Error("--recipe is supported only by read-only render")
    if (statePath && !["list", "status", "inspect", "export"].includes(verb)) throw new Error("--state is supported only by list, status, inspect, and export")
    if (verb === "help") return { exitCode: 0, output: localHelp }
    directory = await realpath(resolve(directory))
    if (verb === "validate") {
      if (arguments_.length || execute) throw new Error("validate accepts --config, --global-config, and --project only")
      return { exitCode: 0, output: json({ valid: true, supportedRuntimes: supportedVersions, modelAvailability: "requires the live OpenCode catalog", config: await configuration(directory, resolve(globalPath ?? options.configDirectory ?? globalConfigDirectory()), configPath) }) }
    }
    if (verb === "render") {
      if (!arguments_.length) throw new Error("render requires an objective")
      const objective = arguments_.join(" ")
      const planning = defaultPlanningPlan(objective)
      const config = await configuration(directory, resolve(globalPath ?? options.configDirectory ?? globalConfigDirectory()), configPath)
      const rendered = recipe ? validatePlan({ ...recipeWorkflow(recipe, objective), revision: 1, criteria: planning.criteria }, "plan", config) : execute ? defaultExecutionPlan(objective, planning.criteria, config.checks) : planning
      return { exitCode: 0, output: json(rendered) }
    }
    if (!["list", "status", "inspect", "export"].includes(verb)) throw new Error(`Unknown local command: ${verb}. Start and control workflows through /ultraopencode inside OpenCode.`)
    if (configPath || globalPath || execute) throw new Error("Snapshot commands accept --project and --state only")
    if ((verb === "list" && arguments_.length) || (verb === "status" && arguments_.length > 1) || (verb === "inspect" && (arguments_.length < 1 || arguments_.length > 2)) || (verb === "export" && arguments_.length !== 1)) throw new Error(localHelp)
    const databasePath = resolve(statePath ?? join(runtimeDirectory(directory), "state.sqlite"))
    const stateDirectory = dirname(databasePath)
    if (!existsSync(databasePath)) {
      if ((verb === "status" && !arguments_.length) || verb === "list") return { exitCode: 0, output: json({ snapshot: true, runs: [] }) }
      throw new Error("No local UltraOpenCode state database exists for this project")
    }
    store = new SQLiteStore(databasePath)
    if (verb === "list" || verb === "status" && !arguments_.length) {
      const database = new Database(databasePath, { readonly: true })
      let projects: { project_id: string }[]
      try { projects = database.query<{ project_id: string }, []>("SELECT DISTINCT project_id FROM runs").all() } finally { database.close() }
      const runs = projects.flatMap(project => store!.list(project.project_id)).filter(run => samePath(run.directory, directory)).sort((left, right) => right.updatedAt - left.updatedAt)
      return { exitCode: 0, output: json({ snapshot: true, runs: runs.map(summary) }) }
    }
    const id = arguments_[0]!
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new Error("Invalid saved run ID")
    const run = store.get(id)
    if (!run || !samePath(run.directory, directory)) throw new Error(`Saved run ${id} was not found in this project`)
    if (verb === "status") return { exitCode: 0, output: json({ snapshot: true, run: summary(run) }) }
    if (verb === "inspect") {
      const task = arguments_[1] ? run.tasks.find(task => task.spec.id === arguments_[1]) : undefined
      if (arguments_[1] && !task) throw new Error(`Unknown task: ${arguments_[1]}`)
      return { exitCode: 0, output: json({ snapshot: true, ...(task ? { task } : { run, events: store.events(run.projectId, run.id) }) }) }
    }
    const artifacts = new ArtifactStore(join(stateDirectory, "artifacts"))
    return { exitCode: 0, output: json(await artifacts.export(run, store.events(run.projectId, run.id))) }
  } catch (error) { return { exitCode: 1, output: error instanceof Error ? error.message : String(error) } }
  finally { store?.close() }
}

if (import.meta.main) {
  const result = await executeLocalCommand(Bun.argv.slice(2))
  if (result.exitCode) console.error(result.output)
  else console.log(result.output)
  process.exitCode = result.exitCode
}

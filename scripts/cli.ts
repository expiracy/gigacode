import { existsSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { ArtifactStore } from "../src/artifacts.ts"
import { loadProjectConfig } from "../src/config.ts"
import { SQLiteStore, sanitizeEventData } from "../src/store.ts"
import { defaultExecutionPlan, defaultPlanningPlan } from "../src/workflow.ts"
import { parseNativeConfiguration, productionPluginDirectory } from "./install.ts"
import type { Config, Run } from "../src/types.ts"

export const localHelp = `Ultra Open Code local CLI

bun scripts/cli.ts help
bun scripts/cli.ts validate [--config <ultra-options.json>]
bun scripts/cli.ts render [--execute] <objective>
bun scripts/cli.ts list
bun scripts/cli.ts status [run-id]
bun scripts/cli.ts inspect <run-id> [task-id]
bun scripts/cli.ts export <run-id>

Every command accepts --project <directory>. Status reads saved snapshots; it does
not reconnect, dispatch workers, or modify run state. Use /ultracode inside OpenCode
to start, pause, resume, cancel, retry, or execute a workflow. validate checks option
syntax; model availability and native permissions are checked in the live host.

list, status, inspect, and export also accept --state <state.sqlite> to select a
shared project database for a worktree. --project still filters the run directory.
Exports are written to artifacts beside the selected database.`

export interface LocalResult { exitCode: number; output: string }
const json = (value: unknown) => JSON.stringify(sanitizeEventData(value), null, 2)
const samePath = (left: string, right: string) => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

async function configuration(directory: string, explicit?: string): Promise<Config> {
  if (explicit) return loadProjectConfig(parseNativeConfiguration(await readFile(resolve(explicit), "utf8")), directory)
  const path = [join(directory, "opencode.json"), join(directory, "opencode.jsonc")].find(existsSync)
  if (!path) return loadProjectConfig({}, directory)
  const native = parseNativeConfiguration(await readFile(path, "utf8"))
  if (!Array.isArray(native.plugins)) return loadProjectConfig({}, directory)
  const entry = native.plugins.find((plugin: any) => typeof plugin?.package === "string" && (plugin.package === "ultra-open-code" || samePath(plugin.package, productionPluginDirectory) || samePath(plugin.package, join(productionPluginDirectory, "index.ts"))))
  return loadProjectConfig(entry?.options ?? {}, directory)
}

function summary(run: Run) {
  return { id: run.id, status: run.status, mode: run.mode, phase: run.phase, revision: run.revision, objective: run.objective, updatedAt: run.updatedAt, tasks: run.tasks.map(task => ({ id: task.spec.id, status: task.status, attempts: task.attempts.length })) }
}

/** Offline inspection only: genuine native invocation contexts are never fabricated. */
export async function executeLocalCommand(args: string[], options: { directory?: string } = {}): Promise<LocalResult> {
  let store: SQLiteStore | undefined
  try {
    const input: string[] = []
    let directory = options.directory ?? process.cwd()
    let configPath: string | undefined
    let statePath: string | undefined
    let execute = false
    for (let index = 0; index < args.length; index++) {
      const value = args[index]!
      if (value === "--project" || value === "--config" || value === "--state") {
        const next = args[++index]
        if (!next) throw new Error(`Missing ${value} argument`)
        if (value === "--project") directory = next
        else if (value === "--config") configPath = next
        else statePath = next
      } else if (value === "--execute") execute = true
      else if (value.startsWith("--")) throw new Error(`Unknown local option: ${value}`)
      else input.push(value)
    }
    const [verb = "help", ...arguments_] = input
    if (statePath && !["list", "status", "inspect", "export"].includes(verb)) throw new Error("--state is supported only by list, status, inspect, and export")
    if (verb === "help") return { exitCode: 0, output: localHelp }
    directory = await realpath(resolve(directory))
    if (verb === "validate") {
      if (arguments_.length || execute) throw new Error("validate accepts --config and --project only")
      return { exitCode: 0, output: json({ valid: true, supportedRuntime: "2.0.25", modelAvailability: "requires the live OpenCode catalog", config: await configuration(directory, configPath) }) }
    }
    if (verb === "render") {
      if (!arguments_.length) throw new Error("render requires an objective")
      const objective = arguments_.join(" ")
      const planning = defaultPlanningPlan(objective)
      const config = await configuration(directory, configPath)
      return { exitCode: 0, output: json(execute ? defaultExecutionPlan(objective, planning.criteria, config.checks) : planning) }
    }
    if (!["list", "status", "inspect", "export"].includes(verb)) throw new Error(`Unknown local command: ${verb}. Start and control workflows through /ultracode inside OpenCode.`)
    if (configPath || execute) throw new Error("Snapshot commands accept --project and --state only")
    if ((verb === "list" && arguments_.length) || (verb === "status" && arguments_.length > 1) || (verb === "inspect" && (arguments_.length < 1 || arguments_.length > 2)) || (verb === "export" && arguments_.length !== 1)) throw new Error(localHelp)
    const databasePath = resolve(statePath ?? join(directory, ".ultracode", "state.sqlite"))
    const stateDirectory = dirname(databasePath)
    if (!existsSync(databasePath)) {
      if ((verb === "status" && !arguments_.length) || verb === "list") return { exitCode: 0, output: json({ snapshot: true, runs: [] }) }
      throw new Error("No local Ultra state database exists for this project")
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

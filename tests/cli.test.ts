import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { executeLocalCommand } from "../scripts/cli.ts"
import { installProject, parseNativeConfiguration } from "../scripts/install.ts"
import { SQLiteStore } from "../src/store.ts"
import { parseConfig } from "../src/config.ts"
import type { Run } from "../src/types.ts"

async function fixture() {
  const base = join(process.cwd(), ".spike")
  mkdirSync(base, { recursive: true })
  const directory = await mkdtemp(join(base, "cli-"))
  const plugin = join(directory, "plugin")
  mkdirSync(plugin)
  await writeFile(join(plugin, "index.ts"), "export default {}\n")
  return { directory, plugin }
}

describe("project installer and local CLI", () => {
  test("merges native project settings without forwarding or printing credentials", async () => {
    const { directory, plugin } = await fixture()
    const native = { model: "private/model", providers: { private: { settings: { apiKey: "secret-credential", baseURL: "https://example.invalid/v1" } } }, plugins: [{ package: "another-plugin", options: { active: true } }], experimental: { anotherFlag: true }, permissions: [{ action: "shell", resource: "*", effect: "ask" }] }
    const path = join(directory, "opencode.json")
    await writeFile(path, JSON.stringify(native))
    const installed = await installProject({ directory, pluginPath: join(plugin, "index.ts"), hostVersion: "2.0.25" })
    const result = JSON.parse(await readFile(path, "utf8"))
    expect(result.providers).toEqual(native.providers)
    expect(result.model).toBe(native.model)
    expect(result.permissions).toEqual(native.permissions)
    expect(result.plugins).toEqual([{ package: "another-plugin", options: { active: true } }, { package: plugin }])
    expect(result.experimental).toEqual({ anotherFlag: true, subagent_depth: 2 })
    expect(result.agents["ultra-supervisor"].mode).toBe("subagent")
    expect(result.agents["ultra-worker"].permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    expect(await readFile(installed.backup!, "utf8")).toBe(JSON.stringify(native))
    expect(JSON.stringify(installed)).not.toContain("secret-credential")
    await installProject({ directory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(JSON.parse(await readFile(path, "utf8")).plugins).toHaveLength(2)
  })

  test("supports JSONC syntax without damaging URL strings and preserves the original backup", async () => {
    const { directory, plugin } = await fixture()
    const source = '{ // project settings\n "model": "provider/model", "providers": {"custom":{"settings":{"baseURL":"https://example.invalid/a//b"}}}, /* note */ }'
    const path = join(directory, "opencode.jsonc")
    await writeFile(path, source)
    const installed = await installProject({ directory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(installed.path).toBe(path)
    expect(parseNativeConfiguration(await readFile(path, "utf8")).providers).toEqual({ custom: { settings: { baseURL: "https://example.invalid/a//b" } } })
    expect(await readFile(installed.backup!, "utf8")).toBe(source)
  })

  test("fails before mutation for incompatible runtime and conflicting reserved agents", async () => {
    const { directory, plugin } = await fixture()
    const path = join(directory, "opencode.json")
    await writeFile(path, '{"agents":{"ultra-supervisor":{"mode":"primary"}}}')
    const original = await readFile(path, "utf8")
    await expect(installProject({ directory, pluginPath: plugin, hostVersion: "2.0.26" })).rejects.toThrow("2.0.25")
    await expect(installProject({ directory, pluginPath: plugin, hostVersion: "2.0.25" })).rejects.toThrow("ultra-supervisor")
    expect(await readFile(path, "utf8")).toBe(original)
  })

  test("validates configuration and renders inspectable graphs without creating runtime state", async () => {
    const { directory } = await fixture()
    const path = join(directory, "ultra.json")
    await writeFile(path, '{"models":{"roles":{"planner":"provider/model#deep"}},"limits":{"workers":2}}')
    const validated = await executeLocalCommand(["validate", "--config", path], { directory })
    expect(validated.exitCode).toBe(0)
    expect(JSON.parse(validated.output).config.models.roles.planner).toBe("provider/model#deep")
    const rendered = await executeLocalCommand(["render", "Inspect queue ordering"], { directory })
    expect(rendered.exitCode).toBe(0)
    expect(JSON.parse(rendered.output).tasks.map((task: any) => task.id)).toContain("critique")
    const status = await executeLocalCommand(["status"], { directory })
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.output).runs).toEqual([])
    expect(existsSync(join(directory, ".ultracode"))).toBe(false)
    expect((await executeLocalCommand(["start", "Fix it"], { directory })).exitCode).toBe(1)
    expect((await executeLocalCommand(["help"], { directory })).output).toContain("OpenCode")
  })

  test("model-only installation preserves omitted checks and previews the same discovered project scripts as the live plugin", async () => {
    const { directory } = await fixture()
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit", lint: "lint-project", build: "build-project" } }))
    await writeFile(join(directory, "bun.lock"), "fixture lock")
    await installProject({ directory, hostVersion: "2.0.25", config: { models: { roles: { planner: "provider/model#deep" } } } })
    const installed = JSON.parse(await readFile(join(directory, "opencode.json"), "utf8"))
    expect(installed.plugins[0].options.checks).toBeUndefined()
    const validated = await executeLocalCommand(["validate"], { directory })
    expect(validated.exitCode).toBe(0)
    const config = JSON.parse(validated.output).config
    expect(config.models.roles.planner).toBe("provider/model#deep")
    expect(config.checks).toEqual(["test", "typecheck", "lint"].map(id => ({ id, command: `bun run ${id}`, criterionIds: ["verification"] })))
    const rendered = await executeLocalCommand(["render", "--execute", "Fix cancellation"], { directory })
    expect(rendered.exitCode).toBe(0)
    const plan = JSON.parse(rendered.output)
    expect(plan.tasks.find((task: any) => task.id === "verify").checkIds).toEqual(["test", "typecheck", "lint"])
    expect(plan.criteria.find((criterion: any) => criterion.id === "verification")).toMatchObject({ required: true, kind: "check" })
    expect(existsSync(join(directory, ".ultracode"))).toBe(false)
  })

  test("an explicit empty check list remains disabled despite available project scripts", async () => {
    const { directory } = await fixture()
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    await installProject({ directory, hostVersion: "2.0.25", config: { models: { roles: { planner: "provider/model" } }, checks: [] } })
    expect(JSON.parse(await readFile(join(directory, "opencode.json"), "utf8")).plugins[0].options.checks).toEqual([])
    const validated = await executeLocalCommand(["validate"], { directory })
    expect(JSON.parse(validated.output).config.checks).toEqual([])
    const rendered = await executeLocalCommand(["render", "--execute", "Inspect cancellation"], { directory })
    expect(JSON.parse(rendered.output).tasks.find((task: any) => task.id === "verify").checkIds).toEqual([])
  })

  test("explicit configuration files discover npm scripts while an explicit custom check replaces discovery", async () => {
    const { directory } = await fixture()
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }))
    const path = join(directory, "ultra.json")
    await writeFile(path, JSON.stringify({ limits: { workers: 2 } }))
    const discovered = await executeLocalCommand(["validate", "--config", path], { directory })
    expect(JSON.parse(discovered.output).config.checks).toEqual([{ id: "test", command: "npm run test", criterionIds: ["verification"] }])
    const checks = [{ id: "custom", command: "node custom.js", criterionIds: ["custom-proof"] }]
    await writeFile(path, JSON.stringify({ checks }))
    const explicit = await executeLocalCommand(["validate", "--config", path], { directory })
    expect(JSON.parse(explicit.output).config.checks).toEqual(checks)
  })

  test("lists and exports saved run snapshots with sanitized history", async () => {
    const { directory } = await fixture()
    const state = join(directory, ".ultracode")
    const store = new SQLiteStore(join(state, "state.sqlite"))
    const run: Run = { id: "run_cli", projectId: "project", directory, parentSessionId: "ses_parent", intentId: "intent", intentExpiresAt: 0, objective: "Inspect persisted evidence", mode: "plan", status: "ready", phase: "planning", revision: 1, plans: [], tasks: [], criteria: [], capturedModel: { providerID: "provider", id: "model" }, modelOptions: {}, config: parseConfig({}), policy: [], workspaceHash: "hash", createdAt: 1, updatedAt: 2, activeMs: 0, repairRound: 0, continuation: 0, ownerEpoch: 0, generation: 0, errors: [], notifications: [] }
    store.create(run)
    store.event(run.projectId, { runId: run.id, kind: "example", data: { apiKey: "private-key" } })
    store.close()
    const listed = await executeLocalCommand(["list"], { directory })
    expect(JSON.parse(listed.output).runs[0].id).toBe("run_cli")
    const exported = await executeLocalCommand(["export", "run_cli"], { directory })
    expect(exported.exitCode).toBe(0)
    const paths = JSON.parse(exported.output)
    expect(paths.json).toContain(join(state, "artifacts"))
    expect(await readFile(paths.json, "utf8")).toContain("[REDACTED]")
    expect(await readFile(paths.markdown, "utf8")).toContain("Inspect persisted evidence")
    expect((await executeLocalCommand(["status", "missing"], { directory })).exitCode).toBe(1)
  })

  test("inspects and exports a worktree run from an explicitly selected shared database without changing saved state", async () => {
    const { directory } = await fixture()
    const worktree = join(directory, "worktree")
    mkdirSync(worktree)
    const databasePath = join(directory, ".ultracode", "state.sqlite")
    const store = new SQLiteStore(databasePath)
    const run: Run = { id: "run_worktree", projectId: "shared-project", directory: worktree, parentSessionId: "ses_parent", intentId: "intent", intentExpiresAt: 0, objective: "Inspect worktree evidence", mode: "plan", status: "ready", phase: "planning", revision: 1, plans: [], tasks: [], criteria: [], capturedModel: { providerID: "provider", id: "model" }, modelOptions: {}, config: parseConfig({}), policy: [], workspaceHash: "hash", createdAt: 1, updatedAt: 2, activeMs: 0, repairRound: 0, continuation: 0, ownerEpoch: 7, generation: 3, errors: [], notifications: [] }
    store.create(run)
    store.event(run.projectId, { runId: run.id, kind: "saved-evidence", data: { detail: "unchanged" } })
    const previousRun = store.get(run.id)
    const previousEvents = store.events(run.projectId, run.id)
    store.close()
    const select = ["--project", worktree, "--state", databasePath]
    const inspected = await executeLocalCommand(["inspect", run.id, ...select], { directory })
    expect(inspected.exitCode).toBe(0)
    expect(JSON.parse(inspected.output).run).toMatchObject({ id: run.id, directory: worktree, ownerEpoch: 7, generation: 3 })
    const listed = await executeLocalCommand(["list", ...select], { directory })
    expect(JSON.parse(listed.output).runs.map((saved: any) => saved.id)).toEqual([run.id])
    const status = await executeLocalCommand(["status", run.id, ...select], { directory })
    expect(JSON.parse(status.output).run.status).toBe("ready")
    const exported = await executeLocalCommand(["export", run.id, ...select], { directory })
    expect(exported.exitCode).toBe(0)
    const paths = JSON.parse(exported.output)
    expect(paths.json).toContain(join(directory, ".ultracode", "artifacts"))
    expect(JSON.parse(await readFile(paths.json, "utf8")).data.run.directory).toBe(worktree)
    expect(existsSync(join(worktree, ".ultracode"))).toBe(false)
    expect((await executeLocalCommand(["inspect", run.id, "--project", directory, "--state", databasePath])).exitCode).toBe(1)
    const after = new SQLiteStore(databasePath)
    try {
      expect(after.get(run.id)).toEqual(previousRun)
      expect(after.events(run.projectId, run.id)).toEqual(previousEvents)
    } finally { after.close() }
    expect((await executeLocalCommand(["help"])).output).toContain("--state <state.sqlite>")
  })

  test("explicit state selection is rejected for configuration and graph rendering commands", async () => {
    const { directory } = await fixture()
    const databasePath = join(directory, ".ultracode", "state.sqlite")
    expect((await executeLocalCommand(["validate", "--state", databasePath], { directory })).exitCode).toBe(1)
    expect((await executeLocalCommand(["render", "Describe the workflow", "--state", databasePath], { directory })).exitCode).toBe(1)
    expect((await executeLocalCommand(["list", "--state"], { directory })).output).toContain("Missing --state argument")
    expect(existsSync(join(directory, ".ultracode"))).toBe(false)
  })
})

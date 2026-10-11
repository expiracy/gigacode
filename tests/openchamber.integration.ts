import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import * as fsPromises from "node:fs/promises"
import { join, resolve } from "node:path"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { Rpc } from "@opencode/plugin"
import { EXPECTED_VERSION, startHost, waitFor, type IsolatedHost } from "../spike/host.ts"
import type { Config } from "../src/types.ts"
import { manifest } from "../src/workspace.ts"
import { createWorkflowFixture } from "./workflow-fixture.ts"

const object = { type: "object", additionalProperties: true } as const
const SettingsRpc = Rpc.define({ id: "ultra.open-code", methods: { config: { input: object, output: object } }, events: {} })
interface PluginEntry { id: string; spec: string; scope: "user" | "project"; sourcePath: string; options?: Record<string, unknown> }
interface OpenChamberPlugins {
  listPluginEntries(directory: string): PluginEntry[]
  getPluginEntry(id: string, directory: string): PluginEntry | null
  updatePluginEntry(id: string, updates: { spec?: string; options: Record<string, unknown> }, directory: string): void
}
interface Configuration { config: Config; hostVersion: string; promptVersion: string; directory: string; state: string }
interface Check { name: string; evidence: unknown }
interface ManagedConfigRuntime {
  ownsConfigFile(): boolean
  buildManagedChildEnv(): Promise<NodeJS.ProcessEnv>
}
interface ManagedConfigModule {
  createManagedConfigRuntime(options: {
    fsPromises: typeof fsPromises; path: typeof path; dataDir: string; env: NodeJS.ProcessEnv
    readSettings(): Promise<Record<string, unknown>>; isAgentMemoryAvailable(): boolean
  }): ManagedConfigRuntime
}

async function sourceIdentity(directory: string, modulePath: string) {
  const source = await readFile(modulePath)
  const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex")
  let provenance: unknown
  const verifiedFiles: { path: string; gitBlob: string }[] = []
  if (existsSync(join(directory, "SOURCE.json"))) {
    provenance = JSON.parse(await readFile(join(directory, "SOURCE.json"), "utf8"))
    const files = (provenance as { files?: { path: string; sha: string }[] }).files
    for (const file of files ?? []) {
      const target = resolve(directory, file.path)
      const relative = path.relative(directory, target)
      assert(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Declared source file must stay inside OPENCHAMBER_SOURCE")
      const bytes = await readFile(target)
      const gitBlob = new Bun.CryptoHasher("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
      assert.equal(gitBlob, file.sha, `External production source differs from its declared pinned blob: ${file.path}`)
      verifiedFiles.push({ path: file.path, gitBlob })
    }
  }
  else if (Bun.which("git")) {
    const child = Bun.spawn([Bun.which("git")!, "rev-parse", "HEAD"], { cwd: directory, stdout: "pipe", stderr: "ignore", windowsHide: true })
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (code === 0) provenance = { gitRef: output.trim() }
  }
  return { directory, modulePath, hash, verifiedFiles, ...(provenance ? { provenance } : { provenance: "Unverified external source; this probe does not infer a release version." }) }
}

/**
 * Optional production-reader/writer probe, not a frontend rendering test.
 * OPENCHAMBER_SOURCE must contain OpenChamber's original server modules and
 * their yaml/jsonc-parser dependencies. Sources are never copied into Git.
 */
export async function runOpenChamberIntegration() {
  const requested = process.env.OPENCHAMBER_SOURCE
  if (!requested) throw new Error("Set OPENCHAMBER_SOURCE to a pinned OpenChamber source checkout with dependencies installed. Then run bun tests/openchamber.integration.ts.")
  const sourceDirectory = resolve(requested)
  const modulePath = join(sourceDirectory, "packages", "web", "server", "lib", "opencode", "plugins.js")
  if (!existsSync(modulePath)) throw new Error(`OpenChamber production plugin helper is missing: ${modulePath}`)
  const managedModulePath = join(sourceDirectory, "packages", "web", "server", "lib", "opencode", "managed-config-file.js")
  if (!existsSync(managedModulePath)) throw new Error(`OpenChamber production managed configuration helper is missing: ${managedModulePath}`)
  const source = await sourceIdentity(sourceDirectory, modulePath)
  const root = resolve(".spike", `openchamber-${EXPECTED_VERSION}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`)
  await mkdir(root, { recursive: true })
  const fixture = createWorkflowFixture()
  const checks: Check[] = []
  const application: { change: string; method: "native source reload" | "explicit fixture restart" }[] = []
  let host: IsolatedHost | undefined
  let pluginSnapshot: { directory: string; hash: string } | undefined
  let stage = "prepare isolated native host"
  const previous = { OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, OPENCODE_CONFIG: process.env.OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT }
  const report = async (error?: unknown) => {
    const value = { status: error ? "fail" : "pass", stage, hostVersion: EXPECTED_VERSION, root, source, pluginSnapshot, application, checks, providerRequests: fixture.requests.length, frontendRenderingVerified: false, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }
    await writeFile(join(root, "openchamber.json"), JSON.stringify(value, null, 2) + "\n")
    return value
  }
  const check = async (name: string, work: () => Promise<unknown>) => {
    stage = name
    const evidence = await work()
    assert.equal(fixture.requests.length, 0, "Editing settings must make no model requests")
    checks.push({ name, evidence })
    console.log(`PASS ${name}`)
    await report()
  }
  try {
    const pluginDirectory = join(root, "plugin")
    await mkdir(pluginDirectory, { recursive: true })
    for (const file of ["index.ts", "package.json", "tui.ts"]) await cp(resolve(file), join(pluginDirectory, file))
    await cp(resolve("src"), join(pluginDirectory, "src"), { recursive: true })
    pluginSnapshot = { directory: pluginDirectory, hash: (await manifest(pluginDirectory)).hash }
    const initial = {
      models: { default: "inherit", roles: { planner: "fixture/test", reviewer: "fixture/test" } },
      limits: { workers: 1 }, checks: [], prompts: { planner: "INITIAL_PLANNER" },
    }
    const options = { root, fixtureURL: fixture.baseURL, pluginDirectory, pluginOptions: initial, installGlobal: true, projectConfiguration: true }
    host = await startHost(options)
    const configDirectory = join(root, "config"), globalFile = join(configDirectory, "opencode.json")
    // Use the normal OpenChamber parent profile: global configuration and no
    // parent OPENCODE_CONFIG. Its managed child's extra config is separate.
    // Restore the caller's environment in all outcomes.
    process.env.OPENCODE_CONFIG_DIR = configDirectory
    delete process.env.OPENCODE_CONFIG
    delete process.env.OPENCODE_CONFIG_CONTENT
    const plugins = await import(pathToFileURL(modulePath).href) as OpenChamberPlugins
    const managedModule = await import(pathToFileURL(managedModulePath).href) as ManagedConfigModule
    const rpc = host.client.rpc(SettingsRpc)
    const configuration = (directory = host!.project) => rpc.config({}, { location: { directory }, signal: AbortSignal.timeout(3_000) }) as Promise<Configuration>
    const activate = async (directory: string) => { await host!.client.session.create({ location: { directory }, model: { providerID: "fixture", id: "test" } }) }
    const applied = async (change: string, directory: string, accepts: (value: Configuration) => boolean) => {
      try {
        const value = await waitFor(change, () => configuration(directory), accepts, 6_000)
        application.push({ change, method: "native source reload" })
        return value
      } catch {
        // Some isolated hosts suppress file watching. A restart checks real
        // persistence without claiming that the changed value applied live.
        await host!.restart()
        await activate(directory)
        const value = await waitFor(`${change} after restart`, () => configuration(directory), accepts, 6_000)
        application.push({ change, method: "explicit fixture restart" })
        return value
      }
    }
    await activate(host.project)
    const installed = JSON.parse(await readFile(globalFile, "utf8"))
    const providers = structuredClone(installed.providers), agents = structuredClone(installed.agents)
    await check("production installer options are readable through OpenChamber's native entry editor", async () => {
      const entries = plugins.listPluginEntries(host!.project)
      const entry = entries.find(value => value.scope === "user" && value.spec === pluginDirectory)
      assert(entry)
      assert.equal(entry.sourcePath, globalFile)
      assert.deepEqual(entry.options, initial)
      assert.deepEqual(plugins.getPluginEntry(entry.id, host!.project), entry)
      const effective = await configuration()
      assert.equal(effective.config.models.roles?.planner, "fixture/test")
      assert.equal(effective.config.limits.workers, 1)
      assert.equal(effective.hostVersion, EXPECTED_VERSION)
      return { entry, effective, cardTitle: entry.spec }
    })

    const managed = managedModule.createManagedConfigRuntime({
      fsPromises, path, dataDir: join(root, "openchamber-data"), env: process.env,
      readSettings: async () => ({}), isAgentMemoryAvailable: () => false,
    })
    await check("OpenChamber's managed child configuration does not hide the parent's global entry", async () => {
      assert.equal(managed.ownsConfigFile(), true)
      const childEnvironment = await managed.buildManagedChildEnv()
      assert.equal(process.env.OPENCODE_CONFIG, undefined)
      assert.equal(childEnvironment.OPENCODE_CONFIG, join(root, "openchamber-data", "opencode.managed.json"))
      assert.deepEqual(JSON.parse(await readFile(childEnvironment.OPENCODE_CONFIG!, "utf8")), { plugins: ["-opencode.browser"] })
      const entry = plugins.listPluginEntries(host!.project).find(value => value.scope === "user" && value.spec === pluginDirectory)
      assert.equal(entry?.sourcePath, globalFile)
      assert.deepEqual(entry?.options, initial)
      return { childEnvironment, editorSource: entry?.sourcePath, parentCustomConfig: null, managedChildLaunched: false }
    })

    await check("a user-supplied custom profile is the native editor's user source", async () => {
      const customFile = join(root, "custom-profile.json")
      const customOptions = { limits: { workers: 4 }, prompts: { planner: "CUSTOM_PLANNER" } }
      await writeFile(customFile, JSON.stringify({ plugins: [{ package: pluginDirectory, options: customOptions }], fixture: "preserve" }, null, 2) + "\n")
      const globalBefore = await readFile(globalFile, "utf8")
      process.env.OPENCODE_CONFIG = customFile
      try {
        assert.equal(managed.ownsConfigFile(), false)
        const childEnvironment = await managed.buildManagedChildEnv()
        assert.equal(childEnvironment.OPENCODE_CONFIG, undefined, "The user's inherited config must not be hijacked")
        assert.equal(process.env.OPENCODE_CONFIG, customFile)
        assert.deepEqual(JSON.parse(childEnvironment.OPENCODE_CONFIG_CONTENT!), { plugins: ["-opencode.browser"] })
        const entry = plugins.listPluginEntries(host!.project).find(value => value.scope === "user" && value.spec === pluginDirectory)
        assert.equal(entry?.sourcePath, customFile)
        assert.deepEqual(entry?.options, customOptions)
        plugins.updatePluginEntry(entry!.id, { options: { limits: { workers: 5 } } }, host!.project)
        assert.deepEqual(plugins.getPluginEntry(entry!.id, host!.project)?.options, { limits: { workers: 5 } })
        assert.equal(JSON.parse(await readFile(customFile, "utf8")).fixture, "preserve")
        assert.equal(await readFile(globalFile, "utf8"), globalBefore)
        return { editorSource: customFile, globalSource: globalFile, childEnvironment, nativeCustomProfileActivated: false }
      } finally { delete process.env.OPENCODE_CONFIG }
    })

    // Add a valid, unrelated native plugin to prove that editing one entry
    // preserves other entries as well as provider and dedicated-agent config.
    const unrelatedDirectory = join(root, "unrelated-plugin")
    await mkdir(unrelatedDirectory)
    await writeFile(join(unrelatedDirectory, "package.json"), JSON.stringify({ name: "fixture-unrelated", type: "module", exports: { ".": "./index.ts" } }))
    await writeFile(join(unrelatedDirectory, "index.ts"), 'import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "fixture.unrelated", setup() {} })\n')
    installed.plugins.push({ package: unrelatedDirectory, options: { fixture: "preserve" } })
    await writeFile(globalFile, JSON.stringify(installed, null, 2) + "\n")
    const updated = {
      models: { default: "fixture/alternate", roles: { planner: "fixture/alternate", reviewer: "fixture/alternate" }, stages: { reporting: "fixture/test" } },
      limits: { workers: 3, steps: 8 },
      checks: [{ id: "global-check", command: "echo global-settings-probe", criterionIds: ["verification"] }],
      prompts: { planner: "GLOBAL_PLANNER", reviewer: "GLOBAL_REVIEWER" },
    }
    await check("OpenChamber edits models limits checks and prompts in the global source", async () => {
      const entry = plugins.listPluginEntries(host!.project).find(value => value.scope === "user" && value.spec === pluginDirectory)!
      const before = await readFile(globalFile, "utf8")
      plugins.updatePluginEntry(entry.id, { options: updated }, host!.project)
      const saved = JSON.parse(await readFile(globalFile, "utf8"))
      assert.deepEqual(saved.providers, providers)
      assert.deepEqual(saved.agents, agents)
      assert.deepEqual(saved.plugins.find((value: any) => value.package === unrelatedDirectory), installed.plugins[1])
      assert.equal(saved.plugins.filter((value: any) => value.package === pluginDirectory).length, 1)
      assert.deepEqual(plugins.getPluginEntry(entry.id, host!.project)?.options, updated)
      assert.equal(await readFile(`${globalFile}.openchamber.backup`, "utf8"), before, "OpenChamber keeps the immediate pre-write source in its fixed backup path")
      const effective = await applied("changed global Ultra options", host!.project, value => value.config.prompts?.planner === "GLOBAL_PLANNER")
      assert.deepEqual(effective.config.models.roles, updated.models.roles)
      assert.deepEqual(effective.config.models.stages, updated.models.stages)
      assert.equal(effective.config.limits.workers, 3)
      assert.equal(effective.config.limits.steps, 8)
      assert.deepEqual(effective.config.checks, updated.checks)
      assert.deepEqual(effective.config.prompts, updated.prompts)
      return { entry: plugins.getPluginEntry(entry.id, host!.project), effective, backup: `${globalFile}.openchamber.backup` }
    })

    const projectFile = join(host.project, "opencode.json")
    const projectInitial = { plugins: [{ package: pluginDirectory, options: { checks: [] } }], permissions: [{ action: "*", resource: "*", effect: "allow" }] }
    await writeFile(projectFile, JSON.stringify(projectInitial, null, 2) + "\n")
    const projectOptions = { models: { roles: { planner: "fixture/test" } }, limits: { workers: 2 }, checks: [], prompts: { reviewer: "NATIVE_PROJECT_REVIEWER" } }
    await check("editing the existing project entry replaces native options and preserves global settings", async () => {
      const entries = plugins.listPluginEntries(host!.project)
      const entry = entries.find(value => value.scope === "project" && value.spec === pluginDirectory)
      assert(entry)
      assert.equal(entry.sourcePath, projectFile)
      const globalBefore = await readFile(globalFile, "utf8")
      const projectBefore = await readFile(projectFile, "utf8")
      plugins.updatePluginEntry(entry.id, { options: projectOptions }, host!.project)
      assert.equal(await readFile(globalFile, "utf8"), globalBefore)
      const saved = JSON.parse(await readFile(projectFile, "utf8"))
      assert.deepEqual(saved.permissions, projectInitial.permissions)
      assert.deepEqual(saved.plugins[0].options, projectOptions)
      assert.equal(await readFile(`${projectFile}.openchamber.backup`, "utf8"), projectBefore)
      const effective = await applied("native project Ultra options", host!.project, value => value.config.prompts?.reviewer === "NATIVE_PROJECT_REVIEWER")
      assert.equal(effective.config.models.default, "inherit")
      assert.deepEqual(effective.config.models.roles, projectOptions.models.roles)
      assert.deepEqual(effective.config.models.stages, {})
      assert.equal(effective.config.limits.workers, 2)
      assert.equal(effective.config.limits.steps, 24)
      assert.deepEqual(effective.config.checks, [])
      assert.deepEqual(effective.config.prompts, projectOptions.prompts)
      const other = await configuration(host!.otherProject)
      assert.equal(other.config.models.default, "fixture/alternate")
      assert.equal(other.config.limits.workers, 3)
      return { entry: plugins.getPluginEntry(entry.id, host!.project), effective, otherProject: other.config }
    })

    await check("ultracode.json remains the higher priority field-wise project override", async () => {
      const overrideFile = join(host!.project, "ultracode.json")
      const override = { models: { roles: { reviewer: "fixture/alternate" } }, limits: { steps: 5 }, checks: [{ id: "file-check", command: "echo file-settings-probe", criterionIds: ["verification"] }], prompts: { planner: "FILE_PLANNER" } }
      await writeFile(overrideFile, JSON.stringify(override, null, 2) + "\n")
      // Ultra captures this non-native file during setup. Do not infer that
      // OpenCode watches it merely because it watches native config files.
      await host!.restart()
      await activate(host!.project)
      application.push({ change: "exact-directory ultracode.json", method: "explicit fixture restart" })
      const effective = await configuration()
      assert.deepEqual(effective.config.models.roles, { planner: "fixture/test", reviewer: "fixture/alternate" })
      assert.equal(effective.config.limits.workers, 2)
      assert.equal(effective.config.limits.steps, 5)
      assert.deepEqual(effective.config.checks, override.checks)
      assert.deepEqual(effective.config.prompts, { reviewer: "NATIVE_PROJECT_REVIEWER", planner: "FILE_PLANNER" })
      const entry = plugins.listPluginEntries(host!.project).find(value => value.scope === "project" && value.spec === pluginDirectory)!
      assert.deepEqual(entry.options, projectOptions, "The native options editor shows its source layer, not the standalone Ultra override")
      return { overrideFile, effective, editorOptions: entry.options }
    })
    assert.equal((await manifest(pluginDirectory)).hash, pluginSnapshot.hash, "Production source snapshot must remain unchanged")
    const result = await report()
    console.log(`PASS OpenChamber integration (${checks.length} checks): ${join(root, "openchamber.json")}`)
    return result
  } catch (error) {
    await report(error)
    console.error(`FAIL OpenChamber integration at ${stage}: ${error instanceof Error ? error.message : String(error)}\nEvidence: ${join(root, "openchamber.json")}`)
    throw error
  } finally {
    for (const key of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"] as const) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    try { await host?.stop() } finally { await fixture.stop() }
  }
}

if (import.meta.main) {
  try { await runOpenChamberIntegration() } catch { process.exitCode = 1 }
}

import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { Rpc } from "@opencode/plugin"
import { Database } from "bun:sqlite"
import { EXPECTED_VERSION, startHost, waitFor, type IsolatedHost } from "../spike/host.ts"
import type { Run, Workflow } from "../src/types.ts"
import { promptVersion } from "../src/workflow.ts"
import { ULTRA_PRIMARY_SYSTEM } from "../src/agents.ts"
import { LEGACY_PRIMARY_SYSTEM } from "./legacy-primary-system.ts"
import { manifest } from "../src/workspace.ts"
import { SQLiteStore } from "../src/store.ts"
import type { SettingsView } from "../src/settings.ts"
import { createWorkflowFixture, fixtureExecutionWorkflow, fixturePlanningWorkflow } from "./workflow-fixture.ts"

const object = { type: "object", additionalProperties: true } as const
// This client contract is independent of the implementation under test.
const WorkflowRpc = Rpc.define({ id: "ultra.open-code", methods: {
  status: { input: object, output: object }, inspect: { input: object, output: object },
  config: { input: object, output: object }, control: { input: object, output: object }, export: { input: object, output: object },
  settings: { input: object, output: object }, saveSettings: { input: object, output: object },
}, events: { commandResult: { schema: {
  type: "object", properties: { sessionId: { type: "string", minLength: 1 }, command: { type: "string" }, result: object, error: { type: "string", minLength: 1 } },
  required: ["sessionId", "command"], additionalProperties: false,
} } } })
type Record_ = Record<string, unknown>
type CommandFeedback = { sessionId: string; command: string; result?: Record_; error?: string }
type Check = { name: string; durationMs: number; evidence: unknown }
type NativeContext = Awaited<ReturnType<IsolatedHost["client"]["session"]["context"]>>
type NativeTool = Extract<Extract<NativeContext[number], { type: "assistant" }>["content"][number], { type: "tool" }>
function nativeTools(context: NativeContext, name: string): NativeTool[] {
  return context.flatMap(message => message.type === "assistant" ? message.content.filter((content): content is NativeTool => content.type === "tool" && content.name === name) : [])
}
function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (error && typeof error === "object") {
    const value = error as { type?: unknown; name?: unknown; message?: unknown; data?: { message?: unknown } }
    return `${String(value.type ?? value.name ?? "Remote error")}: ${String(value.data?.message ?? value.message ?? "Native RPC request failed")}`
  }
  return String(error)
}
function runs(value: unknown): Run[] {
  const data = value as { run?: Run; runs?: Run[] }
  return data.run ? [data.run] : data.runs ?? []
}
function inside(root: string, path: string): boolean { const part = relative(resolve(root), resolve(path)); return part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !/^(?:[A-Za-z]:|\/)/.test(part) }

/** Delay only the native prelaunch callback; production modules remain byte-for-byte unchanged. */
async function cancellationBootstrap(root: string, fixtureURL: string) {
  const directory = join(root, "host-plugin")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "index.ts"), `import production from "../plugin/index.ts"
export default { ...production, async setup(ctx) {
  const cleanup = await production.setup(ctx)
  const registration = await ctx.tool.transform(editor => {
    const native = editor.list().find(tool => tool.name === "subagent")
    if (!native) throw new Error("Native subagent missing from cancellation regression")
    editor.update(native.id, tool => {
      const execute = tool.execute
      tool.execute = async (input, context) => {
        const match = /ULTRA_TASK_META\\s+([^\\r\\n]+)/.exec(input.prompt ?? "")
        const meta = match && JSON.parse(match[1])
        if (meta?.role !== "researcher" || !input.prompt.includes("Cancel a native worker while its model stream is held.")) return execute(input, context)
        return execute(input, { ...context, progress: async update => {
          const response = await fetch(${JSON.stringify(fixtureURL + "/native-prelaunch")}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...meta, sessionId: update.sessionID }), signal: context.signal })
          if (!response.ok) throw new Error("Native prelaunch fixture barrier failed")
          await response.json()
          return context.progress(update)
        } })
      }
    })
  })
  return async () => { await registration.dispose(); await cleanup?.() }
} }
`)
  await writeFile(join(directory, "tui.ts"), 'export { default } from "../plugin/tui.ts"\n')
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "ultra-open-code-integration", private: true, type: "module",
    exports: { ".": "./index.ts", "./tui": "./tui.ts" },
  }, null, 2) + "\n")
  return { directory, hash: (await manifest(directory)).hash, purpose: "Hold native researcher progress after child creation and before production binding during the cancellation regression only." }
}

export async function runOpenCodeIntegration() {
  const root = resolve(".spike", `integration-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`)
  await mkdir(root, { recursive: true })
  const fixture = createWorkflowFixture()
  const checks: Check[] = []
  let host: IsolatedHost | undefined
  let finalRun: Run | undefined
  let pluginSnapshot: { directory: string; hash: string } | undefined
  let testInstrumentation: Awaited<ReturnType<typeof cancellationBootstrap>> | undefined
  let stage = "host startup"
  const report = async (error?: unknown) => {
    const result = { status: error ? "fail" : "pass", stage, version: EXPECTED_VERSION, root, pluginSnapshot, testInstrumentation, checks, requests: fixture.requests, prelaunches: fixture.prelaunches, run: finalRun, ...(error ? { error: errorMessage(error) } : {}) }
    await writeFile(join(root, "integration.json"), JSON.stringify(result, null, 2) + "\n")
    return result
  }
  const check = async (name: string, work: () => Promise<unknown>) => {
    stage = name
    const started = Date.now()
    const evidence = await work()
    checks.push({ name, durationMs: Date.now() - started, evidence })
    console.log(`PASS ${name}`)
    await report()
    return evidence
  }
  try {
    // The host watches local plugin source. Freeze this build so concurrent edits
    // elsewhere in the workspace cannot interrupt native fibers mid-probe.
    const pluginDirectory = join(root, "plugin")
    await mkdir(pluginDirectory, { recursive: true })
    await cp(resolve("index.ts"), join(pluginDirectory, "index.ts"))
    await cp(resolve("package.json"), join(pluginDirectory, "package.json"))
    await cp(resolve("tui.ts"), join(pluginDirectory, "tui.ts"))
    await cp(resolve("src"), join(pluginDirectory, "src"), { recursive: true })
    pluginSnapshot = { directory: pluginDirectory, hash: (await manifest(pluginDirectory)).hash }
    testInstrumentation = await cancellationBootstrap(root, fixture.baseURL)
    host = await startHost({ root, fixtureURL: fixture.baseURL, pluginDirectory: testInstrumentation.directory, installGlobal: true, pluginOptions: {
      models: { roles: { planner: "fixture/alternate", reviewer: "fixture/alternate" }, stages: { reporting: "fixture/alternate" } },
      checks: [{ id: "fixture-check", command: "echo fixtureverified", criterionIds: ["verification"] }],
      limits: { workers: 2, repairRounds: 0, workerMs: 15_000, runMs: 60_000 },
      prompts: { planner: "GLOBAL_PLANNER_INSTRUCTIONS", reviewer: "GLOBAL_REVIEWER_INSTRUCTIONS" },
    } })
    // Exercise an existing installation. Native config overrides agent transforms,
    // so the legacy default must be upgraded in the actual model context.
    const installedPath = join(host.root, "config", "opencode.json")
    const installed = JSON.parse(await readFile(installedPath, "utf8"))
    installed.agents.ultra.system = LEGACY_PRIMARY_SYSTEM
    await writeFile(installedPath, JSON.stringify(installed, null, 2))
    await host.restart()
    const client = host.client
    const location = { directory: host.project }
    const rpc = client.rpc(WorkflowRpc)
    const options = () => ({ location, signal: AbortSignal.timeout(5_000) })
    const parent = await client.session.create({ location, model: { providerID: "fixture", id: "test" } })
    const askPrimary = async (id: typeof parent.id, text: string, toolCalls: { name: string; arguments: Record<string, unknown> }[] = []) => {
      if (toolCalls.length) fixture.scriptPrimary({ prompt: text, toolCalls })
      await client.session.prompt({ sessionID: id, text })
      await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(15_000) })
      return client.session.context({ sessionID: id })
    }
    await client.session.prompt({ sessionID: parent.id, text: "ACTIVATE_ULTRA_WORKFLOW", resume: false })
    await check("native production plugin registration", async () => {
      const configuration = await rpc.config({}, options()) as Record_
      assert.equal((configuration.config as { models?: { roles?: { planner?: string } } } | undefined)?.models?.roles?.planner ?? (configuration.models as { roles?: { planner?: string } } | undefined)?.roles?.planner, "fixture/alternate")
      assert.equal(fixture.requests.length, 0)
      return configuration
    })
    await check("Ultra is a visible native primary agent beside Build and Plan", async () => {
      const agents = (await client.agent.list({ location })).data
      const ultra = agents.find(agent => agent.id === "ultra")
      assert(ultra, "Global installation must expose the native Ultra agent")
      assert.equal(ultra.name, "Ultra")
      assert.equal(ultra.mode, "primary")
      assert.equal(ultra.hidden, false)
      assert.equal(ultra.system, LEGACY_PRIMARY_SYSTEM, "Native configuration retains the old value until the installer is rerun")
      assert.ok(agents.some(agent => agent.id === "build" && agent.mode === "primary"))
      assert.ok(agents.some(agent => agent.id === "plan" && agent.mode === "primary"))
      for (const id of ["ultra-supervisor", "ultra-worker"]) {
        const internal = agents.find(agent => agent.id === id)
        assert.equal(internal?.mode, "subagent")
      }
      assert.equal(fixture.requests.length, 0)
      return { agents: agents.filter(agent => ["build", "plan", "ultra", "ultra-supervisor", "ultra-worker"].includes(agent.id)).map(agent => ({ id: agent.id, name: agent.name, mode: agent.mode, hidden: agent.hidden })), modelRequests: 0 }
    })
    await check("configured package exposes the production terminal companion", async () => {
      const production = JSON.parse(await readFile(join(pluginSnapshot!.directory, "package.json"), "utf8"))
      const configured = JSON.parse(await readFile(join(testInstrumentation!.directory, "package.json"), "utf8"))
      assert.equal(production.exports["./tui"], "./tui.ts")
      assert.equal(configured.exports["./tui"], "./tui.ts")
      assert.equal(await readFile(join(testInstrumentation!.directory, "tui.ts"), "utf8"), 'export { default } from "../plugin/tui.ts"\n')
      assert.ok((await readFile(join(pluginSnapshot!.directory, "tui.ts"), "utf8")).includes("@opencode/plugin/tui"))
      assert.equal(fixture.requests.length, 0)
      return { productionExport: production.exports["./tui"], configuredExport: configured.exports["./tui"], productionCompanion: join(pluginSnapshot!.directory, "tui.ts"), nativeRenderingVerified: false }
    })
    await check("native config command emits immediate RPC feedback without queued input or model calls", async () => {
      const session = await client.session.create({ location, model: { providerID: "fixture", id: "test" } })
      const beforeRequests = fixture.requests.length
      const beforeInbox = await client.session.inbox.list({ sessionID: session.id })
      const beforeContext = await client.session.context({ sessionID: session.id })
      const received: { location?: { directory: string }; data: CommandFeedback }[] = []
      const subscription = new AbortController()
      const unsubscribe = rpc.events.on("commandResult", event => { received.push({ location: event.location, data: event.data as CommandFeedback }) }, { signal: subscription.signal })
      // The Promise client shares an SSE connection between native events and
      // RPC listeners. Wait for its connected marker instead of sleeping and
      // racing a live-only command feedback event.
      const readiness = client.event.subscribe({ signal: AbortSignal.any([subscription.signal, AbortSignal.timeout(5_000)]) })[Symbol.asyncIterator]()
      try {
        let ready = await readiness.next()
        while (!ready.done && ready.value.type !== "server.connected") ready = await readiness.next()
        assert.equal(ready.done, false, "Native event connection must be ready before issuing the command")
        await client.session.command({ sessionID: session.id, name: "ultracode", text: "config" })
        const feedback = await waitFor("native config command RPC result", async () => received.find(event => event.data.sessionId === session.id && event.data.command === "config"), value => !!value, 5_000)
        assert(feedback)
        assert.equal(feedback.location?.directory, host!.project)
        assert.equal(feedback.data.error, undefined)
        assert.equal((feedback.data.result?.config as Run["config"]).models.roles?.planner, "fixture/alternate")
        assert.equal(feedback.data.result?.promptVersion, promptVersion)
        assert.deepEqual(await client.session.inbox.list({ sessionID: session.id }), beforeInbox, "Command feedback must not be queued as future model input")
        assert.deepEqual(await client.session.context({ sessionID: session.id }), beforeContext)
        assert.equal(fixture.requests.length, beforeRequests)

        // Configuration RPC remains available to other clients without an
        // active conversation. Terminal feedback uses the native command.
        const configuration = await rpc.config({}, options()) as { config: Run["config"]; hostVersion: string; promptVersion: string; directory: string; state: string }
        assert.equal(configuration.config.models.roles?.planner, "fixture/alternate")
        assert.equal(configuration.config.checks[0]?.id, "fixture-check")
        assert.equal(configuration.hostVersion, EXPECTED_VERSION)
        assert.equal(configuration.promptVersion, promptVersion)
        assert.equal(configuration.directory, host!.project)
        assert.equal(configuration.state, join(host!.project, ".ultracode", "state.sqlite"))
        assert.deepEqual(await client.session.inbox.list({ sessionID: session.id }), beforeInbox)
        assert.deepEqual(await client.session.context({ sessionID: session.id }), beforeContext)
        assert.equal(fixture.requests.length, beforeRequests)

        let rejected = false
        try { await client.session.command({ sessionID: session.id, name: "ultracode", text: "unknown-verb" }) } catch { rejected = true }
        const error = await waitFor("invalid native command RPC feedback", async () => received.find(event => event.data.sessionId === session.id && event.data.command === "unknown-verb"), value => !!value, 5_000)
        assert(error)
        assert.equal(rejected, true)
        assert.match(error.data.error ?? "", /Unknown ultracode command|Usage:/)
        assert.equal(error.data.result, undefined)
        assert.equal(error.location?.directory, host!.project)
        assert.deepEqual(await client.session.inbox.list({ sessionID: session.id }), beforeInbox)
        assert.deepEqual(await client.session.context({ sessionID: session.id }), beforeContext)
        assert.equal(fixture.requests.length, beforeRequests)
        assert.equal(received.filter(event => event.data.sessionId === session.id).length, 2)
        return { feedback: feedback.data, error: error.data, rpcConfiguration: configuration, providerRequests: 0, queuedFeedback: 0, nativeRenderingVerified: false }
      } finally {
        unsubscribe(); subscription.abort(); await readiness.return?.()
      }
    })
    await check("guided project settings persist without model requests or changing global options", async () => {
      const before = await rpc.settings({ sessionId: parent.id }, options()) as unknown as SettingsView
      const requests = fixture.requests.length
      const globalSource = await readFile(installedPath, "utf8")
      assert.equal(before.inherited.limits.workers, 2)
      assert(before.models.some(model => model.providerID === "fixture" && model.id === "test"))
      const changed = { models: { roles: { reviewer: "fixture/test" } }, limits: { workers: 1 }, checks: [{ id: "settings-check", command: "echo settingsverified", criterionIds: ["verification"], timeoutMs: 1000 }] }
      const saved = await rpc.saveSettings({ sessionId: parent.id, revision: before.revision, options: changed }, options()) as unknown as SettingsView
      assert.deepEqual(JSON.parse(await readFile(before.path, "utf8")), changed)
      assert.equal(saved.effective.models.roles?.reviewer, "fixture/test")
      assert.equal(saved.effective.models.roles?.planner, "fixture/alternate")
      assert.equal((await rpc.config({}, options()) as { config: Run["config"] }).config.limits.workers, 1)
      await assert.rejects(rpc.saveSettings({ sessionId: parent.id, revision: before.revision, options: {} }, options()))
      const reset = await rpc.saveSettings({ sessionId: parent.id, revision: saved.revision, options: {} }, options()) as unknown as SettingsView & { backup: string }
      assert.equal(reset.effective.limits.workers, 2)
      assert.equal(reset.effective.checks[0]?.id, "fixture-check")
      assert.deepEqual(JSON.parse(await readFile(reset.backup, "utf8")), changed)
      assert.equal(await readFile(installedPath, "utf8"), globalSource)
      assert.equal(fixture.requests.length, requests)
      return { path: saved.path, backup: reset.backup, staleSaveRejected: true, inheritedChecksRestored: true, providerRequests: 0, nativeRenderingVerified: false }
    })
    await check("guided global defaults apply across projects after reload and preserve project overrides", async () => {
      const requests = fixture.requests.length
      const shared = await rpc.settings({ sessionId: parent.id, scope: "global" }, options()) as unknown as SettingsView
      assert.equal(shared.scope, "global")
      assert.equal(shared.path, installedPath)
      assert.equal(shared.effective.limits.workers, 2)
      const projectSource = await readFile(join(host!.project, "ultracode.json"), "utf8")
      const saved = await rpc.saveSettings({ sessionId: parent.id, scope: "global", revision: shared.revision, options: { ...shared.overrides, limits: { ...shared.overrides.limits, workers: 3 } } }, options()) as unknown as SettingsView
      assert.equal(saved.reloadRequired, true)
      assert.equal(saved.effective.limits.workers, 3)
      assert.equal(await readFile(join(host!.project, "ultracode.json"), "utf8"), projectSource)
      await writeFile(join(host!.otherProject, "ultracode.json"), '{"limits":{"workers":1}}')
      await host!.restart()
      const primary = await rpc.config({}, options()) as { config: Run["config"] }
      const other = await rpc.config({}, { location: { directory: host!.otherProject }, signal: AbortSignal.timeout(5_000) }) as { config: Run["config"] }
      assert.equal(primary.config.limits.workers, 3)
      assert.equal(other.config.limits.workers, 1)
      const refreshed = await rpc.settings({ sessionId: parent.id, scope: "global" }, options()) as unknown as SettingsView
      await rpc.saveSettings({ sessionId: parent.id, scope: "global", revision: refreshed.revision, options: shared.overrides }, options())
      await rm(join(host!.otherProject, "ultracode.json"))
      await host!.restart()
      assert.equal((await rpc.config({}, options()) as { config: Run["config"] }).config.limits.workers, 2)
      assert.equal(fixture.requests.length, requests)
      return { profile: shared.path, inheritedWorkersAfterReload: 3, projectOverrideWorkers: 1, originalDefaultsRestored: true, providerRequests: 0 }
    })
    await check("advanced settings save and reset in both scopes while legacy saves retain them", async () => {
      const requests = fixture.requests.length
      const before = await rpc.settings({ sessionId: parent.id }, options()) as unknown as SettingsView
      const localText = "Review project contracts.\nCheck integer boundaries."
      const saved = await rpc.saveSettings({ sessionId: parent.id, revision: before.revision, replaceAdvanced: true, options: { ...before.overrides, prompts: { reviewer: localText }, parallelWrites: true, autoThreshold: 130 } }, options()) as unknown as SettingsView
      assert.equal(saved.effective.prompts?.reviewer, localText)
      assert.equal(saved.effective.parallelWrites, true)
      assert.equal(saved.effective.autoThreshold, 130)
      const legacy = await rpc.saveSettings({ sessionId: parent.id, revision: saved.revision, options: { limits: { workers: 1 } } }, options()) as unknown as SettingsView
      assert.equal(legacy.effective.prompts?.reviewer, localText)
      assert.equal(legacy.effective.parallelWrites, true)
      await rpc.saveSettings({ sessionId: parent.id, revision: legacy.revision, replaceAdvanced: true, options: before.overrides }, options())
      const projectSource = await readFile(before.path, "utf8")
      const shared = await rpc.settings({ sessionId: parent.id, scope: "global" }, options()) as unknown as SettingsView
      const globalText = "Review shared contracts.\nPreserve public interfaces."
      const globalSaved = await rpc.saveSettings({ sessionId: parent.id, scope: "global", revision: shared.revision, replaceAdvanced: true, options: { ...shared.overrides, prompts: { ...shared.overrides.prompts, reviewer: globalText }, parallelWrites: true, autoThreshold: 150 } }, options()) as unknown as SettingsView
      assert.equal(globalSaved.reloadRequired, true)
      assert.equal(await readFile(before.path, "utf8"), projectSource)
      await host!.restart()
      const active = await rpc.config({}, options()) as { config: Run["config"] }
      assert.equal(active.config.prompts?.reviewer, globalText)
      assert.equal(active.config.parallelWrites, true)
      assert.equal(active.config.autoThreshold, 150)
      const current = await rpc.settings({ sessionId: parent.id, scope: "global" }, options()) as unknown as SettingsView
      await rpc.saveSettings({ sessionId: parent.id, scope: "global", revision: current.revision, replaceAdvanced: true, options: shared.overrides }, options())
      await host!.restart()
      const restored = await rpc.config({}, options()) as { config: Run["config"] }
      assert.equal(restored.config.parallelWrites, false)
      assert.equal(restored.config.autoThreshold, 80)
      assert.equal(fixture.requests.length, requests)
      return { bothScopes: true, legacyAdvancedValuesPreserved: true, multilineInstructionsPreserved: true, originalDefaultsRestored: true, providerRequests: 0 }
    })
    await check("one global installation supplies isolated project overrides and state", async () => {
      for (const directory of [host!.project, host!.otherProject]) for (const file of ["opencode.json", "opencode.jsonc"]) assert.equal(existsSync(join(directory, file)), false)
      const installed = JSON.parse(await readFile(join(host!.root, "config", "opencode.json"), "utf8"))
      assert.equal(installed.plugins.length, 1)
      assert.equal(installed.plugins[0].package, testInstrumentation!.directory)
      assert.match(installed.agents["ultra-supervisor"].system, /exact runId and intentId/)
      await writeFile(join(host!.otherProject, "ultracode.json"), JSON.stringify({
        models: { roles: { planner: "fixture/test" } },
        checks: [], limits: { workers: 1 }, prompts: { reviewer: "PROJECT_REVIEWER_INSTRUCTIONS" },
      }, null, 2) + "\n")
      const otherLocation = { directory: host!.otherProject }
      const otherOptions = () => ({ location: otherLocation, signal: AbortSignal.timeout(5_000) })
      const otherParent = await client.session.create({ location: otherLocation, agent: "ultra", model: { providerID: "fixture", id: "test" } })
      await client.session.prompt({ sessionID: otherParent.id, text: "ACTIVATE_GLOBAL_OTHER_PROJECT", resume: false })
      const primaryConfig = await rpc.config({}, options()) as { config: Run["config"]; state: string }
      const otherConfig = await rpc.config({}, otherOptions()) as { config: Run["config"]; state: string }
      assert.equal(primaryConfig.config.models.roles?.planner, "fixture/alternate")
      assert.equal(otherConfig.config.models.roles?.planner, "fixture/test")
      assert.equal(otherConfig.config.models.roles?.reviewer, "fixture/alternate")
      assert.equal(otherConfig.config.models.stages?.reporting, "fixture/alternate")
      assert.equal(otherConfig.config.limits.workers, 1)
      assert.equal(otherConfig.config.limits.workerMs, primaryConfig.config.limits.workerMs)
      assert.equal(otherConfig.config.limits.repairRounds, 0)
      assert.equal(otherConfig.config.prompts?.planner, "GLOBAL_PLANNER_INSTRUCTIONS")
      assert.equal(otherConfig.config.prompts?.reviewer, "PROJECT_REVIEWER_INSTRUCTIONS")
      assert.equal(primaryConfig.config.prompts?.reviewer, "GLOBAL_REVIEWER_INSTRUCTIONS")
      assert.equal(primaryConfig.config.checks[0]?.id, "fixture-check")
      assert.deepEqual(otherConfig.config.checks, [])
      assert.equal(primaryConfig.state, join(host!.project, ".ultracode", "state.sqlite"))
      assert.equal(otherConfig.state, join(host!.otherProject, ".ultracode", "state.sqlite"))
      assert.notEqual(primaryConfig.state, otherConfig.state)
      assert.deepEqual(runs(await rpc.status({}, otherOptions())), [])
      assert.deepEqual(runs(await rpc.status({}, options())), [])
      const objective = "GLOBAL_INSTALL_PROJECT_NO_CHECKS: Design a fixture in the second project using its optional overrides."
      const workflow: Workflow = {
        rationale: "This settings regression explicitly requests a designer and independent critic using their separate model and prompt overrides.",
        tasks: [
          { id: "design", title: "Design fixture", role: "planner", stage: "design", instructions: objective, dependencies: [], writes: false },
          { id: "critique", title: "Critique the design", role: "reviewer", stage: "design", instructions: "Independently inspect the proposed fixture design against the request", dependencies: ["design"], writes: false },
        ],
      }
      const context = await askPrimary(otherParent.id, objective, [{ name: "ultra_task", arguments: { objective, mode: "plan", workflow } }])
      assert.equal(nativeTools(context, "ultra_task").at(-1)?.state.status, "completed")
      const admitted = await waitFor("other project global primary admission", async () => runs(await rpc.status({}, otherOptions())), values => values.length === 1, 10_000)
      const otherRunId = admitted[0]!.id
      const saved = await waitFor("other project plan settles with overrides", async () => runs(await rpc.status({ runId: otherRunId }, otherOptions()))[0], run => !!run && ["ready", "partial", "failed", "cancelled"].includes(run.status), 60_000)
      assert(saved)
      assert.equal(saved.status, "ready", saved.errors.join("; "))
      assert.deepEqual(saved.plans[0]!.tasks, workflow.tasks)
      assert.deepEqual(saved.tasks.map(task => task.spec), workflow.tasks)
      const planner = saved.tasks.find(task => task.spec.role === "planner")!.attempts.at(-1)!
      const reviewer = saved.tasks.find(task => task.spec.role === "reviewer")!.attempts.at(-1)!
      assert.equal(planner.model.ref.id, "test")
      assert.equal(reviewer.model.ref.id, "alternate")
      assert.deepEqual(saved.config.checks, [])
      assert.ok(fixture.requests.some(request => request.runId === otherRunId && request.role === "planner" && request.model === "test"))
      assert.ok(fixture.requests.some(request => request.runId === otherRunId && request.role === "reviewer" && request.model === "alternate"))
      const inspected = await rpc.inspect({ runId: otherRunId }, otherOptions()) as { events: { kind: string; data: Record<string, unknown> }[] }
      for (const [role, prompt] of [["planner", "GLOBAL_PLANNER_INSTRUCTIONS"], ["reviewer", "PROJECT_REVIEWER_INSTRUCTIONS"]]) {
        const contexts = inspected.events.filter(event => event.kind === "context.observed" && event.data.role === role)
        assert(contexts.length > 0)
        const captured = await Promise.all(contexts.map(event => readFile(String(event.data.artifact), "utf8")))
        assert.ok(captured.some(text => text.includes(prompt)), `Native ${role} context omitted merged instructions`)
      }
      assert.deepEqual(runs(await rpc.status({}, options())), [])
      assert.equal(existsSync(join(host!.otherProject, "implemented.txt")), false)
      const otherState = new SQLiteStore(otherConfig.state)
      const primaryState = new SQLiteStore(primaryConfig.state)
      try {
        assert.equal(otherState.list(saved.projectId).length, 1)
        assert.equal(primaryState.list(saved.projectId).length, 0)
      } finally { otherState.close(); primaryState.close() }
      await client.session.wait({ sessionID: otherParent.id }, { signal: AbortSignal.timeout(10_000) })
      for (const directory of [host!.project, host!.otherProject]) for (const file of ["opencode.json", "opencode.jsonc"]) assert.equal(existsSync(join(directory, file)), false)
      return { oneGlobalPlugin: installed.plugins[0].package, primary: primaryConfig, other: otherConfig, otherRun: { id: saved.id, projectId: saved.projectId, status: saved.status, planner: planner.model, reviewer: reviewer.model }, primaryRuns: 0, projectNativeConfigurations: 0 }
    })
    await check("invalid native command makes no model request", async () => {
      const before = fixture.requests.length
      let rejected = false
      try { await client.session.command({ sessionID: parent.id, name: "ultracode", text: "unknown-verb" }) } catch { rejected = true }
      const context = await client.session.context({ sessionID: parent.id })
      assert.ok(rejected || /Unknown ultracode command|Usage:/.test(JSON.stringify(context)), "The invalid command needs a deterministic error")
      assert.equal(fixture.requests.length, before)
      return { rejected, requests: 0 }
    })
    const objective = "Implement and verify the isolated native integration fixture."
    stage = "native plan command"
    await client.session.command({ sessionID: parent.id, name: "ultracode", text: `plan ${objective}` })
    stage = "native planning admission"
    const admitted = await waitFor("native planning admission", async () => runs(await rpc.status({}, options())), values => values.some(run => run.objective === objective), 10_000)
    const runId = admitted.find(run => run.objective === objective)!.id
    stage = "native planning settles"
    const ready = await waitFor("native plan completes ready", async () => {
      const saved = runs(await rpc.status({ runId }, options())).find(run => run.id === runId)
      finalRun = saved
      return saved
    }, run => !!run && ["ready", "failed", "partial", "cancelled"].includes(run.status), 60_000)
    assert(ready)
    await check("plan saves a concrete proposal without project writes", async () => {
      assert.equal(ready.mode, "plan")
      assert.equal(ready.status, "ready", ready.errors.join("; "))
      assert.equal(ready.tasks.length, 1, "A legacy plan command should use one planner instead of the former fixed five workers")
      assert.equal(ready.tasks[0]!.spec.role, "planner")
      assert.ok(ready.proposal?.tasks.some(task => task.writes))
      assert.equal(existsSync(join(host!.project, "implemented.txt")), false)
      assert.equal(await readFile(join(host!.project, "protected.txt"), "utf8"), "original\n")
      assert.ok(ready.tasks.every(task => task.status === "succeeded" && !task.spec.writes))
      const planner = ready.tasks.find(task => task.spec.role === "planner")!.attempts.at(-1)!
      assert.equal(planner.model.ref.id, "alternate")
      assert.equal(planner.model.origin, "project.role")
      assert.ok(fixture.requests.some(request => request.runId === runId && request.role === "planner" && request.model === "alternate"))
      return { runId, revision: ready.revision, proposal: ready.proposal, plannerModel: planner.model }
    })
    await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(15_000) })
    stage = "saved proposal execution command"
    await client.session.command({ sessionID: parent.id, name: "ultracode", text: `run ${runId}@${ready.revision}` })
    stage = "native execution settles"
    const completed = await waitFor("saved proposal executes with native checks", async () => {
      finalRun = runs(await rpc.status({ runId }, options())).find(run => run.id === runId)
      return finalRun
    }, run => !!run && ["succeeded", "partial", "failed", "cancelled"].includes(run.status), 60_000)
    assert(completed)
    await check("native implementation review and verification succeed", async () => {
      assert.equal(completed.status, "succeeded", JSON.stringify({ errors: completed.errors, tasks: completed.tasks.map(task => ({ id: task.spec.id, status: task.status, attempt: task.attempts.at(-1) })) }))
      assert.equal(await readFile(join(host!.project, "implemented.txt"), "utf8"), "native implementation verified\n")
      assert.equal(await readFile(join(host!.project, "protected.txt"), "utf8"), "original\n")
      const verifier = completed.tasks.find(task => task.spec.id === "native.verify")!
      const evidence = verifier.attempts.find(attempt => attempt.id === verifier.acceptedAttemptId)!.checks
      assert.ok(evidence.some(check => check.checkId === "fixture-check" && check.exit === 0 && check.outcome === "passed" && check.output.includes("fixtureverified")))
      assert.ok(fixture.requests.some(request => request.taskId === "native.implement" && request.calls.includes("write")))
      assert.ok(fixture.requests.some(request => request.taskId === "native.review" && request.calls.includes("read")))
      assert.ok(fixture.requests.some(request => request.taskId === "native.verify" && request.calls.includes("ultra_check")))
      return { runId, status: completed.status, evidence }
    })
    await check("native role restrictions and check permission provenance", async () => {
      const inspected = await rpc.inspect({ runId }, options()) as { events: { kind: string; data: Record<string, any> }[] }
      const check = completed.tasks.find(task => task.spec.id === "native.verify")!.attempts.at(-1)!.checks[0]!
      const permission = inspected.events.find(event => event.kind === "permission.evaluate" && event.data.action === "shell" && event.data.source?.id === check.callId)
      assert(permission)
      assert.deepEqual(permission.data.resources, [check.command])
      assert.equal(permission.data.effect, "allow")
      const contexts = inspected.events.filter(event => event.kind === "context.observed")
      assert(contexts.some(event => event.data.role === "supervisor" && JSON.stringify(event.data.tools) === JSON.stringify(["ultra_execute"])))
      for (const event of contexts) {
        if (event.data.role === "supervisor") continue
        assert.ok(!event.data.tools.some((name: string) => ["subagent", "execute", "shell"].includes(name)))
        if (event.data.role !== "implementer") assert.ok(!event.data.tools.some((name: string) => ["write", "edit", "patch", "apply_patch"].includes(name)))
      }
      assert(contexts.some(event => event.data.role === "verifier" && event.data.tools.includes("ultra_check")))
      return { permission: permission.data, contexts: contexts.map(event => ({ role: event.data.role, tools: event.data.tools })) }
    })
    if (completed.supervisorSessionId) await client.session.wait({ sessionID: completed.supervisorSessionId }, { signal: AbortSignal.timeout(15_000) })
    await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(15_000) })
    await check("status inspect and exported artifacts preserve provenance", async () => {
      const before = fixture.requests.length
      const inspected = await rpc.inspect({ runId, taskId: "native.verify" }, options())
      const exported = await rpc.export({ runId }, options()) as { json: string; markdown: string; dashboard: string; redacted: boolean; completeReplay: boolean }
      assert.ok(JSON.stringify(inspected).includes("fixture-check"))
      assert.equal(exported.redacted, true)
      assert.equal(exported.completeReplay, false)
      for (const path of [exported.json, exported.markdown, exported.dashboard]) assert(inside(root, path), `Export escaped isolated host: ${path}`)
      const json = JSON.parse(await readFile(exported.json, "utf8")) as { redacted: boolean; completeReplay: boolean; data: { run: Run; events: unknown[] } }
      assert.equal(json.data.run.id, runId)
      assert.equal(json.data.run.status, "succeeded")
      assert.ok(json.data.events.length > 0)
      assert.ok((await readFile(exported.markdown, "utf8")).includes("fixture-check"))
      assert.ok((await readFile(exported.dashboard, "utf8")).includes("<!doctype html>"))
      assert.equal(fixture.requests.length, before)
      return { inspected, exported }
    })
    await check("restart preserves settled run and event history", async () => {
      if (completed.supervisorSessionId) await client.session.wait({ sessionID: completed.supervisorSessionId }, { signal: AbortSignal.timeout(15_000) })
      const persistedBefore = runs(await rpc.status({ runId }, options())).find(run => run.id === runId)!
      const historyBefore = await rpc.inspect({ runId }, options()) as { events: { id: string }[] }
      const before = fixture.requests.length
      await host!.restart()
      const activation = await client.session.create({ location, model: { providerID: "fixture", id: "test" } })
      await client.session.prompt({ sessionID: activation.id, text: "ACTIVATE_ULTRA_AFTER_RESTART", resume: false })
      const saved = runs(await rpc.status({ runId }, options())).find(run => run.id === runId)
      assert.equal(saved?.status, "succeeded")
      assert.equal(saved?.generation, persistedBefore.generation)
      assert.deepEqual(saved?.tasks, persistedBefore.tasks)
      const historyAfter = await rpc.inspect({ runId }, options()) as { events: { id: string }[] }
      assert.ok(JSON.stringify(historyAfter).includes("fixture-check"))
      assert.ok(JSON.stringify(historyBefore).includes(persistedBefore.tasks.find(task => task.spec.id === "native.verify")!.acceptedAttemptId!))
      assert.ok(historyBefore.events.every(event => historyAfter.events.some(saved => saved.id === event.id)))
      assert.equal(fixture.requests.length, before)
      return { runId, generation: saved!.generation, status: saved!.status }
    })
    await check("expired start intent rejects native launch", async () => {
      const hold = fixture.holdNext("start")
      const admitted = runs(await rpc.control({ text: "plan Check an expired native start intent.", sessionId: parent.id }, options()))[0]!
      await waitFor("held start intent request", async () => fixture.requests, values => values.some(value => value.hold === hold && value.state === "held"), 10_000)
      const store = new SQLiteStore(join(host!.project, ".ultracode", "state.sqlite"))
      try { store.mutate(admitted.id, run => { run.intentExpiresAt = Date.now() - 1 }) } finally { store.close() }
      fixture.release(hold)
      await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(10_000) })
      const saved = runs(await rpc.status({ runId: admitted.id }, options()))[0]!
      assert.equal(saved.supervisorSessionId, undefined)
      assert.ok(saved.tasks.every(task => task.attempts.length === 0))
      const context = await client.session.context({ sessionID: parent.id })
      const calls = context.flatMap(message => message.type === "assistant" ? message.content.filter(content => content.type === "tool" && content.name === "ultra_start") : []) as unknown as { state: { status: string; error?: unknown } }[]
      const last = calls.at(-1)!
      assert.equal(last.state.status, "error")
      assert.match(JSON.stringify(last.state), /expired/)
      await rpc.control({ text: `cancel ${admitted.id}`, sessionId: parent.id }, options())
      return { runId: admitted.id, expiredAtInjected: true, nativeTool: last.state, launchedWorkers: 0 }
    })
    await check("native supervisor interruption resumes accepted work without duplicate workers", async () => {
      const hold = fixture.holdNext("task", "planner")
      const objective = "Resume a native supervisor with accepted predecessor evidence."
      const workflow: Workflow = { rationale: "Accepted investigation feeds a dependent held planner", tasks: [
        { id: "inspect-prefix", title: "Inspect the project", role: "explorer", stage: "discovery", instructions: "Inspect the project without changes", dependencies: [], writes: false },
        { id: "design-successor", title: "Design from accepted evidence", role: "planner", stage: "design", instructions: "Use the accepted investigation to propose scoped changes", dependencies: ["inspect-prefix"], writes: false },
      ] }
      const initiating = await client.session.create({ location, agent: "ultra", model: { providerID: "fixture", id: "test" } })
      let runId: string | undefined
      try {
        await askPrimary(initiating.id, objective, [{ name: "ultra_task", arguments: { objective, mode: "plan", workflow } }])
        const before = await waitFor("accepted predecessor and held planner", async () => runs(await rpc.status({}, options())).find(run => run.objective === objective), run => !!run?.supervisorSessionId && !!run.tasks[0]?.acceptedAttemptId && fixture.requests.some(request => request.hold === hold && request.state === "held"), 10_000)
        assert(before?.supervisorSessionId)
        runId = before.id
        const accepted = before.tasks[0]!.acceptedAttemptId!, originalSupervisor = before.supervisorSessionId
        await waitFor("scheduler continues observing a held native worker", async () => runs(await rpc.status({ runId }, options()))[0], run => !!run && run.generation > before.generation, 3_000)
        await client.session.interrupt({ sessionID: originalSupervisor, resume: false })
        await client.session.wait({ sessionID: originalSupervisor }, { signal: AbortSignal.timeout(5_000) })
        assert.equal((await client.session.get({ sessionID: originalSupervisor })).outcome, "interrupted")
        const stopped = await waitFor("interrupted scheduler records recovery", async () => runs(await rpc.status({ runId }, options()))[0], run => !!run && ["recovering", "waiting_input"].includes(run.status), 3_000)
        assert(stopped)
        assert.equal(stopped.tasks[0]!.acceptedAttemptId, accepted)
        await rpc.control({ text: `resume ${runId}`, sessionId: initiating.id }, options())
        const resumed = await waitFor("replacement supervisor reuses the active child", async () => runs(await rpc.status({ runId }, options()))[0], run => !!run?.supervisorSessionId && run.supervisorSessionId !== originalSupervisor && run.status === "planning", 10_000)
        assert(resumed)
        fixture.release(hold)
        const ready = await waitFor("recovered plan completes", async () => runs(await rpc.status({ runId }, options()))[0], run => run?.status === "ready", 15_000)
        assert(ready)
        assert.equal(ready.tasks[0]!.acceptedAttemptId, accepted)
        assert(ready.supervisorHistory?.includes(originalSupervisor))
        assert(ready.tasks.every(task => task.attempts.filter(attempt => attempt.status === "succeeded").length === 1))
        assert.equal(fixture.requests.filter(request => request.runId === runId && request.taskId === "inspect-prefix" && request.calls.includes("ultra_submit")).length, 1)
        await client.session.wait({ sessionID: ready.supervisorSessionId! }, { signal: AbortSignal.timeout(10_000) })
        const delivered = await waitFor("native completion notice is delivered", async () => runs(await rpc.status({ runId }, options()))[0], run => !!run && run.notifications.length > 0 && run.notifications.every(notice => notice.delivered), 5_000)
        return { runId, status: ready.status, originalSupervisor, replacementSupervisor: ready.supervisorSessionId, acceptedPredecessor: accepted, notificationsDelivered: delivered!.notifications.length, duplicateSuccessfulAttempts: 0 }
      } finally {
        fixture.release(hold)
        if (runId) await rpc.control({ text: `cancel ${runId}`, sessionId: initiating.id }, options()).catch(() => {})
      }
    })
    await check("initiating cancellation interrupts a held native worker", async () => {
      const hold = fixture.holdNext("task", "explorer")
      const prelaunch = fixture.holdPrelaunch("researcher")
      const objective = "Cancel a native worker while its model stream is held."
      const workflow = fixturePlanningWorkflow(objective)
      const initiating = await client.session.create({ location, agent: "ultra", model: { providerID: "fixture", id: "test" } })
      const context = await askPrimary(initiating.id, objective, [{ name: "ultra_task", arguments: { objective, mode: "plan", workflow } }])
      assert.equal(nativeTools(context, "ultra_task").at(-1)?.state.status, "completed")
      const admitted = runs(await rpc.status({}, options())).find(run => run.objective === objective)!
      assert(admitted)
      assert.deepEqual(admitted.tasks.map(task => task.spec), workflow.tasks)
      await waitFor("held native explorer", async () => fixture.requests, values => values.some(value => value.hold === hold && value.state === "held"), 10_000)
      const child = await waitFor("held native researcher prelaunch", async () => fixture.prelaunches.find(value => value.key === prelaunch), value => value?.state === "held" && !!value.sessionId, 10_000)
      assert(child?.sessionId && child.attemptId)
      const running = runs(await rpc.status({ runId: admitted.id }, options()))[0]!
      const workerId = running.tasks.find(task => task.spec.role === "explorer")!.attempts.at(-1)!.sessionId!
      assert.ok(workerId)
      const reservation = running.tasks.find(task => task.spec.role === "researcher")!.attempts.find(attempt => attempt.id === child.attemptId)!
      assert.equal(reservation.status, "reserved")
      assert.equal(reservation.sessionId, undefined)
      try {
        const cancelling = runs(await rpc.control({ text: `cancel ${admitted.id}`, sessionId: initiating.id }, options()))[0]!
        assert.equal(cancelling.status, "cancelling")
      } finally { fixture.release(prelaunch) }
      const cancelled = await waitFor("native cancellation settles", async () => runs(await rpc.status({ runId: admitted.id }, options()))[0], value => value?.status === "cancelled", 10_000)
      assert(cancelled)
      const worker = await client.session.get({ sessionID: workerId })
      assert.equal(worker.outcome, "interrupted")
      assert.ok(cancelled.tasks.flatMap(task => task.attempts).every(attempt => ["succeeded", "cancelled", "failed"].includes(attempt.status)))
      assert.equal(cancelled.tasks.find(task => task.spec.role === "explorer")!.attempts.at(-1)!.result, undefined)
      const heldRequest = await waitFor("held model stream aborted", async () => fixture.requests.find(request => request.hold === hold), request => request?.state === "aborted", 5_000)
      fixture.release(hold)
      const failedAdmission = await rpc.inspect({ runId: admitted.id }, options()) as { events: { kind: string; data: Record<string, any> }[] }
      const failure = failedAdmission.events.find(event => event.kind === "native.dispatch.failed" && event.data.child === child.sessionId)
      assert(failure)
      assert.equal(failure.data.released, false)
      const settlement = failedAdmission.events.find(event => event.kind === "native.prelaunch.settled" && event.data.sessionId === child.sessionId)
      assert(settlement)
      assert.equal(settlement.data.promptAdmitted, false)
      assert.match(settlement.data.proof, /native.*awaitIdle/)
      assert.ok(!fixture.requests.some(request => request.runId === admitted.id && request.role === "researcher"))
      await client.session.wait({ sessionID: child.sessionId as any }, { signal: AbortSignal.timeout(5_000) })
      const unusedChild = await client.session.get({ sessionID: child.sessionId as any })
      assert.equal(unusedChild.parentID, cancelled.supervisorSessionId)
      assert.deepEqual(await client.session.context({ sessionID: child.sessionId as any }), [])
      const native = new Database(join(host!.root, "host.sqlite"), { readonly: true })
      let pending: number
      try { pending = (native.query("SELECT count(*) AS count FROM session_pending WHERE session_id=?").get(child.sessionId) as { count: number }).count } finally { native.close() }
      assert.equal(pending, 0)
      const savedReservation = cancelled.tasks.find(task => task.spec.role === "researcher")!.attempts.find(attempt => attempt.id === child.attemptId)!
      assert.equal(savedReservation.status, "cancelled")
      assert.equal(savedReservation.sessionId, child.sessionId)
      return { runId: admitted.id, status: cancelled.status, workerId, outcome: worker.outcome, request: heldRequest, reservedPrelaunch: { attemptId: child.attemptId, sessionId: child.sessionId, reservationStatusAtCancel: reservation.status, settledStatus: savedReservation.status, nativeIdleConfirmed: true, nativeOutcome: unusedChild.outcome ?? null, admittedMessages: 0, queuedPrompts: pending, dispatchFailure: failure.data, settlement: settlement.data } }
    })
    await check("automatic mode opt-in persists and dispatches an ordinary long prompt", async () => {
      const current = runs(await rpc.status({}, options()))
      for (const saved of current) if (saved.supervisorSessionId) await client.session.wait({ sessionID: saved.supervisorSessionId }, { signal: AbortSignal.timeout(10_000) })
      for (const id of new Set([parent.id, ...current.map(saved => saved.parentSessionId)])) await client.session.wait({ sessionID: id as any }, { signal: AbortSignal.timeout(10_000) })
      const beforeContext = await client.session.context({ sessionID: parent.id })
      const beforeInbox = await client.session.inbox.list({ sessionID: parent.id })
      const beforeRunIds = current.map(run => run.id).sort()
      await client.session.command({ sessionID: parent.id, name: "ultracode", text: "on" })
      // Other initiating conversations may receive a late native background
      // completion. Prove this command's behavior in its own conversation.
      assert.deepEqual(await client.session.context({ sessionID: parent.id }), beforeContext)
      assert.deepEqual(await client.session.inbox.list({ sessionID: parent.id }), beforeInbox)
      assert.deepEqual(runs(await rpc.status({}, options())).map(run => run.id).sort(), beforeRunIds)
      await host!.restart()
      const beforeActivation = await client.session.context({ sessionID: parent.id })
      const activation = await client.session.prompt({ sessionID: parent.id, text: "ACTIVATE_AUTO_PERSISTENCE", resume: false })
      const activated = await client.session.context({ sessionID: parent.id })
      assert.deepEqual(activated, beforeActivation, "A resume=false input is queued in the inbox without executing a model turn")
      const queuedActivation = (await client.session.inbox.list({ sessionID: parent.id })).find(item => item.id === activation.id)
      assert(queuedActivation && queuedActivation.type === "user")
      assert.equal(queuedActivation.sessionID, parent.id)
      assert.equal(queuedActivation.payload.text, "ACTIVATE_AUTO_PERSISTENCE")
      assert.deepEqual(runs(await rpc.status({}, options())).map(run => run.id).sort(), beforeRunIds)
      const objective = "Automatic mode should coordinate implementation, independent review, and native verification of this isolated fixture while preserving protected.txt."
      await client.session.prompt({ sessionID: parent.id, text: objective })
      const admitted = await waitFor("automatic ordinary prompt admission", async () => runs(await rpc.status({}, options())), values => values.some(value => value.objective === objective), 10_000)
      const automaticId = admitted.find(value => value.objective === objective)!.id
      const saved = await waitFor("automatic run succeeds", async () => runs(await rpc.status({ runId: automaticId }, options()))[0], value => !!value && ["succeeded", "partial", "failed", "cancelled"].includes(value.status), 60_000)
      assert(saved)
      assert.equal(saved.status, "succeeded", saved.errors.join("; "))
      assert.equal(saved.mode, "execute")
      assert.ok(saved.supervisorSessionId)
      await client.session.wait({ sessionID: saved.supervisorSessionId }, { signal: AbortSignal.timeout(10_000) })
      await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(10_000) })
      assert.equal(await readFile(join(host!.project, "protected.txt"), "utf8"), "original\n")
      assert.ok(fixture.requests.some(request => request.runId === automaticId && request.marker === "start"))
      return { runId: automaticId, status: saved.status, mode: saved.mode, restoredOptIn: true }
    })
    await check("automatic mode opt-out preserves ordinary native conversation", async () => {
      await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(10_000) })
      const before = fixture.requests.length
      const beforeContext = await client.session.context({ sessionID: parent.id })
      const beforeInbox = await client.session.inbox.list({ sessionID: parent.id })
      await client.session.command({ sessionID: parent.id, name: "ultracode", text: "off" })
      assert.deepEqual(await client.session.context({ sessionID: parent.id }), beforeContext)
      assert.deepEqual(await client.session.inbox.list({ sessionID: parent.id }), beforeInbox)
      const count = runs(await rpc.status({}, options())).length
      await client.session.prompt({ sessionID: parent.id, text: "Automatic mode is off. This deliberately long ordinary prompt should receive a normal primary conversation response without admitting another workflow." })
      await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(10_000) })
      assert.equal(runs(await rpc.status({}, options())).length, count)
      assert.ok(fixture.requests.slice(before).every(request => request.marker === "ordinary"))
      assert.ok(fixture.requests.slice(before).some(request => request.tools.includes("subagent") && !request.tools.includes("ultra_execute")), "The explicit follow-up should reach the ordinary primary, rather than only a background supervisor completion")
      return { newRuns: 0, ordinaryRequests: fixture.requests.length - before }
    })
    // These are ordinary model tool calls in a selected native primary agent.
    // Custom RPC is used only by the test observer to inspect durable state.
    const ultraParent = await client.session.create({ location, agent: "ultra", model: { providerID: "fixture", id: "test" } })
    const modeFeedback: CommandFeedback[] = []
    const modeSubscription = new AbortController()
    const modeUnsubscribe = rpc.events.on("commandResult", event => { modeFeedback.push(event.data as CommandFeedback) }, { signal: modeSubscription.signal })
    const modeReadiness = client.event.subscribe({ signal: AbortSignal.any([modeSubscription.signal, AbortSignal.timeout(5_000)]) })[Symbol.asyncIterator]()
    let modeRun: Run | undefined
    try {
      let readyEvent = await modeReadiness.next()
      while (!readyEvent.done && readyEvent.value.type !== "server.connected") readyEvent = await modeReadiness.next()
      assert.equal(readyEvent.done, false)
      await check("Ultra config status and conversation use normal tools without admitting a graph", async () => {
        const before = runs(await rpc.status({}, options())).length
        const requestOffset = fixture.requests.length
        const context = await askPrimary(ultraParent.id, "Show the Ultra configuration and current workflow status.", [
          { name: "ultra_control", arguments: { action: "config" } },
          { name: "ultra_control", arguments: { action: "status" } },
        ])
        const controls = nativeTools(context, "ultra_control")
        assert.equal(controls.length, 2)
        assert.ok(controls.every(call => call.state.status === "completed"), JSON.stringify(controls))
        assert.ok(JSON.stringify(controls).includes("fixture/alternate"), "Effective settings must be ordinary native tool content")
        const primary = fixture.requests.slice(requestOffset).find(request => request.marker === "primary")
        assert(primary)
        assert.ok(primary.system?.includes(ULTRA_PRIMARY_SYSTEM), "An existing installed default must become the coding prompt in the real native model request")
        assert.ok(!primary.system?.includes(LEGACY_PRIMARY_SYSTEM), "The exact old default must not reach the model alongside its replacement")
        assert(primary.tools.includes("ultra_task"))
        assert(primary.tools.includes("ultra_control"))
        assert.ok(!primary.tools.some(name => ["write", "edit", "patch", "shell", "subagent", "ultra_start", "ultra_execute", "ultra_submit", "ultra_check"].includes(name)))
        await askPrimary(ultraParent.id, "Explain the recorded configuration without starting project work.")
        assert.equal(runs(await rpc.status({}, options())).length, before)
        assert.equal(nativeTools(await client.session.context({ sessionID: ultraParent.id }), "ultra_task").length, 0)
        assert.equal(modeFeedback.length, 0, "Model tool feedback must not depend on command RPC events")
        assert.ok(!JSON.stringify(await client.session.inbox.list({ sessionID: ultraParent.id })).includes("ULTRA_CONTROL_RESULT"))
        return { sessionId: ultraParent.id, controls: controls.map(call => ({ name: call.name, state: call.state })), newRuns: 0, customCommandEvents: 0, primaryTools: primary.tools }
      })
      await check("ordinary Ultra planning admits one native graph and rejects duplicate task calls", async () => {
        const objective = "Plan the isolated Ultra agent workflow and preserve protected.txt."
        const workflow = fixturePlanningWorkflow(objective)
        const before = runs(await rpc.status({}, options())).length
        const beforeFile = await readFile(join(host!.project, "implemented.txt"), "utf8")
        const hold = fixture.holdNext("task", "explorer")
        let context: NativeContext
        try {
          context = await askPrimary(ultraParent.id, objective, [
            { name: "ultra_task", arguments: { objective, mode: "plan", workflow } },
            { name: "ultra_task", arguments: { objective, mode: "plan", workflow } },
          ])
          const admitted = runs(await rpc.status({}, options())).filter(run => run.objective === objective)
          assert.equal(admitted.length, 1)
          modeRun = admitted[0]!
          assert.equal(runs(await rpc.status({}, options())).length, before + 1)
          assert.equal(modeRun.parentSessionId, ultraParent.id)
          assert.equal(modeRun.mode, "plan")
          assert.deepEqual(modeRun.plans[0]!.tasks, workflow.tasks)
          assert.deepEqual(modeRun.tasks.map(task => task.spec), workflow.tasks)
          assert.ok(modeRun.supervisorSessionId)
          assert.ok(modeRun.admission?.messageId && modeRun.admission.callId && modeRun.admission.requestHash)
          const calls = nativeTools(context, "ultra_task")
          assert.equal(calls.length, 2)
          assert.equal(calls.filter(call => call.state.status === "completed").length, 1, JSON.stringify(calls))
          const duplicate = calls.find(call => call.state.status === "error")
          assert(duplicate)
          assert.match(JSON.stringify(duplicate.state), /active workflow|not available[^\n]*ultra_task/)
          assert.ok(JSON.stringify(calls.find(call => call.state.status === "completed")!.state).includes(modeRun.id), "Launch must have ordinary native tool content with the admitted run ID")
          const completed = calls.find(call => call.state.status === "completed")!
          assert.equal(completed.state.status, "completed")
          if (completed.state.status !== "completed") throw new Error("Native launch did not complete")
          const kickoff = JSON.parse(completed.state.content.map(part => part.type === "text" ? part.text : "").join(""))
          assert.equal(kickoff.run.objective, objective, "The launch handoff must preserve the user's technical task")
          assert.equal(kickoff.run.id, modeRun.id, "The exact control identity remains available")
          assert.equal(kickoff.tasks.find((task: any) => task.id === "explore")?.title, "Inspect project and constraints")
          assert.ok(kickoff.tasks.find((task: any) => task.id === "explore")?.instructions.includes(objective), "The model must see what will be investigated, rather than only task roles and counters")
          const supervisor = await client.session.get({ sessionID: modeRun.supervisorSessionId as any })
          assert.equal(supervisor.parentID, ultraParent.id)
          assert.equal(supervisor.agent, "ultra-supervisor")
          assert.ok(!JSON.stringify(context).includes("ULTRA_START_INTENT"), "A model tool already has a genuine invocation; it must not enqueue a launch intent")
          assert.ok(!JSON.stringify(await client.session.inbox.list({ sessionID: ultraParent.id })).includes("ULTRA_START_INTENT"))
          assert.equal(modeFeedback.length, 0)
          await waitFor("Ultra graph remains active during a follow-up", async () => fixture.requests.find(request => request.hold === hold), request => request?.state === "held", 10_000)
          const progressContext = await askPrimary(ultraParent.id, "Describe what is being investigated in the current task.", [{ name: "ultra_control", arguments: { action: "status", runId: modeRun.id } }])
          const progressCall = nativeTools(progressContext, "ultra_control").at(-1)!
          assert.equal(progressCall.state.status, "completed")
          if (progressCall.state.status !== "completed") throw new Error("Native status did not complete")
          const progress = JSON.parse(progressCall.state.content.map(part => part.type === "text" ? part.text : "").join(""))
          assert.equal(progress.run.objective, objective)
          assert.ok(progress.tasks.some((task: any) => task.instructions?.includes(objective)))
          context = await askPrimary(ultraParent.id, "Continue observing the existing Ultra plan without duplicating its admission.", [{ name: "ultra_task", arguments: { objective, mode: "plan", workflow } }])
          const followup = nativeTools(context, "ultra_task").at(-1)
          assert.equal(followup?.state.status, "error")
          assert.match(JSON.stringify(followup?.state), /active workflow|not available[^\n]*ultra_task/)
          assert.equal(runs(await rpc.status({}, options())).filter(run => run.objective === objective).length, 1)
          assert.equal(runs(await rpc.status({}, options())).length, before + 1)
        } finally { fixture.release(hold) }
        const saved = await waitFor("ordinary Ultra plan ready", async () => runs(await rpc.status({ runId: modeRun!.id }, options()))[0], run => !!run && ["ready", "failed", "partial", "cancelled"].includes(run.status), 60_000)
        assert.equal(saved?.status, "ready", JSON.stringify(saved?.errors))
        modeRun = saved!
        assert.deepEqual(modeRun.tasks.map(task => task.spec), workflow.tasks, "Selected specialists must survive native execution without extra template workers")
        assert.ok(modeRun.proposal?.revision)
        assert.equal(await readFile(join(host!.project, "implemented.txt"), "utf8"), beforeFile)
        assert.equal(await readFile(join(host!.project, "protected.txt"), "utf8"), "original\n")
        assert.ok(modeRun.tasks.filter(task => !["discovery", "design"].includes(task.spec.stage)).every(task => task.attempts.length === 0), "Planning must leave implementation and later task attempts untouched")
        await client.session.wait({ sessionID: modeRun.supervisorSessionId as any }, { signal: AbortSignal.timeout(15_000) })
        await client.session.wait({ sessionID: ultraParent.id }, { signal: AbortSignal.timeout(15_000) })
        return { runId: modeRun.id, status: modeRun.status, mode: modeRun.mode, admission: modeRun.admission, supervisorSessionId: modeRun.supervisorSessionId, taskResults: nativeTools(context!, "ultra_task").map(call => call.state), startIntents: 0, customCommandEvents: 0 }
      })
      await check("Ultra controls retain run ownership across mode switches and execute the saved graph", async () => {
        assert(modeRun?.proposal)
        const before = runs(await rpc.status({}, options())).length
        const stranger = await client.session.create({ location, agent: "ultra", model: { providerID: "fixture", id: "test" } })
        const wrongCaller = await askPrimary(stranger.id, "Attempt control of another initiating conversation's graph.", [{ name: "ultra_control", arguments: { action: "pause", runId: modeRun.id } }])
        const rejected = nativeTools(wrongCaller, "ultra_control").at(-1)
        assert.equal(rejected?.state.status, "error", JSON.stringify(rejected))
        assert.equal(runs(await rpc.status({ runId: modeRun.id }, options()))[0]?.status, "ready")
        await client.session.switchAgent({ sessionID: ultraParent.id, agent: "build" })
        const inspected = await askPrimary(ultraParent.id, "Inspect the Ultra graph after switching the initiating conversation to Build.", [{ name: "ultra_control", arguments: { action: "inspect", runId: modeRun.id } }])
        const control = nativeTools(inspected, "ultra_control").at(-1)
        assert.equal(control?.state.status, "completed", JSON.stringify(control))
        assert(control?.state.status === "completed")
        const inspectionText = control.state.content.map(part => part.type === "text" ? part.text : "").join("")
        const inspectionView = JSON.parse(inspectionText)
        assert.equal(inspectionView.run.id, modeRun.id)
        assert.equal(inspectionView.run.proposalRevision, modeRun.proposal.revision, "A plan answer needs the exact saved proposal revision")
        const acceptedDesign = modeRun.tasks.findLast(task => task.spec.stage === "design" && task.acceptedAttemptId)!
        const designResult = acceptedDesign.attempts.find(attempt => attempt.id === acceptedDesign.acceptedAttemptId)!.result!
        assert.equal(inspectionView.tasks.find((task: any) => task.id === acceptedDesign.spec.id)?.attempts[0]?.resultSummary, designResult.summary, "Whole-run planning inspection must carry the actual accepted technical conclusion")
        assert.equal(inspectionView.events, undefined, "Model content must omit the full native audit stream")
        assert.ok(!inspectionText.includes('"prompt"'), "Model inspection must not repeat captured worker prompts")
        const request = fixture.requests.findLast(value => value.marker === "primary")!
        assert.ok(request.tools.includes("ultra_control"))
        assert.ok(!request.tools.includes("ultra_task"))
        const launch = await askPrimary(ultraParent.id, "Execute the exact saved Ultra plan in this initiating conversation.", [{ name: "ultra_control", arguments: { action: "run", runId: modeRun.id, revision: modeRun.proposal.revision } }])
        assert.equal(nativeTools(launch, "ultra_control").at(-1)?.state.status, "completed")
        const saved = await waitFor("ordinary Ultra saved graph succeeds", async () => runs(await rpc.status({ runId: modeRun!.id }, options()))[0], run => !!run && ["succeeded", "partial", "failed", "cancelled"].includes(run.status), 60_000)
        assert.equal(saved?.status, "succeeded", JSON.stringify(saved?.errors))
        modeRun = saved!
        assert.equal(modeRun.mode, "execute")
        assert.equal(runs(await rpc.status({}, options())).length, before)
        assert.equal(await readFile(join(host!.project, "implemented.txt"), "utf8"), "native implementation verified\n")
        assert.equal(await readFile(join(host!.project, "protected.txt"), "utf8"), "original\n")
        assert.ok(modeRun.tasks.find(task => task.spec.id === "native.verify")?.attempts.some(attempt => attempt.checks.some(check => check.checkId === "fixture-check" && check.outcome === "passed")))
        const history = await rpc.inspect({ runId: modeRun.id }, options()) as { events: { kind: string; data: Record<string, any> }[] }
        for (const event of history.events.filter(event => event.kind === "context.observed")) assert.ok(!event.data.tools.some((name: string) => ["ultra_task", "ultra_control", "ultra_start"].includes(name)))
        const proofContext = await askPrimary(ultraParent.id, "Inspect the recorded native verification evidence without starting another graph.", [{ name: "ultra_control", arguments: { action: "inspect", runId: modeRun.id, taskId: "native.verify" } }])
        const proof = nativeTools(proofContext, "ultra_control").at(-1)
        assert(proof?.state.status === "completed", JSON.stringify(proof))
        const proofText = proof.state.content.map(part => part.type === "text" ? part.text : "").join("")
        const proofView = JSON.parse(proofText)
        const recorded = modeRun.tasks.find(task => task.spec.id === "native.verify")!.attempts.flatMap(attempt => attempt.checks).find(check => check.checkId === "fixture-check" && check.exit === 0)!
        assert.deepEqual(proofView.tasks.flatMap((task: any) => task.attempts.flatMap((attempt: any) => attempt.checks)).find((check: any) => check.id === recorded.id), recorded, "Native model content must retain actual check output and provenance")
        assert.ok(Buffer.byteLength(proofText, "utf8") < 32 * 1024)
        assert.ok(!proofText.includes('"prompt"') && !proofText.includes('"events"'))
        const fullProof = await rpc.inspect({ runId: modeRun.id, taskId: "native.verify" }, options()) as { run: Run; events: unknown[] }
        assert.ok(fullProof.run.tasks[0]!.attempts[0]!.prompt.length > 0 && fullProof.events.length > 0, "Full audit inspection must remain available through RPC")
        await client.session.wait({ sessionID: modeRun.supervisorSessionId as any }, { signal: AbortSignal.timeout(15_000) })
        const supervisorResult = nativeTools(await client.session.context({ sessionID: modeRun.supervisorSessionId as any }), "ultra_execute").at(-1)
        assert(supervisorResult?.state.status === "completed", JSON.stringify(supervisorResult))
        const handoff = JSON.parse(supervisorResult.state.content.map(part => part.type === "text" ? part.text : "").join(""))
        assert.equal(handoff.run.status, "succeeded")
        const acceptedWriter = modeRun.tasks.find(task => task.spec.writes && task.acceptedAttemptId)!
        const writerResult = acceptedWriter.attempts.find(attempt => attempt.id === acceptedWriter.acceptedAttemptId)!.result!
        assert.equal(handoff.tasks.find((task: any) => task.id === acceptedWriter.spec.id)?.attempts[0]?.resultSummary, writerResult.summary, "Completion handoff must explain the implementation rather than only status and export paths")
        assert.deepEqual(handoff.tasks.flatMap((task: any) => task.attempts.flatMap((attempt: any) => attempt.checks)).find((check: any) => check.id === recorded.id), recorded, "Completion handoff must include actual fresh verification evidence")
        assert.equal(runs(await rpc.status({}, options())).length, before)
        assert.equal(modeFeedback.length, 0)
        await client.session.wait({ sessionID: modeRun.supervisorSessionId as any }, { signal: AbortSignal.timeout(15_000) })
        await client.session.wait({ sessionID: ultraParent.id }, { signal: AbortSignal.timeout(15_000) })
        return { runId: modeRun.id, status: modeRun.status, mode: modeRun.mode, sameGraph: true, foreignControl: rejected?.state, ownerAgent: (await client.session.get({ sessionID: ultraParent.id })).agent, customCommandEvents: 0 }
      })
      await check("a small Ultra implementation runs exactly its three selected workers without a planning phase", async () => {
        const session = await client.session.create({ location, agent: "ultra", model: { providerID: "fixture", id: "test" } })
        const objective = "Make the known isolated fixture change with only implementation, independent review and configured verification."
        const workflow = fixtureExecutionWorkflow()
        const before = runs(await rpc.status({}, options())).length
        const context = await askPrimary(session.id, objective, [{ name: "ultra_task", arguments: { objective, mode: "execute", workflow } }])
        const admission = nativeTools(context, "ultra_task").at(-1)
        assert.equal(admission?.state.status, "completed", JSON.stringify(admission))
        const initial = runs(await rpc.status({}, options())).find(run => run.objective === objective)
        assert(initial)
        assert.equal(initial.phase, "execution", "A complete selected graph must bypass the default planning phase")
        assert.deepEqual(initial.plans[0]!.tasks, workflow.tasks)
        const saved = await waitFor("direct small implementation succeeds", async () => runs(await rpc.status({ runId: initial.id }, options()))[0], run => !!run && ["succeeded", "partial", "failed", "cancelled"].includes(run.status), 60_000)
        assert(saved)
        assert.equal(saved.status, "succeeded", JSON.stringify(saved.errors))
        assert.equal(saved.mode, "execute")
        assert.equal(saved.phase, "execution")
        assert.equal(saved.plans.length, 1, "The exact selected graph must not grow a mandatory planning or reporting graph")
        assert.deepEqual(saved.tasks.map(task => task.spec), workflow.tasks)
        assert.equal(saved.tasks.length, 3)
        assert.deepEqual(saved.tasks.map(task => task.spec.role), ["implementer", "reviewer", "verifier"])
        const attempts = saved.tasks.flatMap(task => task.attempts)
        assert.equal(attempts.length, 3)
        assert.equal(new Set(attempts.map(attempt => attempt.sessionId)).size, 3)
        assert.ok(saved.tasks.every(task => task.status === "succeeded" && task.acceptedAttemptId))
        assert.ok(!fixture.requests.some(request => request.runId === saved.id && ["discovery", "design", "reporting"].includes(request.stage ?? "")))
        const nativeChecks = attempts.flatMap(attempt => attempt.checks)
        const evidence = nativeChecks.find(check => check.checkId === "fixture-check")
        assert(evidence)
        assert.equal(evidence.outcome, "passed")
        assert.equal(evidence.exit, 0)
        assert.equal(evidence.workspaceHash, saved.candidateHash ?? saved.workspaceHash)
        assert.ok(evidence.output.includes("fixtureverified"))
        assert.ok(saved.criteria.some(criterion => criterion.id === "request" && criterion.required && criterion.description === objective))
        assert.ok(saved.criteria.some(criterion => criterion.id === "verification" && criterion.required && criterion.kind === "check"))
        for (const attempt of attempts) {
          assert(attempt.sessionId)
          const child = await client.session.get({ sessionID: attempt.sessionId as any })
          assert.equal(child.parentID, saved.supervisorSessionId)
          assert.equal(child.agent, "ultra-worker")
        }
        assert.equal(await readFile(join(host!.project, "implemented.txt"), "utf8"), "native implementation verified\n")
        assert.equal(await readFile(join(host!.project, "protected.txt"), "utf8"), "original\n")
        assert.equal(runs(await rpc.status({}, options())).length, before + 1)
        assert.equal(modeFeedback.length, 0)
        await client.session.wait({ sessionID: saved.supervisorSessionId as any }, { signal: AbortSignal.timeout(15_000) })
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15_000) })
        return { runId: saved.id, status: saved.status, phase: saved.phase, selectedTasks: workflow.tasks, workerSessions: attempts.map(attempt => attempt.sessionId), nativeCheck: evidence, planningWorkers: 0, customCommandEvents: 0 }
      })
      await check("ordinary Build and child conversations cannot forge Ultra task admission", async () => {
        const before = runs(await rpc.status({}, options())).length
        const build = await client.session.create({ location, agent: "build", model: { providerID: "fixture", id: "test" } })
        const buildContext = await askPrimary(build.id, "Forge an Ultra task from an ordinary Build conversation.", [{ name: "ultra_task", arguments: { objective: "This Build request must not admit a graph.", mode: "plan" } }])
        assert.equal(nativeTools(buildContext, "ultra_task").at(-1)?.state.status, "error")
        const buildRequest = fixture.requests.findLast(value => value.marker === "primary")!
        assert.ok(!buildRequest.tools.includes("ultra_task"))
        const child = await client.session.create({ location, parentID: ultraParent.id, agent: "ultra", model: { providerID: "fixture", id: "test" } })
        const childContext = await askPrimary(child.id, "Forge Ultra control from a child conversation.", [{ name: "ultra_control", arguments: { action: "config" } }])
        assert.equal(nativeTools(childContext, "ultra_control").at(-1)?.state.status, "error")
        const childRequest = fixture.requests.findLast(value => value.marker === "primary")!
        assert.ok(!childRequest.tools.some(name => ["ultra_task", "ultra_control"].includes(name)))
        assert.equal(runs(await rpc.status({}, options())).length, before)
        assert.equal(modeFeedback.length, 0)
        return { buildSessionId: build.id, childSessionId: child.id, buildResult: nativeTools(buildContext, "ultra_task").at(-1)?.state, childResult: nativeTools(childContext, "ultra_control").at(-1)?.state, admittedRuns: 0 }
      })
      await check("Ultra task admission rechecks a mode switch after model request", async () => {
        const session = await client.session.create({ location, agent: "ultra", model: { providerID: "fixture", id: "test" } })
        const objective = "A held Ultra request must not launch after the conversation switches to Build."
        fixture.scriptPrimary({ prompt: objective, toolCalls: [{ name: "ultra_task", arguments: { objective, mode: "plan" } }] })
        const hold = fixture.holdNext("primary")
        const before = runs(await rpc.status({}, options())).length
        try {
          await client.session.prompt({ sessionID: session.id, text: objective })
          const requested = await waitFor("held Ultra primary tool response", async () => fixture.requests.find(request => request.hold === hold), request => request?.state === "held", 10_000)
          assert(requested)
          assert.ok(requested.tools.includes("ultra_task"))
          await client.session.switchAgent({ sessionID: session.id, agent: "build" })
        } finally { fixture.release(hold) }
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15_000) })
        const context = await client.session.context({ sessionID: session.id })
        const tool = nativeTools(context, "ultra_task").at(-1)
        assert.equal(tool?.state.status, "error", JSON.stringify(tool))
        assert.equal((await client.session.get({ sessionID: session.id })).agent, "build")
        assert.equal(runs(await rpc.status({}, options())).length, before)
        assert.ok(!runs(await rpc.status({}, options())).some(run => run.objective === objective))
        assert.equal(modeFeedback.length, 0)
        return { sessionId: session.id, tool: tool?.state, admittedRuns: 0, finalAgent: "build" }
      })
    } finally {
      modeUnsubscribe(); modeSubscription.abort(); await modeReadiness.return?.()
    }
    await check("unavailable configured model rejects native admission without fallback", async () => {
      const secondary = await startHost({ root: join(root, "unknown-model"), fixtureURL: fixture.baseURL, pluginDirectory, installGlobal: true, pluginOptions: { models: { default: "fixture/missing" } } })
      try {
        const secondaryLocation = { directory: secondary.project }
        const secondaryRpc = secondary.client.rpc(WorkflowRpc)
        const secondaryOptions = () => ({ location: secondaryLocation, signal: AbortSignal.timeout(5_000) })
        const session = await secondary.client.session.create({ location: secondaryLocation, model: { providerID: "fixture", id: "test" } })
        await secondary.client.session.prompt({ sessionID: session.id, text: "ACTIVATE_UNKNOWN_MODEL", resume: false })
        const before = fixture.requests.length
        let failure: unknown
        try { await secondary.client.session.command({ sessionID: session.id, name: "ultracode", text: "plan Verify that a missing model is rejected before dispatch." }) } catch (error) { failure = error }
        assert(failure, "Unknown model admission must reject")
        assert.match(errorMessage(failure), /not available.*no fallback/)
        assert.equal(fixture.requests.length, before)
        assert.deepEqual(runs(await secondaryRpc.status({}, secondaryOptions())), [])
        return { error: errorMessage(failure), modelRequests: 0, admittedRuns: 0 }
      } finally { await secondary.stop() }
    })
    const result = await report()
    console.log(`PASS integration (${checks.length} checks): ${join(root, "integration.json")}`)
    return result
  } catch (error) {
    await report(error)
    console.error(`FAIL integration at ${stage}: ${errorMessage(error)}\nEvidence: ${join(root, "integration.json")}`)
    throw error
  } finally {
    await host?.stop()
    await fixture.stop()
  }
}

if (import.meta.main) {
  try { await runOpenCodeIntegration() } catch { process.exitCode = 1 }
}

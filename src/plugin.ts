import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Engine } from "./engine.ts"
import { SQLiteStore, sanitizeEventData } from "./store.ts"
import { ArtifactStore } from "./artifacts.ts"
import { loadProjectConfig, resolveModel } from "./config.ts"
import { parseCommand } from "./commands.ts"
import { OpenCodeAdapter, invocation, sessionID, visibleTools } from "./opencode.ts"
import { UltraRpc, type CommandResult } from "./rpc.ts"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { assertPlainPath } from "./workspace.ts"
import { taskResultSchema } from "./results.ts"
import { resourceCleanup } from "./lifecycle.ts"
import { promptVersion } from "./workflow.ts"
import { assertHostVersion } from "./compatibility.ts"
import type { Run, TaskSpec } from "./types.ts"

const supervisorSpec: TaskSpec = { id: "supervisor", title: "Coordinate workflow", role: "supervisor", stage: "design", instructions: "", writes: false, dependencies: [] }
const terminal = new Set(["ready", "succeeded", "partial", "failed", "cancelled"])
const intentText = (run: Run) => `ULTRA_START_INTENT\n${JSON.stringify({ runId: run.id, intentId: run.intentId })}\nThis workflow was explicitly authorized in this initiating conversation. Call ultra_start({runId:${JSON.stringify(run.id)},intentId:${JSON.stringify(run.intentId)}}) once to launch its native supervisor. Do not implement this task while the workflow is active. The durable tools own orchestration and will report status.`

export default Plugin.define({
  id: "ultra.open-code",
  async setup(ctx) {
    const hostVersion = ctx.app.version
    assertHostVersion(hostVersion)
    const directory = await realpath(ctx.location.directory)
    const projectDirectory = await realpath(ctx.location.project.directory)
    const config = await loadProjectConfig(ctx.options, directory)
    if (config.parallelWrites) throw new Error("Parallel writer integration is not enabled in this release. Use the verified single project writer reservation.")
    const root = join(projectDirectory, ".ultracode")
    assertPlainPath(root)
    await mkdir(root, { recursive: true })
    assertPlainPath(join(root, "state.sqlite"))
    const store = new SQLiteStore(join(root, "state.sqlite"))
    const registrations: { dispose: () => Promise<void> }[] = []
    const stop = new AbortController()
    const invocations = new Set<Promise<unknown>>()
    let observer: Promise<void> | undefined
    const cleanup = resourceCleanup({ stop, invocations, registrations, observer: () => observer, close: () => store.close() })
    try {
      const artifacts = new ArtifactStore(join(root, "artifacts"))
      const adapter = new OpenCodeAdapter(ctx, store, artifacts)
      const engine = new Engine(store, adapter, ctx.location.project.id, directory, config, join(root, "state.sqlite"))
      const track = <T>(work: () => Promise<T>): Promise<T> => {
        stop.signal.throwIfAborted()
        const operation = work()
        invocations.add(operation)
        return operation.finally(() => invocations.delete(operation))
      }
      const auto = new Map<string, boolean>()
      for (const event of store.events(ctx.location.project.id)) if (event.kind === "session.auto") {
        const value = event.data as { sessionId: string; enabled: boolean }
        auto.set(value.sessionId, value.enabled)
      }
      const required = (id: string) => {
        const matches = engine.list().filter(run => run.id === id || run.id.startsWith(id))
        if (matches.length !== 1) throw new Error(matches.length ? "Run prefix is ambiguous" : "Unknown project run")
        return matches[0]!
      }
      const summary = (run: Run) => ({ id: run.id, status: run.status, phase: run.phase, mode: run.mode, revision: run.revision, objective: run.objective, tasks: run.tasks.map(task => ({ id: task.spec.id, role: task.spec.role, status: task.status, attempts: task.attempts.length })), errors: run.errors })
      const inspect = (id: string, taskId?: string) => {
        const run = required(id)
        if (taskId && !run.tasks.some(task => task.spec.id === taskId)) throw new Error("Unknown run task")
        return { run: taskId ? { ...run, tasks: run.tasks.filter(task => task.spec.id === taskId) } : run, events: store.events(run.projectId, run.id).filter(event => !taskId || !event.taskId || event.taskId === taskId), replay: { complete: false, source: "durable plugin observations and native snapshots", gap: "OpenCode CLI does not retain native event payload history" } }
      }
      const start = async (objective: string, mode: "plan" | "execute", id: string) => {
        const session = await adapter.scoped(id)
        if (adapter.binding(id) || session.parentID) throw new Error("Start is only available in an initiating primary conversation")
        const agents = (await ctx.agent.list()).data
        if (!["ultra-supervisor", "ultra-worker"].every(name => agents.some(agent => agent.id === name))) throw new Error("Install ultra-supervisor and ultra-worker agent configuration with bun run install:global, then restart OpenCode")
        const primary = agents.find(agent => agent.id === (session.agent ?? "build"))
        if (!primary || !["primary", "all"].includes(primary.mode)) throw new Error("The initiating primary agent is unavailable; authorization cannot be captured")
        const inherited = session.model ?? primary.model ?? (await ctx.model.default()).data
        if (!inherited) throw new Error("Select a model in the initiating conversation before starting")
        const catalog = await adapter.models()
        const available = catalog.find(model => model.providerID === inherited.providerID && model.id === inherited.id)
        // Native sessions use "default" as an implicit variant sentinel even when no variants exist.
        const variant = "variant" in inherited && inherited.variant && (inherited.variant !== "default" || available?.variants.includes("default")) ? inherited.variant : undefined
        const capturedModel = { providerID: inherited.providerID, id: inherited.id, ...(variant ? { variant } : {}) }
        // Validate the supervisor model before reserving capacity as well as each worker model in Engine.start.
        resolveModel(supervisorSpec, { capturedModel, modelOptions: {}, config }, catalog)
        return engine.start({ objective, mode, parentSessionId: id, capturedModel, policy: [...primary.permissions, ...(session.permissions ?? [])] })
      }
      const enqueue = async (run: Run) => {
        try {
          await ctx.session.synthetic({ sessionID: sessionID(run.parentSessionId), text: intentText(run), delivery: "queue", resume: true, metadata: { ultraRunId: run.id, ultraIntent: run.intentId } })
        } catch (error) { await engine.launchFailed(run.id, error); throw error }
        adapter.record(run, "intent.enqueued", { intentId: run.intentId, parentSessionId: run.parentSessionId })
      }
      const controlRaw = async (text: string, id: string) => {
        const command = parseCommand(text) // No model request or state change for malformed input.
        const caller = await adapter.scoped(id)
        if (adapter.binding(id)) throw new Error("Workflow workers cannot issue user control commands")
        switch (command.type) {
          case "start": case "plan": {
            const run = await start(command.task, command.type === "plan" ? "plan" : "execute", id)
            await enqueue(run); return { run: summary(run) }
          }
          case "status": return command.id ? { run: summary(required(command.id)) } : { runs: engine.list().map(summary) }
          case "inspect": return inspect(command.id, command.taskId)
          case "export": { const run = required(command.id); return artifacts.export(run, store.events(run.projectId, run.id)) }
          case "config": return { config, hostVersion, promptVersion, parallelWrites: "single project writer", state: join(root, "state.sqlite") }
          case "on": case "off": {
            if (caller.parentID) throw new Error("Automatic mode is only available in an initiating primary conversation")
            const enabled = command.type === "on"
            auto.set(id, enabled); store.event(ctx.location.project.id, { kind: "session.auto", data: { sessionId: id, enabled } }); return { enabled, autoThreshold: config.autoThreshold }
          }
          default: {
            const run = required(command.id)
            if (run.parentSessionId !== id || resolve(run.directory) !== directory) throw new Error("Controls must come from the run's initiating session and location")
            let saved: Run
            if (command.type === "run") saved = await engine.runSaved(run.id, command.revision)
            else if (command.type === "retry") saved = await engine.retry(run.id, command.taskId)
            else if (command.type === "input") saved = await engine.provideInput(run.id, command.answer)
            else if (command.type === "budget") saved = engine.setBudget(run.id, command.limits)
            else saved = await engine[command.type](run.id)
            if (["resume", "retry", "run", "input"].includes(command.type) && saved.status === "starting") await enqueue(saved)
            return { run: summary(saved) }
          }
        }
      }
      const control = (text: string, id: string) => track(async () => {
        const command = parseCommand(text)
        return ["status", "inspect", "config", "export"].includes(command.type) ? controlRaw(text, id) : engine.withOwnership(stop.signal, () => controlRaw(text, id))
      })
      let rpcRegistration: RpcRegistration<typeof UltraRpc> | undefined
      const feedback = async (value: CommandResult) => {
        try {
          if (!rpcRegistration) throw new Error("Command feedback is not registered")
          await rpcRegistration.events.emit("commandResult", sanitizeEventData(value) as Record<string, unknown>)
        } catch (error) {
          // A presentation failure must not fail or repeat a completed control mutation.
          try { store.event(ctx.location.project.id, { kind: "command.feedback.failed", data: { sessionId: value.sessionId, command: value.command, error: String(error) } }) } catch {}
        }
      }
      registrations.push(await ctx.command.transform(editor => editor.add({ name: "ultracode", description: "Transparent design, implementation, review and verification workflow", async execute(input) { return track(async () => {
        let result: Record<string, unknown>
        try { result = await control(input.prompt.text, input.sessionID) }
        catch (error) {
          const message = (error instanceof Error ? error.message : String(error)) || "Unknown command error"
          await feedback({ sessionId: input.sessionID, command: input.prompt.text, error: message })
          throw error
        }
        await feedback({ sessionId: input.sessionID, command: input.prompt.text, result })
      }) } })))
      registrations.push(await ctx.tool.transform(editor => {
        const originalAdd = editor.add.bind(editor)
        editor.add = tool => originalAdd({ ...tool, execute: (input, context) => track(() => {
          const native = { ...context, signal: AbortSignal.any([context.signal, stop.signal]) }
          return engine.withOwnership(native.signal, () => tool.execute(input, native))
        }) })
        editor.add({ name: "ultra_start", description: "Consume an authorized Ultracode start intent and launch its native supervisor.", input: Schema.Struct({ runId: Schema.String, intentId: Schema.String }), output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          const run = required(input.runId)
          await adapter.scoped(context.sessionID)
          engine.consumeStartIntent(run.id, input.intentId, context.sessionID)
          try {
            const model = resolveModel(supervisorSpec, run, await adapter.models())
            const child = await adapter.supervisor(run, invocation(context), model, async id => engine.bindSupervisor(run.id, input.intentId, id))
            return { content: `Ultracode ${run.id} launched. Use /ultracode status ${run.id} to inspect it.`, output: { runId: run.id, ...child } }
          } catch (error) { await engine.launchFailed(run.id, error); throw error }
        } })
        editor.add({ name: "ultra_execute", description: "Drive and reconcile the bound run graph from its native supervisor. Await completion; do not call twice concurrently.", input: Schema.Struct({ runId: Schema.String, intentId: Schema.optionalKey(Schema.String) }), output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          const run = required(input.runId)
          if (run.supervisorSessionId !== context.sessionID || (input.intentId && input.intentId !== run.intentId)) throw new Error("Only the bound supervisor can drive this run")
          await adapter.scoped(context.sessionID)
          const controller = new AbortController()
          const signal = AbortSignal.any([context.signal, stop.signal, controller.signal])
          const drive = engine.drive(run.id, { ...invocation(context), signal, native: { ...context, signal } })
          try {
            const saved = await drive
            await artifacts.write(saved.id, "run", saved)
            const files = await artifacts.export(saved, store.events(saved.projectId, saved.id))
            return { content: `Ultracode ${saved.id}: ${saved.status}. ${JSON.stringify(files)}`, output: { run: summary(saved), files } }
          } finally { controller.abort() }
        } })
        editor.add({ name: "ultra_submit", description: "Submit this worker's attributable structured task result. Native settlement and fresh evidence are still required.", input: Schema.Struct({ result: taskResultSchema }), output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          await adapter.scoped(context.sessionID)
          engine.submit(context.sessionID, input.result)
          const binding = adapter.binding(context.sessionID)!
          const artifact = await artifacts.put({ runId: binding.run.id, attemptId: binding.attempt!.id, result: input.result })
          adapter.record(binding.run, "result.artifact", { attemptId: binding.attempt!.id, artifact })
          return { content: "Result recorded. Finish this worker response without further edits or check claims.", output: { recorded: true, artifact } }
        } })
        editor.add({ name: "ultra_check", description: "Run one explicitly configured native check and record provenance and exit status.", input: Schema.Struct({ checkId: Schema.String }), output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          const binding = adapter.binding(context.sessionID)
          if (!binding) throw new Error("Checks require a bound worker attempt")
          await adapter.scoped(context.sessionID)
          const evidence = await adapter.check(binding, input.checkId, context)
          engine.evidence(context.sessionID, evidence)
          return { content: JSON.stringify(sanitizeEventData(evidence)), output: evidence }
        } })
      }))
      registrations.push(await ctx.permission.hook("evaluate", event => {
        const binding = adapter.binding(event.sessionID)
        if (!binding) return
        if (stop.signal.aborted) { event.effect = "deny"; return }
        const previous = event.effect
        event.effect = adapter.permission(binding, event)
        adapter.record(binding.run, "permission.evaluate", { sessionId: event.sessionID, action: event.action, resources: event.resources, source: event.source, previous, effect: event.effect })
      }))
      registrations.push(await ctx.session.hook("context", event => {
        const binding = adapter.binding(event.sessionID)
        if (!binding) {
          // These tools are internal capabilities, made visible only to their bound sessions.
          for (const name of ["ultra_execute", "ultra_submit", "ultra_check"]) delete event.tools[name]
          return
        }
        return track(async () => {
          if (binding.retired) { event.tools = {}; return }
          event.tools = visibleTools(event.tools, binding.role)
          const artifact = await artifacts.put({ sessionId: event.sessionID, model: event.model, role: binding.role, system: event.system, messages: event.messages, tools: event.tools, options: event.options })
          adapter.record(binding.run, "context.observed", { sessionId: event.sessionID, attemptId: binding.attempt?.id, role: binding.role, model: event.model, tools: Object.keys(event.tools), artifact })
        })
      }))
      registrations.push(await ctx.session.hook("model.request", event => {
        const binding = adapter.binding(event.sessionID)
        if (!binding) return
        stop.signal.throwIfAborted()
        if (event.kind === "primary" && binding.attempt) engine.step(event.sessionID)
        adapter.record(binding.run, "model.request", { sessionId: event.sessionID, model: event.model, kind: event.kind, role: binding.role })
      }))
      registrations.push(await ctx.session.hook("prompt", event => {
        if (adapter.binding(event.sessionID)) { stop.signal.throwIfAborted(); return }
        if (!auto.get(event.sessionID) || event.prompt.text.length < config.autoThreshold || /^(?:ULTRA_|<subagent|\/ultracode)/.test(event.prompt.text.trim())) return
        return track(async () => {
          if (engine.list().some(run => run.parentSessionId === event.sessionID && !terminal.has(run.status))) return
          const run = await start(event.prompt.text, "execute", event.sessionID)
          event.prompt.text = intentText(run)
          event.metadata = { ...event.metadata, ultraRunId: run.id, ultraIntent: run.intentId }
        })
      }))
      registrations.push(await ctx.tool.hook("execute.after", event => {
        if (stop.signal.aborted) return
        const binding = adapter.binding(event.sessionID)
        if (binding) adapter.record(binding.run, "tool.executed", { sessionId: event.sessionID, attemptId: binding.attempt?.id, tool: event.tool, callId: event.id, input: event.input, status: event.status, ...(event.status === "completed" ? { result: event.result } : { error: event.error }) })
      }))
      rpcRegistration = await ctx.rpc.register(UltraRpc, {
        async status(input) { const id = (input as { runId?: string }).runId; return sanitizeEventData(id ? { run: required(id) } : { runs: engine.list() }) as object },
        async inspect(input) { const value = input as { runId: string; taskId?: string }; return sanitizeEventData(inspect(value.runId, value.taskId)) as object },
        async config() { return { config, hostVersion, promptVersion, directory, state: join(root, "state.sqlite") } },
        async control(input) { const value = input as { text: string; sessionId: string }; return sanitizeEventData(await control(value.text, value.sessionId)) as object },
        async export(input) { return track(async () => { const run = required((input as { runId: string }).runId); return artifacts.export(run, store.events(run.projectId, run.id)) }) },
      })
      registrations.push(rpcRegistration)
      // CLI history does not retain native payloads: reconciliation uses snapshots and an explicit audit gap.
      if (engine.list().some(run => !terminal.has(run.status))) {
        store.event(ctx.location.project.id, { kind: "recovery.gap", data: { directory, reason: "Native CLI event payload replay is unavailable; reconcile saved identities with live snapshots before dispatch" } })
        try { await engine.recover() } catch (error) { store.event(ctx.location.project.id, { kind: "recovery.deferred", data: { error: String(error) } }) }
      }
      observer = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
            if (event.location && resolve(event.location.directory) !== directory) continue
            const data = event.data as { sessionID?: string }
            const binding = data?.sessionID && adapter.binding(data.sessionID)
            if (!binding) continue
            store.event(ctx.location.project.id, { id: event.id, runId: binding.run.id, kind: `native.${event.type}`, data: event })
          }
        } catch (error) { if (!stop.signal.aborted) store.event(ctx.location.project.id, { kind: "observer.failed", data: { error: String(error) } }) }
      })()
      store.event(ctx.location.project.id, { kind: "plugin.ready", data: { hostVersion, directory, config } })
      return cleanup
    } catch (error) {
      try { await cleanup() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `Ultracode setup failed: ${String(error)}; cleanup also failed`, { cause: error }) }
      throw error
    }
  },
})

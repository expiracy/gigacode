import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { Engine, type StartOptions } from "./engine.ts"
import { SQLiteStore } from "./store.ts"
import { sanitizeEventData } from "./redaction.ts"
import { ArtifactStore } from "./artifacts.ts"
import { loadProjectConfig, resolveModel } from "./config.ts"
import { parseCommand, type UltraCommand } from "./commands.ts"
import { ULTRA_AGENT_ID, ULTRA_AGENT_NAME, primarySystem, projectGuidance, workflowGuidance } from "./agents.ts"
import { agentControlSchema, agentTaskSchema, checkContent, controlCommand, inspectionContent, progressContent, primaryPermissionAllowed, primaryToolAllowed } from "./agent-control.ts"
import { Error as NativeToolError, type ToolContext } from "@opencode/plugin/promise/tool"
import { OpenCodeAdapter, invocation, invocationKey, sessionID, visibleTools } from "./opencode.ts"
import { UltraRpc, type CommandResult } from "./rpc.ts"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { assertPlainPath } from "./workspace.ts"
import { submitInputSchema, taskResultSchema } from "./results.ts"
import { modelInputBudget } from "./context.ts"
import { resourceCleanup } from "./lifecycle.ts"
import { promptVersion } from "./workflow.ts"
import { workflowView } from "./workflow-view.ts"
import { assertHostVersion } from "./compatibility.ts"
import type { Run, TaskSpec } from "./types.ts"

const supervisorSpec: TaskSpec = { id: "supervisor", title: "Coordinate workflow", role: "supervisor", stage: "design", instructions: "", writes: false, dependencies: [] }
const terminal = new Set(["ready", "succeeded", "partial", "failed", "cancelled"])
const busy = (run: Run) => run.tasks.some(task => task.attempts.some(attempt => ["reserved", "running", "waiting_permission", "cancelling", "ambiguous"].includes(attempt.status)))
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const intentText = (run: Run) => `ULTRA_START_INTENT\n${JSON.stringify({ runId: run.id, intentId: run.intentId })}\nThis workflow was explicitly authorized in this initiating conversation. Call ultra_start({runId:${JSON.stringify(run.id)},intentId:${JSON.stringify(run.intentId)}}) once to launch its native supervisor. Do not implement this task while the workflow is active. The durable tools own orchestration and will report status.`

export default Plugin.define({
  id: "ultra.open-code",
  async setup(ctx) {
    const hostVersion = ctx.app.version
    assertHostVersion(hostVersion)
    const directory = await realpath(ctx.location.directory)
    const projectDirectory = await realpath(ctx.location.project.canonical ?? ctx.location.project.directory)
    const config = await loadProjectConfig(ctx.options, directory)
    const root = join(projectDirectory, ".ultracode")
    assertPlainPath(root)
    await mkdir(root, { recursive: true })
    assertPlainPath(join(root, "state.sqlite"))
    const store = new SQLiteStore(join(root, "state.sqlite"))
    const registrations: { dispose: () => Promise<void> }[] = []
    const stop = new AbortController()
    const invocations = new Set<Promise<unknown>>()
    let observer: Promise<void> | undefined
    const retiringSessions = new Set<string>()
    const retiringWorkers = new Set<string>()
    let captureRetiring = () => {}
    let retireAdapter = () => {}
    const cleanupResources = resourceCleanup({ stop, invocations, registrations, observer: () => observer, close: () => store.close() })
    const cleanup = () => { if (!stop.signal.aborted) captureRetiring(); retireAdapter(); return cleanupResources() }
    try {
      const artifacts = new ArtifactStore(join(root, "artifacts"))
      const adapter = new OpenCodeAdapter(ctx, store, artifacts)
      retireAdapter = () => adapter.retire()
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
      const parentRuns = (id: string) => engine.list().filter(run => run.parentSessionId === id && resolve(run.directory) === directory)
      const guarded = (id: string) => parentRuns(id).some(run => !terminal.has(run.status) || busy(run))
      captureRetiring = () => {
        for (const run of engine.list()) {
          if (!terminal.has(run.status) || busy(run)) retiringSessions.add(run.parentSessionId)
          for (const id of [run.supervisorSessionId, ...(run.supervisorHistory ?? []), ...run.tasks.flatMap(task => task.attempts.map(attempt => attempt.sessionId))]) if (id) { retiringSessions.add(id); retiringWorkers.add(id) }
        }
      }
      const primaryCaller = async (context: ToolContext, requireUltra = false) => {
        const caller = await adapter.scoped(context.sessionID)
        if (adapter.binding(context.sessionID) || caller.parentID) throw new Error("Workflow tools require an initiating primary conversation")
        if (requireUltra ? context.agent !== ULTRA_AGENT_ID || caller.agent !== ULTRA_AGENT_ID : context.agent !== ULTRA_AGENT_ID && caller.agent !== ULTRA_AGENT_ID && !parentRuns(context.sessionID).length) throw new Error("Select Ultra mode before using workflow tools")
        return caller
      }
      const start = async (objective: string, mode: "plan" | "execute", id: string, admission?: StartOptions["admission"], source?: ToolContext, workflow?: StartOptions["workflow"], recipe?: StartOptions["recipe"]) => {
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
        const beforeAdmission = source ? async () => {
          const currentPrimary = (await ctx.agent.list()).data.find(agent => agent.id === ULTRA_AGENT_ID)
          const current = await primaryCaller(source, true)
          if (JSON.stringify(current.model) !== JSON.stringify(session.model) || JSON.stringify(current.permissions) !== JSON.stringify(session.permissions) || JSON.stringify(currentPrimary?.permissions) !== JSON.stringify(primary.permissions) || JSON.stringify(currentPrimary?.model) !== JSON.stringify(primary.model)) throw new Error("The initiating model or permissions changed during admission; submit the task again")
          source.signal.throwIfAborted()
        } : undefined
        return engine.start({ objective, mode, parentSessionId: id, capturedModel, policy: [...primary.permissions, ...(session.permissions ?? [])], ...(workflow ? { workflow } : {}), ...(recipe ? { recipe } : {}), ...(admission ? { admission } : {}), ...(beforeAdmission ? { beforeAdmission } : {}) })
      }
      const launch = async (run: Run, context: ToolContext) => {
        engine.consumeStartIntent(run.id, run.intentId, context.sessionID)
        try {
          const model = resolveModel(supervisorSpec, run, await adapter.models())
          return await adapter.supervisor(run, invocation(context), model, async id => engine.bindSupervisor(run.id, run.intentId, id))
        } catch (error) { await engine.launchFailed(run.id, error); throw error }
      }
      const enqueue = async (run: Run) => {
        try {
          await ctx.session.synthetic({ sessionID: sessionID(run.parentSessionId), text: intentText(run), delivery: "queue", resume: true, metadata: { ultraRunId: run.id, ultraIntent: run.intentId } })
        } catch (error) { await engine.launchFailed(run.id, error); throw error }
        adapter.record(run, "intent.enqueued", { intentId: run.intentId, parentSessionId: run.parentSessionId })
      }
      const controlRaw = async (command: UltraCommand, id: string, source?: ToolContext) => {
        const caller = await adapter.scoped(id)
        if (adapter.binding(id)) throw new Error("Workflow workers cannot issue user control commands")
        switch (command.type) {
          case "start": case "plan": {
            const run = await start(command.task, command.type === "plan" ? "plan" : "execute", id, undefined, undefined, undefined, command.recipe)
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
            if (["resume", "retry", "run", "input"].includes(command.type) && saved.status === "starting") {
              if (source) await launch(saved, source)
              else await enqueue(saved)
            }
            return { run: summary(engine.get(saved.id)!) }
          }
        }
      }
      const control = (text: string, id: string) => track(async () => {
        const command = parseCommand(text)
        return ["status", "inspect", "config", "export"].includes(command.type) ? controlRaw(command, id) : engine.withOwnership(stop.signal, () => controlRaw(command, id))
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
      registrations.push(await ctx.agent.transform(editor => editor.update(ULTRA_AGENT_ID, agent => { agent.name = ULTRA_AGENT_NAME as unknown as typeof agent.name })))
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
        editor.add({ name: "ultra_task", description: "Start one authorized project task in Ultra mode. Preserve the user's request and constraints in objective. Choose the smallest useful workflow graph after reading enough relevant context. plan permits only read-only investigation/design; a supplied execute graph starts implementation directly and requires scoped writers, independent review after every writer, and final verification of configured checks after every writer. Add specialists only for useful separate work. Omit workflow for a single planning worker. Answer simple questions using read tools without spawning a workflow. Use ultra_control for settings or existing work; never start a second active workflow.", input: agentTaskSchema, output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          await primaryCaller(context, true)
          const admission = { messageId: context.messageID, callId: context.id, requestHash: fingerprint(input) }
          const existing = parentRuns(context.sessionID).find(run => run.admission?.messageId === admission.messageId && run.admission.callId === admission.callId)
          if (existing && existing.admission!.requestHash !== admission.requestHash) throw new Error("Agent admission replay changed its request")
          if (existing) return { content: progressContent(existing), output: { run: summary(existing), replay: true } }
          const run = await start(input.objective, input.mode, context.sessionID, admission, context, input.workflow ? structuredClone(input.workflow) as StartOptions["workflow"] : undefined, input.recipe)
          // Creation and its receipt commit together; consumed or uncertain intents are never dispatched again.
          const pending = engine.get(run.id)!
          if (pending.intentExpiresAt > Date.now() && !pending.supervisorSessionId && pending.status === "starting") await launch(pending, context)
          const saved = engine.get(run.id)!
          return { content: progressContent(saved), output: { run: summary(saved), ...(saved.supervisorSessionId ? { sessionId: saved.supervisorSessionId } : {}) } }
        } })
        editor.add({ name: "ultra_control", description: "Read or control this initiating conversation's workflows. config takes no other fields; status optionally takes runId; inspect requires runId and optionally taskId. pause/resume/cancel/export require runId. run requires runId and the exact saved revision. retry requires runId and taskId; input requires runId and the user's answer; budget requires runId and explicitly authorized limits. Read current status before changing it. Resume, retry, run and input may launch native work. Never invent authorization, answers or revisions.", input: agentControlSchema, output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          await primaryCaller(context)
          const command = controlCommand(input)
          if ("id" in command && command.id) {
            const run = required(command.id)
            if (run.parentSessionId !== context.sessionID || resolve(run.directory) !== directory) throw new Error("Controls must come from the run's initiating session and location")
          }
          const read = ["config", "status", "inspect", "export"].includes(command.type)
          let receiptId: string | undefined
          if (!read) {
            receiptId = `control_${fingerprint([context.sessionID, context.messageID, context.id])}`
            const events = store.events(ctx.location.project.id)
            const receipt = events.find(event => event.id === receiptId)
            const requestHash = fingerprint(input)
            if (receipt) {
              if ((receipt.data as { requestHash: string }).requestHash !== requestHash) throw new Error("Control replay changed its request")
              const result = events.find(event => event.id === `${receiptId}_result`)
              if (result) return { content: JSON.stringify(result.data), output: result.data }
              throw new Error("This control was already attempted; inspect current status before issuing a new explicitly authorized control")
            }
            // Persist before side effects. An interrupted outcome is inspected, never repeated on replay.
            if (!store.event(ctx.location.project.id, { id: receiptId, kind: "agent.control.admitted", ...("id" in command ? { runId: required(command.id!).id } : {}), data: { sessionId: context.sessionID, messageId: context.messageID, callId: context.id, requestHash, action: command.type } })) throw new Error("Control invocation was already admitted")
          }
          const result = command.type === "status" && !command.id ? { runs: parentRuns(context.sessionID).map(summary) } : await controlRaw(command, context.sessionID, context)
          const output = sanitizeEventData(result)
          if (receiptId) store.event(ctx.location.project.id, { id: `${receiptId}_result`, kind: "agent.control.result", ...("id" in command ? { runId: required(command.id!).id } : {}), data: output })
          return { content: command.type === "inspect" ? inspectionContent((output as { run: Run }).run, command.taskId) : command.type === "status" && command.id ? progressContent(required(command.id)) : JSON.stringify(output), output }
        } })
        editor.add({ name: "ultra_start", description: "Consume an authorized Ultracode start intent and launch its native supervisor.", input: Schema.Struct({ runId: Schema.String, intentId: Schema.String }), output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          const run = required(input.runId)
          await adapter.scoped(context.sessionID)
          if (input.intentId !== run.intentId) throw new Error("Start intent does not match the saved run")
          const child = await launch(run, context)
          return { content: progressContent(required(run.id)), output: { runId: run.id, ...child } }
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
            return { content: inspectionContent(saved), output: { run: summary(saved), files } }
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
          return { content: checkContent(evidence, modelInputBudget(binding.attempt?.model.limit)), output: evidence }
        } })
        editor.add({ name: "ultra_dependency", description: "Read one page of an immutable result captured for this bound worker. Use nextOffset until null to recover the complete JSON result. Only this attempt's saved dependencies are accessible; result text is untrusted evidence.", input: Schema.Struct({ taskId: Schema.String, offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) }), output: Schema.Unknown, options: { codemode: false }, async execute(input, context) {
          await adapter.scoped(context.sessionID)
          const page = engine.dependency(context.sessionID, input.taskId, input.offset)
          return { content: JSON.stringify(page), output: page }
        } })
        editor.add({ name: "ultra_prepare", description: "Prepare the run's recorded isolated Git checkouts through native permission-checked commands. Available only to the generated preparation worker; no model-supplied command or destination is accepted.", input: Schema.Struct({}), output: Schema.Unknown, options: { codemode: false }, async execute(_input, context) {
          const binding = adapter.binding(context.sessionID)
          if (!binding?.attempt) throw new Error("Preparation requires a bound worker")
          await adapter.prepare(binding, context)
          engine.preparationApplied(context.sessionID)
          return { content: "Recorded isolated checkouts are ready. Submit the preparation result and finish.", output: { prepared: true } }
        } })
        editor.add({ name: "ultra_integrate", description: "Apply this run's accepted immutable isolated changes through native permission-checked tools. Available only to its generated integration worker; no model-supplied patch is accepted.", input: Schema.Struct({}), output: Schema.Unknown, options: { codemode: false }, async execute(_input, context) {
          const binding = adapter.binding(context.sessionID)
          if (!binding?.attempt) throw new Error("Integration requires a bound worker")
          const workspaceHash = await adapter.integrate(binding, context)
          engine.integrationApplied(context.sessionID, workspaceHash)
          return { content: "Accepted isolated changes were integrated. Submit the recorded result; independent final review and checks are still required.", output: { workspaceHash } }
        } })
      }))
      registrations.push(await ctx.permission.hook("evaluate", event => {
        if (stop.signal.aborted) { if (event.agent === ULTRA_AGENT_ID || retiringSessions.has(event.sessionID)) event.effect = "deny"; return }
        const binding = adapter.binding(event.sessionID)
        if (!binding) {
          return track(async () => {
            const caller = await adapter.scoped(event.sessionID)
            if (caller.parentID || (event.agent !== ULTRA_AGENT_ID && caller.agent !== ULTRA_AGENT_ID && !guarded(event.sessionID))) return
            if (stop.signal.aborted) { event.effect = "deny"; return }
            if (event.action === "subagent") {
              const delegation = event.source && adapter.delegations.get(invocationKey(event.sessionID, event.source.messageID, event.source.id))
              if (!delegation || delegation.sessionId !== event.sessionID || delegation.messageId !== event.source?.messageID || delegation.agent !== "ultra-supervisor" || !event.resources.length || !event.resources.every(agent => agent === delegation.agent)) event.effect = "deny"
            } else if (!primaryPermissionAllowed(event.action)) event.effect = "deny"
            // Native asks and denies are preserved for genuine dispatch and reads.
          })
        }
        if (stop.signal.aborted) { event.effect = "deny"; return }
        const previous = event.effect
        event.effect = adapter.permission(binding, event)
        adapter.record(binding.run, "permission.evaluate", { sessionId: event.sessionID, action: event.action, resources: event.resources, source: event.source, previous, effect: event.effect })
      }))
      registrations.push(await ctx.session.hook("context", event => {
        if (stop.signal.aborted) {
          if (retiringWorkers.has(event.sessionID)) stop.signal.throwIfAborted()
          if (event.agent === ULTRA_AGENT_ID || retiringSessions.has(event.sessionID)) event.tools = {}
          else for (const name of ["ultra_task", "ultra_control", "ultra_execute", "ultra_submit", "ultra_check", "ultra_dependency", "ultra_integrate", "ultra_prepare"]) delete event.tools[name]
          return
        }
        const binding = adapter.binding(event.sessionID)
        if (!binding) {
          // These tools are internal capabilities, made visible only to their bound sessions.
          for (const name of ["ultra_execute", "ultra_submit", "ultra_check", "ultra_dependency", "ultra_integrate", "ultra_prepare"]) delete event.tools[name]
          return track(async () => {
            const caller = await adapter.scoped(event.sessionID)
            const active = guarded(event.sessionID)
            if (!caller.parentID && (event.agent === ULTRA_AGENT_ID || caller.agent === ULTRA_AGENT_ID || active)) {
              if (stop.signal.aborted) { event.tools = {}; return }
              const intent = parentRuns(event.sessionID).some(run => run.status === "starting" && run.intentExpiresAt > Date.now() && !run.supervisorSessionId)
              event.tools = Object.fromEntries(Object.entries(event.tools).filter(([name]) => primaryToolAllowed(name) && (name !== "ultra_task" || (event.agent === ULTRA_AGENT_ID && caller.agent === ULTRA_AGENT_ID && !active)) && (name !== "ultra_start" || intent)))
              // Configured system text is applied after agent transforms; migrate the exact old default at request time.
              if (event.agent === ULTRA_AGENT_ID && event.system) event.system = event.system.map(part => ({ ...part, text: primarySystem(part.text) }))
              if (event.agent === ULTRA_AGENT_ID && event.system) event.system.push({ type: "text", text: workflowGuidance(config.checks) })
              if (event.system) event.system.push({ type: "text", text: projectGuidance(parentRuns(event.sessionID).filter(run => !terminal.has(run.status) || busy(run)).map(summary), active) })
            } else {
              delete event.tools.ultra_task
              if (caller.parentID || !parentRuns(event.sessionID).length) delete event.tools.ultra_control
            }
          })
        }
        return track(async () => {
          if (binding.retired) { event.tools = {}; return }
          event.tools = visibleTools(event.tools, binding.role, !!binding.task && binding.task.id === binding.run.parallel?.integrationTaskId, !!binding.task && binding.task.id === binding.run.parallel?.preparationTaskId)
          if (binding.task && event.tools.ultra_submit) event.tools.ultra_submit = { ...event.tools.ultra_submit, input: submitInputSchema(binding.task, binding.run.criteria) }
          const artifact = await artifacts.put({ sessionId: event.sessionID, model: event.model, role: binding.role, system: event.system, messages: event.messages, tools: event.tools, options: event.options })
          adapter.record(binding.run, "context.observed", { sessionId: event.sessionID, attemptId: binding.attempt?.id, role: binding.role, model: event.model, tools: Object.keys(event.tools), artifact })
        })
      }))
      registrations.push(await ctx.session.hook("model.request", event => {
        if (stop.signal.aborted) { if (event.agent === ULTRA_AGENT_ID || retiringSessions.has(event.sessionID)) stop.signal.throwIfAborted(); return }
        const binding = adapter.binding(event.sessionID)
        if (!binding) return
        stop.signal.throwIfAborted()
        if (event.kind === "primary" && binding.attempt) engine.step(event.sessionID)
        adapter.record(binding.run, "model.request", { sessionId: event.sessionID, model: event.model, kind: event.kind, role: binding.role })
      }))
      registrations.push(await ctx.session.hook("prompt", event => {
        if (stop.signal.aborted) { if (retiringSessions.has(event.sessionID) || auto.get(event.sessionID)) stop.signal.throwIfAborted(); return }
        if (adapter.binding(event.sessionID)) { stop.signal.throwIfAborted(); return }
        if (!auto.get(event.sessionID) || event.prompt.text.length < config.autoThreshold || /^(?:ULTRA_|<subagent|\/ultracode)/.test(event.prompt.text.trim())) return
        return track(async () => {
          if ((await adapter.scoped(event.sessionID)).agent === ULTRA_AGENT_ID) return // Ultra interprets requests through typed tools, without a length classifier.
          if (engine.list().some(run => run.parentSessionId === event.sessionID && !terminal.has(run.status))) return
          const run = await start(event.prompt.text, "execute", event.sessionID)
          event.prompt.text = intentText(run)
          event.metadata = { ...event.metadata, ultraRunId: run.id, ultraIntent: run.intentId }
        })
      }))
      registrations.push(await ctx.tool.hook("execute.before", event => {
        if (stop.signal.aborted) {
          if (event.agent === ULTRA_AGENT_ID || retiringSessions.has(event.sessionID)) throw new NativeToolError({ message: "Plugin is reloading or shutting down" })
          return
        }
        if (adapter.binding(event.sessionID)) return
        return track(async () => {
          const caller = await adapter.scoped(event.sessionID)
          if (caller.parentID || (event.agent !== ULTRA_AGENT_ID && caller.agent !== ULTRA_AGENT_ID && !guarded(event.sessionID))) return
          if (stop.signal.aborted) throw new NativeToolError({ message: "Plugin is reloading or shutting down" })
          if (!primaryToolAllowed(event.tool)) throw new NativeToolError({ message: "The workflow coordinator uses workflow and read-only tools; settle or cancel active work before direct project changes" })
        })
      }))
      registrations.push(await ctx.tool.hook("execute.after", event => {
        if (stop.signal.aborted) return
        const binding = adapter.binding(event.sessionID)
        if (binding) adapter.record(binding.run, "tool.executed", { sessionId: event.sessionID, attemptId: binding.attempt?.id, tool: event.tool, callId: event.id, input: event.input, status: event.status, ...(event.status === "completed" ? { result: event.result } : { error: event.error }) })
      }))
      registrations.push(await ctx.shell.hook("create.before", event => {
        if (stop.signal.aborted) return
        return track(async () => { adapter.preparationShell(event) })
      }))
      rpcRegistration = await ctx.rpc.register(UltraRpc, {
        async workflow(input) { return track(async () => {
          const value = input as { sessionId: string; runId?: string }
          const caller = await adapter.scoped(value.sessionId)
          stop.signal.throwIfAborted()
          if (adapter.binding(value.sessionId) || caller.parentID) throw new Error("Workflow snapshots require an initiating conversation")
          const runs = parentRuns(value.sessionId)
          if (value.runId) {
            const run = required(value.runId)
            if (!runs.some(value => value.id === run.id)) throw new Error("Workflow snapshots require the run's initiating conversation and location")
            return { sessionId: value.sessionId, runs: [workflowView(run)] }
          }
          return { sessionId: value.sessionId, runs: runs.map(run => workflowView(run)) }
        }) },
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
      adapter.markReady()
      return cleanup
    } catch (error) {
      try { await cleanup() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `Ultracode setup failed: ${String(error)}; cleanup also failed`, { cause: error }) }
      throw error
    }
  },
})

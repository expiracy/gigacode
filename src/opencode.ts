import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import type { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { manifest } from "./workspace.ts"
import { restrictPermission } from "./policy.ts"
import type { ArtifactStore } from "./artifacts.ts"
import type { Attempt, CheckEvidence, HostAdapter, Invocation, ModelSelection, Role, Run, Store, TaskSpec, WorkerSnapshot } from "./types.ts"
import { NoLaunchError, SettledLaunchError, UnsettledLaunchError } from "./types.ts"

const safeTools = new Set(["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "search", "skill", "question", "ultra_submit"])
const writeTools = new Set(["write", "edit", "patch", "apply_patch"])
export function visibleTools<T>(tools: Record<string, T>, role: Role): Record<string, T> {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => {
    if (role === "supervisor") return name === "ultra_execute"
    return safeTools.has(name) || (role === "implementer" && writeTools.has(name)) || (role === "verifier" && name === "ultra_check")
  }))
}
export async function checkedInput(tool: Pick<Info, "name" | "input">, value: unknown): Promise<any> {
  if (Schema.isSchema(tool.input)) return Schema.decodeUnknownPromise(tool.input)(value)
  const validator = (tool.input as any)["~standard"]
  if (validator) {
    const result = await validator.validate(value)
    if (result.issues) throw new Error(`Native ${tool.name} schema rejected input: ${JSON.stringify(result.issues)}`)
    return result.value
  }
  throw new Error(`Unsupported native ${tool.name} schema; dispatch refused`)
}
export function checkOutcome(output: unknown): CheckEvidence["outcome"] {
  const value = output as { exit?: unknown; status?: unknown; timeout?: unknown; signal?: unknown } | undefined
  if (value?.status === "cancelled" || value?.signal) return "cancelled"
  if (value?.timeout || (value?.status !== undefined && value.status !== "completed")) return "unknown"
  const exit = value?.exit
  return typeof exit !== "number" ? "unknown" : exit === 0 ? "passed" : "failed"
}
export interface Binding { run: Run; role: Role; task?: TaskSpec; attempt?: Attempt; retired?: boolean }
export function activeWorker(binding: Binding): boolean {
  const { run, task, attempt } = binding
  return !!task && !!attempt && run.tasks.find(item => item.spec.id === task.id)?.attempts.at(-1)?.id === attempt.id && ["running", "waiting_permission"].includes(attempt.status) && attempt.ownerEpoch === run.ownerEpoch && !["ready", "succeeded", "partial", "failed", "cancelled", "cancelling", "recovering", "paused"].includes(run.status)
}
export const sessionID = (value: string) => value as Session.ID
export const invocationKey = (sessionId: string, messageId: string, callId: string) => JSON.stringify([sessionId, messageId, callId])
export function invocation(context: ToolContext): Invocation {
  return { native: context, signal: context.signal, sessionId: context.sessionID, messageId: context.messageID, callId: context.id }
}

/** The only place the scheduler can invoke native side effects. Every call keeps a real ToolContext. */
export class OpenCodeAdapter implements HostAdapter {
  readonly checks = new Map<string, { sessionId: string; messageId: string; command: string }>()
  readonly delegations = new Map<string, { sessionId: string; messageId: string; agent: string; users: number }>()
  constructor(readonly ctx: Context, readonly store: Store, readonly artifacts: ArtifactStore) {}
  binding(id: string): Binding | undefined {
    for (const run of this.store.list(this.ctx.location.project.id)) {
      if (resolve(run.directory) !== resolve(this.ctx.location.directory)) continue
      if (run.supervisorSessionId === id) return { run, role: "supervisor" }
      if (run.supervisorHistory?.includes(id)) return { run, role: "supervisor", retired: true }
      for (const task of run.tasks) for (const attempt of task.attempts) if (attempt.sessionId === id) return { run, task: task.spec, attempt, role: task.spec.role }
    }
  }
  async scoped(id: string) {
    const session = await this.ctx.session.get({ sessionID: sessionID(id) })
    if (session.projectID !== this.ctx.location.project.id || resolve(session.location.directory) !== resolve(this.ctx.location.directory)) throw new Error("Session is outside this plugin's project and location")
    return session
  }
  async models() {
    return (await this.ctx.model.list()).data.map(model => ({ providerID: model.providerID, id: model.id, variants: model.variants.map(variant => variant.id), tools: model.capabilities.tools }))
  }
  async workspace(directory: string) { return (await manifest(directory)).hash }
  async native(name: string) {
    const tool = (await this.ctx.tool.list()).find(tool => tool.name === name)
    if (!tool) throw new Error(`Native ${name} tool is missing from the supported host`)
    return tool
  }
  async launch(run: Run, attempt: Attempt, task: TaskSpec, source: Invocation, bind: (id: string) => Promise<void>) {
    if (source.sessionId !== run.supervisorSessionId) throw new Error("Worker dispatch requires the bound supervisor invocation")
    return this.delegate(run, source, "ultra-worker", attempt.model, `ULTRA_TASK_META\n${JSON.stringify({ runId: run.id, taskId: task.id, attemptId: attempt.id, role: task.role, stage: task.stage })}\n${attempt.prompt}`, task.title, bind, task.role)
  }
  async supervisor(run: Run, source: Invocation, model: ModelSelection, bind: (id: string) => Promise<void>) {
    if (source.sessionId !== run.parentSessionId) throw new Error("Supervisor dispatch requires the initiating session invocation")
    return this.delegate(run, source, "ultra-supervisor", model, `ULTRA_SUPERVISOR\n${JSON.stringify({ runId: run.id, intentId: run.intentId })}\nYou supervise the durable graph. Call ultra_execute({runId:${JSON.stringify(run.id)},intentId:${JSON.stringify(run.intentId)}}) exactly once and wait for it. The tool schedules and reconciles every worker. On an interrupted or recovered session, call the same tool again to reconcile the saved run. Do not implement, delegate manually, or invent status.`, "Ultracode supervisor", bind, "supervisor")
  }
  private async delegate(run: Run, source: Invocation, agent: string, model: ModelSelection, prompt: string, description: string, bind: (id: string) => Promise<void>, role: Role) {
    const context = source.native as ToolContext
    let native: Awaited<ReturnType<OpenCodeAdapter["native"]>>, args: any
    try {
      if (!context || context.sessionID !== source.sessionId || context.messageID !== source.messageId || context.id !== source.callId || context.signal !== source.signal || typeof context.progress !== "function") throw new Error("Native dispatch requires a genuine invocation context")
      source.signal.throwIfAborted()
      await this.scoped(source.sessionId)
      native = await this.native("subagent")
      args = await checkedInput(native, { agent, description, prompt, background: true, model: `${model.ref.providerID}/${model.ref.id}${model.ref.variant ? `#${model.ref.variant}` : ""}` })
    } catch (error) { throw new NoLaunchError(String(error)) }
    const key = invocationKey(context.sessionID, context.messageID, context.id)
    const existing = this.delegations.get(key)
    if (existing && existing.agent !== agent) throw new NoLaunchError("An active native invocation cannot change its delegation target")
    let child: string | undefined, released = false
    this.record(run, "native.dispatch", { parent: source.sessionId, callId: source.callId, agent, model, prompt })
    const claim = existing ?? { sessionId: context.sessionID, messageId: context.messageID, agent, users: 0 }
    claim.users++
    this.delegations.set(key, claim)
    try {
      const result = await native.execute(args, { ...context, progress: async update => {
        if (typeof update.sessionID !== "string" || (child && child !== update.sessionID)) throw new Error("Unsupported native prelaunch identity")
        child = update.sessionID
        source.signal.throwIfAborted()
        const session = await this.scoped(child)
        if (session.parentID !== source.sessionId) throw new Error("Native child belongs to another parent")
        await bind(child)
        // Captured original rules remain the child's baseline. The evaluation hook intersects role and scope.
        const restrictions = role === "supervisor" ? ["edit", "write", "patch", "shell", "execute"] : ["subagent", "execute", ...(role === "implementer" ? [] : ["edit", "write", "patch"])]
        const permissions = [...run.policy, ...restrictions.map(action => ({ action, resource: "*", effect: "deny" as const }))]
        await this.ctx.session.update({ sessionID: sessionID(child), permissions })
        if (JSON.stringify((await this.scoped(child)).permissions) !== JSON.stringify(permissions)) throw new Error("Native child permissions were not retained; prompt admission refused")
        source.signal.throwIfAborted()
        this.record(run, "native.prelaunch", { parent: source.sessionId, sessionId: child, role, model })
        await context.progress({ ...update, runId: run.id, ultraPrelaunchBound: true })
        released = true
      } })
      if (!child || (result.output as any)?.sessionID !== child || !["running", "completed"].includes((result.output as any)?.status)) throw new Error("Native admission identity or status did not match the prelaunch binding")
      return { sessionId: child }
    } catch (error) {
      this.record(run, "native.dispatch.failed", { child, released, error: String(error) })
      if (child && !released) {
        let attested = false
        try {
          const created = await this.scoped(child)
          if (created.parentID !== source.sessionId) throw new Error("Cleanup child belongs to another parent")
          attested = true
          await this.interrupt(child)
          // The native API awaits execution quiescence. Never-prompted children have no outcome/idle stamp.
          await this.ctx.session.wait({ sessionID: sessionID(child) })
          if ((await this.scoped(child)).parentID !== source.sessionId) throw new Error("Cleanup child identity changed")
        } catch (cleanupError) {
          this.record(run, "native.prelaunch.unconfirmed", { sessionId: child, error: String(error), cleanupError: String(cleanupError) })
          if (attested) throw new UnsettledLaunchError(child, `${String(error)}; native cleanup unconfirmed: ${String(cleanupError)}`)
          throw cleanupError
        }
        this.record(run, "native.prelaunch.settled", { sessionId: child, promptAdmitted: false, proof: "native execution.awaitIdle after interrupt", error: String(error) })
        throw new SettledLaunchError(child, String(error))
      }
      if (!child && (error as any)?._tag === "Tool.Error" && (error as any)?.message === `Subagent denied: ${agent}`) throw new NoLaunchError(`Native delegation was denied before child creation: ${agent}`)
      throw error
    } finally { if (--claim.users === 0 && this.delegations.get(key) === claim) this.delegations.delete(key) }
  }
  async inspect(id: string): Promise<WorkerSnapshot> {
    const session = await this.scoped(id)
    const permissions = await this.ctx.permission.list({ sessionID: sessionID(id) })
    const state = permissions.length ? "waiting_permission" : session.time.idle ? session.outcome ?? "unknown" : "running"
    return { sessionId: id, state, tokens: session.tokens.input + session.tokens.output + session.tokens.reasoning + session.tokens.cache.read + session.tokens.cache.write, cost: session.cost }
  }
  async interrupt(id: string) { await this.scoped(id); await this.ctx.session.interrupt({ sessionID: sessionID(id), resume: false }) }
  async publish(run: Run, id: string, text: string) {
    await this.scoped(run.parentSessionId)
    await this.ctx.session.synthetic({ sessionID: sessionID(run.parentSessionId), id: id as any, text: `ULTRA_NOTICE\n${run.id}: ${text}`, delivery: "queue", resume: false, metadata: { ultraRunId: run.id } })
  }
  permission(binding: Binding, event: { sessionID: string; action: string; resources: readonly string[]; effect: "allow" | "ask" | "deny"; source?: { id: string; messageID?: string } }) {
    if (binding.retired) return "deny"
    if (binding.attempt && !activeWorker(binding)) return "deny"
    if (event.action === "subagent") {
      const active = event.source?.messageID && this.delegations.get(invocationKey(event.sessionID, event.source.messageID, event.source.id))
      if (!active || active.sessionId !== binding.run.supervisorSessionId || !event.resources.length || !event.resources.every(agent => agent === active.agent)) return "deny"
    }
    if (event.action === "shell") {
      const active = event.source?.messageID && this.checks.get(invocationKey(event.sessionID, event.source.messageID, event.source.id))
      if (!active || active.sessionId !== binding.attempt?.sessionId || !event.resources.length || !event.resources.every(command => command === active.command)) return "deny"
    }
    return restrictPermission(event.effect, binding.run.policy, binding.role, event.action, [...event.resources], binding.task?.ownedPaths, binding.run.directory)
  }
  async check(binding: Binding, checkId: string, context: ToolContext): Promise<CheckEvidence> {
    const { run, task, attempt } = binding
    if (!activeWorker(binding) || !task || !attempt || task.role !== "verifier" || !task.checkIds?.includes(checkId) || attempt.sessionId !== context.sessionID) throw new Error("Check is not authorized for this active worker")
    context.signal.throwIfAborted()
    const check = run.config.checks.find(check => check.id === checkId)
    if (!check) throw new Error("Unknown configured check")
    const key = invocationKey(context.sessionID, context.messageID, context.id)
    const native = await this.native("shell")
    const args = await checkedInput(native, { command: check.command, background: false, timeout: Math.min(check.timeoutMs ?? run.config.limits.workerMs, run.config.limits.workerMs) })
    const startedAt = Date.now(), before = await this.workspace(run.directory)
    context.signal.throwIfAborted()
    if (this.checks.has(key)) throw new Error("Check invocation is already active")
    this.checks.set(key, { sessionId: context.sessionID, messageId: context.messageID, command: check.command })
    let exit: number | null = null, output = "", outcome: CheckEvidence["outcome"] = "unknown"
    try {
      const result = await native.execute(args, context)
      const value = result.output as { exit?: number; output?: string } | undefined
      exit = typeof value?.exit === "number" ? value.exit : null
      output = String(value?.output ?? result.content ?? "")
      outcome = checkOutcome(value)
      if (context.signal.aborted) outcome = "cancelled"
    } catch (error) { output = String(error); outcome = context.signal.aborted ? "cancelled" : "unknown" }
    finally { this.checks.delete(key) }
    const after = await this.workspace(run.directory)
    if (before !== after) outcome = "unknown"
    const evidence: CheckEvidence = { id: `check_${randomUUID().replaceAll("-", "")}`, attemptId: attempt.id, taskId: task.id, sessionId: context.sessionID, callId: context.id, checkId, command: check.command, criterionIds: check.criterionIds, cwd: run.directory, startedAt, finishedAt: Date.now(), exit, outcome, output: output.slice(-100_000), workspaceHash: before }
    this.record(run, "check.executed", evidence)
    return evidence
  }
  record(run: Run, kind: string, data: unknown) { this.store.event(run.projectId, { runId: run.id, kind, data }) }
}

import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import type { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { dirname, join, relative, resolve } from "node:path"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { assertPlainPath, digest, manifest } from "./workspace.ts"
import { parallelBaseline, readGit, captureWriter, integrationChanges, worktreeDirectory } from "./worktrees.ts"
import { restrictPermission } from "./policy.ts"
import type { ArtifactStore } from "./artifacts.ts"
import type { Attempt, CheckEvidence, HostAdapter, Invocation, ModelSelection, Role, Run, Store, TaskSpec, WorkerSnapshot } from "./types.ts"
import { NoLaunchError, SettledLaunchError, UnsettledLaunchError } from "./types.ts"

const safeTools = new Set(["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "search", "skill", "question", "ultraopencode_submit", "ultraopencode_dependency"])
const writeTools = new Set(["write", "edit", "patch", "apply_patch"])
const readySymbol = Symbol.for("open-ultra-code.location-adapters.v1")
const readyAdapters: Map<string, OpenCodeAdapter> = Reflect.get(globalThis, readySymbol) ?? new Map()
Reflect.set(globalThis, readySymbol, readyAdapters)
const locationKey = (project: string, directory: string) => JSON.stringify([project, process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory)])
export function visibleTools<T>(tools: Record<string, T>, role: Role, integration = false, preparation = false): Record<string, T> {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => {
    if (integration) return name === "ultraopencode_integrate" || name === "ultraopencode_submit"
    if (preparation) return name === "ultraopencode_prepare" || name === "ultraopencode_submit"
    if (role === "supervisor") return name === "ultraopencode_execute"
    return safeTools.has(name) || (role === "implementer" && writeTools.has(name)) || (role === "verifier" && name === "ultraopencode_check")
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

/** Evidenced precreation refusals in the two pinned hosts; unfamiliar failures remain uncertain. */
function precreationRefusal(error: unknown, agent: string, model: ModelSelection): boolean {
  const failure = error as { _tag?: unknown; message?: unknown } | undefined
  if (failure?._tag !== "Tool.Error" || typeof failure.message !== "string") return false
  const reference = `${model.ref.providerID}/${model.ref.id}`
  const requested = `${reference}${model.ref.variant ? `#${model.ref.variant}` : ""}`
  const exact = [
    `Subagent denied: ${agent}`, `Unknown agent: ${agent}`, `Agent ${agent} cannot run as a subagent`,
    `Model "${reference}" is not available. Use the models tool to see what is available.`,
    `Invalid model "${requested}". Use "providerID/modelID" or "providerID/modelID#variant".`,
    ...(model.ref.variant ? [`Model "${reference}" has no variants. Omit the variant.`] : []),
  ]
  if (exact.includes(failure.message)) return true
  if (/^Subagent depth limit reached \(\d+\)\. Increase "experimental\.subagent_depth" to allow nested subagents\.$/.test(failure.message)) return true
  const prefix = `Variant "${model.ref.variant}" is not available for "${reference}". Available: `
  return !!model.ref.variant && failure.message.startsWith(prefix) && /^[\w.-]+(?:, [\w.-]+)*\.$/.test(failure.message.slice(prefix.length))
}

/** The only place the scheduler can invoke native side effects. Every call keeps a real ToolContext. */
export class OpenCodeAdapter implements HostAdapter {
  readonly checks = new Map<string, { sessionId: string; messageId: string; command: string }>()
  readonly delegations = new Map<string, { sessionId: string; messageId: string; agent: string; users: number }>()
  readonly integrations = new Set<string>()
  readonly preparations = new Map<string, { sessionId: string; messageId: string; command: string; directory: string }>()
  readonly preparing = new Set<string>()
  private readonly idleWaits = new Map<string, Promise<PromiseSettledResult<void>>>()
  constructor(readonly ctx: Context, readonly store: Store, readonly artifacts: ArtifactStore) {}
  markReady(): void { readyAdapters.set(locationKey(this.ctx.location.project.id, this.ctx.location.directory), this) }
  retire(): void { const key = locationKey(this.ctx.location.project.id, this.ctx.location.directory); if (readyAdapters.get(key) === this) readyAdapters.delete(key) }
  destinationReady(directory: string, id: string): boolean { const binding = readyAdapters.get(locationKey(this.ctx.location.project.id, directory))?.binding(id); return !!binding?.attempt && !binding.retired }
  binding(id: string, remote = false): Binding | undefined {
    for (const run of this.store.list(this.ctx.location.project.id)) {
      const source = resolve(run.directory) === resolve(this.ctx.location.directory)
      if (source && run.supervisorSessionId === id) return { run, role: "supervisor" }
      if (source && run.supervisorHistory?.includes(id)) return { run, role: "supervisor", retired: true }
      for (const task of run.tasks) for (const attempt of task.attempts) if (attempt.sessionId === id) return { run, task: task.spec, attempt, role: task.spec.role, ...(resolve(attempt.worktree?.directory ?? run.directory) !== resolve(this.ctx.location.directory) && !(remote && source) ? { retired: true } : {}) }
    }
  }
  async scoped(id: string, expectedDirectory: string = this.ctx.location.directory) {
    if (resolve(expectedDirectory) !== resolve(this.ctx.location.directory)) {
      const recorded = this.binding(id, true)
      if (!recorded?.attempt?.worktree || resolve(recorded.attempt.worktree.directory) !== resolve(expectedDirectory)) throw new Error("Remote session has no attested checkout binding")
    }
    const session = await this.ctx.session.get({ sessionID: sessionID(id) })
    if (session.projectID !== this.ctx.location.project.id || resolve(session.location.directory) !== resolve(expectedDirectory)) throw new Error("Session is outside this plugin's project and location")
    return session
  }
  async models() {
    return (await this.ctx.model.list()).data.map(model => ({ providerID: model.providerID, id: model.id, variants: model.variants.map(variant => variant.id), tools: model.capabilities.tools, ...(model.limit === undefined ? {} : { limit: { ...model.limit } }) }))
  }
  async workspace(directory: string) { return (await manifest(directory)).hash }
  async parallelBaseline(directory: string) {
    return parallelBaseline(directory)
  }
  preparationShell(event: { command: string; cwd: string; env: Record<string, string | undefined> }): void {
    const active = [...this.preparations.values()].find(active => active.command === event.command)
    if (!active) return
    if (resolve(active.directory) !== resolve(event.cwd)) throw new Error("Native preparation changed its authorized checkout directory")
    for (const name of new Set([...Object.keys(process.env), ...Object.keys(event.env)])) if (name.toUpperCase().startsWith("GIT_")) event.env[name] = undefined
    for (const name of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME"]) event.env[name] = process.env[name]
  }
  async prepare(binding: Binding, context: ToolContext): Promise<void> {
    const { run, task, attempt } = binding
    if (!activeWorker(binding) || !attempt || !task || task.id !== run.parallel?.preparationTaskId || attempt.sessionId !== context.sessionID || typeof context.progress !== "function") throw new Error("Preparation requires its bound native writer invocation")
    if (this.preparing.has(attempt.id)) throw new Error("Native worktree preparation is already active")
    this.preparing.add(attempt.id)
    const key = invocationKey(context.sessionID, context.messageID, context.id)
    try {
      context.signal.throwIfAborted(); await this.scoped(context.sessionID)
      const source = await this.parallelBaseline(run.directory), commit = run.parallel.baseline.commit
      if (source.hash !== run.parallel.baseline.hash || source.commit !== commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !/^run_[a-f0-9]{32}$/.test(run.id)) throw new Error("Parallel preparation baseline or generated identity is invalid")
      const hooks = `.ultraopencode/empty-hooks/${randomUUID().replaceAll("-", "")}`
      const hooksDirectory = join(run.directory, hooks)
      assertPlainPath(hooksDirectory); await mkdir(dirname(hooksDirectory), { recursive: true }); await mkdir(hooksDirectory, { mode: 0o700 })
      if ((await readGit(run.directory, ["ls-tree", "--name-only", commit, "--", hooks])).trim()) throw new Error("Generated hooks directory exists in the frozen repository")
      const shell = await this.native("shell")
      for (const checkout of run.parallel.checkouts) {
        context.signal.throwIfAborted()
        const current = this.binding(context.sessionID)
        if (!current || !activeWorker(current) || current.attempt?.id !== attempt.id) throw new Error("Preparation ownership changed; partial worktrees were retained")
        const expected = worktreeDirectory(run, { taskId: checkout.taskId, number: 1 }), path = relative(run.directory, checkout.directory).replaceAll("\\", "/")
        if (checkout.state !== "planned" || resolve(checkout.directory) !== resolve(expected) || !/^\.(?:ultraopencode|ultracode)\/worktrees\/run_[a-f0-9]{32}\/[a-f0-9]{16}-1$/.test(path)) throw new Error("Checkout path differs from its saved generated preparation scope")
        assertPlainPath(checkout.directory)
        if (await this.workspace(run.directory) !== run.parallel.baseline.hash) throw new Error("Source checkout changed during preparation; user changes were preserved")
        const command = `git -c core.hooksPath=${hooks} -c core.fsmonitor=false worktree add --detach ${path} ${commit}`
        const args = await checkedInput(shell, { command, background: false, timeout: Math.min(run.config?.limits.workerMs ?? 120_000, 120_000) })
        if (this.preparations.has(key)) throw new Error("Native preparation invocation is already active")
        this.preparations.set(key, { sessionId: context.sessionID, messageId: context.messageID, command, directory: run.directory })
        try {
          const result = await shell.execute(args, context)
          if (checkOutcome(result.output) !== "passed") throw new Error(`Native Git preparation did not exit successfully for ${checkout.taskId}: ${JSON.stringify(result.output)}`)
        } finally { this.preparations.delete(key) }
        this.record(run, "preparation.git_completed", { sessionId: context.sessionID, messageId: context.messageID, callId: context.id, taskId: checkout.taskId, directory: checkout.directory, command })
      }
      context.signal.throwIfAborted()
      await this.ctx.worktree.refresh({ projectID: this.ctx.location.project.id }, { signal: context.signal })
      const registered = await this.ctx.worktree.list({ projectID: this.ctx.location.project.id })
      for (const checkout of run.parallel.checkouts) await this.attestCheckout(run, checkout.directory, registered)
      if (await this.workspace(run.directory) !== run.parallel.baseline.hash || (await readGit(run.directory, ["rev-parse", "HEAD"])).trim() !== commit) throw new Error("Source checkout changed during preparation; user changes and worktrees were retained")
      this.record(run, "preparation.native_completed", { sessionId: context.sessionID, callId: context.id, directories: run.parallel.checkouts.map(checkout => checkout.directory), commit })
    } catch (error) { this.record(run, "preparation.native_failed", { sessionId: context.sessionID, callId: context.id, directories: run.parallel.checkouts.map(checkout => checkout.directory), error: String(error) }); throw error }
    finally { this.preparations.delete(key); this.preparing.delete(attempt.id) }
  }
  private async attestCheckout(run: Run, directory: string, registered: readonly { directory: string }[]) {
    if (!run.parallel) throw new Error("Checkout has no frozen parallel baseline")
    const actual = await realpath(directory)
    if (resolve(actual) !== resolve(directory)) throw new Error("Prepared worktree changed its recorded canonical directory")
    assertPlainPath(actual)
    const [head, common, sourceCommon, snapshot] = await Promise.all([
      readGit(actual, ["rev-parse", "HEAD"]), readGit(actual, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), readGit(run.directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), manifest(actual),
    ])
    if (!registered.some(entry => resolve(entry.directory) === actual) || head.trim() !== run.parallel.baseline.commit || resolve(common.trim()) !== resolve(sourceCommon.trim()) || snapshot.hash !== run.parallel.baseline.hash) throw new Error("Prepared worktree did not preserve native registration and the exact frozen baseline; retained for inspection")
  }
  async prepareWriter(run: Run, attempt: Attempt) {
    const checkout = run.parallel?.checkouts.find(checkout => checkout.taskId === attempt.taskId)
    if (!checkout || checkout.state !== "ready" || !attempt.worktree || attempt.worktree.state !== "planned" || attempt.number !== 1 || resolve(checkout.directory) !== resolve(attempt.worktree.directory)) throw new Error("Writer requires its persisted, natively prepared checkout")
    await this.attestCheckout(run, checkout.directory, await this.ctx.worktree.list({ projectID: this.ctx.location.project.id }))
    this.record(run, "worktree.attested", { attemptId: attempt.id, directory: checkout.directory, commit: run.parallel!.baseline.commit, workspaceHash: run.parallel!.baseline.hash })
  }
  async captureWriter(run: Run, attempt: Attempt, task: TaskSpec) { return captureWriter(run, attempt, task) }
  async integrate(binding: Binding, context: ToolContext): Promise<string> {
    const { run, task, attempt } = binding
    if (!activeWorker(binding) || !attempt || !task || task.id !== run.parallel?.integrationTaskId || attempt.sessionId !== context.sessionID || typeof context.progress !== "function") throw new Error("Integration requires its bound native writer invocation")
    if (this.integrations.has(attempt.id)) throw new Error("Native integration is already active")
    this.integrations.add(attempt.id)
    try {
      context.signal.throwIfAborted()
      await this.scoped(context.sessionID)
      const expected = integrationChanges(run)
      if (expected.hash !== run.parallel.expectedHash) throw new Error("Integration candidate differs from its admitted immutable changes")
      if (attempt.integrationAppliedHash === expected.hash && await this.workspace(run.directory) === expected.hash) return expected.hash
      const source = await this.parallelBaseline(run.directory)
      if (source.commit !== run.parallel.baseline.commit || source.hash !== run.parallel.baseline.hash) throw new Error("Source checkout changed before integration; user changes and worktrees were preserved")
      const files = { ...run.parallel.baseline.files }, write = await this.native("write")
      let progressive = run.parallel.baseline.hash
      for (const change of expected.changes) {
        context.signal.throwIfAborted()
        const current = this.binding(context.sessionID)
        if (!current || !activeWorker(current) || current.attempt?.id !== attempt.id) throw new Error("Integration ownership changed; partial changes and worktrees were retained")
        const path = join(run.directory, change.path)
        assertPlainPath(path)
        if (change.beforeHash) {
          const info = await lstat(path)
          if (!info.isFile() || info.nlink !== 1) throw new Error(`Integration refuses existing root symlinks or hardlinks: ${change.path}; user data was preserved`)
          const read = await this.native("read")
          await read.execute(await checkedInput(read, { path }), context)
        }
        if (await this.workspace(run.directory) !== progressive) throw new Error("Source checkout changed during integration; partial changes and worktrees were retained")
        assertPlainPath(path)
        if (change.beforeHash) {
          const info = await lstat(path)
          if (!info.isFile() || info.nlink !== 1) throw new Error(`Integration refuses changed root symlinks or hardlinks: ${change.path}; user data was preserved`)
        }
        await write.execute(await checkedInput(write, { path, content: change.content }), context)
        files[change.path] = change.afterHash
        progressive = digest(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
        if (await this.workspace(run.directory) !== progressive) throw new Error("Native write did not establish the exact integration candidate; partial changes and worktrees were retained")
        this.record(run, "integration.native_write", { sessionId: context.sessionID, messageId: context.messageID, callId: context.id, path: change.path, beforeHash: change.beforeHash, afterHash: change.afterHash, workspaceHash: progressive })
      }
      if ((await readGit(run.directory, ["rev-parse", "HEAD"])).trim() !== run.parallel.baseline.commit || progressive !== expected.hash) throw new Error("Source Git revision changed during integration; partial changes and worktrees were retained")
      this.record(run, "integration.native_applied", { sessionId: context.sessionID, callId: context.id, workspaceHash: expected.hash, paths: expected.changes.map(change => change.path) })
      return expected.hash
    } finally { this.integrations.delete(attempt.id) }
  }
  async native(name: string) {
    const tool = (await this.ctx.tool.list()).find(tool => tool.name === name)
    if (!tool) throw new Error(`Native ${name} tool is missing from the supported host`)
    return tool
  }
  async launch(run: Run, attempt: Attempt, task: TaskSpec, source: Invocation, bind: (id: string) => Promise<void>) {
    if (source.sessionId !== run.supervisorSessionId) throw new Error("Worker dispatch requires the bound supervisor invocation")
    return this.delegate(run, source, "ultraopencode-worker", attempt.model, `ULTRA_TASK_META\n${JSON.stringify({ runId: run.id, taskId: task.id, attemptId: attempt.id, role: task.role, stage: task.stage })}\n${attempt.prompt}`, task.title, bind, task.role, attempt.worktree?.directory)
  }
  async supervisor(run: Run, source: Invocation, model: ModelSelection, bind: (id: string) => Promise<void>) {
    if (source.sessionId !== run.parentSessionId) throw new Error("Supervisor dispatch requires the initiating session invocation")
    return this.delegate(run, source, "ultraopencode-supervisor", model, `ULTRA_SUPERVISOR\n${JSON.stringify({ runId: run.id, intentId: run.intentId })}\nCall ultraopencode_execute({runId:${JSON.stringify(run.id)},intentId:${JSON.stringify(run.intentId)}}) exactly once and wait for it. The tool schedules and reconciles every worker. On an interrupted or recovered session, call the same tool again to reconcile the saved run. Do not implement, delegate manually, or invent status. After the tool returns, explain the actual design or code changes from its accepted results, the fresh native test evidence, and any remaining problems. Preserve the exact run outcome; worker claims cannot override failed checks or a partial status. Summarize useful technical conclusions rather than just identifiers, task counts, or export paths.`, "UltraOpenCode supervisor", bind, "supervisor")
  }
  private checkoutRules(run: Run, directory: string) {
    const from = resolve(run.directory).replaceAll("\\", "/"), to = resolve(directory).replaceAll("\\", "/")
    return run.policy.map(rule => {
      const resource = rule.resource.replaceAll("\\", "/"), match = process.platform === "win32" ? resource.toLowerCase() : resource, root = process.platform === "win32" ? from.toLowerCase() : from
      return match === root || match.startsWith(root + "/") ? { ...rule, resource: to + resource.slice(from.length) } : rule
    })
  }
  private async delegate(run: Run, source: Invocation, agent: string, model: ModelSelection, prompt: string, description: string, bind: (id: string) => Promise<void>, role: Role, destination?: string) {
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
        const permissions = [...this.checkoutRules(run, destination ?? run.directory), ...restrictions.map(action => ({ action, resource: "*", effect: "deny" as const }))]
        await this.ctx.session.update({ sessionID: sessionID(child), permissions })
        if (JSON.stringify((await this.scoped(child)).permissions) !== JSON.stringify(permissions)) throw new Error("Native child permissions were not retained; prompt admission refused")
        if (destination) {
          this.record(run, "worktree.move.preparing", { sessionId: child, directory: destination, promptAdmitted: false })
          const options = { signal: AbortSignal.any([source.signal, AbortSignal.timeout(15_000)]) }
          await this.ctx.session.move({ sessionID: sessionID(child), directory: destination, delivery: "queue" }, options)
          if (!await this.awaitIdle(child, 15_000, options.signal)) throw new Error("Native child placement idle state remains unconfirmed")
          const moved = await this.scoped(child, destination)
          if (moved.parentID !== source.sessionId || JSON.stringify(moved.permissions) !== JSON.stringify(permissions)) throw new Error("Moved child identity or permissions changed; prompt admission refused")
          if (!this.destinationReady(destination, child)) {
            source.signal.throwIfAborted()
            const attempt = this.binding(child, true)?.attempt
            const activation = await this.ctx.session.prompt({ sessionID: sessionID(child), text: "ULTRA_WORKTREE_ACTIVATION\nActivate this location's workflow hooks only. The actual delegated task arrives later; this marker supplies no authority, permissions, or task scope.", resume: false, delivery: "queue", metadata: { ultraRunId: run.id, ultraAttemptId: attempt?.id ?? "", ultraWorktreeActivation: true } }, options)
            this.record(run, "worktree.activation.admitted", { sessionId: child, attemptId: attempt?.id, promptId: activation.id, directory: destination, resume: false, taskPromptAdmitted: false })
            source.signal.throwIfAborted()
          }
          if (!this.destinationReady(destination, child)) throw new Error("Destination workflow hooks are not ready; prompt admission refused")
          const prepared = await this.scoped(child, destination)
          if (prepared.parentID !== source.sessionId || JSON.stringify(prepared.permissions) !== JSON.stringify(permissions)) throw new Error("Destination activation changed child identity or permissions; prompt admission refused")
          this.record(run, "worktree.move.prepared", { sessionId: child, directory: destination, promptAdmitted: false })
        }
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
          const created = await this.recordedSession(child)
          if (created.parentID !== source.sessionId) throw new Error("Cleanup child belongs to another parent")
          attested = true
          await this.interrupt(child)
          // The native API awaits execution quiescence. Never-prompted children have no outcome/idle stamp.
          if (!await this.awaitIdle(child, 15_000)) throw new Error("Native prelaunch cleanup idle state remains unconfirmed")
          if ((await this.recordedSession(child)).parentID !== source.sessionId) throw new Error("Cleanup child identity changed")
        } catch (cleanupError) {
          this.record(run, "native.prelaunch.unconfirmed", { sessionId: child, error: String(error), cleanupError: String(cleanupError) })
          if (attested) throw new UnsettledLaunchError(child, `${String(error)}; native cleanup unconfirmed: ${String(cleanupError)}`)
          throw cleanupError
        }
        this.record(run, "native.prelaunch.settled", { sessionId: child, promptAdmitted: false, proof: "native execution.awaitIdle after interrupt", error: String(error) })
        throw new SettledLaunchError(child, String(error))
      }
      if (!child && precreationRefusal(error, agent, model)) throw new NoLaunchError(`Native delegation refused before child creation: ${String(error)}`)
      throw error
    } finally { if (--claim.users === 0 && this.delegations.get(key) === claim) this.delegations.delete(key) }
  }
  private async awaitIdle(id: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    let pending = this.idleWaits.get(id)
    if (!pending) {
      pending = this.ctx.session.wait({ sessionID: sessionID(id) }).then(() => ({ status: "fulfilled", value: undefined } as const), reason => ({ status: "rejected", reason } as const)).finally(() => {
        if (this.idleWaits.get(id) === pending) this.idleWaits.delete(id)
      })
      this.idleWaits.set(id, pending)
    }
    let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined
    try {
      // The Promise SDK ignores per-call signals; bound each observation locally.
      const settled = await Promise.race([pending, new Promise<undefined>((resolve, reject) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
        if (signal) {
          aborted = () => reject(signal.reason)
          signal.addEventListener("abort", aborted, { once: true })
          if (signal.aborted) aborted()
        }
      })])
      if (!settled) return false
      if (settled.status === "rejected") throw settled.reason
      return true
    } finally { clearTimeout(timer); if (aborted) signal?.removeEventListener("abort", aborted) }
  }
  async inspect(id: string): Promise<WorkerSnapshot> {
    let session = await this.recordedSession(id)
    const binding = this.binding(id, true)
    const permissions = await this.ctx.permission.list({ sessionID: sessionID(id) })
    let state: WorkerSnapshot["state"] = "waiting_permission"
    if (!permissions.length) {
      try {
        if (await this.awaitIdle(id, 50)) {
          session = await this.recordedSession(id)
          state = session.time.idle ? session.outcome ?? "unknown" : "running"
        } else state = "running"
      } catch { state = "unknown" }
    }
    return { sessionId: id, state, tokens: session.tokens.input + session.tokens.output + session.tokens.reasoning + session.tokens.cache.read + session.tokens.cache.write, cost: session.cost, ...(binding?.attempt?.worktree && ["succeeded", "failed", "interrupted"].includes(state) ? { workspaceHash: await this.workspace(binding.attempt.worktree.directory) } : {}) }
  }
  private async recordedSession(id: string) {
    const binding = this.binding(id, true)
    if (!binding?.attempt?.worktree) return this.scoped(id)
    const session = await this.ctx.session.get({ sessionID: sessionID(id) })
    if (session.projectID !== binding.run.projectId || ![binding.run.supervisorSessionId, ...(binding.run.supervisorHistory ?? [])].includes(session.parentID) || ![binding.run.directory, binding.attempt.worktree.directory].some(directory => resolve(directory) === resolve(session.location.directory))) throw new Error("Recorded worker identity or placement changed")
    return session
  }
  async interrupt(id: string) { await this.recordedSession(id); await this.ctx.session.interrupt({ sessionID: sessionID(id), resume: false }) }
  async publish(run: Run, id: string, text: string) {
    await this.scoped(run.parentSessionId)
    await this.ctx.session.synthetic({ sessionID: sessionID(run.parentSessionId), id: `msg_ultraopencode_${id}` as any, text: `ULTRA_NOTICE\n${run.id}: ${text}`, delivery: "queue", resume: false, metadata: { ultraRunId: run.id } })
  }
  permission(binding: Binding, event: { sessionID: string; action: string; resources: readonly string[]; effect: "allow" | "ask" | "deny"; source?: { id: string; messageID?: string } }) {
    if (binding.retired) return "deny"
    if (binding.attempt && !activeWorker(binding)) return "deny"
    if (event.action === "subagent") {
      const active = event.source?.messageID && this.delegations.get(invocationKey(event.sessionID, event.source.messageID, event.source.id))
      if (!active || active.sessionId !== binding.run.supervisorSessionId || !event.resources.length || !event.resources.every(agent => agent === active.agent)) return "deny"
    }
    if (event.action === "shell") {
      const key = event.source?.messageID && invocationKey(event.sessionID, event.source.messageID, event.source.id)
      const active = key && (this.checks.get(key) ?? this.preparations.get(key))
      if (!active || active.sessionId !== binding.attempt?.sessionId || !event.resources.length || !event.resources.every(command => command === active.command)) return "deny"
    }
    const directory = binding.attempt?.worktree?.directory ?? binding.run.directory
    return restrictPermission(event.effect, this.checkoutRules(binding.run, directory), binding.role, event.action, [...event.resources], binding.task?.ownedPaths, directory)
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

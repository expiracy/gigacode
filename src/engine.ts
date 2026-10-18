import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { parseConfig, resolveModel, strictRecord } from "./config.ts"
import { validateExecutionCoverage, validatePlan } from "./graph.ts"
import { acquireProjectLease, projectCoordination, ProjectOwnershipError, releaseProjectLease, type ProjectCoordination } from "./coordination.ts"
import { acceptedResults, executionCompletion, planningEvidenceComplete } from "./completion.ts"
import { parseTaskResult } from "./results.ts"
import { ContextBudgetError, defaultExecutionPlan, defaultPlanningPlan, promptVersion, renderTaskPrompt } from "./workflow.ts"
import { integrationChanges, worktreeDirectory } from "./worktrees.ts"
import { dependencyPage } from "./dependencies.ts"
import { recipeName, recipeWorkflow } from "./recipes.ts"
import { NoLaunchError, SettledLaunchError, UnsettledLaunchError } from "./types.ts"
import type { Attempt, CheckEvidence, Config, HostAdapter, Invocation, Lease, Limits, ModelOptions, ModelRef, Plan, Rule, Run, Store, Task, TaskSpec, Workflow } from "./types.ts"

const terminalRuns = new Set<Run["status"]>(["ready", "succeeded", "partial", "failed", "cancelled"])
const activeAttempts = new Set<Attempt["status"]>(["reserved", "running", "waiting_permission", "cancelling", "ambiguous"])
const settledAttempts = new Set<Attempt["status"]>(["succeeded", "failed", "cancelled"])
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const latest = (task: Task) => task.attempts.at(-1)
const busy = (run: Run) => run.tasks.some(task => task.attempts.some(attempt => activeAttempts.has(attempt.status)))
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); done() }
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); fail(signal.reason ?? new Error("Invocation interrupted")) }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted()
  })
}

export interface StartOptions {
  objective: string; mode: "plan" | "execute"; parentSessionId: string; capturedModel: ModelRef; policy: Rule[]; modelOptions?: ModelOptions
  workflow?: Workflow
  recipe?: Run["recipe"]
  admission?: Run["admission"]
  beforeAdmission?: () => Promise<void>
}

/** Deterministic policy. Host side effects occur only through the permission-preserving adapter. */
export class Engine {
  private readonly coordination: ProjectCoordination
  private get heldLease() { return this.coordination.lease }
  private set heldLease(value: Lease | undefined) { this.coordination.lease = value }
  private get leaseFailure() { return this.coordination.failure }
  private get driving() { return this.coordination.driving }
  constructor(private readonly store: Store, private readonly host: HostAdapter, readonly projectId: string, readonly directory: string, private readonly config: Config, coordinationKey?: string) {
    this.coordination = projectCoordination(projectId, coordinationKey)
  }

  get(runId: string) { return this.store.get(runId) }
  list() { return this.store.list(this.projectId) }
  private required(runId: string): Run {
    const run = this.store.get(runId)
    if (!run || run.projectId !== this.projectId) throw new Error(`Unknown project run: ${runId}`)
    return run
  }
  private audit(runId: string, kind: string, data?: unknown, attempt?: Attempt) {
    this.store.event(this.projectId, { runId, kind, data, taskId: attempt?.taskId, attemptId: attempt?.id })
  }
  private change<T>(runId: string, fn: (run: Run) => T, lease = this.heldLease) {
    this.required(runId)
    if (this.leaseFailure) throw this.leaseFailure
    if (lease) return this.store.mutate(runId, fn, lease)
    const acquired = this.acquire()
    try { return this.store.mutate(runId, fn, acquired) } finally { this.release() }
  }
  private project<T>(fn: (runs: Run[]) => T, lease = this.heldLease): T {
    if (this.leaseFailure) throw this.leaseFailure
    if (lease) return this.store.project(this.projectId, fn, lease)
    const acquired = this.acquire()
    try { return this.store.project(this.projectId, fn, acquired) } finally { this.release() }
  }
  private acquire(): Lease { return acquireProjectLease(this.coordination, this.store, this.projectId) }
  private release(): void { releaseProjectLease(this.coordination, this.store) }
  private async acquireWhenFree(signal: AbortSignal, runId?: string): Promise<void> {
    let waiting = false
    for (;;) {
      signal.throwIfAborted()
      try { this.acquire(); return } catch (error) {
        if (!(error instanceof ProjectOwnershipError)) throw error
        if (runId && !waiting) { this.audit(runId, "ownership.waiting", { directory: this.directory }); waiting = true }
        await abortableDelay(100, signal)
      }
    }
  }
  async withOwnership<T>(signal: AbortSignal, work: () => Promise<T> | T): Promise<T> {
    await this.acquireWhenFree(signal)
    try { signal.throwIfAborted(); return await work() } finally { this.release() }
  }
  private newIntent(run: Run) {
    run.intentId = id("intent"); run.intentExpiresAt = Date.now() + 300_000
    if (run.supervisorSessionId) {
      run.supervisorHistory ??= []
      if (!run.supervisorHistory.includes(run.supervisorSessionId)) run.supervisorHistory.push(run.supervisorSessionId)
    }
    run.supervisorSessionId = undefined; run.supervisorAttempt = (run.supervisorAttempt ?? 0) + 1
    run.continuation++
  }

  async start(options: StartOptions): Promise<Run> {
    if (!options.objective.trim() || !options.parentSessionId) throw new Error("Objective and initiating session are required")
    const { objective, mode, parentSessionId } = options, admission = structuredClone(options.admission)
    const recipe = options.recipe === undefined ? undefined : recipeName(options.recipe)
    if (recipe && (mode !== "plan" || options.workflow !== undefined)) throw new Error("Recipes require plan mode and cannot be combined with workflow")
    const capturedModel = structuredClone(options.capturedModel), modelOptions = structuredClone(options.modelOptions ?? {})
    const config = structuredClone(this.config), policy = structuredClone(options.policy)
    const planning = defaultPlanningPlan(objective)
    const execution = defaultExecutionPlan(objective, planning.criteria, config.checks)
    const requestedWorkflow = recipe ? recipeWorkflow(recipe, objective) : options.workflow
    const workflow = requestedWorkflow === undefined ? undefined : strictRecord(requestedWorkflow, ["rationale", "tasks"], "workflow")
    let initial = workflow ? validatePlan({ revision: 1, criteria: execution.criteria, rationale: workflow.rationale, tasks: workflow.tasks }, mode, config, execution.criteria, this.authorizedModels({ capturedModel, modelOptions })) : validatePlan(planning, "plan", config, planning.criteria)
    if (workflow && mode === "execute") validateExecutionCoverage(initial, config)
    const workspaceHash = await this.host.workspace(this.directory)
    const now = Date.now()
    const run: Run = {
      id: id("run"), projectId: this.projectId, directory: this.directory, parentSessionId,
      ...(admission ? { admission } : {}),
      ...(recipe ? { recipe } : {}),
      intentId: id("intent"), intentExpiresAt: now + 300_000, objective, mode,
      status: "starting", phase: workflow && mode === "execute" ? "execution" : "planning", revision: initial.revision, plans: [initial],
      tasks: initial.tasks.map(spec => ({ spec, status: "pending", attempts: [] })),
      criteria: structuredClone(workflow || mode === "execute" ? execution.criteria : planning.criteria),
      capturedModel, modelOptions, config, policy, workspaceHash,
      createdAt: now, updatedAt: now, activeMs: 0, repairRound: 0, continuation: 0, ownerEpoch: 0, generation: 0,
      errors: [], notifications: [],
    }
    if (run.phase === "execution") {
      const prepared = await this.parallelPlan(run, initial)
      initial = prepared.plan; run.parallel = prepared.parallel; run.plans = [initial]; run.tasks = initial.tasks.map(spec => ({ spec, status: "pending", attempts: [] }))
    }
    // Resolve every initial selection before admitting work; availability is never guessed or silently changed.
    const catalog = await this.host.models()
    for (const task of run.tasks) resolveModel(task.spec, run, catalog)
    await options.beforeAdmission?.()
    const admittedId = this.project(runs => {
      if (admission) {
        const existing = runs.find(saved => saved.parentSessionId === run.parentSessionId && saved.admission?.messageId === admission.messageId && saved.admission.callId === admission.callId)
        if (existing) {
          if (existing.admission!.requestHash !== admission.requestHash) throw new Error("Agent admission replay changed its request")
          return existing.id
        }
        if (runs.some(saved => saved.parentSessionId === run.parentSessionId && (!terminalRuns.has(saved.status) || busy(saved)))) throw new Error("This conversation already has an active workflow; inspect or control the existing run")
      }
      if (runs.filter(saved => !terminalRuns.has(saved.status)).length >= config.limits.runs) throw new Error("Active run capacity is exhausted")
      if (mode === "execute" && runs.some(saved => saved.mode === "execute" && (!terminalRuns.has(saved.status) || busy(saved)))) {
        throw new Error("Another execution run owns the project writer reservation")
      }
      runs.push(run)
      return run.id
    })
    if (admittedId === run.id) this.audit(run.id, "run.admitted", { mode: run.mode, objective: run.objective, intentId: run.intentId })
    return this.required(admittedId)
  }

  private async parallelPlan(run: Run, plan: Plan): Promise<{ plan: Plan; parallel?: Run["parallel"] }> {
    if (!run.config.parallelWrites) return { plan }
    const writers = plan.tasks.filter(task => task.writes), writerIds = new Set(writers.map(task => task.id)), byId = new Map(plan.tasks.map(task => [task.id, task]))
    if (writers.length < 2) return { plan }
    if (!this.host.parallelBaseline || !this.host.prepareWriter || !this.host.captureWriter) throw new Error("The host adapter does not support verified parallel worktrees")
    const afterWriter = (task: TaskSpec): boolean => task.dependencies.some(id => writerIds.has(id) || afterWriter(byId.get(id)!))
    if (writers.some(afterWriter)) throw new Error("Parallel writers require independent implementation tasks; use serial mode for dependent writers")
    const integrationTaskId = `integration.${plan.revision}`, preparationTaskId = `preparation.${plan.revision}`
    if (byId.has(integrationTaskId) || byId.has(preparationTaskId)) throw new Error("The plan uses a reserved parallel task identity")
    const baseline = await this.host.parallelBaseline(run.directory)
    if (baseline.hash !== run.workspaceHash) throw new Error("Parallel baseline changed during admission")
    const ownedPaths = [...new Set(writers.flatMap(task => task.ownedPaths ?? []))]
    const preparation: TaskSpec = { id: preparationTaskId, title: "Prepare isolated worktrees", role: "implementer", stage: "implementation", instructions: "Call gigacode_prepare({}) exactly once to prepare the recorded isolated worktrees through the fixed permission-checked native Git command. Then submit its recorded outcome through gigacode_submit. Do not run commands or edit files directly. Report a denied or failed preparation honestly; partial worktrees are retained.", dependencies: [], writes: true, ownedPaths }
    const integration: TaskSpec = { id: integrationTaskId, title: "Integrate isolated changes", role: "implementer", stage: "implementation", instructions: "Call gigacode_integrate({}) exactly once to apply the accepted immutable writer changes through native tools. Then submit its recorded outcome through gigacode_submit. Do not edit files directly. If integration is refused, report the exact conflict or freshness error; the source and worktrees are retained.", dependencies: writers.map(task => task.id), writes: true, ownedPaths }
    const expanded = { ...plan, tasks: [preparation, ...plan.tasks.map(task => writerIds.has(task.id) ? { ...task, dependencies: [...task.dependencies, preparationTaskId] } : afterWriter(task) ? { ...task, dependencies: [...task.dependencies, integrationTaskId] } : task), integration] }
    if (expanded.tasks.length > run.config.limits.attempts) throw new Error("Parallel integration exceeds the worker attempt budget")
    validateExecutionCoverage(expanded, run.config)
    return { plan: expanded, parallel: { baseline, integrationTaskId, preparationTaskId, checkouts: writers.map(task => ({ taskId: task.id, directory: worktreeDirectory(run, { taskId: task.id, number: 1 }), state: "planned" })) } }
  }

  preparationApplied(sessionId: string): void {
    const { run, task, attempt } = this.attribution(sessionId)
    if (task.spec.id !== run.parallel?.preparationTaskId) throw new Error("Preparation evidence requires the bound preparation worker")
    this.change(run.id, saved => {
      saved.tasks.find(task => task.spec.id === attempt.taskId)!.attempts.find(item => item.id === attempt.id)!.preparationApplied = true
      for (const checkout of saved.parallel!.checkouts) checkout.state = "ready"
    })
    this.audit(run.id, "preparation.applied", { directories: run.parallel.checkouts.map(checkout => checkout.directory) }, attempt)
  }

  integrationApplied(sessionId: string, workspaceHash: string): void {
    const { run, task, attempt } = this.attribution(sessionId)
    if (task.spec.id !== run.parallel?.integrationTaskId || workspaceHash !== run.parallel.expectedHash) throw new Error("Integration evidence does not match the accepted writer changes")
    this.change(run.id, saved => { saved.tasks.find(task => task.spec.id === attempt.taskId)!.attempts.find(item => item.id === attempt.id)!.integrationAppliedHash = workspaceHash })
    this.audit(run.id, "integration.applied", { workspaceHash }, attempt)
  }

  dependency(sessionId: string, taskId: string, offset = 0) {
    const { run, attempt } = this.attribution(sessionId), page = dependencyPage(run, attempt, taskId, offset)
    this.audit(run.id, "dependency.retrieved", { taskId, sourceAttemptId: page.attemptId, offset, nextOffset: page.nextOffset }, attempt)
    return page
  }

  consumeStartIntent(runId: string, intentId: string, parentSessionId: string): void {
    this.change(runId, run => {
      if (run.parentSessionId !== parentSessionId || run.intentId !== intentId || run.intentExpiresAt <= Date.now() || run.supervisorSessionId || run.status !== "starting") {
        throw new Error("Start intent is expired, consumed, or belongs to another initiating session")
      }
      run.intentExpiresAt = 0
    })
    this.audit(runId, "intent.consumed", { intentId, parentSessionId })
  }
  bindSupervisor(runId: string, intentId: string, sessionId: string): void {
    this.change(runId, run => {
      if (run.intentId !== intentId || run.intentExpiresAt !== 0 || run.supervisorSessionId || !sessionId || run.status !== "starting") throw new Error("Supervisor does not match a consumed start intent")
      run.supervisorSessionId = sessionId; run.status = run.phase === "planning" ? "planning" : "running"
      run.activeSince = Date.now()
    })
    this.audit(runId, "supervisor.bound", { intentId, sessionId })
  }
  async launchFailed(runId: string, error: unknown): Promise<Run> {
    this.change(runId, run => {
      if (terminalRuns.has(run.status) || ["paused", "cancelling"].includes(run.status)) return
      if (run.supervisorSessionId) run.status = "recovering"
      else if (!busy(run)) run.status = "waiting_input"
      run.errors.push(`Supervisor launch failed: ${String(error)}`)
    })
    this.audit(runId, "supervisor.launch_failed", { error: String(error) })
    return this.required(runId)
  }

  private attribution(sessionId: string): { run: Run; task: Task; attempt: Attempt } {
    for (const run of this.list()) for (const task of run.tasks) for (const attempt of task.attempts) {
      if (attempt.sessionId !== sessionId) continue
      if (latest(task)?.id !== attempt.id || !["running", "waiting_permission"].includes(attempt.status) || terminalRuns.has(run.status) || ["cancelling", "recovering", "paused"].includes(run.status) || attempt.ownerEpoch !== run.ownerEpoch) {
        throw new Error("Stale or settled worker submission is not accepted")
      }
      return { run, task, attempt }
    }
    throw new Error("Worker session is not bound to an attempt")
  }
  submit(sessionId: string, input: unknown): void {
    const { run, task, attempt } = this.attribution(sessionId)
    const result = parseTaskResult(input)
    if (result.assessments) for (const assessment of result.assessments) {
      const criterion = run.criteria.find(item => item.id === assessment.criterionId)
      if (!criterion || criterion.kind !== "assessment" || typeof assessment.passed !== "boolean" || typeof assessment.explanation !== "string" || !assessment.explanation.trim()) throw new Error("Invalid criterion assessment")
    }
    if (result.proposal) {
      if (task.spec.stage !== "design" || !["planner", "synthesizer"].includes(task.spec.role)) throw new Error("Only bound design workers may propose an execution graph")
      validatePlan(result.proposal, "execute", run.config, run.criteria, this.authorizedModels(run))
    }
    const resultHash = hash(result)
    if (attempt.resultHash) {
      if (attempt.resultHash === resultHash) return
      throw new Error("A submitted result is immutable; corrections require another attempt")
    }
    this.change(run.id, saved => {
      const current = saved.tasks.find(item => item.spec.id === task.spec.id)!.attempts.find(item => item.id === attempt.id)!
      current.result = structuredClone(result); current.resultHash = resultHash
    })
    this.audit(run.id, "result.candidate", { sessionId, resultHash }, attempt)
  }
  evidence(sessionId: string, evidence: CheckEvidence): void {
    const { run, task, attempt } = this.attribution(sessionId)
    const check = run.config.checks.find(item => item.id === evidence.checkId)
    if (!check || !task.spec.checkIds?.includes(check.id) || evidence.sessionId !== sessionId || evidence.attemptId !== attempt.id || evidence.taskId !== task.spec.id || evidence.command !== check.command || resolve(evidence.cwd) !== resolve(run.directory) || !evidence.callId || evidence.finishedAt < evidence.startedAt || hash(evidence.criterionIds.toSorted()) !== hash(check.criterionIds.toSorted())) {
      throw new Error("Check evidence does not match the bound native invocation and approved check")
    }
    if (!evidence.id || !evidence.workspaceHash || !Number.isFinite(evidence.startedAt) || !Number.isFinite(evidence.finishedAt) || !["passed", "failed", "cancelled", "unknown"].includes(evidence.outcome) || evidence.exit !== null && !Number.isInteger(evidence.exit)) throw new Error("Malformed native check evidence")
    if (evidence.outcome === "passed" && evidence.exit !== 0) throw new Error("A passed check requires native exit zero")
    const recorded = this.change(run.id, saved => {
      const current = saved.tasks.find(item => item.spec.id === task.spec.id)!.attempts.find(item => item.id === attempt.id)!
      const existing = current.checks.find(item => item.id === evidence.id)
      if (existing && hash(existing) !== hash(evidence)) throw new Error("Check evidence IDs are immutable")
      if (!existing) { current.checks.push(structuredClone(evidence)); return true }
      return false
    })
    if (recorded) this.audit(run.id, "check.recorded", { checkId: evidence.checkId, outcome: evidence.outcome, workspaceHash: evidence.workspaceHash }, attempt)
  }
  step(sessionId: string, usage?: { tokens?: number; cost?: number }): void {
    const { run, task, attempt } = this.attribution(sessionId)
    this.change(run.id, saved => {
      const current = saved.tasks.find(item => item.spec.id === task.spec.id)!.attempts.find(item => item.id === attempt.id)!
      current.steps++; if (usage?.tokens !== undefined) current.tokens = usage.tokens; if (usage?.cost !== undefined) current.cost = usage.cost
    })
  }

  async drive(runId: string, invocation: Invocation): Promise<Run> {
    if (this.driving.has(runId)) throw new Error("This run already has a scheduler invocation")
    this.driving.add(runId)
    let acquired = false
    try {
      await this.acquireWhenFree(invocation.signal, runId); acquired = true
      for (;;) {
        invocation.signal.throwIfAborted()
        const run = await this.tick(runId, invocation, this.heldLease)
        invocation.signal.throwIfAborted()
        if (terminalRuns.has(run.status) || ["paused", "waiting_input", "waiting_budget"].includes(run.status)) return run
        await abortableDelay(100, invocation.signal)
      }
    } catch (error) {
      if (invocation.signal.aborted) {
        if (acquired) this.change(runId, run => { if (!terminalRuns.has(run.status) && !["paused", "waiting_budget", "cancelling"].includes(run.status)) { run.previousStatus = run.status; run.status = "recovering" } })
        this.audit(runId, "supervisor.interrupted", { sessionId: invocation.sessionId, waitingOwnership: !acquired })
      }
      throw error
    } finally { this.driving.delete(runId); if (acquired) this.release() }
  }

  async tick(runId: string, invocation: Invocation, existingLease?: Lease): Promise<Run> {
    const lease = existingLease ? this.store.renew(existingLease, Date.now(), 30_000) : this.acquire()
    if (existingLease) this.heldLease = lease
    try {
      let run = this.required(runId)
      if (run.supervisorSessionId !== invocation.sessionId) throw new Error("Scheduler invocation is not the bound supervisor")
      if (terminalRuns.has(run.status) || ["paused", "waiting_input", "waiting_budget"].includes(run.status)) { await this.deliver(runId); return this.required(runId) }
      this.change(runId, saved => { this.adoptOwnerEpoch(saved, lease.epoch) }, lease)
      await this.reconcile(runId, lease)
      invocation.signal.throwIfAborted()
      run = this.required(runId)
      if (run.status === "recovering") {
        // This fresh, bound invocation proves that the old driver has drained and its owner is live.
        // Reuse reconciled attempts; never turn an unbound launch or unanswered question into dispatch.
        this.change(runId, saved => {
          for (const task of saved.tasks) for (const attempt of task.attempts) if (activeAttempts.has(attempt.status) && !attempt.sessionId) {
            attempt.status = "ambiguous"; task.status = "blocked"; saved.status = "waiting_input"
          }
          if (saved.status === "recovering") saved.status = this.questions(saved).length ? "waiting_input" : saved.previousStatus === "pausing" ? "pausing" : saved.phase === "planning" ? "planning" : "running"
        }, lease)
        this.audit(runId, "supervisor.reentered", { sessionId: invocation.sessionId, status: this.required(runId).status })
        run = this.required(runId)
      }
      if (run.status === "cancelling") { await this.finishCancellation(runId, lease); return this.required(runId) }
      if (run.status === "pausing") {
        if (!busy(run)) this.change(runId, saved => { this.stopClock(saved); saved.status = saved.previousStatus === "waiting_budget" ? "waiting_budget" : "paused" }, lease)
        return this.required(runId)
      }
      if (["waiting_input", "waiting_budget"].includes(run.status)) return run
      const now = Date.now(), elapsed = now - run.createdAt, active = run.activeMs + (run.activeSince ? now - run.activeSince : 0)
      if (elapsed >= run.config.limits.elapsedMs || active >= run.config.limits.runMs) {
        this.change(runId, saved => { saved.previousStatus = "waiting_budget"; saved.status = busy(saved) ? "pausing" : "waiting_budget"; if (!busy(saved)) this.stopClock(saved); saved.errors.push("Run time budget exhausted") }, lease)
        for (const task of run.tasks) for (const attempt of task.attempts) if (activeAttempts.has(attempt.status) && attempt.sessionId) {
          await this.host.interrupt(attempt.sessionId)
          this.change(runId, saved => { const current = saved.tasks.find(item => item.spec.id === task.spec.id)!.attempts.find(item => item.id === attempt.id)!; current.status = "cancelling" }, lease)
        }
        this.audit(runId, "budget.exhausted", { elapsed, active }); return this.required(runId)
      }
      const eligible = run.tasks.filter(task => task.status === "pending" && task.spec.dependencies.every(dependency => {
        const before = run.tasks.find(item => item.spec.id === dependency)!
        return before.status === "succeeded" || (!!task.spec.acceptsFailures && ["failed", "blocked", "skipped", "cancelled"].includes(before.status))
      }))
      if (!eligible.length && busy(run)) return run
      const catalog = eligible.length ? await this.host.models() : []
      let workspaceHash: string | undefined
      for (const candidate of eligible) {
        invocation.signal.throwIfAborted()
        run = this.required(runId)
        const spec = candidate.spec
        const isolated = !!run.parallel && run.repairRound === 0 && spec.writes && spec.id !== run.parallel.integrationTaskId && spec.id !== run.parallel.preparationTaskId
        const occupied = this.list().flatMap(saved => saved.tasks.flatMap(task => task.attempts.filter(attempt => activeAttempts.has(attempt.status)).map(() => task)))
        if (occupied.length >= run.config.limits.workers || spec.writes && !isolated && occupied.some(task => task.spec.writes)) continue
        if (run.parallel && spec.id === run.parallel.integrationTaskId) {
          try {
            const expected = integrationChanges(run)
            if (await this.host.workspace(run.directory) !== run.parallel.baseline.hash) throw new Error("Source checkout changed before integration; user changes and worktrees were preserved")
            this.change(runId, saved => { saved.parallel!.expectedHash = expected.hash }, lease)
            run = this.required(runId)
          } catch (error) {
            this.change(runId, saved => { saved.tasks.find(task => task.spec.id === spec.id)!.status = "blocked"; saved.status = "waiting_input"; saved.errors.push(String(error)) }, lease)
            this.audit(runId, "integration.blocked", { error: String(error) }); return this.required(runId)
          }
        }
        const inputWorkspaceHash = workspaceHash ??= await this.host.workspace(run.directory)
        const model = resolveModel(spec, run, catalog)
        let reservation: Attempt | undefined
        this.store.project(this.projectId, runs => {
          const saved = runs.find(item => item.id === runId)!, task = saved.tasks.find(item => item.spec.id === spec.id)!
          if (task.status !== "pending" || !["planning", "running", "starting"].includes(saved.status)) return
          const occupied = runs.flatMap(item => item.tasks.flatMap(task => task.attempts.filter(attempt => activeAttempts.has(attempt.status))))
          if (occupied.length >= saved.config.limits.workers) return
          if (spec.writes && !isolated && runs.some(item => item.tasks.some(task => task.spec.writes && task.attempts.some(attempt => activeAttempts.has(attempt.status))))) return
          if (saved.tasks.reduce((total, task) => total + task.attempts.length, 0) >= saved.config.limits.attempts) {
            saved.previousStatus = "waiting_budget"; saved.status = busy(saved) ? "pausing" : "waiting_budget"; if (!busy(saved)) this.stopClock(saved); saved.errors.push("Worker attempt budget exhausted"); return
          }
          const predecessorResults = saved.tasks.filter(item => spec.dependencies.includes(item.spec.id)).flatMap(item => {
            const accepted = item.attempts.find(attempt => attempt.id === item.acceptedAttemptId) ?? (spec.acceptsFailures ? latest(item) : undefined)
            return accepted?.result ? [{ taskId: item.spec.id, result: accepted.result }] : []
          })
          reservation = {
            id: id("attempt"), taskId: spec.id, number: task.attempts.length + 1, status: "reserved", ownerEpoch: lease.epoch,
            model, createdAt: Date.now(), workspaceHash: inputWorkspaceHash, inputHash: hash({ objective: saved.objective, mode: saved.mode, revision: saved.revision, spec, model, predecessorResults, workspaceHash: inputWorkspaceHash, clarifications: saved.clarifications ?? [], criteria: saved.criteria, policy: saved.policy, checks: saved.config.checks, promptVersion, customPrompts: saved.config.prompts ?? {} }),
            prompt: "", checks: [], steps: 0, candidateHash: saved.candidateHash,
          }
          if (isolated) {
            const checkout = saved.parallel!.checkouts.find(checkout => checkout.taskId === spec.id)
            if (!checkout || checkout.state !== "ready" || reservation.number !== 1) throw new Error("Isolated writer checkout is not prepared; replan this parallel run")
            reservation.worktree = { directory: checkout.directory, state: "planned" }
          }
          reservation.dependencyResults = saved.tasks.flatMap(item => {
            const direct = spec.dependencies.includes(item.spec.id), design = saved.phase === "execution" && item.spec.stage === "design" && !!item.acceptedAttemptId
            if (!direct && !design) return []
            const source = item.attempts.find(attempt => attempt.id === item.acceptedAttemptId) ?? (direct && spec.acceptsFailures ? latest(item) : undefined)
            return source?.result && source.resultHash ? [{ taskId: item.spec.id, attemptId: source.id, resultHash: source.resultHash }] : []
          })
          try { reservation.prompt = renderTaskPrompt(saved, spec, reservation, predecessorResults) }
          catch (error) {
            if (!(error instanceof ContextBudgetError)) throw error
            reservation = undefined; saved.previousStatus = "waiting_budget"; saved.status = busy(saved) ? "pausing" : "waiting_budget"
            if (!busy(saved)) this.stopClock(saved)
            saved.errors.push(error.message)
            return
          }
          task.attempts.push(reservation); task.status = "running"; saved.ownerEpoch = lease.epoch
          if (!saved.activeSince) saved.activeSince = Date.now()
        }, lease)
        if (!reservation) continue
        const attempt = reservation as Attempt
        this.audit(runId, "attempt.reserved", { model: attempt.model, inputHash: attempt.inputHash, prompt: attempt.prompt }, attempt)
        try {
          if (attempt.worktree) {
            await this.host.prepareWriter!(this.required(runId), attempt)
            this.change(runId, saved => { saved.tasks.find(task => task.spec.id === spec.id)!.attempts.find(item => item.id === attempt.id)!.worktree!.state = "ready" }, lease)
          }
          const preparedAttempt = this.required(runId).tasks.find(task => task.spec.id === spec.id)!.attempts.find(item => item.id === attempt.id)!
          const admitted = await this.host.launch(this.required(runId), preparedAttempt, spec, invocation, async sessionId => {
            this.change(runId, saved => {
              const current = saved.tasks.find(task => task.spec.id === spec.id)!.attempts.find(item => item.id === attempt.id)!
              if (current.status !== "reserved" || current.sessionId || saved.ownerEpoch !== lease.epoch || saved.status === "cancelling") throw new Error("Dispatch ownership changed before native prelaunch")
              if (runsWithSession(this.list(), sessionId)) throw new Error("Native session is already bound")
              current.sessionId = sessionId; current.status = "running"; current.startedAt = Date.now()
            }, lease)
            this.audit(runId, "attempt.bound", { sessionId }, attempt)
          })
          const bound = this.required(runId).tasks.find(item => item.spec.id === spec.id)!.attempts.find(item => item.id === attempt.id)!
          if (!bound.sessionId || admitted.sessionId !== bound.sessionId) throw new Error("Native admission did not match persisted prelaunch binding")
          this.audit(runId, "attempt.launched", { sessionId: admitted.sessionId }, attempt)
        } catch (error) {
          const bound = this.required(runId).tasks.find(item => item.spec.id === spec.id)!.attempts.find(item => item.id === attempt.id)!
          if (error instanceof NoLaunchError && !bound.sessionId) {
            this.change(runId, saved => {
              const task = saved.tasks.find(item => item.spec.id === spec.id)!, current = task.attempts.find(item => item.id === attempt.id)!
              current.status = saved.status === "cancelling" ? "cancelled" : "failed"; current.finishedAt = Date.now(); current.candidateHash = current.workspaceHash; current.error = error.message
              task.status = current.status; saved.errors.push(`Native launch refused before child creation: ${error.message}`)
            }, lease)
            this.audit(runId, "attempt.not_launched", { error: error.message }, attempt)
            continue
          }
          if ((error instanceof SettledLaunchError || error instanceof UnsettledLaunchError) && error.sessionId && (!bound.sessionId || bound.sessionId === error.sessionId)) {
            let recorded = false
            this.store.project(this.projectId, runs => {
              const saved = runs.find(run => run.id === runId)!, task = saved.tasks.find(item => item.spec.id === spec.id)!, current = task.attempts.find(item => item.id === attempt.id)!
              if (current.sessionId && current.sessionId !== error.sessionId) return
              if (runs.some(run => run.supervisorSessionId === error.sessionId || run.supervisorHistory?.includes(error.sessionId) || run.tasks.some(task => task.attempts.some(other => other.id !== attempt.id && other.sessionId === error.sessionId)))) return
              current.sessionId = error.sessionId; recorded = true
              if (error instanceof SettledLaunchError) {
                current.status = saved.status === "cancelling" ? "cancelled" : "failed"
                current.finishedAt = Date.now(); current.candidateHash = current.workspaceHash; current.error = error.message; task.status = current.status
                saved.errors.push(`Native child settled before release: ${error.message}`)
              }
            }, lease)
            if (recorded) {
              this.audit(runId, error instanceof SettledLaunchError ? "attempt.settled_before_release" : "attempt.cleanup_unconfirmed", { sessionId: error.sessionId, error: error.message }, attempt)
              if (error instanceof SettledLaunchError) continue
            }
          }
          this.change(runId, saved => {
            const task = saved.tasks.find(item => item.spec.id === spec.id)!, current = task.attempts.find(item => item.id === attempt.id)!
            current.status = "ambiguous"; current.error = String(error); task.status = saved.status === "cancelling" ? "cancelling" : "blocked"
            if (current.worktree) { current.worktree.state = "quarantined"; current.worktree.error = String(error) }
            if (saved.status !== "cancelling") saved.status = "waiting_input"
            saved.errors.push(`Ambiguous launch ${current.id}: ${String(error)}; reconcile before retrying`)
          }, lease)
          this.audit(runId, "attempt.ambiguous", { error: String(error) }, attempt)
          break
        }
      }
      if (!busy(this.required(runId))) await this.finish(runId, await this.host.workspace(run.directory), lease)
      return this.required(runId)
    } finally { if (!existingLease) this.release() }
  }

  private stopClock(run: Run) {
    if (run.activeSince) run.activeMs += Date.now() - run.activeSince
    run.activeSince = undefined
  }
  private adoptOwnerEpoch(run: Run, epoch: number) {
    if (run.ownerEpoch === epoch) return
    const previousEpoch = run.ownerEpoch
    run.ownerEpoch = epoch
    for (const task of run.tasks) {
      const attempt = latest(task)
      if (attempt?.sessionId && ["running", "waiting_permission"].includes(attempt.status) && attempt.ownerEpoch === previousEpoch) attempt.ownerEpoch = epoch
    }
  }
  private async reconcile(runId: string, lease?: Lease) {
    const run = this.required(runId)
    let gap = false
    for (const task of run.tasks) for (const attempt of task.attempts) {
      if (!activeAttempts.has(attempt.status) || !attempt.sessionId) continue
      let snapshot
      try { snapshot = await this.host.inspect(attempt.sessionId) } catch { snapshot = { sessionId: attempt.sessionId, state: "unknown" as const } }
      if (snapshot.sessionId !== attempt.sessionId) snapshot = { sessionId: attempt.sessionId, state: "unknown" }
      const current = this.required(runId).tasks.find(item => item.spec.id === task.spec.id)?.attempts.find(item => item.id === attempt.id)
      if (!current || !activeAttempts.has(current.status) || current.sessionId !== attempt.sessionId) continue
      if (snapshot.state === "unknown") {
        gap = true
        this.change(runId, saved => {
          const current = latest(saved.tasks.find(item => item.spec.id === task.spec.id)!)
          // Zero is unowned: only a confirmed native observation can readopt this session.
          if (current?.id === attempt.id && current.sessionId === attempt.sessionId && ["running", "waiting_permission"].includes(current.status)) current.ownerEpoch = 0
          if (saved.status !== "cancelling") saved.status = "waiting_input"
        }, lease)
        this.audit(runId, "snapshot.gap", { sessionId: attempt.sessionId }, attempt); continue
      }
      // Moving an unprompted child has its own idle outcome, before the task's model request.
      if (attempt.worktree && snapshot.state === "succeeded" && current.steps === 0 && !current.result && current.status !== "cancelling" && run.status !== "cancelling") snapshot = { ...snapshot, state: "running" }
      if (["running", "waiting_permission"].includes(snapshot.state)) {
        this.change(runId, saved => {
          const current = saved.tasks.find(item => item.spec.id === task.spec.id)!.attempts.find(item => item.id === attempt.id)!
          if (!activeAttempts.has(current.status)) return
          if (lease) current.ownerEpoch = lease.epoch
          if (snapshot.tokens !== undefined && Number.isFinite(snapshot.tokens) && snapshot.tokens >= 0) current.tokens = snapshot.tokens
          if (snapshot.cost !== undefined && Number.isFinite(snapshot.cost) && snapshot.cost >= 0) current.cost = snapshot.cost
        }, lease)
        const expired = current.startedAt !== undefined && Date.now() - current.startedAt >= run.config.limits.workerMs
        const exhausted = current.steps >= run.config.limits.steps
        if (expired || exhausted || run.status === "cancelling" && current.status !== "cancelling") {
          await this.host.interrupt(attempt.sessionId)
          this.change(runId, saved => { const t = saved.tasks.find(item => item.spec.id === task.spec.id)!, a = t.attempts.find(item => item.id === attempt.id)!; if (!activeAttempts.has(a.status)) return; a.status = "cancelling"; a.error ??= expired ? "Worker deadline exhausted" : exhausted ? "Worker step budget exhausted" : "Run cancellation awaiting native settlement"; t.status = "cancelling" }, lease)
        } else if (current.status !== "cancelling") {
          this.change(runId, saved => { const t = saved.tasks.find(item => item.spec.id === task.spec.id)!, a = t.attempts.find(item => item.id === attempt.id)!; if (a.status === "cancelling" || !activeAttempts.has(a.status)) return; a.status = snapshot.state === "waiting_permission" ? "waiting_permission" : "running"; t.status = a.status }, lease)
        }
        continue
      }
      const workspaceHash = snapshot.workspaceHash ?? await this.host.workspace(attempt.worktree?.directory ?? run.directory)
      let changes: Awaited<ReturnType<NonNullable<HostAdapter["captureWriter"]>>> | undefined, captureError: string | undefined
      if (snapshot.state === "succeeded" && current.result && current.status !== "cancelling" && run.status !== "cancelling") {
        if (attempt.worktree) {
          try { changes = await this.host.captureWriter!(run, attempt, task.spec) } catch (error) { captureError = String(error) }
        } else if (task.spec.id === run.parallel?.preparationTaskId && !current.preparationApplied) captureError = "Native preparation did not establish the recorded worktree checkouts"
        else if (task.spec.id === run.parallel?.integrationTaskId && (current.integrationAppliedHash !== run.parallel.expectedHash || workspaceHash !== run.parallel.expectedHash)) captureError = "Native integration did not establish the exact captured writer candidate"
      }
      const settled = this.change(runId, saved => {
        const currentTask = saved.tasks.find(item => item.spec.id === task.spec.id)!, current = currentTask.attempts.find(item => item.id === attempt.id)!
        if (!activeAttempts.has(current.status) || current.sessionId !== attempt.sessionId) return false
        if (lease) current.ownerEpoch = lease.epoch
        current.finishedAt = Date.now(); current.candidateHash = workspaceHash
        if (snapshot.tokens !== undefined && Number.isFinite(snapshot.tokens) && snapshot.tokens >= 0) current.tokens = snapshot.tokens
        if (snapshot.cost !== undefined && Number.isFinite(snapshot.cost) && snapshot.cost >= 0) current.cost = snapshot.cost
        if (snapshot.state === "succeeded" && current.result && !captureError && current.status !== "cancelling" && saved.status !== "cancelling") {
          current.status = "succeeded"; currentTask.status = "succeeded"; currentTask.acceptedAttemptId = current.id
          if (current.worktree) { current.worktree.state = "settled"; current.worktree.changes = changes }
          else if (currentTask.spec.writes) saved.candidateHash = workspaceHash
          if (currentTask.spec.id === saved.parallel?.integrationTaskId) saved.parallel.integratedHash = workspaceHash
          if (current.result.needsInput) { saved.status = "waiting_input"; saved.errors.push(current.result.needsInput) }
        } else {
          current.status = snapshot.state === "interrupted" || current.status === "cancelling" ? "cancelled" : "failed"
          currentTask.status = current.status; current.error ??= captureError ?? snapshot.error ?? (current.result ? "Native worker did not succeed" : "Native success has no attributable task result")
          if (current.worktree) { current.worktree.state = "quarantined"; current.worktree.error = current.error }
          if (currentTask.spec.id === saved.parallel?.preparationTaskId) for (const checkout of saved.parallel.checkouts) { checkout.state = "quarantined"; checkout.error = current.error }
        }
        return true
      }, lease)
      if (settled) this.audit(runId, "attempt.settled", { sessionId: attempt.sessionId, state: snapshot.state, workspaceHash }, attempt)
      if (captureError) this.audit(runId, "worktree.quarantined", { directory: attempt.worktree?.directory, error: captureError }, attempt)
    }
    return gap
  }

  private async finish(runId: string, workspaceHash: string, lease?: Lease) {
    const run = this.required(runId)
    if (!["planning", "running", "starting"].includes(run.status) || busy(run)) return
    // A failed dependency cannot leave a run silently pending forever.
    this.change(runId, saved => {
      for (const task of saved.tasks) if (task.status === "pending" && !task.spec.acceptsFailures && task.spec.dependencies.some(id => ["failed", "blocked", "cancelled", "skipped"].includes(saved.tasks.find(item => item.spec.id === id)!.status))) task.status = "blocked"
    }, lease)
    const refreshed = this.required(runId)
    if (refreshed.tasks.some(task => task.status === "pending")) return
    const results = acceptedResults(refreshed)
    const failed = refreshed.tasks.some(task => ["failed", "blocked", "cancelled"].includes(task.status))
    if (refreshed.phase === "planning") {
      if (failed) return this.terminal(runId, "partial", "Planning did not obtain every required result", lease)
      const proposed = results.toReversed().find(item => item.attempt.result?.proposal)?.attempt.result?.proposal
      let proposal = proposed ?? defaultExecutionPlan(refreshed.objective, refreshed.criteria, refreshed.config.checks)
      // A plan-only run stores an execution proposal but never admits writers by itself.
      proposal = validatePlan(proposal, "execute", refreshed.config, refreshed.criteria, this.authorizedModels(refreshed))
      if (!planningEvidenceComplete(refreshed, results)) return this.terminal(runId, "partial", "Proposal lacks a passing requirement assessment or has blocking critique", lease)
      if (refreshed.recipe && !proposed) return this.terminal(runId, "ready", `Read-only ${refreshed.recipe} report ready; no implementation proposal was requested`, lease)
      const prepared = refreshed.mode === "execute" ? await this.parallelPlan({ ...refreshed, workspaceHash }, { ...proposal, revision: Math.max(refreshed.revision + 1, proposal.revision) }) : { plan: proposal, parallel: undefined }
      proposal = prepared.plan
      this.change(runId, saved => {
        const revision = Math.max(saved.revision + 1, proposal.revision)
        proposal = { ...proposal, revision }; saved.proposal = proposal; saved.plans.push(proposal); saved.revision = revision; saved.workspaceHash = workspaceHash
        if (saved.mode === "plan") { this.stopClock(saved); saved.status = "ready" }
        else { saved.phase = "execution"; saved.status = "running"; saved.criteria = proposal.criteria; saved.parallel = prepared.parallel; this.addExecutionTasks(saved, proposal) }
      }, lease)
      this.audit(runId, "proposal.saved", { revision: proposal.revision, workspaceHash });
      if (this.required(runId).status === "ready") {
        this.change(runId, saved => saved.notifications.push({ id: id("notification"), text: `Design ready for review: saved proposal revision ${proposal.revision}`, delivered: false }), lease)
        await this.deliver(runId)
      }
      return
    }
    const decision = executionCompletion(refreshed, workspaceHash)
    if (decision.type === "repair") await this.repair(runId, workspaceHash, lease)
    else await this.terminal(runId, decision.status, decision.text, lease)
  }
  private async terminal(runId: string, status: Run["status"], text: string, lease?: Lease) {
    this.change(runId, saved => { this.stopClock(saved); saved.status = status; if (status !== "succeeded" && status !== "ready") saved.errors.push(text); saved.notifications.push({ id: id("notification"), text, delivered: false }) }, lease)
    this.audit(runId, "run.terminal", { status, text })
    await this.deliver(runId)
  }
  private async deliver(runId: string) {
    const run = this.required(runId)
    for (const notification of run.notifications.filter(item => !item.delivered)) {
      try {
        await this.host.publish(run, notification.id, notification.text)
        this.change(runId, saved => { const current = saved.notifications.find(item => item.id === notification.id)!; current.delivered = true })
        this.audit(runId, "notification.delivered", { id: notification.id })
      } catch (error) { this.audit(runId, "notification.pending", { id: notification.id, error: String(error) }) }
    }
  }
  private async repair(runId: string, workspaceHash: string, lease?: Lease) {
    const saved = this.required(runId)
    const ownedPaths = [...new Set(saved.tasks.filter(task => task.spec.writes).flatMap(task => task.spec.ownedPaths ?? []))]
    if (!ownedPaths.length) {
      this.audit(runId, "repair.not_admitted", { reason: "No admitted writer scope" })
      await this.terminal(runId, "partial", "No admitted writer scope is available for repair", lease)
      return
    }
    if (saved.tasks.length + 3 > saved.config.limits.attempts || saved.tasks.reduce((total, task) => total + task.attempts.length, 0) + 3 > saved.config.limits.attempts) {
      this.change(runId, run => { this.stopClock(run); run.status = "waiting_budget"; run.errors.push("Repair graph requires additional worker attempt budget") }, lease)
      this.audit(runId, "budget.exhausted", { reason: "repair_attempts" })
      return
    }
    this.change(runId, run => {
      const round = ++run.repairRound, implement = `repair.write.${round}`, review = `repair.review.${round}`, verify = `repair.verify.${round}`
      const tasks: TaskSpec[] = [
        { id: implement, title: `Repair round ${round}`, role: "implementer", stage: "implementation", instructions: "Resolve recorded blocking findings and failed checks without changing acceptance criteria or the admitted writer scope.", dependencies: run.tasks.map(task => task.spec.id), acceptsFailures: true, writes: true, ownedPaths },
        { id: review, title: `Review repair ${round}`, role: "reviewer", stage: "review", instructions: "Independently assess the repaired candidate against every required assessment criterion and submit concrete findings.", dependencies: [implement], writes: false },
        { id: verify, title: `Verify repair ${round}`, role: "verifier", stage: "verification", instructions: "Run every configured native check against the repaired candidate and report evidence.", dependencies: [implement], writes: false, checkIds: run.config.checks.map(check => check.id) },
      ]
      const plan = validatePlan({ revision: run.revision + 1, tasks: [...run.tasks.map(task => task.spec), ...tasks], criteria: run.criteria, rationale: `Bounded repair round ${round}` }, "execute", run.config, run.criteria, this.authorizedModels(run))
      run.revision = plan.revision; run.plans.push(plan); run.tasks.push(...tasks.map(spec => ({ spec, status: "pending" as const, attempts: [] }))); run.candidateHash = workspaceHash
      // Previous failures remain in immutable history but no longer block the replacement repair graph.
      for (const task of run.tasks) if (["failed", "blocked", "cancelled"].includes(task.status)) task.status = "skipped"
    }, lease)
    this.audit(runId, "plan.repaired", { round: this.required(runId).repairRound })
  }

  async pause(runId: string): Promise<Run> {
    this.change(runId, run => {
      if (["ready", "paused", "succeeded", "partial", "failed", "cancelled"].includes(run.status)) return
      if (run.status === "cancelling") throw new Error("Cancellation cannot be paused")
      run.previousStatus = run.status; run.status = busy(run) ? "pausing" : "paused"; if (!busy(run)) this.stopClock(run)
    })
    this.audit(runId, "run.pause"); return this.required(runId)
  }
  async resume(runId: string): Promise<Run> {
    await this.recover(runId)
    const reconciled = this.required(runId)
    if (this.questions(reconciled).length) throw new Error("Unanswered worker input requires provideInput before resume")
    if (await this.host.workspace(reconciled.directory) !== (reconciled.candidateHash ?? reconciled.workspaceHash)) throw new Error("Resume workspace is stale; replan before dispatching more work")
    this.project(runs => {
      const run = runs.find(item => item.id === runId)!
      if (!["paused", "waiting_input", "waiting_budget"].includes(run.status)) throw new Error("Only paused or waiting runs can resume")
      if (run.tasks.some(task => task.attempts.some(attempt => attempt.status === "ambiguous"))) throw new Error("Ambiguous launches must be reconciled before resume")
      this.readmission(runs, run)
      this.newIntent(run); run.status = "starting"
    })
    this.audit(runId, "run.resume"); return this.required(runId)
  }
  private questions(run: Run) {
    return run.tasks.flatMap(task => {
      const attempt = task.attempts.find(item => item.id === task.acceptedAttemptId)
      const question = attempt?.result?.needsInput
      return question && !run.clarifications?.some(item => item.taskId === task.spec.id && item.question === question && item.at >= (attempt!.finishedAt ?? attempt!.createdAt)) ? [{ task, attempt: attempt!, question }] : []
    })
  }
  private inputReset(run: Run, taskId: string, interrupted: Iterable<string>, workspaceHash: string) {
    const seeds = new Set([taskId, ...interrupted])
    for (const task of run.tasks) {
      const attempt = task.attempts.find(attempt => attempt.id === task.acceptedAttemptId)
      if (!attempt || attempt.worktree || task.spec.id === run.parallel?.preparationTaskId || attempt.workspaceHash === workspaceHash) continue
      if (task.spec.id === run.parallel?.integrationTaskId && attempt.integrationAppliedHash === workspaceHash && attempt.candidateHash === workspaceHash) continue
      seeds.add(task.spec.id)
    }
    return this.dependencyClosure(run, seeds)
  }
  private frozenReset(run: Run, reset: Set<string>) {
    return !!run.parallel && run.tasks.some(task => reset.has(task.spec.id) && (task.spec.id === run.parallel!.preparationTaskId || task.attempts.some(attempt => attempt.worktree) || task.spec.id === run.parallel!.integrationTaskId && task.attempts.some(attempt => attempt.integrationAppliedHash)))
  }
  async provideInput(runId: string, answer: string): Promise<Run> {
    if (typeof answer !== "string" || !answer.trim()) throw new Error("A nonempty user answer is required")
    const lease = this.acquire()
    try {
      const run = this.required(runId), question = this.questions(run)[0]
      if (run.status !== "waiting_input" || !question) throw new Error("This run has no unanswered worker question")
      if (run.parallel) {
        const reset = this.inputReset(run, question.task.spec.id, run.tasks.filter(task => task.attempts.some(attempt => activeAttempts.has(attempt.status))).map(task => task.spec.id), await this.host.workspace(run.directory))
        if (this.frozenReset(run, reset)) throw new Error("Answering this question would restart isolated preparation, writers, or applied integration; start a new parallel run. Your answer was not recorded; accepted work was preserved.")
      }
      const interrupted = new Set<string>()
      for (const task of run.tasks) for (const attempt of task.attempts) if (activeAttempts.has(attempt.status) && attempt.sessionId) {
        interrupted.add(task.spec.id)
        this.change(runId, saved => { const current = saved.tasks.find(item => item.spec.id === task.spec.id)!.attempts.find(item => item.id === attempt.id)!; current.status = "cancelling" }, lease)
        try { await this.host.interrupt(attempt.sessionId) } catch (error) { this.audit(runId, "interrupt.unconfirmed", { sessionId: attempt.sessionId, error: String(error) }, attempt) }
      }
      const deadline = Date.now() + 2_000
      for (;;) {
        const gap = await this.reconcile(runId, lease)
        if (!busy(this.required(runId)) || gap || Date.now() >= deadline) break
        await new Promise(done => setTimeout(done, 25))
      }
      if (busy(this.required(runId))) {
        this.audit(runId, "input.waiting_settlement", { taskId: question.task.spec.id })
        throw new Error("Worker settlement is unconfirmed; your answer was not recorded. Inspect this run and submit the answer in a new call after its workers settle.")
      }
      const workspaceHash = await this.host.workspace(run.directory)
      this.project(runs => {
        const saved = runs.find(item => item.id === runId)!
        if (saved.status !== "waiting_input" || this.questions(saved)[0]?.attempt.id !== question.attempt.id) throw new Error("Worker question changed before the answer could be recorded")
        const reset = this.inputReset(saved, question.task.spec.id, interrupted, workspaceHash)
        if (this.frozenReset(saved, reset)) throw new Error("Changed inputs require a new parallel run; your answer was not recorded and accepted work was preserved")
        saved.clarifications ??= []
        saved.clarifications.push({ taskId: question.task.spec.id, question: question.question, answer: answer.trim(), at: Date.now() })
        for (const task of saved.tasks) if (reset.has(task.spec.id)) { task.status = "pending"; task.acceptedAttemptId = undefined }
        saved.workspaceHash = workspaceHash; if (saved.phase === "execution") saved.candidateHash = workspaceHash
        if (!this.questions(saved).length) { this.readmission(runs, saved); this.newIntent(saved); saved.status = "starting" }
      }, lease)
      this.audit(runId, "input.provided", { taskId: question.task.spec.id, question: question.question, answer: answer.trim() })
      return this.required(runId)
    } finally { this.release() }
  }
  setBudget(runId: string, overrides: Partial<Limits>): Run {
    const run = this.required(runId), limits = parseConfig({ limits: { ...run.config.limits, ...overrides } }).limits
    for (const key of Object.keys(limits) as (keyof Limits)[]) if ((limits[key] ?? 64_000) < (run.config.limits[key] ?? 64_000)) throw new Error("Explicit budget updates may only increase limits")
    this.change(runId, saved => {
      if (!["waiting_budget", "paused", "waiting_input"].includes(saved.status)) throw new Error("Budgets can only be updated while a run is waiting or paused")
      saved.config.limits = limits
    })
    this.audit(runId, "budget.updated", { previous: run.config.limits, limits })
    return this.required(runId)
  }
  async cancel(runId: string): Promise<Run> {
    const run = this.required(runId)
    if (terminalRuns.has(run.status) && run.status !== "ready") return run
    this.change(runId, saved => { saved.status = "cancelling"; for (const task of saved.tasks) for (const attempt of task.attempts) if (activeAttempts.has(attempt.status) && attempt.sessionId) { attempt.status = "cancelling"; task.status = "cancelling" } })
    for (const task of this.required(runId).tasks) for (const attempt of task.attempts) if (activeAttempts.has(attempt.status) && attempt.sessionId) {
      try { await this.host.interrupt(attempt.sessionId) } catch (error) { this.audit(runId, "interrupt.unconfirmed", { sessionId: attempt.sessionId, error: String(error) }, attempt) }
    }
    const deadline = Date.now() + 2_000
    for (;;) {
      const gap = await this.reconcile(runId, this.heldLease)
      await this.finishCancellation(runId, this.heldLease)
      const current = this.required(runId)
      if (!busy(current) || gap || current.tasks.some(task => task.attempts.some(attempt => activeAttempts.has(attempt.status) && !attempt.sessionId)) || Date.now() >= deadline) break
      await new Promise(done => setTimeout(done, 25))
    }
    this.audit(runId, "run.cancel"); return this.required(runId)
  }
  private async finishCancellation(runId: string, lease?: Lease) {
    if (!busy(this.required(runId))) {
      this.change(runId, run => { for (const task of run.tasks) if (task.status === "pending") task.status = "cancelled" }, lease)
      await this.terminal(runId, "cancelled", "Cancellation settled; partial artifacts are retained", lease)
    }
  }
  async recover(runId?: string): Promise<Run[]> {
    const target = runId ? this.required(runId) : undefined
    if (target && resolve(target.directory) !== resolve(this.directory)) throw new Error("Recovery requires the run's owning location")
    const runs = (target ? [target] : this.list().filter(run => resolve(run.directory) === resolve(this.directory))).filter(run => !this.driving.has(run.id))
    const lease = this.acquire()
    try {
      for (const run of runs) {
        if (this.driving.has(run.id)) continue
        const preserve = ["paused", "ready", "succeeded", "partial", "failed", "cancelled"].includes(run.status)
        this.change(run.id, saved => {
          if (!preserve) this.adoptOwnerEpoch(saved, lease.epoch)
            if (!preserve && saved.supervisorSessionId && this.store.events(this.projectId, saved.id).some(event => event.kind === "supervisor.interrupted" && (event.data as { sessionId?: string; waitingOwnership?: boolean }).sessionId === saved.supervisorSessionId && (event.data as { waitingOwnership?: boolean }).waitingOwnership)) saved.status = "recovering"
          if (saved.status === "starting" && !saved.supervisorSessionId && saved.intentExpiresAt > 0 && saved.intentExpiresAt <= Date.now()) { saved.status = "waiting_input"; saved.errors.push("Unconsumed start intent expired; resume creates a fresh intent") }
          for (const task of saved.tasks) for (const attempt of task.attempts) if (activeAttempts.has(attempt.status) && !attempt.sessionId) {
            attempt.status = "ambiguous"; task.status = "blocked"; if (saved.status !== "cancelling" && !preserve) saved.status = "waiting_input"
          }
        }, lease)
        if (!preserve) await this.reconcile(run.id, lease)
        if (this.driving.has(run.id)) continue
        if (!preserve && run.supervisorSessionId && ["starting", "planning", "running", "recovering"].includes(run.status)) {
          let snapshot
          try { snapshot = await this.host.inspect(run.supervisorSessionId) } catch { snapshot = { sessionId: run.supervisorSessionId, state: "unknown" as const } }
          if (this.driving.has(run.id)) continue
          if (snapshot.sessionId !== run.supervisorSessionId) snapshot = { sessionId: run.supervisorSessionId, state: "unknown" }
          const ownerEvents = this.store.events(this.projectId, run.id).filter(event => ["supervisor.interrupted", "supervisor.reentered"].includes(event.kind) && (event.data as { sessionId?: string }).sessionId === run.supervisorSessionId)
          const stopped = ["succeeded", "failed", "interrupted"].includes(snapshot.state) || snapshot.state === "unknown" && ownerEvents.at(-1)?.kind === "supervisor.interrupted"
          this.change(run.id, saved => {
            if (saved.supervisorSessionId !== run.supervisorSessionId || ["paused", "pausing", "cancelling"].includes(saved.status) || terminalRuns.has(saved.status)) return
            if (stopped) {
              saved.status = "waiting_input"
              const error = "Supervisor stopped; native attempts reconciled before explicit continuation"
              if (!saved.errors.includes(error)) saved.errors.push(error)
            } else if (snapshot.state === "unknown") saved.status = "recovering"
          }, lease)
          if (snapshot.state === "unknown" && !stopped) this.audit(run.id, "supervisor.snapshot.gap", { sessionId: run.supervisorSessionId })
        } else if (this.required(run.id).status === "recovering") this.change(run.id, saved => { saved.status = "waiting_input"; saved.errors.push("Supervisor stopped; native attempts reconciled before explicit continuation") }, lease)
        if (this.required(run.id).status === "cancelling") await this.finishCancellation(run.id, lease)
        await this.deliver(run.id)
        this.audit(run.id, "run.reconciled", { preserved: preserve })
      }
      return runs.map(run => this.required(run.id))
    } finally { this.release() }
  }
  async runSaved(runId: string, revision: number): Promise<Run> {
    const run = this.required(runId)
    if (run.status !== "ready" || !run.proposal || run.proposal.revision !== revision) throw new Error("Saved proposal revision is not ready for execution")
    const workspaceHash = await this.host.workspace(run.directory)
    if (workspaceHash !== run.workspaceHash) throw new Error("Saved proposal workspace is stale")
    const validated = validatePlan(run.proposal, "execute", run.config, run.criteria, this.authorizedModels(run))
    const prepared = await this.parallelPlan(run, run.config.parallelWrites ? { ...validated, revision: run.revision + 1 } : validated), plan = prepared.plan
    this.project(runs => {
      const saved = runs.find(item => item.id === runId)!
      if (saved.status !== "ready" || saved.proposal?.revision !== revision || saved.workspaceHash !== workspaceHash) throw new Error("Saved proposal changed before execution admission")
      this.readmission(runs, saved, true)
      saved.mode = "execute"; saved.phase = "execution"; saved.parallel = prepared.parallel; this.addExecutionTasks(saved, plan); saved.criteria = plan.criteria
      if (prepared.parallel) { saved.revision = plan.revision; saved.plans.push(plan) }
      this.newIntent(saved); saved.status = "starting"
    })
    this.audit(runId, "proposal.executing", { revision }); return this.required(runId)
  }
  async retry(runId: string, taskId: string): Promise<Run> {
    const run = this.required(runId), task = run.tasks.find(item => item.spec.id === taskId), attempt = task && latest(task)
    if (!task || !attempt || !settledAttempts.has(attempt.status) || !["failed", "cancelled", "blocked"].includes(task.status)) throw new Error("Retry requires a settled failed attempt")
    if (attempt.worktree || taskId === run.parallel?.preparationTaskId) throw new Error("Retrying isolated worktree preparation or writers requires a new parallel run; existing changes were retained")
    const affected = this.dependencyClosure(run, [taskId]), snapshots = new Map<string, string | undefined>()
    for (const affectedTask of run.tasks.filter(item => affected.has(item.spec.id))) {
      if (affectedTask.attempts.some(attempt => activeAttempts.has(attempt.status))) throw new Error("Dependent workers must be settled before retry invalidates their inputs")
      const before = latest(affectedTask)
      snapshots.set(affectedTask.spec.id, before?.id)
      if (before?.sessionId && !["succeeded", "failed", "interrupted"].includes((await this.host.inspect(before.sessionId)).state)) throw new Error("Old worker or dependent worker has not settled")
    }
    if (await this.host.workspace(run.directory) !== (attempt.worktree ? run.parallel?.baseline.hash : attempt.candidateHash ?? attempt.workspaceHash)) throw new Error("Retry inputs are stale")
    this.project(runs => {
      const saved = runs.find(item => item.id === runId)!
      this.readmission(runs, saved)
      if (latest(saved.tasks.find(item => item.spec.id === taskId)!)?.id !== attempt.id) throw new Error("Retry attempt changed during admission")
      for (const affectedTask of saved.tasks.filter(item => affected.has(item.spec.id))) {
        if (latest(affectedTask)?.id !== snapshots.get(affectedTask.spec.id) || affectedTask.attempts.some(attempt => activeAttempts.has(attempt.status))) throw new Error("Dependent attempt changed during retry admission")
        affectedTask.status = "pending"; affectedTask.acceptedAttemptId = undefined
      }
      if (terminalRuns.has(saved.status) || ["paused", "waiting_input", "waiting_budget"].includes(saved.status)) { this.newIntent(saved); saved.status = "starting" }
    })
    this.audit(runId, "task.retry", { taskId }); return this.required(runId)
  }
  private authorizedModels(run: Pick<Run, "capturedModel" | "modelOptions">): string[] {
    const captured = `${run.capturedModel.providerID}/${run.capturedModel.id}${run.capturedModel.variant ? `#${run.capturedModel.variant}` : ""}`
    return [captured, run.modelOptions.default, ...Object.values(run.modelOptions.roles ?? {}), ...Object.values(run.modelOptions.stages ?? {})].filter((value): value is string => typeof value === "string")
  }
  private dependencyClosure(run: Run, seeds: Iterable<string>): Set<string> {
    const closure = new Set(seeds)
    let changed = true
    while (changed) {
      changed = false
      for (const task of run.tasks) if (!closure.has(task.spec.id) && task.spec.dependencies.some(id => closure.has(id))) { closure.add(task.spec.id); changed = true }
    }
    return closure
  }
  private readmission(runs: Run[], run: Run, execution = run.mode === "execute") {
    if (runs.filter(saved => saved.id !== run.id && !terminalRuns.has(saved.status)).length >= run.config.limits.runs) throw new Error("Active run capacity is exhausted")
    if (execution && runs.some(saved => saved.id !== run.id && saved.mode === "execute" && (!terminalRuns.has(saved.status) || busy(saved)))) throw new Error("Another execution owns the project writer reservation")
  }
  private addExecutionTasks(run: Run, plan: Plan): void {
    for (const spec of plan.tasks) {
      const previous = run.tasks.find(task => task.spec.id === spec.id)
      if (previous && hash(previous.spec) !== hash(spec)) throw new Error(`Execution proposal redefines historical task ${spec.id}`)
      if (!previous) run.tasks.push({ spec, status: "pending", attempts: [] })
    }
  }
}

function runsWithSession(runs: Run[], sessionId: string): boolean {
  return runs.some(run => run.supervisorSessionId === sessionId || run.supervisorHistory?.includes(sessionId) || run.tasks.some(task => task.attempts.some(attempt => attempt.sessionId === sessionId)))
}

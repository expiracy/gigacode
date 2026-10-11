import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import { tmpdir } from "node:os"
import { Engine } from "../src/engine.ts"
import { SQLiteStore } from "../src/store.ts"
import type { Config, Plan, Run, TaskSpec } from "../src/types.ts"
import { NoLaunchError, SettledLaunchError, UnsettledLaunchError } from "../src/types.ts"
import { FakeHost, invocation } from "./fake-host.ts"

let path: string, store: SQLiteStore, host: FakeHost, engine: Engine
const config: Config = {
  models: { default: "inherit" }, checks: [{ id: "test", command: "echo check", criterionIds: ["verification"] }],
  limits: { workers: 4, runs: 2, attempts: 24, repairRounds: 2, workerMs: 600_000, runMs: 2_700_000, elapsedMs: 3_600_000, steps: 24 },
  parallelWrites: false, autoThreshold: 5,
}
beforeEach(() => {
  path = mkdtempSync(join(tmpdir(), "ultra-engine-"))
  store = new SQLiteStore(join(path, "state.sqlite")); host = new FakeHost()
  engine = new Engine(store, host, "project", path, config)
})
afterEach(() => {
  store.close()
  const root = realpathSync(tmpdir()), target = realpathSync(path), child = relative(root, target)
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..\\`) || child.startsWith("../") || !basename(target).startsWith("ultra-engine-")) throw new Error("Unsafe engine test cleanup target")
  rmSync(target, { recursive: true, force: true })
})
const start = (mode: "plan" | "execute" = "plan") => engine.start({ objective: "Inspect behavior", mode, parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, policy: [] })
function task(id: string, writes = false, dependencies: string[] = []): TaskSpec {
  return { id, title: id, role: writes ? "implementer" : "explorer", stage: writes ? "implementation" : "discovery", instructions: `Produce attributable evidence for ${id}`, writes, dependencies, ...(writes ? { ownedPaths: ["**"] } : {}) }
}
function install(run: Run, specs: TaskSpec[], phase: Run["phase"] = "planning") {
  store.mutate(run.id, value => {
    value.supervisorSessionId = "supervisor"; value.status = phase === "planning" ? "planning" : "running"; value.phase = phase
    value.tasks = specs.map(spec => ({ spec, status: "pending", attempts: [] }))
  })
}

test("run admission is atomic and exact intent identity is required", async () => {
  const first = await start(); await start()
  await expect(start()).rejects.toThrow(/run|capacity/i)
  expect(() => engine.consumeStartIntent(first.id, first.intentId, "another-parent")).toThrow()
  engine.consumeStartIntent(first.id, first.intentId, "parent")
  expect(() => engine.consumeStartIntent(first.id, first.intentId, "parent")).toThrow()
  engine.bindSupervisor(first.id, first.intentId, "supervisor")
  expect(engine.get(first.id)?.supervisorSessionId).toBe("supervisor")
})

test("attempt is durable before native launch and a candidate waits for actual settlement", async () => {
  const run = await start(); install(run, [task("one")])
  host.beforeBind = (_run, attempt) => expect(store.get(run.id)!.tasks[0]!.attempts[0]!.id).toBe(attempt.id)
  await engine.tick(run.id, invocation())
  const launched = host.launches[0]!
  engine.submit(launched.sessionId, { summary: "Observed behavior", assessments: [{ criterionId: "request", passed: true, explanation: "Read the requested material" }] })
  expect(engine.get(run.id)!.tasks[0]!.status).toBe("running")
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.tasks[0]!.status).toBe("running")
  host.settle(launched.sessionId); await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.tasks[0]!.status).toBe("succeeded")
  expect(() => engine.submit(launched.sessionId, { summary: "Late change" })).toThrow()
})

test("permission waits retain worker capacity shared across runs", async () => {
  const first = await start(), second = await start()
  install(first, [task("a"), task("b"), task("c"), task("d")]); install(second, [task("e")])
  await engine.tick(first.id, invocation())
  expect(host.launches).toHaveLength(4)
  for (const launch of host.launches) host.settle(launch.sessionId, "waiting_permission")
  await engine.tick(first.id, invocation()); await engine.tick(second.id, invocation())
  expect(host.launches).toHaveLength(4)
  expect(engine.get(first.id)!.tasks.every(item => item.status === "waiting_permission")).toBe(true)
})

test("one writer is admitted per project and inherited execution scope is retained", async () => {
  await start("execute")
  await expect(start("execute")).rejects.toThrow(/writer|write|execution/i)
})

test("pause drains active work and prevents further dispatch", async () => {
  const run = await start(); install(run, [task("first"), task("second", false, ["first"])])
  await engine.tick(run.id, invocation()); await engine.pause(run.id)
  const launch = host.launches[0]!
  engine.submit(launch.sessionId, { summary: "Done" }); host.settle(launch.sessionId)
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("paused"); expect(host.launches).toHaveLength(1)
  await engine.resume(run.id)
  expect(engine.get(run.id)!.intentId).not.toBe(run.intentId)
  expect(engine.get(run.id)!.mode).toBe("plan")
  expect(engine.get(run.id)!.supervisorHistory).toEqual(["supervisor"])
})

test("unknown cancellation and ambiguous reservation never release a writer or duplicate dispatch", async () => {
  const run = await start("execute"); install(run, [task("write", true)], "execution")
  await engine.tick(run.id, invocation()); host.interruptState = "unknown"
  await engine.cancel(run.id)
  expect(engine.get(run.id)!.status).toBe("cancelling")
  await expect(start("execute")).rejects.toThrow()
  await engine.recover(run.id)
  expect(host.launches).toHaveLength(1)
  const attempt = engine.get(run.id)!.tasks[0]!.attempts[0]!
  store.mutate(run.id, saved => { const a = saved.tasks[0]!.attempts[0]!; a.sessionId = undefined; a.status = "reserved" })
  await engine.recover(run.id)
  expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.status).toBe("ambiguous")
  await engine.tick(run.id, invocation()); expect(host.launches).toHaveLength(1)
})

test("verification evidence must match native caller, approved check, and fresh workspace", async () => {
  const run = await start("execute")
  const spec: TaskSpec = { ...task("verify"), role: "verifier", stage: "verification", checkIds: ["test"] }
  install(run, [spec], "execution"); await engine.tick(run.id, invocation())
  const launch = host.launches[0]!
  const evidence = { id: "evidence", attemptId: launch.attempt.id, taskId: spec.id, sessionId: launch.sessionId, callId: "native-call", checkId: "test", command: "echo check", criterionIds: ["verification"], cwd: path, startedAt: Date.now(), finishedAt: Date.now(), exit: 0, outcome: "passed" as const, output: "check", workspaceHash: host.hash }
  expect(() => engine.evidence("wrong-session", evidence)).toThrow()
  expect(() => engine.evidence(launch.sessionId, { ...evidence, command: "arbitrary command" })).toThrow()
  engine.evidence(launch.sessionId, evidence)
  engine.submit(launch.sessionId, { summary: "Verified", assessments: [{ criterionId: "request", passed: true, explanation: "Requirement assessed" }] })
  host.hash = "workspace:changed"; host.settle(launch.sessionId)
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).not.toBe("succeeded")
})

test("saved plan execution rejects stale workspace and wrong revision", async () => {
  const run = await start()
  const proposal: Plan = { revision: 2, tasks: [task("implement", true)], criteria: [{ id: "request", kind: "assessment", required: true, description: "Request" }], rationale: "Execute inspected changes" }
  store.mutate(run.id, saved => { saved.status = "ready"; saved.proposal = proposal; saved.revision = 2 })
  await expect(engine.runSaved(run.id, 1)).rejects.toThrow()
  host.hash = "changed"; await expect(engine.runSaved(run.id, 2)).rejects.toThrow(/stale|workspace/i)
  expect(engine.get(run.id)!.mode).toBe("plan")
})

async function settleWave(runId: string, checkOutcome: "passed" | "failed" = "passed") {
  const active = host.launches.filter(launch => launch.run.id === runId && host.sessions.get(launch.sessionId)?.state === "running")
  for (const launch of active) {
    if (launch.task.writes) host.hash = `workspace:${launch.attempt.id}`
    engine.submit(launch.sessionId, { summary: `Completed ${launch.task.id}`, ...(launch.task.writes ? {} : { assessments: [{ criterionId: "request", passed: true, explanation: "Independently assessed the original objective" }] }) })
    for (const checkId of launch.task.checkIds ?? []) {
      const check = config.checks.find(item => item.id === checkId)!
      engine.evidence(launch.sessionId, { id: `evidence-${launch.attempt.id}-${checkId}`, attemptId: launch.attempt.id, taskId: launch.task.id, sessionId: launch.sessionId, callId: `check-${launch.attempt.id}`, checkId, command: check.command, criterionIds: check.criterionIds, cwd: path, startedAt: Date.now(), finishedAt: Date.now(), exit: checkOutcome === "passed" ? 0 : 1, outcome: checkOutcome, output: "native check", workspaceHash: host.hash })
    }
    host.settle(launch.sessionId)
  }
  await engine.tick(runId, invocation())
}

test("plan-only stays read-only and executing the saved revision preserves planning history", async () => {
  const run = await start()
  engine.consumeStartIntent(run.id, run.intentId, "parent"); engine.bindSupervisor(run.id, run.intentId, "supervisor")
  await engine.tick(run.id, invocation())
  for (let i = 0; i < 12 && engine.get(run.id)!.status !== "ready"; i++) await settleWave(run.id)
  const ready = engine.get(run.id)!
  expect(ready.status).toBe("ready")
  expect(host.launches.every(launch => !launch.task.writes)).toBe(true)
  const history = ready.tasks.map(item => [item.spec.id, item.attempts[0]!.id])
  const execute = await engine.runSaved(run.id, ready.revision)
  expect(execute.supervisorHistory).toEqual(["supervisor"])
  engine.consumeStartIntent(run.id, execute.intentId, "parent"); engine.bindSupervisor(run.id, execute.intentId, "supervisor")
  await engine.tick(run.id, invocation())
  for (let i = 0; i < 16 && engine.get(run.id)!.status === "running"; i++) await settleWave(run.id)
  const complete = engine.get(run.id)!
  expect(complete.status).toBe("succeeded")
  for (const [taskId, attemptId] of history) expect(complete.tasks.find(item => item.spec.id === taskId)!.attempts[0]!.id).toBe(attemptId)
  expect(host.publications).toHaveLength(2)
  await engine.recover(run.id); expect(host.publications).toHaveLength(2)
})

test("native check failure adds a bounded repair graph with unchanged required criteria", async () => {
  const run = await start("execute")
  install(run, [task("implement", true), { ...task("review", false, ["implement"]), role: "reviewer", stage: "review" }, { ...task("verify", false, ["implement"]), role: "verifier", stage: "verification", checkIds: ["test"] }], "execution")
  await engine.tick(run.id, invocation()); await settleWave(run.id); await settleWave(run.id, "failed")
  expect(engine.get(run.id)!.repairRound).toBe(1)
  expect(engine.get(run.id)!.criteria).toEqual(run.criteria)
  await engine.tick(run.id, invocation())
  for (let i = 0; i < 12 && engine.get(run.id)!.status === "running"; i++) await settleWave(run.id)
  expect(engine.get(run.id)!.status).toBe("succeeded")
  expect(engine.get(run.id)!.plans).toHaveLength(2)
})

test("a successful-looking summary cannot substitute for native checks or independent review", async () => {
  const run = await start("execute"); install(run, [task("implement", true)], "execution")
  store.mutate(run.id, saved => { saved.config.limits.repairRounds = 0 })
  await engine.tick(run.id, invocation()); await settleWave(run.id)
  expect(engine.get(run.id)!.status).toBe("partial")
})

test("interruption acknowledgement does not settle cancellation before native idle", async () => {
  const run = await start("execute"); install(run, [task("write", true)], "execution")
  await engine.tick(run.id, invocation()); host.interruptState = "running"
  setTimeout(() => host.settle(host.launches[0]!.sessionId, "interrupted"), 60)
  const settled = await engine.cancel(run.id)
  expect(settled.status).toBe("cancelled")
  expect(settled.tasks[0]!.attempts[0]!.status).toBe("cancelled")
  await expect(start("execute")).resolves.toBeDefined()
})

test("run budget stops dispatch and settles interrupted workers before waiting_budget", async () => {
  const run = await start(); install(run, [task("one"), task("two", false, ["one"])])
  await engine.tick(run.id, invocation())
  store.mutate(run.id, saved => { saved.config.limits.elapsedMs = 1; saved.createdAt = Date.now() - 10 })
  await engine.tick(run.id, invocation()); await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("waiting_budget")
  expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.status).toBe("cancelled")
  expect(host.launches).toHaveLength(1)
})

test("a second process cannot dispatch or mutate while the first owns the project lease", async () => {
  const run = await start(); install(run, [task("one")])
  const lease = store.lease("project", "another-process", Date.now(), 30_000)!
  await expect(engine.tick(run.id, invocation())).rejects.toThrow(/owned/)
  await expect(engine.pause(run.id)).rejects.toThrow(/owned/)
  expect(host.launches).toHaveLength(0)
  store.release(lease)
})

test("aborted supervisor records recovering instead of claiming active workers settled", async () => {
  const run = await start(); install(run, [task("one")])
  const controller = new AbortController(), context = { ...invocation(), signal: controller.signal }
  host.afterBind = () => controller.abort(new Error("Supervisor disconnected"))
  await expect(engine.drive(run.id, context)).rejects.toThrow(/disconnected/)
  expect(engine.get(run.id)!.status).toBe("recovering")
  expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.status).toBe("running")
  await engine.recover(run.id)
  expect(engine.get(run.id)!.status).toBe("waiting_input")
  expect(host.launches).toHaveLength(1)
})

test("permission-blocked native launch retains the project lease through an awaited boundary", async () => {
  const run = await start(); install(run, [task("one")])
  host.beforeBind = async () => {
    await new Promise(done => setTimeout(done, 6_100))
    // Without renewal the original lease would expire before this future instant.
    expect(store.lease("project", "competing-process", Date.now() + 27_000, 30_000)).toBeUndefined()
  }
  await engine.tick(run.id, invocation())
  expect(host.launches).toHaveLength(1)
}, 10_000)

test("repair attempts stop at the configured bound and retain original checks and histories", async () => {
  const run = await start("execute")
  install(run, [task("implement", true), { ...task("review", false, ["implement"]), role: "reviewer", stage: "review" }, { ...task("verify", false, ["implement"]), role: "verifier", stage: "verification", checkIds: ["test"] }], "execution")
  await engine.tick(run.id, invocation())
  for (let i = 0; i < 24 && engine.get(run.id)!.status === "running"; i++) await settleWave(run.id, "failed")
  const complete = engine.get(run.id)!
  expect(complete.status).toBe("partial")
  expect(complete.repairRound).toBe(2)
  expect(complete.criteria).toEqual(run.criteria)
  expect(complete.tasks.filter(item => item.spec.writes)).toHaveLength(3)
  expect(complete.tasks[0]!.attempts[0]!.status).toBe("succeeded")
})

test("submitted candidates are immutable and native snapshot identity must match the worker", async () => {
  const run = await start(); install(run, [task("one")]); await engine.tick(run.id, invocation())
  const launch = host.launches[0]!
  engine.submit(launch.sessionId, { summary: "Candidate" })
  engine.submit(launch.sessionId, { summary: "Candidate" })
  expect(() => engine.submit(launch.sessionId, { summary: "Rewritten candidate" })).toThrow(/immutable/)
  host.sessions.set(launch.sessionId, { sessionId: "other-session", state: "succeeded", workspaceHash: host.hash })
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("waiting_input")
  expect(engine.get(run.id)!.tasks[0]!.acceptedAttemptId).toBeUndefined()
})

test("malformed nested worker results are rejected before persistence and can be corrected", async () => {
  const run = await start(); install(run, [task("one")]); await engine.tick(run.id, invocation())
  const sessionId = host.launches[0]!.sessionId
  for (const malformed of [
    { findings: [{ id: "finding", description: "Observed gap", blocking: true, evidence: {} }] },
    { findings: {} }, { findings: [null] }, { findings: [{ id: "", description: "Gap", blocking: true }] },
    { assessments: {} }, { assessments: [null] }, { artifacts: "result.md" }, { artifacts: [123] },
    { needsInput: 123 }, { summary: "   " },
  ]) {
    expect(() => engine.submit(sessionId, { summary: "Observed result", ...malformed })).toThrow(/Invalid task result/)
    expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.result).toBeUndefined()
    expect(store.events("project", run.id).some(event => event.kind === "result.candidate")).toBe(false)
  }
  engine.submit(sessionId, { summary: "Observed result", assessments: [{ criterionId: "request", passed: true, explanation: "Inspected requested behavior" }] })
  host.settle(sessionId)
  await expect(engine.tick(run.id, invocation())).resolves.toBeDefined()
  expect(engine.get(run.id)!.status).toBe("ready")
})

test("bounded repair preserves the union of admitted writer scopes", async () => {
  const run = await start("execute")
  install(run, [
    { ...task("first", true), ownedPaths: ["src/first.ts", "tests/first.test.ts"] },
    { ...task("second", true, ["first"]), ownedPaths: ["src/second.ts", "tests/first.test.ts"] },
    { ...task("review", false, ["second"]), role: "reviewer", stage: "review" },
    { ...task("verify", false, ["second"]), role: "verifier", stage: "verification", checkIds: ["test"] },
  ], "execution")
  await engine.tick(run.id, invocation()); await settleWave(run.id); await settleWave(run.id); await settleWave(run.id, "failed")
  const repair = engine.get(run.id)!.tasks.find(task => task.spec.id === "repair.write.1")!
  expect(repair.spec.ownedPaths).toEqual(["src/first.ts", "tests/first.test.ts", "src/second.ts"])
  await engine.tick(run.id, invocation())
  expect(host.launches.find(launch => launch.task.id === "repair.write.1")!.task.ownedPaths).toEqual(repair.spec.ownedPaths)
})

test("a graph without admitted writer scope cannot create a repair writer", async () => {
  const run = await start("execute")
  install(run, [
    { ...task("review"), role: "reviewer", stage: "review" },
    { ...task("verify"), role: "verifier", stage: "verification", checkIds: ["test"] },
  ], "execution")
  await engine.tick(run.id, invocation()); await settleWave(run.id, "failed")
  expect(engine.get(run.id)!.status).toBe("partial")
  expect(engine.get(run.id)!.repairRound).toBe(0)
  expect(engine.get(run.id)!.tasks.some(task => task.spec.writes)).toBe(false)
  expect(engine.get(run.id)!.errors.join(" ")).toContain("writer scope")
})

test("retry appends an attempt with the captured model and rejects prior-session submissions", async () => {
  const run = await start(); install(run, [task("one")]); await engine.tick(run.id, invocation())
  const original = host.launches[0]!
  host.settle(original.sessionId, "failed"); await engine.tick(run.id, invocation())
  const retry = await engine.retry(run.id, "one")
  expect(retry.supervisorHistory).toEqual(["supervisor"])
  engine.consumeStartIntent(run.id, retry.intentId, "parent"); engine.bindSupervisor(run.id, retry.intentId, "supervisor-2")
  await engine.tick(run.id, invocation("supervisor-2"))
  expect(engine.get(run.id)!.tasks[0]!.attempts).toHaveLength(2)
  expect(host.launches[1]!.attempt.model).toEqual(original.attempt.model)
  expect(() => engine.submit(original.sessionId, { summary: "Late original" })).toThrow(/Stale/)
})

test("notification delivery failure leaves a durable outbox item for one replay", async () => {
  const run = await start(); install(run, [task("one")]); await engine.tick(run.id, invocation())
  host.publicationError = new Error("Disconnected notification receiver")
  host.settle(host.launches[0]!.sessionId, "failed"); await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("partial")
  expect(engine.get(run.id)!.notifications[0]!.delivered).toBe(false)
  host.publicationError = undefined
  await engine.recover(run.id); await engine.recover(run.id)
  expect(host.publications).toHaveLength(1)
  expect(engine.get(run.id)!.notifications[0]!.delivered).toBe(true)
})

test("two required checks sharing a criterion cannot mask one another's failure", async () => {
  const run = await start("execute")
  const review: TaskSpec = { ...task("review"), role: "reviewer", stage: "review" }
  const verify: TaskSpec = { ...task("verify"), role: "verifier", stage: "verification", checkIds: ["test", "typecheck"] }
  install(run, [review, verify], "execution")
  store.mutate(run.id, saved => { saved.config.checks.push({ id: "typecheck", command: "echo typecheck", criterionIds: ["verification"] }); saved.config.limits.repairRounds = 0 })
  await engine.tick(run.id, invocation())
  for (const launch of host.launches) {
    engine.submit(launch.sessionId, { summary: "Reviewed", assessments: [{ criterionId: "request", passed: true, explanation: "Assessed original objective" }] })
    if (launch.task.id === "verify") for (const check of engine.get(run.id)!.config.checks) {
      engine.evidence(launch.sessionId, { id: check.id, attemptId: launch.attempt.id, taskId: launch.task.id, sessionId: launch.sessionId, callId: `native-${check.id}`, checkId: check.id, command: check.command, criterionIds: check.criterionIds, cwd: path, startedAt: Date.now(), finishedAt: Date.now(), exit: check.id === "test" ? 1 : 0, outcome: check.id === "test" ? "failed" : "passed", output: check.id, workspaceHash: host.hash })
    }
    host.settle(launch.sessionId)
  }
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("partial")
})

test("resume rejects changed workspace without replacing the saved intent or graph", async () => {
  const run = await start(); install(run, [task("one")]); await engine.pause(run.id)
  host.hash = "external-change"
  await expect(engine.resume(run.id)).rejects.toThrow(/stale|workspace/i)
  expect(engine.get(run.id)!.status).toBe("paused")
  expect(engine.get(run.id)!.intentId).toBe(run.intentId)
})

test("missing required native check cannot be replaced by another check on the same criterion", async () => {
  const run = await start("execute")
  install(run, [{ ...task("review"), role: "reviewer", stage: "review" }, { ...task("verify"), role: "verifier", stage: "verification", checkIds: ["test"] }], "execution")
  store.mutate(run.id, saved => { saved.config.checks.push({ id: "typecheck", command: "echo typecheck", criterionIds: ["verification"] }); saved.config.limits.repairRounds = 0 })
  await engine.tick(run.id, invocation()); await settleWave(run.id)
  expect(engine.get(run.id)!.status).toBe("partial")
})

test("denied supervisor launch and expired unconsumed intent can resume with a fresh intent", async () => {
  const run = await start()
  engine.consumeStartIntent(run.id, run.intentId, "parent")
  await engine.launchFailed(run.id, new Error("Subagent permission denied"))
  expect(engine.get(run.id)!.status).toBe("waiting_input")
  const resumed = await engine.resume(run.id)
  expect(resumed.intentId).not.toBe(run.intentId)
  store.mutate(run.id, saved => { saved.intentExpiresAt = Date.now() - 1 })
  await engine.recover(run.id)
  expect(engine.get(run.id)!.status).toBe("waiting_input")
  const continued = await engine.resume(run.id)
  expect(continued.intentId).not.toBe(resumed.intentId)
})

test("a needsInput result cannot resume or finish until a user answer creates fresh attempts", async () => {
  const run = await start(); install(run, [task("question"), task("dependent", false, ["question"])])
  await engine.tick(run.id, invocation())
  engine.submit(host.launches[0]!.sessionId, { summary: "Need a choice", needsInput: "Which behavior is intended?" })
  host.settle(host.launches[0]!.sessionId); await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("waiting_input")
  await expect(engine.resume(run.id)).rejects.toThrow(/input|answer|question/i)
  const answered = await engine.provideInput(run.id, "Keep the existing public interface")
  expect(answered.status).toBe("starting")
  expect(answered.clarifications?.[0]?.answer).toBe("Keep the existing public interface")
  engine.consumeStartIntent(run.id, answered.intentId, "parent"); engine.bindSupervisor(run.id, answered.intentId, "supervisor-2")
  await engine.tick(run.id, invocation("supervisor-2"))
  expect(engine.get(run.id)!.tasks[0]!.attempts).toHaveLength(2)
  expect(host.launches[1]!.attempt.prompt).toContain("Keep the existing public interface")
  expect(host.launches.every(launch => launch.task.id !== "dependent")).toBe(true)
})

test("providing input retains waiting_input while another child cannot be confirmed settled", async () => {
  const run = await start(); install(run, [task("question"), task("parallel")]); await engine.tick(run.id, invocation())
  engine.submit(host.launches[0]!.sessionId, { summary: "Need a choice", needsInput: "Choose behavior" })
  host.settle(host.launches[0]!.sessionId); await engine.tick(run.id, invocation())
  host.interruptState = "unknown"
  const waiting = await engine.provideInput(run.id, "Preserve current behavior")
  expect(waiting.status).toBe("waiting_input")
  expect(waiting.clarifications).toBeUndefined()
  expect(host.launches).toHaveLength(2)
})

test("explicit budget increase preserves counters and can resume an exhausted run", async () => {
  const run = await start(); install(run, [task("one")])
  store.mutate(run.id, saved => { saved.status = "waiting_budget"; saved.config.limits.attempts = 1; saved.activeMs = 42 })
  expect(() => engine.setBudget(run.id, { attempts: 0 })).toThrow()
  const raised = engine.setBudget(run.id, { attempts: 30 })
  expect(raised.config.limits.attempts).toBe(30)
  expect(raised.activeMs).toBe(42)
  expect(raised.intentId).toBe(run.intentId)
  const resumed = await engine.resume(run.id)
  expect(resumed.status).toBe("starting")
  expect(store.events("project", run.id).some(event => event.kind === "budget.updated")).toBe(true)
})

test("attempt input hashes bind permission policy and configured prompts", async () => {
  const first = await start(), second = await start()
  install(first, [task("same")]); install(second, [task("same")])
  store.mutate(second.id, saved => { saved.config.prompts = { explorer: "Inspect the public interface carefully" }; saved.policy = [{ action: "shell", resource: "*", effect: "deny" }] })
  await engine.tick(first.id, invocation()); await engine.tick(second.id, invocation())
  const firstHash = engine.get(first.id)!.tasks[0]!.attempts[0]!.inputHash
  const secondHash = engine.get(second.id)!.tasks[0]!.attempts[0]!.inputHash
  expect(firstHash).not.toBe(secondHash)
  expect(engine.get(second.id)!.tasks[0]!.attempts[0]!.prompt).toContain("Inspect the public interface carefully")
})

test("definitive denial before native child creation settles and releases its reservation", async () => {
  const run = await start("execute"); install(run, [task("write", true)], "execution")
  store.mutate(run.id, saved => { saved.config.limits.repairRounds = 0 })
  host.beforeBind = () => { throw new NoLaunchError("Subagent denied: ultra-worker") }
  await engine.tick(run.id, invocation())
  const saved = engine.get(run.id)!, attempt = saved.tasks[0]!.attempts[0]!
  expect(attempt.status).toBe("failed")
  expect(attempt.sessionId).toBeUndefined()
  expect(attempt.finishedAt).toBeDefined()
  expect(saved.status).toBe("partial")
  expect(host.launches).toHaveLength(0)
  await expect(start("execute")).resolves.toBeDefined()
})

test("a claimed precreation denial after binding remains ambiguous until native reconciliation", async () => {
  const run = await start(); install(run, [task("one")])
  host.afterBind = () => { throw new NoLaunchError("Incorrect adapter certainty after binding") }
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.status).toBe("ambiguous")
  expect(engine.get(run.id)!.status).toBe("waiting_input")
})

test("a second location queues its genuine invocation until project ownership is released", async () => {
  const first = await start(), second = await start()
  install(first, [task("first")]); install(second, [task("second")])
  const otherHost = new FakeHost(), other = new Engine(store, otherHost, "project", path, config)
  otherHost.sessionPrefix = "other-location-session"
  const firstController = new AbortController(), secondController = new AbortController()
  const firstContext = { ...invocation(), signal: firstController.signal }, secondContext = { ...invocation(), signal: secondController.signal }
  const firstDrive = engine.drive(first.id, firstContext).catch(error => error)
  while (!host.launches.length) await new Promise(done => setTimeout(done, 5))
  const secondDrive = other.drive(second.id, secondContext).catch(error => error)
  await new Promise(done => setTimeout(done, 130))
  expect(otherHost.launches).toHaveLength(0)
  firstController.abort(new Error("Release first supervisor")); await firstDrive
  for (let i = 0; i < 60 && !otherHost.launches.length; i++) await new Promise(done => setTimeout(done, 5))
  expect(otherHost.launches).toHaveLength(1)
  expect(otherHost.launches[0]!.invocation).toBe(secondContext)
  expect(store.events("project", second.id).filter(event => event.kind === "ownership.waiting")).toHaveLength(1)
  secondController.abort(new Error("Test cleanup")); await secondDrive
})

test("queued ownership controls stop on abort without running their mutation", async () => {
  const lease = store.lease("project", "another-process", Date.now(), 30_000)!
  const controller = new AbortController(); let ran = false
  const waiting = engine.withOwnership(controller.signal, () => { ran = true })
  controller.abort(new Error("Control cancelled"))
  await expect(waiting).rejects.toThrow(/cancelled/)
  expect(ran).toBe(false); store.release(lease)
})

test("location engines sharing a database coordinate concurrent drives and live child controls", async () => {
  const database = join(path, "state.sqlite"), otherStore = new SQLiteStore(database)
  const otherHost = new FakeHost(); otherHost.sessionPrefix = "shared-location-session"
  const firstEngine = new Engine(store, host, "project", path, config, database)
  const secondEngine = new Engine(otherStore, otherHost, "project", path, config, database)
  const options = { objective: "Inspect behavior", mode: "plan" as const, parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, policy: [] }
  const first = await firstEngine.start(options), second = await secondEngine.start(options)
  install(first, [task("a"), task("b"), task("c")]); install(second, [task("d"), task("e"), task("f")])
  const firstController = new AbortController(), secondController = new AbortController()
  const firstDrive = firstEngine.drive(first.id, { ...invocation(), signal: firstController.signal }).catch(error => error)
  const secondDrive = secondEngine.drive(second.id, { ...invocation(), signal: secondController.signal }).catch(error => error)
  try {
    for (let i = 0; i < 80 && host.launches.length + otherHost.launches.length < 4; i++) await new Promise(done => setTimeout(done, 5))
    expect(host.launches.length + otherHost.launches.length).toBe(4)
    const launch = host.launches[0]!
    await firstEngine.withOwnership(new AbortController().signal, () => firstEngine.submit(launch.sessionId, { summary: "Child remains attributable while both drivers own the shared coordinator" }))
    const paused = await secondEngine.withOwnership(new AbortController().signal, () => secondEngine.pause(second.id))
    expect(paused.status).toBe("pausing")
    expect(firstEngine.get(first.id)!.tasks.find(item => item.spec.id === launch.task.id)!.attempts[0]!.result?.summary).toContain("attributable")
  } finally {
    firstController.abort(new Error("Shared test cleanup")); secondController.abort(new Error("Shared test cleanup"))
    await Promise.all([firstDrive, secondDrive]); otherStore.close()
  }
})

test("location recovery does not inspect or quarantine another worktree's active sessions", async () => {
  const database = join(path, "state.sqlite"), otherDirectory = join(path, "other-location")
  const local = new Engine(store, host, "project", path, config, database), foreignHost = new FakeHost()
  const foreign = new Engine(store, foreignHost, "project", otherDirectory, config, database)
  const run = await local.start({ objective: "Inspect behavior", mode: "plan", parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, policy: [] })
  install(run, [task("one")]); await local.tick(run.id, invocation())
  expect(await foreign.recover()).toEqual([])
  await expect(foreign.recover(run.id)).rejects.toThrow(/location/)
  expect(local.get(run.id)!.status).toBe("planning")
})

test("bounded repair preserves task model overrides authorized by the captured run options", async () => {
  const run = await engine.start({ objective: "Inspect behavior", mode: "execute", parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, modelOptions: { roles: { implementer: "fixture/test#high" } }, policy: [] })
  install(run, [{ ...task("implement", true), model: "fixture/test#high" }, { ...task("review", false, ["implement"]), role: "reviewer", stage: "review" }, { ...task("verify", false, ["implement"]), role: "verifier", stage: "verification", checkIds: ["test"] }], "execution")
  await engine.tick(run.id, invocation()); await settleWave(run.id)
  await settleWave(run.id, "failed")
  expect(engine.get(run.id)!.repairRound).toBe(1)
  expect(engine.get(run.id)!.plans.at(-1)!.tasks.find(task => task.id === "implement")!.model).toBe("fixture/test#high")
})

test("retrying a failed implementation reruns blocked review and native verification descendants", async () => {
  const run = await start("execute")
  install(run, [task("implement", true), { ...task("review", false, ["implement"]), role: "reviewer", stage: "review" }, { ...task("verify", false, ["implement"]), role: "verifier", stage: "verification", checkIds: ["test"] }], "execution")
  store.mutate(run.id, saved => { saved.config.limits.repairRounds = 0 })
  await engine.tick(run.id, invocation())
  host.settle(host.launches[0]!.sessionId, "failed"); await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.tasks.slice(1).every(task => task.status === "blocked")).toBe(true)
  const retried = await engine.retry(run.id, "implement")
  engine.consumeStartIntent(run.id, retried.intentId, "parent"); engine.bindSupervisor(run.id, retried.intentId, "supervisor")
  await engine.tick(run.id, invocation())
  for (let i = 0; i < 10 && engine.get(run.id)!.status === "running"; i++) await settleWave(run.id)
  const complete = engine.get(run.id)!
  expect(complete.status).toBe("succeeded")
  expect(complete.tasks[0]!.attempts).toHaveLength(2)
  expect(complete.tasks[1]!.attempts).toHaveLength(1)
  expect(complete.tasks[2]!.attempts[0]!.checks).toHaveLength(1)
})

test("retrying planning discovery reruns design, critique, and reconciliation descendants", async () => {
  const run = await start()
  engine.consumeStartIntent(run.id, run.intentId, "parent"); engine.bindSupervisor(run.id, run.intentId, "supervisor")
  await engine.tick(run.id, invocation())
  const explore = host.launches.find(item => item.task.id === "explore")!, research = host.launches.find(item => item.task.id === "research")!
  host.settle(explore.sessionId, "failed"); engine.submit(research.sessionId, { summary: "Source contracts established", assessments: [{ criterionId: "request", passed: true, explanation: "Research criteria assessed" }] }); host.settle(research.sessionId)
  for (let i = 0; i < 10 && engine.get(run.id)!.status === "planning"; i++) await settleWave(run.id)
  expect(engine.get(run.id)!.status).toBe("partial")
  const retried = await engine.retry(run.id, "explore")
  engine.consumeStartIntent(run.id, retried.intentId, "parent"); engine.bindSupervisor(run.id, retried.intentId, "supervisor")
  await engine.tick(run.id, invocation())
  for (let i = 0; i < 12 && engine.get(run.id)!.status === "planning"; i++) await settleWave(run.id)
  expect(engine.get(run.id)!.status).toBe("ready")
  expect(engine.get(run.id)!.tasks.find(task => task.spec.id === "research")!.attempts).toHaveLength(1)
  for (const id of ["design", "critique", "reconcile"]) expect(engine.get(run.id)!.tasks.find(task => task.spec.id === id)!.status).toBe("succeeded")
})

test("retry invalidates accepted descendant results but rejects dependent workers still in flight", async () => {
  const run = await start(); install(run, [task("failed"), { ...task("dependent", false, ["failed"]), acceptsFailures: true }])
  await engine.tick(run.id, invocation()); host.settle(host.launches[0]!.sessionId, "failed"); await engine.tick(run.id, invocation())
  const dependent = host.launches[1]!
  await expect(engine.retry(run.id, "failed")).rejects.toThrow(/dependent|settled|active/i)
  engine.submit(dependent.sessionId, { summary: "Examined the failure", assessments: [{ criterionId: "request", passed: true, explanation: "Observed the failed predecessor" }] })
  host.settle(dependent.sessionId); await engine.tick(run.id, invocation())
  const accepted = engine.get(run.id)!.tasks[1]!.acceptedAttemptId
  expect(accepted).toBeDefined()
  const retried = await engine.retry(run.id, "failed")
  expect(retried.tasks[1]!.status).toBe("pending")
  expect(retried.tasks[1]!.acceptedAttemptId).toBeUndefined()
  expect(retried.tasks[1]!.attempts[0]!.result?.summary).toBe("Examined the failure")
  expect(() => engine.submit(dependent.sessionId, { summary: "Late dependent correction" })).toThrow(/Stale/)
})

test("cancellation during reserved prelaunch retains the settled native child and reaches cancelled", async () => {
  const run = await start("execute"); install(run, [task("write", true)], "execution")
  host.beforeBind = async () => {
    const cancellation = await engine.cancel(run.id)
    expect(cancellation.status).toBe("cancelling")
    throw new SettledLaunchError("never-released-child", "Ownership binding refused during cancellation; child settled before release")
  }
  await engine.tick(run.id, invocation()); await engine.tick(run.id, invocation())
  const saved = engine.get(run.id)!, attempt = saved.tasks[0]!.attempts[0]!
  expect(saved.status).toBe("cancelled")
  expect(attempt.status).toBe("cancelled")
  expect(attempt.sessionId).toBe("never-released-child")
  expect(attempt.finishedAt).toBeDefined()
  expect(host.launches).toHaveLength(0)
  await expect(start("execute")).resolves.toBeDefined()
})

test("uncertain reserved launch failure preserves cancelling and quarantines capacity", async () => {
  const run = await start("execute"); install(run, [task("write", true)], "execution")
  host.beforeBind = async () => { await engine.cancel(run.id); throw new Error("No proof whether a native child survived") }
  await engine.tick(run.id, invocation()); await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("cancelling")
  expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.status).toBe("ambiguous")
  await expect(start("execute")).rejects.toThrow(/writer|execution/)
})

test("settled-before-release identity must match the dispatch binding", async () => {
  const run = await start(); install(run, [task("first"), task("second")])
  host.afterBind = sessionId => { throw new SettledLaunchError(`${sessionId}-different`, "Mismatched cleanup receipt") }
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("waiting_input")
  expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.status).toBe("ambiguous")
  expect(engine.get(run.id)!.tasks[0]!.attempts[0]!.sessionId).toBe("fake-session-1")
})

test("cleanup failure retains its attested native child identity without claiming settlement", async () => {
  const run = await start("execute"); install(run, [task("write", true)], "execution")
  host.beforeBind = async () => { await engine.cancel(run.id); throw new UnsettledLaunchError("unconfirmed-child", "Native cleanup wait failed") }
  await engine.tick(run.id, invocation())
  const saved = engine.get(run.id)!, attempt = saved.tasks[0]!.attempts[0]!
  expect(saved.status).toBe("cancelling")
  expect(attempt.status).toBe("ambiguous")
  expect(attempt.sessionId).toBe("unconfirmed-child")
  expect(attempt.finishedAt).toBeUndefined()
  host.settle("unconfirmed-child", "interrupted")
  await engine.tick(run.id, invocation())
  expect(engine.get(run.id)!.status).toBe("cancelled")
})

test("an attested prelaunch error cannot reuse another attempt's native child identity", async () => {
  const run = await start(); install(run, [task("first"), task("second")])
  host.beforeBind = () => { if (host.launches.length) throw new SettledLaunchError(host.launches[0]!.sessionId, "Child was already bound to another attempt") }
  await engine.tick(run.id, invocation())
  const attempts = engine.get(run.id)!.tasks.map(task => task.attempts[0]!)
  expect(attempts[0]!.sessionId).toBe("fake-session-1")
  expect(attempts[1]!.sessionId).toBeUndefined()
  expect(attempts[1]!.status).toBe("ambiguous")
})

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { OpenCodeAdapter, checkedInput, checkOutcome, invocation, visibleTools } from "../src/opencode.ts"
import type { Binding } from "../src/opencode.ts"
import type { Run, Store } from "../src/types.ts"
import { SettledLaunchError } from "../src/types.ts"
import { execFileSync } from "node:child_process"

function bridgeFixture() {
  const directory = process.cwd(), sessions = new Map<string, any>()
  const calls: { input: any; context: any; release: () => void }[] = []
  const waiters: { count: number; resolve: () => void }[] = []
  const seed = (id: string, parentID?: string) => sessions.set(id, { id, parentID, projectID: "project", location: { directory }, permissions: [] })
  const model = { ref: { providerID: "fixture", id: "model" }, requested: "fixture/model", origin: "captured" as const }
  const native = (name: string, input: any) => ({ name, input, async execute(input: any, context: any) {
    let release!: () => void
    const held = new Promise<void>(done => { release = done })
    const number = calls.push({ input, context, release })
    for (const waiter of waiters) if (number >= waiter.count) waiter.resolve()
    if (name === "shell") { await held; return { output: { exit: 0, status: "completed" } } }
    const child = `child_${number}`
    seed(child, context.sessionID)
    await context.progress({ sessionID: child })
    await held
    return { output: { sessionID: child, status: "running" } }
  } })
  const tools = [
    native("subagent", Schema.Struct({ agent: Schema.String, description: Schema.String, prompt: Schema.String, background: Schema.Boolean, model: Schema.String })),
    native("shell", Schema.Struct({ command: Schema.String, background: Schema.Boolean, timeout: Schema.Number })),
  ]
  const ctx = {
    location: { directory, project: { id: "project" } }, tool: { async list() { return tools } },
    session: {
      async get({ sessionID }: any) { return sessions.get(sessionID) },
      async update({ sessionID, permissions }: any) { sessions.get(sessionID).permissions = permissions },
    },
  }
  const adapter = new OpenCodeAdapter(ctx as any, { list() { return [] }, event() { return true } } as unknown as Store, {} as any)
  adapter.workspace = async () => "workspace"
  const context = (sessionID: string, messageID = "message", id = "call") => {
    seed(sessionID)
    return { sessionID, messageID, id, agent: "ultra", signal: new AbortController().signal, async progress() {} } as any
  }
  const run = (sessionId: string): Run => ({ id: `run_${sessionId}`, projectId: "project", directory, parentSessionId: sessionId, supervisorSessionId: sessionId, intentId: "intent", policy: [{ action: "*", resource: "*", effect: "allow" }], status: "running", ownerEpoch: 1, tasks: [] } as unknown as Run)
  const worker = (sessionId: string): Binding => {
    const saved = run("supervisor")
    const task = { id: sessionId, title: "Verify", role: "verifier" as const, stage: "verification" as const, instructions: "Check", dependencies: [], writes: false, checkIds: ["unit"] }
    const attempt = { id: `attempt_${sessionId}`, sessionId, status: "running", ownerEpoch: 1 } as any
    saved.config = { limits: { workerMs: 1_000 }, checks: [{ id: "unit", command: `check ${sessionId}`, criterionIds: ["tests"] }] } as any
    saved.tasks = [{ spec: task, status: "running", attempts: [attempt] }]
    return { run: saved, task, attempt, role: "verifier" }
  }
  return { adapter, ctx, directory, sessions, calls, model, context, run, worker, async entered(count: number) {
    if (calls.length >= count) return
    await new Promise<void>(resolve => { waiters.push({ count, resolve }) })
  }, async settle(operations: Promise<unknown>[]) { calls.forEach(call => call.release()); await Promise.allSettled(operations) } }
}

describe("native adapter boundaries", () => {
  test("completion notices use valid stable native message IDs for queued retries", async () => {
    const f = bridgeFixture(), notices: any[] = []
    f.context("parent")
    Object.assign(f.ctx.session, { async synthetic(input: any) {
      Schema.decodeUnknownSync(SessionMessage.ID)(input.id)
      notices.push(input)
    } })
    const run = f.run("parent")
    await f.adapter.publish(run, "notification_saved", "Verified candidate")
    await f.adapter.publish(run, "notification_saved", "Verified candidate")
    expect(notices.map(item => item.id)).toEqual(["msg_ultra_notification_saved", "msg_ultra_notification_saved"])
    expect(notices[0]).toMatchObject({ sessionID: "parent", delivery: "queue", resume: false, metadata: { ultraRunId: run.id } })
  })
  test("only an active fixed preparation command removes Git overrides before the native shell spawn", () => {
    const f = bridgeFixture(), event = { command: "fixed-preparation", cwd: f.directory, env: { ...process.env, GIT_DIR: "foreign-git", GIT_CONFIG_COUNT: "1", ULTRA_FIXTURE_KEEP: "kept" } }
    f.adapter.preparations.set("proof", { sessionId: "prepare", messageId: "message", command: event.command, directory: f.directory })
    f.adapter.preparationShell(event)
    expect(event.env.GIT_DIR).toBeUndefined(); expect(event.env.GIT_CONFIG_COUNT).toBeUndefined()
    const output = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({git:process.env.GIT_DIR??null,config:process.env.GIT_CONFIG_COUNT??null,keep:process.env.ULTRA_FIXTURE_KEEP}))"], { env: { ...process.env, ...event.env }, encoding: "utf8" })
    expect(JSON.parse(output)).toEqual({ git: null, config: null, keep: "kept" })
    const unrelated = { command: "ordinary-user-command", cwd: f.directory, env: { GIT_DIR: "user-choice" } }
    f.adapter.preparationShell(unrelated); expect(unrelated.env.GIT_DIR).toBe("user-choice")
  })
  test("native idle polling stays bounded and shares one wait when the SDK ignores request options", async () => {
    const f = bridgeFixture()
    f.context("worker")
    Object.assign(f.sessions.get("worker"), { time: { idle: 1 }, outcome: "succeeded", tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.1 })
    Object.assign(f.ctx, { permission: { async list() { return [] } } })
    let release!: () => void, waits = 0, timer: ReturnType<typeof setTimeout> | undefined
    const held = new Promise<void>(resolve => { release = resolve })
    Object.assign(f.ctx.session, { async wait() { waits++; await held } })
    const first = f.adapter.inspect("worker")
    try {
      const snapshot = await Promise.race([first, new Promise(resolve => { timer = setTimeout(() => resolve({ state: "inspection blocked by ignored request options" }), 200) })])
      expect(snapshot).toMatchObject({ state: "running", tokens: 7, cost: 0.1 })
      expect(await f.adapter.inspect("worker")).toMatchObject({ state: "running" })
      expect(waits).toBe(1)
      Object.assign(f.sessions.get("worker"), { time: { idle: 2 }, tokens: { input: 5, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.2 })
      release()
      expect(await f.adapter.inspect("worker")).toMatchObject({ state: "succeeded", tokens: 9, cost: 0.2 })
      expect(waits).toBe(2)
    } finally { clearTimeout(timer); release(); await first }
  })
  test("moved workers bind only at their recorded destination while the source can reconcile them", async () => {
    const f = bridgeFixture(), saved = f.run("supervisor"), worker = f.worker("worker"), destination = f.directory + "/.ultracode/test-worktree"
    saved.tasks = worker.run.tasks
    saved.tasks[0]!.attempts[0]!.worktree = { directory: destination, state: "ready" }
    f.context("worker"); f.sessions.get("worker").location.directory = destination
    const store = { list() { return [saved] }, event() { return true } } as unknown as Store
    const source = new OpenCodeAdapter(f.ctx as any, store, {} as any)
    const target = new OpenCodeAdapter({ ...f.ctx, location: { directory: destination, project: { id: "project" } } } as any, store, {} as any)
    expect(source.binding("worker")?.retired).toBe(true)
    expect(target.binding("worker")?.attempt?.id).toBe("attempt_worker")
    expect(target.binding("supervisor")).toBeUndefined()
    await expect(source.scoped("worker")).rejects.toThrow("outside")
    await expect(source.scoped("worker", destination as any)).resolves.toMatchObject({ id: "worker" })
  })
  test("destination hooks must be ready and retiring an old adapter cannot erase a replacement", () => {
    const f = bridgeFixture(), saved = f.run("supervisor"), worker = f.worker("worker"), destination = f.directory + "/.ultracode/ready-worktree"
    saved.tasks = worker.run.tasks; saved.tasks[0]!.attempts[0]!.worktree = { directory: destination, state: "ready" }
    const store = { list() { return [saved] }, event() { return true } } as unknown as Store
    const ctx = { ...f.ctx, location: { directory: destination, project: { id: "project" } } }
    const source = new OpenCodeAdapter(f.ctx as any, store, {} as any), old = new OpenCodeAdapter(ctx as any, store, {} as any), replacement = new OpenCodeAdapter(ctx as any, store, {} as any)
    expect(source.destinationReady(destination, "worker")).toBe(false)
    old.markReady()
    expect(source.destinationReady(destination, "worker")).toBe(true)
    replacement.markReady(); old.retire()
    expect(source.destinationReady(destination, "worker")).toBe(true)
    replacement.retire()
    expect(source.destinationReady(destination, "worker")).toBe(false)
  })
  test("native delegated worktree children move and establish destination hooks before prompt release", async () => {
    const f = bridgeFixture(), context = f.context("supervisor"), saved = f.run("supervisor"), destination = f.directory + "/.ultracode/prelaunch-worktree", order: string[] = []
    const task = { id: "writer", title: "Write", role: "implementer", stage: "implementation", instructions: "Write", dependencies: [], writes: true, ownedPaths: ["a.txt"] } as any
    const attempt = { id: "attempt-writer", taskId: task.id, model: f.model, prompt: "Write", status: "reserved", ownerEpoch: 1, worktree: { directory: destination, state: "ready" } } as any
    saved.tasks = [{ spec: task, status: "running", attempts: [attempt] }]
    const store = { list() { return [saved] }, event() { return true } } as unknown as Store
    const source = new OpenCodeAdapter(f.ctx as any, store, {} as any), target = new OpenCodeAdapter({ ...f.ctx, location: { directory: destination, project: { id: "project" } } } as any, store, {} as any)
    const update = f.ctx.session.update
    f.ctx.session.update = async input => { order.push("permissions"); await update(input) }
    Object.assign(f.ctx.session, { async move({ sessionID, directory }: any) { order.push("move"); f.sessions.get(sessionID).location.directory = directory }, async wait() { order.push("wait") }, async prompt(input: any) {
      order.push("activation"); expect(input.resume).toBe(false); expect(input.metadata.ultraWorktreeActivation).toBe(true); expect(input.metadata.ultraAttemptId).toBe(attempt.id)
      target.markReady(); return { id: "activation-message" }
    } })
    context.progress = async () => { order.push("release") }
    const operation = source.launch(saved, attempt, task, invocation(context), async id => { order.push("bind"); attempt.sessionId = id; attempt.status = "running" })
    operation.catch(() => {})
    try {
      await f.entered(1)
      await new Promise(done => setTimeout(done, 10))
      expect(order).toEqual(["bind", "permissions", "move", "wait", "activation", "release"])
      expect(target.binding("child_1")?.task?.id).toBe("writer")
      f.calls[0]!.release(); await operation
    } finally { target.retire(); await f.settle([operation]) }
  })
  test("placement observes source cancellation even when native idle wait ignores request options", async () => {
    const f = bridgeFixture(), controller = new AbortController(), context = f.context("supervisor"), saved = f.run("supervisor"), destination = f.directory + "/.ultracode/aborted-placement"
    context.signal = controller.signal
    const task = { id: "writer", title: "Write", role: "implementer", stage: "implementation", instructions: "Write", dependencies: [], writes: true, ownedPaths: ["a.txt"] } as any
    const attempt = { id: "attempt-writer", taskId: task.id, model: f.model, prompt: "Write", status: "reserved", ownerEpoch: 1, worktree: { directory: destination, state: "ready" } } as any
    saved.tasks = [{ spec: task, status: "running", attempts: [attempt] }]
    const source = new OpenCodeAdapter(f.ctx as any, { list() { return [saved] }, event() { return true } } as unknown as Store, {} as any)
    let release!: () => void, entered!: () => void, activation = 0, interruption = 0, timer: ReturnType<typeof setTimeout> | undefined
    const held = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
    Object.assign(f.ctx.session, {
      async move({ sessionID, directory }: any) { f.sessions.get(sessionID).location.directory = directory },
      async wait() { entered(); await held },
      async interrupt() { interruption++; release() },
      async prompt() { activation++; return { id: "unexpected-activation" } },
    })
    const operation = source.launch(saved, attempt, task, invocation(context), async id => { attempt.sessionId = id; attempt.status = "running" })
    const outcome = operation.then(() => undefined, error => error)
    try {
      await Promise.race([waiting, operation])
      controller.abort(new Error("Placement interrupted"))
      const result = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve("Placement remained blocked after source cancellation"), 200) })])
      expect(result).toBeInstanceOf(SettledLaunchError)
      expect(interruption).toBe(1)
      expect(activation).toBe(0)
    } finally { clearTimeout(timer); release(); await f.settle([outcome]) }
  })
  test("decodes real native schemas and refuses an unsupported validator", async () => {
    expect(await checkedInput({ name: "probe", input: Schema.Struct({ count: Schema.Number }) } as any, { count: 3 })).toEqual({ count: 3 })
    await expect(checkedInput({ name: "probe", input: Schema.Struct({ count: Schema.Number }) } as any, { count: "3" })).rejects.toThrow()
    await expect(checkedInput({ name: "probe", input: {} } as any, {})).rejects.toThrow("Unsupported")
  })
  test("workers cannot expose raw shell, delegation or codemode escape hatches", () => {
    const tools = Object.fromEntries(["read", "write", "edit", "shell", "execute", "subagent", "ultra_submit", "ultra_check", "ultra_execute", "ultra_start", "third_party"].map(name => [name, {}]))
    expect(Object.keys(visibleTools(tools, "reviewer"))).toEqual(["read", "ultra_submit"])
    expect(Object.keys(visibleTools(tools, "implementer"))).toEqual(["read", "write", "edit", "ultra_submit"])
    expect(Object.keys(visibleTools(tools, "verifier"))).toEqual(["read", "ultra_submit", "ultra_check"])
    expect(Object.keys(visibleTools(tools, "supervisor"))).toEqual(["ultra_execute"])
    expect(visibleTools({ "third_party.read": {}, "third_party.write": {}, "third_party.ultra_execute": {} }, "implementer")).toEqual({})
  })
  test("a model assertion or missing native exit is never a passed check", () => {
    expect(checkOutcome({ exit: 0 })).toBe("passed")
    expect(checkOutcome({ exit: 1 })).toBe("failed")
    expect(checkOutcome({ passed: true })).toBe("unknown")
    expect(checkOutcome({ exit: null })).toBe("unknown")
  })

  test("reused provider call IDs in distinct sessions keep independent native delegation proof", async () => {
    const f = bridgeFixture(), a = f.context("parent_a"), b = f.context("parent_b")
    const operations = [f.adapter.supervisor(f.run(a.sessionID), invocation(a), f.model, async () => {}), f.adapter.supervisor(f.run(b.sessionID), invocation(b), f.model, async () => {})]
    try {
      await f.entered(2)
      expect(f.adapter.delegations.size).toBe(2)
      f.calls[0]!.release(); await operations[0]
      expect([...f.adapter.delegations.values()]).toEqual([expect.objectContaining({ sessionId: b.sessionID, messageId: b.messageID, agent: "ultra-supervisor" })])
      f.calls[1]!.release(); await operations[1]
      expect(f.adapter.delegations.size).toBe(0)
    } finally { await f.settle(operations) }
  })

  test("parallel worker delegation on one supervisor invocation retains proof until every dispatch settles", async () => {
    const f = bridgeFixture(), context = f.context("supervisor"), saved = f.run(context.sessionID)
    const task = { id: "research", title: "Research", role: "researcher" as const, stage: "discovery" as const, instructions: "Inspect", dependencies: [], writes: false }
    const attempt = { model: f.model, prompt: "Inspect" } as any
    const operations = [f.adapter.launch(saved, attempt, task, invocation(context), async () => {}), f.adapter.launch(saved, attempt, task, invocation(context), async () => {})]
    const binding: Binding = { run: saved, role: "supervisor" }
    const event = { sessionID: context.sessionID, action: "subagent", resources: ["ultra-worker"], source: { messageID: context.messageID, id: context.id }, effect: "ask" as const }
    try {
      await f.entered(2)
      expect(f.adapter.delegations.size).toBe(1)
      expect(f.adapter.permission(binding, event)).toBe("ask")
      f.calls[0]!.release(); await operations[0]
      expect(f.adapter.permission(binding, event)).toBe("ask")
      expect(f.adapter.permission(binding, { ...event, effect: "deny" })).toBe("deny")
      expect(f.adapter.permission(binding, { ...event, source: { ...event.source, messageID: "other_message" } })).toBe("deny")
      expect(f.adapter.permission(binding, { ...event, source: { id: context.id } } as any)).toBe("deny")
      expect(f.adapter.permission(binding, { ...event, sessionID: "other_session" })).toBe("deny")
      f.calls[1]!.release(); await operations[1]
      expect(f.adapter.permission(binding, event)).toBe("deny")
    } finally { await f.settle(operations) }
  })

  test("an overlapping invocation cannot change its delegation target", async () => {
    const f = bridgeFixture(), context = f.context("parent"), saved = f.run(context.sessionID)
    const first = f.adapter.supervisor(saved, invocation(context), f.model, async () => {})
    try {
      await f.entered(1)
      const task = { id: "research", title: "Research", role: "researcher" as const, stage: "discovery" as const, instructions: "Inspect", dependencies: [], writes: false }
      const second = f.adapter.launch(saved, { model: f.model, prompt: "Inspect" } as any, task, invocation(context), async () => {})
      // Even a rejected claim must not remove the first dispatch's proof.
      let outcome: unknown
      second.catch(error => { outcome = error })
      await new Promise(done => setTimeout(done, 10))
      expect(outcome).toBeInstanceOf(Error)
      expect(f.calls).toHaveLength(1)
      expect([...f.adapter.delegations.values()][0]?.agent).toBe("ultra-supervisor")
      f.calls.forEach(call => call.release()); await Promise.allSettled([first, second])
    } finally { await f.settle([first]) }
  })

  test("checks with repeated call IDs retain only their own session and message authorization", async () => {
    const f = bridgeFixture(), a = f.context("worker_a"), b = f.context("worker_b"), bindingA = f.worker(a.sessionID), bindingB = f.worker(b.sessionID)
    const operations = [f.adapter.check(bindingA, "unit", a), f.adapter.check(bindingB, "unit", b)]
    try {
      await f.entered(2)
      expect(f.adapter.checks.size).toBe(2)
      const event = { sessionID: b.sessionID, action: "shell", resources: ["check worker_b"], source: { messageID: b.messageID, id: b.id }, effect: "ask" as const }
      expect(f.adapter.permission(bindingB, event)).toBe("ask")
      expect(f.adapter.permission(bindingB, { ...event, source: { ...event.source, messageID: "old_message" } })).toBe("deny")
      expect(f.adapter.permission(bindingB, { ...event, source: { id: b.id } } as any)).toBe("deny")
      expect(f.adapter.permission(bindingB, { ...event, sessionID: a.sessionID })).toBe("deny")
      f.calls[0]!.release(); await operations[0]
      expect(f.adapter.permission(bindingB, event)).toBe("ask")
      f.calls[1]!.release(); await operations[1]
      expect(f.adapter.checks.size).toBe(0)
    } finally { await f.settle(operations) }
  })

  test("a check invocation is claimed after asynchronous preparation and cannot run twice concurrently", async () => {
    const f = bridgeFixture(), context = f.context("worker"), binding = f.worker(context.sessionID)
    const operations = [f.adapter.check(binding, "unit", context), f.adapter.check(binding, "unit", context)]
    const results = operations.map(operation => operation.then(() => ({ status: "resolved" }), error => ({ status: "rejected", error })))
    try {
      await f.entered(1)
      await new Promise(done => setTimeout(done, 10))
      expect(f.calls).toHaveLength(1)
      f.calls[0]!.release()
      const outcomes = await Promise.all(results)
      expect(outcomes.map(value => value.status).sort()).toEqual(["rejected", "resolved"])
      expect(f.adapter.checks.size).toBe(0)
    } finally { await f.settle(operations) }
  })
})

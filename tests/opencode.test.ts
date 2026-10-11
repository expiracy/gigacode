import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenCodeAdapter, checkedInput, checkOutcome, invocation, visibleTools } from "../src/opencode.ts"
import type { Binding } from "../src/opencode.ts"
import type { Run, Store } from "../src/types.ts"

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
  return { adapter, calls, model, context, run, worker, async entered(count: number) {
    if (calls.length >= count) return
    await new Promise<void>(resolve => { waiters.push({ count, resolve }) })
  }, async settle(operations: Promise<unknown>[]) { calls.forEach(call => call.release()); await Promise.allSettled(operations) } }
}

describe("native adapter boundaries", () => {
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

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Error as NativeToolError } from "@opencode/plugin/promise/tool"
import { join } from "node:path"
import { OpenCodeAdapter, checkOutcome, invocation, visibleTools } from "../src/opencode.ts"
import { parseConfig } from "../src/config.ts"
import { evaluateRules } from "../src/policy.ts"
import type { ModelSelection, Run, Store } from "../src/types.ts"
import { NoLaunchError, SettledLaunchError, UnsettledLaunchError } from "../src/types.ts"

const model: ModelSelection = { requested: "fixture/model", origin: "captured", ref: { providerID: "fixture", id: "model" } }

// Both pinned native handlers reject these before sessions.create and progress.
const precreationFailures = [
  { label: "depth limit", message: 'Subagent depth limit reached (1). Increase "experimental.subagent_depth" to allow nested subagents.', model },
  { label: "missing agent", message: "Unknown agent: gigacode-supervisor", model },
  { label: "primary-only agent", message: "Agent gigacode-supervisor cannot run as a subagent", model },
  { label: "missing model", message: 'Model "fixture/model" is not available. Use the models tool to see what is available.', model },
  { label: "model without variants", message: 'Model "fixture/model" has no variants. Omit the variant.', model: { ...model, ref: { ...model.ref, variant: "fast" } } },
  { label: "unavailable variant", message: 'Variant "fast" is not available for "fixture/model". Available: slow, default.', model: { ...model, ref: { ...model.ref, variant: "fast" } } },
  { label: "invalid native model reference", message: 'Invalid model "fixture/". Use "providerID/modelID" or "providerID/modelID#variant".', model: { ...model, ref: { ...model.ref, id: "" } } },
] satisfies { label: string; message: string; model: ModelSelection }[]

function admissionFixture(options: { ignorePermissionUpdate?: boolean; status?: string; failure?: unknown; failureAfterPrelaunch?: boolean; cleanupActive?: boolean; cleanupFailure?: boolean } = {}) {
  const order: string[] = []
  const events: unknown[] = []
  const parentId = "ses_parent", childId = "ses_child", projectId = "project"
  const directory = process.cwd()
  const run = { id: "run_admission", projectId, directory, parentSessionId: parentId, intentId: "intent", policy: [{ action: "*", resource: "*", effect: "allow" }], tasks: [] } as unknown as Run
  const sessions: Record<string, any> = {
    [parentId]: { id: parentId, projectID: projectId, location: { directory }, permissions: [], time: {}, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
    [childId]: { id: childId, parentID: parentId, projectID: projectId, location: { directory }, permissions: [], time: { idle: 123 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
  }
  const native = {
    name: "subagent",
    input: Schema.Struct({ agent: Schema.String, description: Schema.String, prompt: Schema.String, background: Schema.Boolean, model: Schema.String }),
    async execute(_args: unknown, context: any) {
      if (options.failure && !options.failureAfterPrelaunch) throw options.failure
      await context.progress({ sessionID: childId, status: "running" })
      order.push("prompt-admitted")
      if (options.failure) throw options.failure
      return { output: { sessionID: childId, status: options.status ?? "running" }, content: "background child" }
    },
  }
  const ctx = {
    location: { directory, project: { id: projectId } },
    tool: { async list() { return [native] } },
    permission: { async list() { return [] } },
    session: {
      async get({ sessionID }: any) { return sessions[sessionID] },
      async update({ sessionID, permissions }: any) { order.push("permissions-updated"); if (!options.ignorePermissionUpdate) sessions[sessionID].permissions = permissions },
      async interrupt() { order.push("interrupt"); if (options.cleanupFailure) throw new Error("Cleanup unavailable"); if (options.cleanupActive) sessions[childId].time = {} },
      async wait() { order.push("wait"); if (options.cleanupActive) throw new Error("Child execution has not settled") },
    },
  }
  const store = { list() { return [run] }, event(_projectId: string, event: unknown) { events.push(event); return true } } as unknown as Store
  const adapter = new OpenCodeAdapter(ctx as any, store, {} as any)
  const context = { sessionID: parentId, messageID: "message", id: "call", signal: new AbortController().signal, async progress() { order.push("progress-released") } } as any
  return { adapter, run, context, order, events, childId, sessions }
}

describe("native admission and lifecycle regressions", () => {
  test("persists the child identity and restrictive permissions before releasing the native prelaunch callback", async () => {
    const fixture = admissionFixture()
    const child = await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => { fixture.order.push("identity-bound") })
    expect(child.sessionId).toBe(fixture.childId)
    expect(fixture.order.slice(0, 4)).toEqual(["identity-bound", "permissions-updated", "progress-released", "prompt-admitted"])
    expect(fixture.sessions[fixture.childId].permissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" })
  })

  test("refuses prompt admission if the host did not retain child permissions", async () => {
    const fixture = admissionFixture({ ignorePermissionUpdate: true })
    await expect(fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => { fixture.order.push("identity-bound") })).rejects.toThrow(/permission/i)
    expect(fixture.order).not.toContain("progress-released")
    expect(fixture.order).not.toContain("prompt-admitted")
    expect(fixture.order.slice(-2)).toEqual(["interrupt", "wait"])
  })

  test("retains captured ordered permission exceptions while adding role restrictions", async () => {
    const fixture = admissionFixture()
    fixture.run.supervisorSessionId = fixture.context.sessionID
    fixture.run.policy = [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "deny" }, { action: "read", resource: "src/**", effect: "allow" }]
    const task = { id: "explore", title: "Explore source", role: "explorer", stage: "discovery", writes: false } as any
    const attempt = { id: "attempt_explore", model, prompt: "Inspect authorized source files" } as any
    await fixture.adapter.launch(fixture.run, attempt, task, invocation(fixture.context), async () => {})
    const permissions = fixture.sessions[fixture.childId].permissions
    expect(evaluateRules(permissions, "read", "src/app.ts")).toBe("allow")
    expect(evaluateRules(permissions, "read", "private.env")).toBe("deny")
    expect(evaluateRules(permissions, "write", "src/app.ts")).toBe("deny")
    expect(evaluateRules(permissions, "subagent", "gigacode-worker")).toBe("deny")
  })

  test("rejects an unsupported native admission state even when the session ID matches", async () => {
    const fixture = admissionFixture({ status: "failed" })
    await expect(fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => {})).rejects.toThrow(/admission|status|state/i)
  })

  test("an idle child without a terminal outcome is unknown rather than actively running", async () => {
    const fixture = admissionFixture()
    expect((await fixture.adapter.inspect(fixture.childId)).state).toBe("unknown")
  })

  test("namespaced third party tools cannot inherit trusted native or workflow capabilities by suffix", () => {
    const tools = { read: {}, gigacode_submit: {}, "foreign.read": {}, "foreign.write": {}, "foreign.gigacode_check": {}, "foreign.gigacode_execute": {} }
    expect(Object.keys(visibleTools(tools, "reviewer"))).toEqual(["read", "gigacode_submit"])
    expect(Object.keys(visibleTools(tools, "implementer"))).toEqual(["read", "gigacode_submit"])
    expect(Object.keys(visibleTools(tools, "verifier"))).toEqual(["read", "gigacode_submit"])
    expect(Object.keys(visibleTools(tools, "supervisor"))).toEqual([])
  })

  test("cancelled native check output cannot pass merely because its exit field is zero", () => {
    expect(checkOutcome({ status: "cancelled", exit: 0 })).toBe("cancelled")
  })

  test("a caller abort invalidates a returned check result even when native execution returns exit zero", async () => {
    const fixture = admissionFixture()
    const controller = new AbortController()
    const task = { id: "verify", role: "verifier", checkIds: ["unit"] } as any
    const attempt = { id: "attempt_verify", sessionId: fixture.childId, status: "running", ownerEpoch: 1 } as any
    fixture.run.status = "running"
    fixture.run.ownerEpoch = 1
    fixture.run.tasks = [{ spec: task, status: "running", attempts: [attempt] }]
    fixture.run.config = parseConfig({ checks: [{ id: "unit", command: "bun test", criterionIds: ["tests"] }] })
    fixture.adapter.workspace = async () => "same-workspace"
    fixture.adapter.native = async () => ({ name: "shell", input: Schema.Struct({ command: Schema.String, background: Schema.Boolean, timeout: Schema.Number }), async execute() { controller.abort(); return { output: { exit: 0, output: "late completion" } } } }) as any
    const evidence = await fixture.adapter.check({ run: fixture.run, role: "verifier", task, attempt }, "unit", { ...fixture.context, sessionID: fixture.childId, signal: controller.signal })
    expect(evidence.outcome).toBe("cancelled")
    expect(fixture.adapter.checks.size).toBe(0)
  })

  test("refuses a settled worker check before executing native shell", async () => {
    const fixture = admissionFixture()
    const task = { id: "verify", role: "verifier", checkIds: ["unit"] } as any
    const attempt = { id: "attempt_verify", sessionId: fixture.childId, status: "succeeded", ownerEpoch: 1 } as any
    fixture.run.status = "running"
    fixture.run.ownerEpoch = 1
    fixture.run.tasks = [{ spec: task, status: "succeeded", attempts: [attempt] }]
    fixture.run.config = parseConfig({ checks: [{ id: "unit", command: "bun test", criterionIds: ["tests"] }] })
    let executed = 0
    fixture.adapter.native = async () => ({ name: "shell", input: Schema.Struct({ command: Schema.String, background: Schema.Boolean, timeout: Schema.Number }), async execute() { executed++; return { output: { exit: 0 } } } }) as any
    await expect(fixture.adapter.check({ run: fixture.run, role: "verifier", task, attempt }, "unit", { ...fixture.context, sessionID: fixture.childId })).rejects.toThrow(/settled|active|stale|authoriz/i)
    expect(executed).toBe(0)
  })

  test("binds hooks only to this plugin location even when project state includes other worktrees", () => {
    const fixture = admissionFixture()
    fixture.run.supervisorSessionId = fixture.childId
    fixture.run.directory = join(process.cwd(), "other-worktree")
    expect(fixture.adapter.binding(fixture.childId)).toBeUndefined()
  })

  test("labels an exact typed native permission denial before child creation as definitive no launch", async () => {
    const fixture = admissionFixture({ failure: new NativeToolError({ message: "Subagent denied: gigacode-supervisor" }) })
    let caught: unknown
    try { await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => {}) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(NoLaunchError)
    expect(fixture.order).not.toContain("identity-bound")
    expect(fixture.order).not.toContain("prompt-admitted")
  })

  for (const failure of precreationFailures) test(`classifies the pinned native ${failure.label} refusal before child creation as no launch`, async () => {
    const fixture = admissionFixture({ failure: new NativeToolError({ message: failure.message }) })
    let caught: unknown
    try { await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), failure.model, async () => { fixture.order.push("identity-bound") }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(NoLaunchError)
    expect(fixture.order).toEqual([])
    expect(fixture.adapter.delegations.size).toBe(0)
  })

  test("never treats transport lookalikes or a known refusal after child release as proof of no launch", async () => {
    for (const failure of precreationFailures) for (const options of [
      { failure: new Error(failure.message) },
      { failure: new NativeToolError({ message: failure.message }), failureAfterPrelaunch: true },
    ]) {
      const fixture = admissionFixture(options)
      let caught: unknown
      try { await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), failure.model, async () => {}) } catch (error) { caught = error }
      expect(caught).toBeDefined()
      expect(caught).not.toBeInstanceOf(NoLaunchError)
      expect(fixture.adapter.delegations.size).toBe(0)
    }
  })

  test("keeps unknown typed failures and mismatched native refusal targets uncertain", async () => {
    for (const message of [
      "Native transport disconnected",
      "Parent session not found: ses_parent", // Also emitted by sessions.create; ordering is not proven.
      "Unknown agent: different-agent",
      "Agent different-agent cannot run as a subagent",
      'Model "fixture/different-model" is not available. Use the models tool to see what is available.',
      'Model "fixture/model" has no variants. Omit the variant.', // No variant was requested.
      'Variant "different-variant" is not available for "fixture/model". Available: slow.',
      'Invalid model "different/model". Use "providerID/modelID" or "providerID/modelID#variant".',
      'Subagent depth limit reached (1). Increase "experimental.subagent_depth" to allow nested subagents. Transport disconnected',
    ]) {
      const fixture = admissionFixture({ failure: new NativeToolError({ message }) })
      let caught: unknown
      try { await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => {}) } catch (error) { caught = error }
      expect(caught).toBeDefined()
      expect(caught).not.toBeInstanceOf(NoLaunchError)
      expect(fixture.order).toEqual([])
    }
  })

  test("keeps arbitrary childless failures, lookalike messages, and post-prelaunch denials uncertain", async () => {
    for (const options of [
      { failure: new Error("Subagent denied: gigacode-supervisor") },
      { failure: new NativeToolError({ message: "Subagent denied: different-agent" }) },
      { failure: new NativeToolError({ message: "Subagent denied: gigacode-supervisor" }), failureAfterPrelaunch: true },
    ]) {
      const fixture = admissionFixture(options)
      let caught: unknown
      try { await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => {}) } catch (error) { caught = error }
      expect(caught).toBeDefined()
      expect(caught).not.toBeInstanceOf(NoLaunchError)
    }
  })

  test("adapter validation before native execution is definitive no launch", async () => {
    const fixture = admissionFixture()
    const source = { ...invocation(fixture.context), callId: "wrong-native-call" }
    let caught: unknown
    try { await fixture.adapter.supervisor(fixture.run, source, model, async () => {}) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(NoLaunchError)
    expect(fixture.order).toEqual([])
  })

  test("a prelaunch binding rejection retains its created child identity after native quiescence confirmation", async () => {
    const fixture = admissionFixture()
    fixture.sessions[fixture.childId].time = {}
    let caught: unknown
    try { await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => { throw new Error("Dispatch ownership changed before native prelaunch") }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(SettledLaunchError)
    expect((caught as SettledLaunchError).sessionId).toBe(fixture.childId)
    expect(fixture.order).not.toContain("prompt-admitted")
    expect(fixture.order.slice(-2)).toEqual(["interrupt", "wait"])
    expect(fixture.events).toContainEqual(expect.objectContaining({ kind: "native.prelaunch.settled", data: expect.objectContaining({ sessionId: fixture.childId }) }))
    // A never-prompted child has no native outcome/idle timestamp; successful awaitIdle is the proof.
    expect(fixture.sessions[fixture.childId].outcome).toBeUndefined()
    expect(fixture.sessions[fixture.childId].time.idle).toBeUndefined()
  })

  test("an unconfirmed prelaunch cleanup is uncertain and cannot release its reservation", async () => {
    for (const options of [{ cleanupActive: true }, { cleanupFailure: true }]) {
      const fixture = admissionFixture(options)
      let caught: unknown
      try { await fixture.adapter.supervisor(fixture.run, invocation(fixture.context), model, async () => { throw new Error("Prelaunch rejected") }) } catch (error) { caught = error }
      expect(caught).toBeDefined()
      expect(caught).not.toBeInstanceOf(SettledLaunchError)
      expect(caught).not.toBeInstanceOf(NoLaunchError)
      expect(caught).toBeInstanceOf(UnsettledLaunchError)
      expect((caught as UnsettledLaunchError).sessionId).toBe(fixture.childId)
      expect(fixture.order).not.toContain("prompt-admitted")
    }
  })
})

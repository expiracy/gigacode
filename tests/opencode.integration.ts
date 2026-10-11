import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { Rpc } from "@opencode/plugin"
import { Database } from "bun:sqlite"
import { startHost, waitFor, type IsolatedHost } from "../spike/host.ts"
import type { Run } from "../src/types.ts"
import { manifest } from "../src/workspace.ts"
import { SQLiteStore } from "../src/store.ts"
import { createWorkflowFixture } from "./workflow-fixture.ts"

const object = { type: "object", additionalProperties: true } as const
// This client contract is independent of the implementation under test.
const WorkflowRpc = Rpc.define({ id: "ultra.open-code", methods: {
  status: { input: object, output: object }, inspect: { input: object, output: object },
  config: { input: object, output: object }, control: { input: object, output: object }, export: { input: object, output: object },
}, events: {} })
type Record_ = Record<string, unknown>
type Check = { name: string; durationMs: number; evidence: unknown }
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
    const result = { status: error ? "fail" : "pass", stage, version: "2.0.25", root, pluginSnapshot, testInstrumentation, checks, requests: fixture.requests, prelaunches: fixture.prelaunches, run: finalRun, ...(error ? { error: errorMessage(error) } : {}) }
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
    await cp(resolve("src"), join(pluginDirectory, "src"), { recursive: true })
    pluginSnapshot = { directory: pluginDirectory, hash: (await manifest(pluginDirectory)).hash }
    testInstrumentation = await cancellationBootstrap(root, fixture.baseURL)
    host = await startHost({ root, fixtureURL: fixture.baseURL, pluginDirectory: testInstrumentation.directory, pluginOptions: {
      models: { roles: { planner: "fixture/alternate" } },
      checks: [{ id: "fixture-check", command: "echo fixtureverified", criterionIds: ["verification"] }],
      limits: { workers: 2, repairRounds: 0, workerMs: 15_000, runMs: 60_000 },
    } })
    const client = host.client
    const location = { directory: host.project }
    const rpc = client.rpc(WorkflowRpc)
    const options = () => ({ location, signal: AbortSignal.timeout(5_000) })
    const parent = await client.session.create({ location, model: { providerID: "fixture", id: "test" } })
    await client.session.prompt({ sessionID: parent.id, text: "ACTIVATE_ULTRA_WORKFLOW", resume: false })
    await check("native production plugin registration", async () => {
      const configuration = await rpc.config({}, options()) as Record_
      assert.equal((configuration.config as { models?: { roles?: { planner?: string } } } | undefined)?.models?.roles?.planner ?? (configuration.models as { roles?: { planner?: string } } | undefined)?.roles?.planner, "fixture/alternate")
      assert.equal(fixture.requests.length, 0)
      return configuration
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
    await check("initiating cancellation interrupts a held native worker", async () => {
      const hold = fixture.holdNext("task", "explorer")
      const prelaunch = fixture.holdPrelaunch("researcher")
      const admitted = runs(await rpc.control({ text: "plan Cancel a native worker while its model stream is held.", sessionId: parent.id }, options()))[0]!
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
        const cancelling = runs(await rpc.control({ text: `cancel ${admitted.id}`, sessionId: parent.id }, options()))[0]!
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
      await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(10_000) })
      const before = fixture.requests.length
      await client.session.command({ sessionID: parent.id, name: "ultracode", text: "on" })
      assert.equal(fixture.requests.length, before)
      await host!.restart()
      await client.session.prompt({ sessionID: parent.id, text: "ACTIVATE_AUTO_PERSISTENCE", resume: false })
      assert.equal(fixture.requests.length, before)
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
      const before = fixture.requests.length
      await client.session.command({ sessionID: parent.id, name: "ultracode", text: "off" })
      assert.equal(fixture.requests.length, before)
      const count = runs(await rpc.status({}, options())).length
      await client.session.prompt({ sessionID: parent.id, text: "Automatic mode is off. This deliberately long ordinary prompt should receive a normal primary conversation response without admitting another workflow." })
      await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(10_000) })
      assert.equal(runs(await rpc.status({}, options())).length, count)
      assert.ok(fixture.requests.slice(before).every(request => request.marker === "ordinary"))
      return { newRuns: 0, ordinaryRequests: fixture.requests.length - before }
    })
    await check("unavailable configured model rejects native admission without fallback", async () => {
      const secondary = await startHost({ root: join(root, "unknown-model"), fixtureURL: fixture.baseURL, pluginDirectory, pluginOptions: { models: { default: "fixture/missing" } } })
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

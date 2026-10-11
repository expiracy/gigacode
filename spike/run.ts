import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createFixtureProvider, type FixtureRequest } from "./fixture-provider.ts"
import { EXPECTED_VERSION, startHost, waitFor, type IsolatedHost } from "./host.ts"
import { CompatibilityRpc } from "./rpc.ts"
import { probeWorktree } from "./worktree.ts"

type Evidence = Record<string, any>
type Row = { seq: number; event_id: string | null; kind: string; session_id: string | null; data: Evidence }
type Check = { name: string; status: "pass" | "unsupported" | "fail"; durationMs: number; evidence?: unknown; error?: string }
class UnsupportedCapability extends Error {
  constructor(message: string, readonly evidence: unknown) { super(message) }
}
const root = resolve(".spike", `run-${Date.now()}`)
const pluginDirectory = join(root, "plugin")
await mkdir(pluginDirectory, { recursive: true })
await writeFile(join(pluginDirectory, "index.ts"), await readFile(resolve("spike/plugin.ts"), "utf8"))
await writeFile(join(pluginDirectory, "rpc.ts"), await readFile(resolve("spike/rpc.ts"), "utf8"))
const fixture = createFixtureProvider()
const checks: Check[] = []
let host: IsolatedHost | undefined
const report = () => ({ version: EXPECTED_VERSION, platform: process.platform, root, checks, fixtureRequests: fixture.requests })
async function check(name: string, work: () => Promise<unknown>) {
  const start = Date.now()
  try {
    const evidence = await work()
    checks.push({ name, status: "pass", durationMs: Date.now() - start, evidence })
    console.log(`PASS ${name}`)
  } catch (error) {
    const status = error instanceof UnsupportedCapability ? "unsupported" : "fail"
    checks.push({ name, status, durationMs: Date.now() - start, error: String(error), ...(error instanceof UnsupportedCapability ? { evidence: error.evidence } : {}) })
    console.log(`${status.toUpperCase()} ${name}: ${String(error).slice(0, 700)}`)
  }
  await writeFile(join(root, "report.json"), JSON.stringify(report(), null, 2))
}

try {
  host = await startHost({ root, fixtureURL: fixture.baseURL, pluginDirectory })
  const client = host.client
  const location = { directory: host.project }
  const rpc = client.rpc(CompatibilityRpc)
  const history = async (): Promise<Row[]> => (await rpc.history({}, { location, signal: AbortSignal.timeout(5_000) }) as Evidence).events
  const event = async (kind: string, sessionID?: string) => waitFor(kind, history, rows => rows.some(row => row.kind === kind && (!sessionID || row.session_id === sessionID))).then(rows => rows.findLast(row => row.kind === kind && (!sessionID || row.session_id === sessionID))!)
  const create = async (model = "test", permissions?: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]) => {
    const session = await client.session.create({ location, model: { providerID: "fixture", id: model }, permissions })
    await rpc.claim({ sessionID: session.id }, { location })
    return session
  }
  const settled = async (sessionID: string) => {
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) })
    return client.session.get({ sessionID })
  }
  // Match the task's latest user message, not a parent mentioning it in tool arguments.
  const agentRequest = (marker: string) => (request: FixtureRequest) => Array.isArray(request.body.tools) && request.body.tools.length > 0 && JSON.stringify(request.messages.findLast(message => message.role === "user")?.content).includes(marker)
  const scripted = (marker: string, name: string, arguments_: Evidence, extra: { model?: string; hold?: string } = {}) => fixture.enqueue({ marker, ...extra, match: agentRequest(marker), toolCalls: [{ name, arguments: arguments_ }] })
  const prompt = (sessionID: string, text: string) => client.session.prompt({ sessionID, text })
  const toolResult = async (sessionID: string, name: string, expected = "completed") => {
    const messages = await client.session.context({ sessionID })
    const tools = messages.flatMap(message => message.type === "assistant" ? message.content.filter(content => content.type === "tool" && content.name === name) : []) as Evidence[]
    const tool = tools.at(-1)
    assert.ok(tool, `Missing durable tool record for ${name}`)
    assert.equal(tool.state.status, expected, JSON.stringify(tool.state))
    return tool
  }

  // Plugin/model inventory is lazy in 2.0.25: a location must run before inspection.
  const bootstrap = await client.session.create({ location, model: { providerID: "fixture", id: "test" } })
  await prompt(bootstrap.id, "ACTIVATE_COMPATIBILITY_LOCATION")
  await settled(bootstrap.id)

  await check("plugin registration and SQLite runtime", async () => {
    const plugins = await client.plugin.list({ location })
    const info = await rpc.inspect({}, { location, signal: AbortSignal.timeout(5_000) }) as Evidence
    assert.equal(info.hostVersion, EXPECTED_VERSION)
    assert.equal(info.sqlite, true)
    assert.ok(info.runtime)
    assert.ok(info.tools.some((tool: Evidence) => tool.name === "ultra_probe"))
    assert.ok(info.tools.some((tool: Evidence) => tool.name === "subagent"))
    return { plugins, ...info }
  })
  if (checks[0]?.status !== "pass") throw new Error("Plugin registration is required for remaining probes")

  await check("deterministic command avoids model requests", async () => {
    const session = await create()
    const before = fixture.requests.length
    await client.session.command({ sessionID: session.id, name: "ultra-spike", text: "status" })
    const command = await event("command", session.id)
    assert.equal(fixture.requests.length, before)
    assert.equal(command.data.text, "status")
    return { sessionID: session.id, command: command.data, modelRequests: 0 }
  })

  await check("genuine tool context and selected model", async () => {
    const session = await create("alternate")
    const plan = scripted("IDENTITY_PROBE", "ultra_probe", { label: "identity" }, { model: "alternate" })
    await prompt(session.id, "IDENTITY_PROBE")
    const completed = await event("probe.completed", session.id)
    assert.equal((await settled(session.id)).outcome, "succeeded")
    assert.equal(completed.data.sessionID, session.id)
    assert.equal(typeof completed.data.messageID, "string")
    assert.equal(typeof completed.data.callID, "string")
    assert.equal(completed.data.hasSignal, true)
    assert.ok(fixture.requests.some(request => request.matchedPlan === plan && request.model === "alternate"))
    return { ...completed.data, durableTool: await toolResult(session.id, "ultra_probe") }
  })

  await check("background child and prelaunch permission installation", async () => {
    const session = await create()
    scripted("BACKGROUND_PARENT", "ultra_bridge", { prompt: "BACKGROUND_CHILD", background: true, model: "fixture/alternate" })
    const childPlan = fixture.enqueue({ marker: "BACKGROUND_CHILD", model: "alternate", hold: "background-child", text: "Worker finished", match: agentRequest("BACKGROUND_CHILD") })
    await prompt(session.id, "BACKGROUND_PARENT")
    const returned = await event("bridge.returned", session.id)
    const childID = returned.data.childID as string
    const child = await client.session.get({ sessionID: childID })
    assert.equal(child.parentID, session.id)
    assert.equal(child.model?.id, "alternate")
    assert.ok(child.permissions?.some(rule => rule.action === "edit" && rule.effect === "deny"))
    await waitFor("held background request", async () => fixture.requests, requests => requests.some(request => request.matchedPlan === childPlan && request.status === "held"))
    assert.equal(returned.data.result.output.status, "running")
    const rows = await history()
    const prelaunch = rows.find(row => row.kind === "bridge.permissions" && row.session_id === childID)!
    const firstRequest = rows.find(row => row.kind === "model.request" && row.session_id === childID)!
    assert.ok(prelaunch.seq < firstRequest.seq)
    fixture.release("background-child")
    assert.equal((await settled(childID)).outcome, "succeeded")
    await settled(session.id)
    await toolResult(session.id, "ultra_bridge")
    return { childID, parentID: child.parentID, permissions: child.permissions, result: returned.data.result, beforeFirstModelRequest: true }
  })

  await check("concurrent native children keep distinct invocation bindings", async () => {
    const session = await create()
    fixture.enqueue({ marker: "PARALLEL_PARENT", match: agentRequest("PARALLEL_PARENT"), toolCalls: [
      { name: "ultra_bridge", arguments: { prompt: "PARALLEL_CHILD_ONE" } },
      { name: "ultra_bridge", arguments: { prompt: "PARALLEL_CHILD_TWO" } },
    ] })
    const plans = ["PARALLEL_CHILD_ONE", "PARALLEL_CHILD_TWO"].map(marker => fixture.enqueue({ marker, match: agentRequest(marker), hold: "parallel-children", text: "Parallel child completed" }))
    await prompt(session.id, "PARALLEL_PARENT")
    const rows = await waitFor("two native child bindings", history, values => values.filter(row => row.kind === "bridge.returned" && row.session_id === session.id).length === 2)
    const launches = rows.filter(row => row.kind === "bridge.returned" && row.session_id === session.id)
    assert.equal(new Set(launches.map(row => row.data.childID)).size, 2)
    assert.equal(new Set(launches.map(row => row.data.callID)).size, 2)
    await waitFor("both children active concurrently", async () => fixture.requests, requests => plans.every(plan => requests.some(request => request.matchedPlan === plan && request.status === "held")))
    for (const launch of launches) assert.equal((await client.session.get({ sessionID: launch.data.childID })).parentID, session.id)
    fixture.release("parallel-children")
    for (const launch of launches) assert.equal((await settled(launch.data.childID)).outcome, "succeeded")
    await settled(session.id)
    return { parentID: session.id, children: launches.map(row => ({ childID: row.data.childID, callID: row.data.callID })), simultaneousHeldRequests: 2 }
  })

  await check("permission ask suspends tool admission", async () => {
    const session = await create("test", [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }])
    scripted("PERMISSION_ASK", "ultra_permission_probe", {})
    await prompt(session.id, "PERMISSION_ASK")
    const requests = await waitFor("native permission request", () => client.permission.list({ sessionID: session.id }), value => value.some(request => request.action === "shell"))
    assert.ok(!(await history()).some(row => row.session_id === session.id && row.kind === "permission-probe.executed"))
    const request = requests.find(request => request.action === "shell")!
    await client.permission.reply({ sessionID: session.id, requestID: request.id, decision: "once" })
    const admitted = await event("permission-probe.executed", session.id)
    await settled(session.id)
    return { request, admitted: admitted.data, durableTool: await toolResult(session.id, "ultra_permission_probe") }
  })

  await check("permission rejection prevents native execution", async () => {
    const session = await create("test", [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }])
    scripted("PERMISSION_REJECT", "ultra_permission_probe", {})
    await prompt(session.id, "PERMISSION_REJECT")
    const requests = await waitFor("permission to reject", () => client.permission.list({ sessionID: session.id }), value => value.some(request => request.action === "shell"))
    const request = requests.find(request => request.action === "shell")!
    await client.permission.reply({ sessionID: session.id, requestID: request.id, decision: "reject" })
    await settled(session.id)
    assert.ok(!(await history()).some(row => row.session_id === session.id && row.kind === "permission-probe.executed"))
    return { requestID: request.id, durableTool: await toolResult(session.id, "ultra_permission_probe", "error") }
  })

  await check("read-only child cannot bypass native write restrictions", async () => {
    const session = await create()
    scripted("DENIED_PARENT", "ultra_bridge", { prompt: "DENIED_CHILD", permissionMode: "deny-edit" })
    scripted("DENIED_CHILD", "ultra_native_check", { command: "echo mutated > protected.txt" })
    await prompt(session.id, "DENIED_PARENT")
    const returned = await event("bridge.returned", session.id)
    const childID = returned.data.childID as string
    await event("native-check.started", childID)
    await settled(childID)
    const tool = await toolResult(childID, "ultra_native_check", "error")
    assert.match(JSON.stringify(tool.state.error), /permission|denied|reject/i)
    assert.equal(await readFile(join(host!.project, "protected.txt"), "utf8"), "original\n")
    assert.ok(!(await history()).some(row => row.session_id === childID && row.kind === "native-check.completed"))
    return { childID, protectedFile: "unchanged", error: tool.state.error }
  })

  await check("supervisor can dispatch a worker at depth two", async () => {
    const session = await create()
    scripted("HIER_ROOT", "ultra_bridge", { prompt: "HIER_SUPERVISOR", agent: "ultra-supervisor", permissionMode: "inherit" })
    scripted("HIER_SUPERVISOR", "ultra_bridge", { prompt: "HIER_WORKER", agent: "ultra-worker" })
    scripted("HIER_WORKER", "ultra_probe", { label: "nested worker" })
    await prompt(session.id, "HIER_ROOT")
    const supervisorLaunch = await event("bridge.returned", session.id)
    const supervisorID = supervisorLaunch.data.childID as string
    const workerLaunch = await event("bridge.returned", supervisorID)
    const workerID = workerLaunch.data.childID as string
    await event("probe.completed", workerID)
    assert.equal((await client.session.get({ sessionID: supervisorID })).parentID, session.id)
    const worker = await settled(workerID)
    assert.equal(worker.parentID, supervisorID)
    assert.ok(worker.permissions?.some(rule => rule.action === "subagent" && rule.effect === "deny"))
    await settled(supervisorID)
    await settled(session.id)
    await toolResult(session.id, "ultra_bridge")
    await toolResult(supervisorID, "ultra_bridge")
    await toolResult(workerID, "ultra_probe")
    return { rootID: session.id, supervisorID, workerID, depth: 2, workerDelegationDenied: true }
  })

  await check("unavailable model is rejected without fallback", async () => {
    const session = await create()
    scripted("MISSING_MODEL", "ultra_bridge", { prompt: "NO_MODEL_CHILD", model: "fixture/missing" })
    await prompt(session.id, "MISSING_MODEL")
    const failed = await event("bridge.failed", session.id)
    await settled(session.id)
    assert.match(failed.data.error, /not available/i)
    assert.ok(!failed.data.childID)
    return { error: failed.data.error, durableTool: await toolResult(session.id, "ultra_bridge", "error") }
  })

  await check("queued prompt does not interrupt an active tool", async () => {
    const session = await create()
    scripted("QUEUE_ACTIVE", "ultra_probe", { label: "queue active", waitMs: 1_500 })
    await prompt(session.id, "QUEUE_ACTIVE")
    await event("probe.started", session.id)
    const receipt = await client.session.prompt({ sessionID: session.id, text: "QUEUE_NEXT", delivery: "queue" })
    const completed = await event("probe.completed", session.id)
    assert.equal(completed.data.aborted, false)
    await settled(session.id)
    const rows = await history()
    assert.ok(!rows.some(row => row.session_id === session.id && row.kind === "probe.interrupted"))
    const messages = await client.session.context({ sessionID: session.id })
    assert.ok(messages.some(message => message.type === "user" && JSON.stringify(message).includes("QUEUE_NEXT")))
    return { receipt, acknowledgment: completed.data }
  })

  await check("native completion waits for the active parent tool's step boundary", async () => {
    const session = await create()
    scripted("NOTIFY_PARENT", "ultra_bridge", { prompt: "NOTIFY_CHILD" })
    scripted("NOTIFY_PARENT", "ultra_probe", { label: "notification admission", waitMs: 2_000 })
    fixture.enqueue({ marker: "NOTIFY_CHILD", hold: "notification-child", text: "Child completed", match: agentRequest("NOTIFY_CHILD") })
    await prompt(session.id, "NOTIFY_PARENT")
    const returned = await event("bridge.returned", session.id)
    await event("probe.started", session.id)
    fixture.release("notification-child")
    await settled(returned.data.childID)
    const completed = await event("probe.completed", session.id)
    assert.equal(completed.data.aborted, false)
    await settled(session.id)
    const messages = await client.session.context({ sessionID: session.id })
    const notifications = messages.filter(message => message.type === "synthetic" && message.text.includes(returned.data.childID))
    assert.equal(notifications.length, 1)
    const rows = await history()
    assert.ok(!rows.some(row => row.session_id === session.id && row.kind === "probe.interrupted"))
    const admission = rows.find(row => row.session_id === session.id && row.kind === "session.inbox.enqueued" && row.data.data?.item?.type === "synthetic" && JSON.stringify(row.data).includes(returned.data.childID))
    assert.equal(admission?.data.data.item.delivery, "steer")
    assert.ok(admission!.seq < completed.seq)
    const delivered = rows.find(row => row.kind === "session.inbox.delivered" && row.data.data?.inboxID === admission!.data.data.inboxID)
    assert.ok(delivered && delivered.seq > completed.seq)
    return { parentID: session.id, childID: returned.data.childID, admission, notificationCount: notifications.length, acknowledgment: completed.data, behavior: "Steer is admitted at a step boundary; it does not abort the running tool" }
  })

  await check("cancellation reaches the real tool abort signal", async () => {
    const session = await create()
    scripted("CANCEL_TOOL", "ultra_probe", { label: "cancel", waitMs: 60_000 })
    await prompt(session.id, "CANCEL_TOOL")
    await event("probe.started", session.id)
    const receipt = await client.session.interrupt({ sessionID: session.id, resume: false })
    const interrupted = await event("probe.interrupted", session.id)
    const final = await settled(session.id)
    assert.equal(interrupted.data.aborted, true)
    assert.equal(final.outcome, "interrupted")
    assert.ok(interrupted.data.elapsedMs < 60_000)
    return { receipt, outcome: final.outcome, acknowledgment: interrupted.data }
  })

  await check("background child cancellation is acknowledged before release", async () => {
    const session = await create()
    scripted("CANCEL_PARENT", "ultra_bridge", { prompt: "CANCEL_CHILD" })
    scripted("CANCEL_CHILD", "ultra_probe", { label: "cancel child", waitMs: 60_000 })
    await prompt(session.id, "CANCEL_PARENT")
    const returned = await event("bridge.returned", session.id)
    const childID = returned.data.childID as string
    await event("probe.started", childID)
    const receipt = await client.session.interrupt({ sessionID: childID, resume: false })
    const interrupted = await event("probe.interrupted", childID)
    const child = await settled(childID)
    assert.equal(interrupted.data.aborted, true)
    assert.equal(child.outcome, "interrupted")
    assert.ok(interrupted.data.elapsedMs < 60_000)
    return { parentID: session.id, childID, receipt, outcome: child.outcome, acknowledgment: interrupted.data }
  })

  await check("prelaunch failure never prompts a child", async () => {
    const session = await create()
    scripted("REJECT_PARENT", "ultra_bridge", { prompt: "MUST_NOT_PROMPT_CHILD", failPrelaunch: true })
    await prompt(session.id, "REJECT_PARENT")
    const rejected = await event("bridge.prelaunch.rejected")
    await settled(session.id)
    const rows = await history()
    assert.ok(!rows.some(row => row.session_id === rejected.session_id && row.kind === "model.request"))
    assert.ok(!fixture.requests.some(request => request.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("MUST_NOT_PROMPT_CHILD"))))
    return { childID: rejected.session_id, modelRequests: 0 }
  })

  await check("native check returns structured evidence", async () => {
    const session = await create()
    scripted("NATIVE_CHECK", "ultra_native_check", { command: "echo ultra-compatibility-check" })
    await prompt(session.id, "NATIVE_CHECK")
    const completed = await event("native-check.completed", session.id)
    await settled(session.id)
    assert.ok(JSON.stringify(completed.data.result).includes("ultra-compatibility-check"))
    assert.equal(typeof completed.data.result.output, "object")
    assert.equal(completed.data.result.output.exit, 0)
    assert.equal(completed.data.result.output.status, "completed")
    return { result: completed.data.result, durableTool: await toolResult(session.id, "ultra_native_check") }
  })

  await check("foreign location ownership is rejected", async () => {
    const other = await client.session.create({ location: { directory: host!.otherProject }, model: { providerID: "fixture", id: "test" } })
    await assert.rejects(() => rpc.claim({ sessionID: other.id }, { location }))
    assert.ok(!(await rpc.snapshot({}, { location }) as Evidence).sessions.some((session: Evidence) => session.id === other.id))
    return { rejectedSessionID: other.id, directory: other.location.directory }
  })

  await check("host events are deduplicated", async () => {
    const rows = await history()
    const native = rows.find(row => row.event_id !== null)!
    assert.ok(native)
    const replay = await rpc.replay({ eventID: native.event_id! }, { location }) as Evidence
    assert.equal(replay.inserted, false)
    assert.equal((await history()).filter(row => row.event_id === native.event_id).length, 1)
    return replay
  })

  await check("plugin reload cleans registrations and preserves state", async () => {
    const before = await history()
    await client.location.reload({ signal: AbortSignal.timeout(10_000) })
    const session = await client.session.create({ location, model: { providerID: "fixture", id: "test" } })
    await prompt(session.id, "RELOAD_LOCATION")
    await settled(session.id)
    const after = await history()
    assert.ok(after.filter(row => row.kind === "setup").length > before.filter(row => row.kind === "setup").length)
    assert.ok(after.some(row => row.kind === "cleanup"))
    const info = await rpc.inspect({}, { location }) as Evidence
    assert.equal(info.tools.filter((tool: Evidence) => tool.name === "ultra_probe").length, 1)
    assert.equal(info.commands.data.filter((command: Evidence) => command.name === "ultra-spike").length, 1)
    return { setups: after.filter(row => row.kind === "setup").length, cleanup: true, duplicateRegistrations: 0 }
  })

  await check("service restart resumes the same background child", async () => {
    const session = await create()
    scripted("RESTART_PARENT", "ultra_bridge", { prompt: "RESTART_CHILD" })
    const heldPlan = fixture.enqueue({ marker: "RESTART_CHILD", hold: "restart-child", text: "before restart", match: agentRequest("RESTART_CHILD") })
    await prompt(session.id, "RESTART_PARENT")
    const returned = await event("bridge.returned", session.id)
    const childID = returned.data.childID as string
    await waitFor("child held before restart", async () => fixture.requests, requests => requests.some(request => request.matchedPlan === heldPlan && request.status === "held"))
    const resumedPlan = fixture.enqueue({ marker: "RESTART_CHILD", text: "Recovered background child", match: request =>
      Array.isArray(request.body.tools) && request.messages.some(message => message.role === "user" && String(message.content).startsWith("You are a subagent spawned by another session.\nRESTART_CHILD")) &&
      String(request.messages.findLast(message => message.role === "user")?.content).includes("The server restarted while you were working")
    })
    await host!.restart()
    await waitFor("recovered background request", async () => fixture.requests, requests => requests.some(request => request.matchedPlan === resumedPlan), 20_000)
    assert.equal((await settled(childID)).outcome, "succeeded")
    const after = await history()
    assert.equal(after.filter(row => row.kind === "bridge.prelaunch.released" && row.session_id === childID).length, 1)
    const children = (await rpc.snapshot({}, { location }) as Evidence).sessions.filter((item: Evidence) => item.parent_id === session.id)
    assert.equal(children.length, 1)
    return { parentID: session.id, childID, launches: 1, resumedPlan, outcome: "succeeded", service: true }
  })

  await check("SQLite and native session snapshots survive host restart", async () => {
    const session = await create()
    scripted("PERSIST_PROBE", "ultra_probe", { label: "persist" })
    await prompt(session.id, "PERSIST_PROBE")
    await event("probe.completed", session.id)
    await settled(session.id)
    const before = await history()
    await host!.restart()
    const after = await history()
    assert.ok(before.every(row => after.some(item => item.seq === row.seq && item.kind === row.kind)))
    assert.equal((await client.session.get({ sessionID: session.id })).outcome, "succeeded")
    await toolResult(session.id, "ultra_probe")
    return { sessionID: session.id, eventsBefore: before.length, eventsAfter: after.length, nativeSnapshotPersisted: true }
  })

  await check("native session.log supplies historical events", async () => {
    const session = await create()
    scripted("LOG_HISTORY", "ultra_probe", { label: "native replay" })
    await prompt(session.id, "LOG_HISTORY")
    await event("probe.completed", session.id)
    await settled(session.id)
    const log = []
    for await (const entry of client.session.log({ sessionID: session.id, follow: false }, { signal: AbortSignal.timeout(5_000) })) log.push(entry)
    if (!log.some(entry => entry.type.startsWith("session."))) {
      throw new UnsupportedCapability("Installed CLI supplies synchronization markers but no historical session events; reconcile snapshots and persist observed events in our database", { sessionID: session.id, log })
    }
    return { sessionID: session.id, log }
  })

  await check("native worktrees, placement, event filtering, and dirty protection", async () => {
    const before = fixture.requests.length
    const evidence = await probeWorktree(host!)
    assert.equal(fixture.requests.length, before)
    return { ...evidence, modelRequests: 0 }
  })
} catch (error) {
  checks.push({ name: "runner", status: "fail", durationMs: 0, error: String(error) })
  console.error(String(error))
} finally {
  await host?.stop()
  await fixture.stop()
  await writeFile(join(root, "report.json"), JSON.stringify(report(), null, 2))
  console.log(`Evidence: ${join(root, "report.json")}`)
}
if (checks.some(check => check.status === "fail")) process.exitCode = 1

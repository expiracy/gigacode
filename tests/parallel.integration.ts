import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { Rpc } from "@opencode/plugin"
import { EXPECTED_VERSION, startHost, waitFor, type IsolatedHost } from "../spike/host.ts"
import { createWorkflowFixture } from "./workflow-fixture.ts"
import { manifest } from "../src/workspace.ts"
import { sanitizeEventData } from "../src/redaction.ts"
import type { Run, Workflow } from "../src/types.ts"
import { preparePackedInstallation } from "../scripts/check-package.ts"

const object = { type: "object", additionalProperties: true } as const
const contract = Rpc.define({ id: "gigacode", methods: {
  status: { input: object, output: object }, inspect: { input: object, output: object },
  control: { input: object, output: object }, workflow: { input: object, output: object },
}, events: {} })

/** Private native fixture: actual permission, placement and integration; no paid provider. */
export async function runParallelIntegration() {
  const root = resolve(".spike", `parallel-${EXPECTED_VERSION}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`)
  await mkdir(root, { recursive: true })
  const packedRoot = join(root, "packed")
  await mkdir(packedRoot)
  const { packageDirectory: pluginDirectory, artifact } = await preparePackedInstallation(packedRoot)
  const packageVersion = JSON.parse(await readFile(join(pluginDirectory, "package.json"), "utf8")).version as string
  const sourceHash = (await manifest(pluginDirectory)).hash
  const fixture = createWorkflowFixture({ writePaths: { first: "first.txt", second: "second.txt" } })
  let host: IsolatedHost | undefined
  try {
    host = await startHost({ root, fixtureURL: fixture.baseURL, pluginDirectory, installGlobal: true, pluginOptions: {
      parallelWrites: true, checks: [{ id: "fixture-check", command: "echo fixtureverified", criterionIds: ["verification"] }],
      limits: { workers: 4, repairRounds: 0, workerMs: 30_000, runMs: 180_000 },
    } })
    const client = host.client, location = { directory: host.project }, rpc = client.rpc(contract)
    const request = () => ({ location, signal: AbortSignal.timeout(10_000) })
    const parent = await client.session.create({ location, agent: "gigacode", model: { providerID: "fixture", id: "test" } })
    await client.session.prompt({ sessionID: parent.id, text: "ACTIVATE_PARALLEL_FIXTURE", resume: false })
    const project = await client.location.get({ location })
    // A native worktree.create call would execute this. Permission-checked Git preparation must not.
    await client.project.update({ projectID: project.project.id, commands: { start: "echo UNSAFE_STARTUP > startup-marker.txt" } })
    const workflow: Workflow = { rationale: "Two independent owned files can be changed in isolated checkouts", tasks: [
      { id: "first", title: "Write first file", role: "implementer", stage: "implementation", instructions: "Write first.txt with native implementation verified and a newline", dependencies: [], writes: true, ownedPaths: ["first.txt"] },
      { id: "second", title: "Write second file", role: "implementer", stage: "implementation", instructions: "Write second.txt with native implementation verified and a newline", dependencies: [], writes: true, ownedPaths: ["second.txt"] },
      { id: "review", title: "Review both files", role: "reviewer", stage: "review", instructions: "Independently review both owned file changes", dependencies: ["first", "second"], writes: false },
      { id: "verify", title: "Verify integration", role: "verifier", stage: "verification", instructions: "Run fixture-check after both changes are integrated", dependencies: ["first", "second"], writes: false, checkIds: ["fixture-check"] },
    ] }
    const prompt = "Implement two isolated fixture files and verify the integrated root"
    fixture.scriptPrimary({ prompt, toolCalls: [{ name: "gigacode_task", arguments: { objective: prompt, mode: "execute", workflow } }] })
    await client.session.prompt({ sessionID: parent.id, text: prompt })
    await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(30_000) })
    const settled = await waitFor("parallel native completion", async () => {
      const snapshot = await rpc.status({}, request()) as { runs: Run[] }
      return snapshot.runs.find(run => run.parentSessionId === parent.id)
    }, run => !!run && ["succeeded", "partial", "failed", "waiting_input", "waiting_budget"].includes(run.status), 150_000)
    assert(settled, "Native task must admit a run")
    const audit = await rpc.inspect({ runId: settled.id }, request()) as { run: Run; events: { kind: string; data: any }[] }
    const run = audit.run
    await writeFile(join(root, "audit.json"), JSON.stringify(sanitizeEventData(audit), null, 2))
    assert.equal(run.status, "succeeded", `Parallel run did not succeed: ${JSON.stringify({ status: run.status, errors: run.errors, tasks: run.tasks.map(task => ({ id: task.spec.id, status: task.status, error: task.attempts.at(-1)?.error })) })}`)
    assert(run.parallel?.integratedHash)
    const prep = run.tasks.find(task => task.spec.id === run.parallel!.preparationTaskId)!
    const integration = run.tasks.find(task => task.spec.id === run.parallel!.integrationTaskId)!
    assert(prep.attempts.at(-1)?.preparationApplied)
    assert.equal(integration.attempts.at(-1)?.integrationAppliedHash, run.parallel.integratedHash)
    for (const id of ["first", "second"]) {
      const task = run.tasks.find(task => task.spec.id === id)!, attempt = task.attempts.at(-1)!
      assert(attempt.worktree?.directory)
      assert.equal(attempt.worktree.state, "settled")
      const native = await client.session.get({ sessionID: attempt.sessionId! as any })
      assert.equal(native.parentID, run.supervisorSessionId)
      assert.equal(native.location.directory, attempt.worktree.directory)
      assert.equal(await readFile(join(host.project, `${id}.txt`), "utf8"), "native implementation verified\n")
      assert(!existsSync(join(attempt.worktree.directory, "startup-marker.txt")))
      const own = fixture.requests.filter(request => request.taskId === id)
      assert(own.some(request => request.calls.includes("write")))
      assert(own.every(request => !request.tools.includes("shell") && !request.tools.includes("gigacode_prepare") && !request.tools.includes("gigacode_integrate")))
    }
    assert(!existsSync(join(host.project, "startup-marker.txt")))
    assert.equal(await readFile(join(host.project, "protected.txt"), "utf8"), "original\n")
    const check = run.tasks.find(task => task.spec.id === "verify")!.attempts.at(-1)!.checks.at(-1)!
    assert.equal(check.outcome, "passed"); assert.equal(check.exit, 0)
    assert.equal(check.cwd, host.project); assert.equal(check.workspaceHash, run.parallel.integratedHash)
    assert(check.startedAt >= integration.attempts.at(-1)!.finishedAt!)
    const snapshot = await rpc.workflow({ sessionId: parent.id }, request()) as { runs: any[] }
    assert.equal(snapshot.runs[0]?.id, run.id)
    assert.equal(snapshot.runs[0]?.status, "succeeded")
    const preparationCalls = fixture.requests.filter(request => request.taskId === prep.spec.id)
    assert(preparationCalls.some(request => request.calls.includes("gigacode_prepare")))
    assert(preparationCalls.every(request => !request.tools.includes("write") && !request.tools.includes("shell")))
    assert(audit.events.some(event => event.kind === "permission.evaluate" && event.data.action === "shell" && event.data.source?.id))
    const deniedLocation = { directory: host.otherProject }
    const denied = await client.session.create({ location: deniedLocation, agent: "gigacode", model: { providerID: "fixture", id: "test" }, permissions: [{ action: "shell", resource: "*", effect: "deny" }] })
    const deniedPrompt = "A denied preparation must preserve this project and refuse isolated workers"
    fixture.scriptPrimary({ prompt: deniedPrompt, toolCalls: [{ name: "gigacode_task", arguments: { objective: deniedPrompt, mode: "execute", workflow } }] })
    await client.session.prompt({ sessionID: denied.id, text: deniedPrompt })
    await client.session.wait({ sessionID: denied.id }, { signal: AbortSignal.timeout(30_000) })
    const deniedRun = await waitFor("native preparation denial", async () => {
      const snapshot = await rpc.status({}, { location: deniedLocation, signal: AbortSignal.timeout(10_000) }) as { runs: Run[] }
      return snapshot.runs.find(run => run.parentSessionId === denied.id)
    }, run => !!run && ["partial", "failed", "waiting_input"].includes(run.status), 60_000)
    assert(deniedRun && deniedRun.status !== "succeeded")
    assert(deniedRun.tasks.filter(task => ["first", "second"].includes(task.spec.id)).every(task => task.attempts.length === 0))
    assert(deniedRun.parallel!.checkouts.every(checkout => !existsSync(checkout.directory)))
    const deniedAudit = await rpc.inspect({ runId: deniedRun.id }, { location: deniedLocation }) as { run: Run; events: { kind: string; data: any }[] }
    // Native deny rules can stop shell admission before user evaluation hooks run.
    assert(deniedAudit.run.policy.some(rule => rule.action === "shell" && rule.resource === "*" && rule.effect === "deny"))
    assert(deniedAudit.events.some(event => event.kind === "preparation.native_failed" && String(event.data.error).includes("Tool.Error")))
    assert(!deniedAudit.events.some(event => event.kind === "preparation.git_completed"))
    await writeFile(join(root, "denied-audit.json"), JSON.stringify(sanitizeEventData(deniedAudit), null, 2))
    const report = { hostVersion: EXPECTED_VERSION, sourceHash, artifact: { path: artifact.path, version: packageVersion, files: artifact.files.length, size: artifact.size }, runId: run.id, outcome: run.status, isolatedWriters: 2,
      preparationApplied: true, integrationApplied: true, freshNativeCheck: check.id, unsafeStartupSkipped: true, nativePreparationDenyPreserved: true, requests: fixture.requests.length, audit: join(root, "audit.json") }
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    return report
  } finally {
    await writeFile(join(root, "requests.json"), JSON.stringify(sanitizeEventData(fixture.requests), null, 2))
    if (host) { await host.stop(); await writeFile(join(root, "host.log"), host.logs()) }
    await fixture.stop()
  }
}

if (import.meta.main) runParallelIntegration().catch(error => { console.error(error); process.exitCode = 1 })

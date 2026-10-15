import { expect, test } from "bun:test"
import { parseEvaluationOptions, scoreEvaluation, evaluationUsage, prepareEvaluationFixture, checkEvaluationFixture, runModelEvaluation, type EvaluationEvidence } from "./model-evaluation.ts"
import type { Run } from "../src/types.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { manifest } from "../src/workspace.ts"

const budget = JSON.stringify({ workers: 2, attempts: 8, steps: 10, repairRounds: 0, workerMs: 60_000, runMs: 180_000, elapsedMs: 180_000 })
const explicit = ["--url", "http://127.0.0.1:4096", "--model", "connected/model#high", "--budget", budget, "--max-cost", "0.25"]
const scriptedFetch = (handler: (request: Request) => Response | Promise<Response>) => ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch

test("model evaluation refuses incomplete authority before any native call", () => {
  for (const args of [[], explicit.slice(2), explicit.filter((_value, index) => index !== 2 && index !== 3), explicit.filter((_value, index) => index !== 4 && index !== 5), explicit.slice(0, 6)]) {
    expect(() => parseEvaluationOptions(args)).toThrow()
  }
})

test("evaluation options preserve exact selection and reject remote endpoints, inheritance and unbounded allowances", () => {
  const options = parseEvaluationOptions([...explicit, "--scenario", "research"])
  expect(options.model).toEqual({ providerID: "connected", id: "model", variant: "high" })
  expect(options.scenarios).toEqual(["research"])
  expect(options.limits).toMatchObject({ attempts: 8, steps: 10, workerMs: 60_000, runMs: 180_000 })
  for (const [index, value] of [[1, "https://remote.example"], [1, "http://user:secret@localhost:4096"], [3, "inherit"], [5, '{"attempts":8,"steps":10}'], [5, '{"attempts":0,"steps":10,"workerMs":60000,"runMs":180000}'], [7, "0"], [7, "Infinity"]] as const) {
    const args = [...explicit]; args[index] = value
    expect(() => parseEvaluationOptions(args)).toThrow()
  }
})

function evidence(): EvaluationEvidence {
  const model = { providerID: "connected", id: "model", variant: "high" }
  const attempt = (id: string, taskId: string, sessionId: string) => ({ id, taskId, sessionId, number: 1, status: "succeeded", workspaceHash: "current", candidateHash: "current", startedAt: 10, finishedAt: 20, checks: [], model: { ref: model, origin: "captured", requested: "connected/model#high" }, result: { summary: "Everything passed", assessments: [{ criterionId: "request", passed: true, explanation: "Trust the model" }] } })
  const run = {
    id: "run_eval", parentSessionId: "parent", supervisorSessionId: "supervisor", mode: "execute", phase: "execution", status: "succeeded", directory: "/fixture", candidateHash: "current", workspaceHash: "initial",
    config: { checks: [{ id: "test", command: "bun run test", criterionIds: ["verification"] }] },
    criteria: [{ id: "request", kind: "assessment", required: true, description: "Fix the parser" }, { id: "verification", kind: "check", required: true, description: "Native checks" }],
    tasks: [
      { spec: { id: "implement", role: "implementer", stage: "implementation", writes: true, ownedPaths: ["src/parse.ts"], dependencies: [] }, status: "succeeded", acceptedAttemptId: "attempt_write", attempts: [attempt("attempt_write", "implement", "worker_write")] },
      { spec: { id: "review", role: "reviewer", stage: "review", writes: false, dependencies: ["implement"] }, status: "succeeded", acceptedAttemptId: "attempt_review", attempts: [attempt("attempt_review", "review", "worker_review")] },
      { spec: { id: "verify", role: "verifier", stage: "verification", writes: false, dependencies: ["implement"], checkIds: ["test"] }, status: "succeeded", acceptedAttemptId: "attempt_verify", attempts: [attempt("attempt_verify", "verify", "worker_verify")] },
    ],
  } as unknown as Run
  return {
    run, before: { hash: "initial", files: { "src/parse.ts": "broken", "protected.txt": "sentinel" } }, after: { hash: "current", files: { "src/parse.ts": "fixed", "protected.txt": "sentinel" } }, oracle: { passed: true, output: "Independent boundaries pass" },
    sessions: [{ id: "parent", model, outcome: "succeeded" }, { id: "supervisor", parentID: "parent", model, outcome: "succeeded" }, ...["worker_write", "worker_review", "worker_verify"].map(id => ({ id, parentID: "supervisor", model, outcome: "succeeded" as const }))],
  }
}

function addNativeCheck(input: EvaluationEvidence) {
  const task = input.run.tasks.find(task => task.spec.id === "verify")!, attempt = task.attempts[0]!
  attempt.checks.push({ id: "evidence", taskId: task.spec.id, attemptId: attempt.id, sessionId: attempt.sessionId!, callId: "native_call", checkId: "test", command: "bun run test", criterionIds: ["verification"], cwd: "/fixture", startedAt: 30, finishedAt: 40, exit: 0, outcome: "passed", output: "Actual native check passed", workspaceHash: "current" })
}

test("self-assessed success cannot replace fresh attributable native checks", () => {
  const input = evidence()
  const result = scoreEvaluation("bugfix", input, input.sessions[0]!.model!)
  expect(result.passed).toBe(false)
  expect(result.checks.find(check => check.name === "native verification")?.passed).toBe(false)
  expect(result.quality.every(item => item.status === "needs-review")).toBe(true)
})

test("independent scope checks catch protected file changes despite a passing native test", () => {
  const input = evidence()
  addNativeCheck(input)
  input.after.files["protected.txt"] = "overwritten"
  const result = scoreEvaluation("bugfix", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "native verification")?.passed).toBe(true)
  expect(result.checks.find(check => check.name === "scope preservation")?.passed).toBe(false)
  expect(result.passed).toBe(false)
})

test("unrelated native sessions cannot attest accepted worker model and ancestry", () => {
  const input = evidence()
  addNativeCheck(input)
  input.sessions.find(session => session.id === "worker_verify")!.parentID = "unrelated_supervisor"
  const result = scoreEvaluation("bugfix", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "native sessions")?.passed).toBe(false)
  expect(result.passed).toBe(false)
})

test("an earlier check cannot verify a later writer even when file hashes match", () => {
  const input = evidence()
  addNativeCheck(input)
  input.run.tasks[0]!.attempts[0]!.finishedAt = 50
  const result = scoreEvaluation("bugfix", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "native verification")?.passed).toBe(false)
})

test("a self-reporting synthesis cannot substitute for independent candidate review", () => {
  const input = evidence()
  addNativeCheck(input)
  input.run.tasks[1]!.spec.role = "synthesizer"
  const result = scoreEvaluation("bugfix", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "independent review")?.passed).toBe(false)
})

test("independent fixture boundaries reject behavior that the model's own native tests accepted", () => {
  const input = evidence()
  addNativeCheck(input)
  input.oracle = { passed: false, output: "Zero is still rejected" }
  const result = scoreEvaluation("bugfix", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "fixture behavior")?.passed).toBe(false)
  expect(result.passed).toBe(false)
})

test("planning evidence must remain read-only and stop at a ready proposal", () => {
  const input = evidence()
  input.before = input.after
  input.run.mode = "plan"; input.run.phase = "planning"; input.run.status = "ready"
  const result = scoreEvaluation("planning", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "planning scope")?.passed).toBe(false)
})

test("a ready planning proposal proves admitted work without executing proposed tasks", () => {
  const input = evidence(), proposed = input.run.tasks.filter(task => task.spec.writes || task.spec.role === "verifier").map(task => task.spec)
  input.before = input.after
  input.run.mode = "plan"; input.run.phase = "planning"; input.run.status = "ready"
  input.run.tasks = [input.run.tasks[1]!]
  const design = input.run.tasks[0]!
  design.spec = { ...design.spec, id: "design", role: "planner", stage: "design", dependencies: [] }
  design.attempts[0]!.taskId = "design"
  input.run.plans = [
    { revision: 1, rationale: "Admitted read-only planning", criteria: input.run.criteria, tasks: [design.spec] },
    { revision: 2, rationale: "Saved implementation proposal", criteria: input.run.criteria, tasks: proposed },
  ]
  input.sessions = input.sessions.filter(session => ["parent", "supervisor", "worker_review"].includes(session.id))
  const result = scoreEvaluation("planning", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "native sessions")?.passed).toBe(true)
  expect(result.passed).toBe(true)
})

test("interruption evidence must preserve accepted work without duplicate successful attempts", () => {
  const input = evidence()
  input.before = input.after
  input.run.mode = "plan"; input.run.phase = "planning"; input.run.status = "ready"
  input.run.tasks = [input.run.tasks[1]!]
  input.run.tasks[0]!.spec.dependencies = []
  const design = structuredClone(input.run.tasks[0]!)
  design.spec = { ...design.spec, id: "design", role: "planner", stage: "design", dependencies: ["review"] }
  design.acceptedAttemptId = "attempt_design"; design.attempts[0] = { ...design.attempts[0]!, id: "attempt_design", taskId: "design", sessionId: "worker_design" }
  input.run.tasks.push(design)
  input.sessions.push({ id: "worker_design", parentID: "supervisor", model: input.sessions[0]!.model!, outcome: "succeeded" })
  input.interrupted = { supervisorId: "supervisor", acceptedAttemptIds: ["attempt_review"], successorTaskId: "design", nativeOutcome: "interrupted" }
  expect(scoreEvaluation("interrupted", input, input.sessions[0]!.model!).checks.find(check => check.name === "interruption recovery")?.passed).toBe(true)
  input.run.tasks[0]!.attempts.push({ ...input.run.tasks[0]!.attempts[0]!, id: "duplicate_review", sessionId: "duplicate_worker" })
  const result = scoreEvaluation("interrupted", input, input.sessions[0]!.model!)
  expect(result.checks.find(check => check.name === "interruption recovery")?.passed).toBe(false)
})

test("an interruption without completed predecessor evidence cannot claim successful preservation", () => {
  const input = evidence()
  input.before = input.after
  input.run.mode = "plan"; input.run.phase = "planning"; input.run.status = "ready"
  input.run.tasks = [input.run.tasks[1]!]
  input.run.tasks[0]!.spec.dependencies = []
  input.interrupted = { supervisorId: "supervisor", acceptedAttemptIds: [], successorTaskId: "design", nativeOutcome: "interrupted" }
  expect(scoreEvaluation("interrupted", input, input.sessions[0]!.model!).checks.find(check => check.name === "interruption recovery")?.passed).toBe(false)
})

test("a partial runtime outcome cannot be labelled an independently passing evaluation", () => {
  const input = evidence()
  addNativeCheck(input)
  input.run.status = "partial"
  const result = scoreEvaluation("bugfix", input, input.sessions[0]!.model!)
  expect(result.passed).toBe(false)
  expect(result.checks.find(check => check.name === "runtime outcome")?.passed).toBe(false)
})

test("a later failed native check cannot be hidden by an earlier passing check on the same candidate", () => {
  const input = evidence()
  addNativeCheck(input)
  const attempt = input.run.tasks[2]!.attempts[0]!
  attempt.checks.push({ ...attempt.checks[0]!, id: "later_failure", callId: "later_native_call", startedAt: 41, finishedAt: 50, exit: 1, outcome: "failed" })
  expect(scoreEvaluation("bugfix", input, input.sessions[0]!.model!).checks.find(check => check.name === "native verification")?.passed).toBe(false)
})

test("a repaired success keeps failed history while proving the final required graph", () => {
  const input = evidence()
  addNativeCheck(input)
  const historical = structuredClone(input.run.tasks[0]!)
  historical.spec.id = "failed_initial_writer"; historical.status = "skipped"; delete historical.acceptedAttemptId
  historical.attempts[0] = { ...historical.attempts[0]!, id: "failed_attempt", taskId: historical.spec.id, sessionId: "failed_worker", status: "failed" }
  input.run.tasks.push(historical)
  const initial = input.run.tasks.map(task => task.spec)
  const repair = input.run.tasks.slice(0, 3).map(task => {
    const next = structuredClone(task), id = `repair.${task.spec.id}`
    next.spec.id = id; next.spec.dependencies = task.spec.writes ? initial.map(task => task.id) : ["repair.implement"]
    next.acceptedAttemptId = `attempt_${id}`
    next.attempts[0] = { ...next.attempts[0]!, id: next.acceptedAttemptId, taskId: id, sessionId: `worker_${id}`, startedAt: 50, finishedAt: 60 }
    next.attempts[0]!.checks = next.attempts[0]!.checks.map(check => ({ ...check, id: "repair_check", taskId: id, attemptId: next.acceptedAttemptId!, sessionId: `worker_${id}`, callId: "repair_call", startedAt: 70, finishedAt: 80 }))
    return next
  })
  input.run.tasks.push(...repair); input.run.repairRound = 1
  input.run.plans = [{ revision: 1, rationale: "Initial candidate", criteria: input.run.criteria, tasks: initial }, { revision: 2, rationale: "Bounded repair", criteria: input.run.criteria, tasks: input.run.tasks.map(task => task.spec) }]
  input.sessions.push({ id: "failed_worker", parentID: "supervisor", model: input.sessions[0]!.model!, outcome: "failed" }, ...repair.map(task => ({ id: task.attempts[0]!.sessionId!, parentID: "supervisor", model: input.sessions[0]!.model!, outcome: "succeeded" as const })))
  expect(scoreEvaluation("bugfix", input, input.sessions[0]!.model!).passed).toBe(true)
  repair[2]!.attempts[0]!.checks = []
  expect(scoreEvaluation("bugfix", input, input.sessions[0]!.model!).checks.find(check => check.name === "native verification")?.passed).toBe(false)
})

test("usage includes each native session once and never turns missing observations into zero", () => {
  expect(evaluationUsage([{ id: "primary", cost: 0.1 }, { id: "primary", cost: 0.2 }, { id: "worker" }])).toEqual({ cost: null, knownCost: 0.2, tokens: null, unknownCostSessions: ["worker"] })
  const tokens = { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
  expect(evaluationUsage([{ id: "primary", cost: 0, tokens }, { id: "worker", cost: 0.2, tokens }])).toEqual({ cost: 0.2, knownCost: 0.2, tokens: 40, unknownCostSessions: [] })
})

test("incomplete native token breakdown stays unknown instead of crashing accounting", () => {
  const session = { id: "worker", cost: 0, tokens: { input: 1, output: 2 } } as any
  expect(evaluationUsage([session])).toEqual({ cost: 0, knownCost: 0, tokens: null, unknownCostSessions: [] })
})

test("bugfix oracle catches the seeded zero and precision defects independently of editable tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-"))
  const directory = join(root, "project")
  try {
    await prepareEvaluationFixture("bugfix", directory, parseEvaluationOptions(explicit))
    expect((await checkEvaluationFixture("bugfix", directory)).passed).toBe(false)
    await writeFile(join(directory, "src", "parse.ts"), `export function parseDuration(value: string): number {
      const match = /^(\\d+)(ms|s)$/.exec(value)
      if (!match) throw new Error("Invalid duration")
      const result = BigInt(match[1]!) * (match[2] === "s" ? 1000n : 1n)
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe duration")
      return Number(result)
    }\n`)
    expect((await checkEvaluationFixture("bugfix", directory)).passed).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("feature oracle checks chunk boundaries, validation and preservation of the existing export", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-"))
  const directory = join(root, "project")
  try {
    await prepareEvaluationFixture("feature", directory, parseEvaluationOptions(explicit))
    expect((await checkEvaluationFixture("feature", directory)).passed).toBe(false)
    await writeFile(join(directory, "src", "chunk.ts"), `export function identity<T>(values: T[]): T[] { return values }
export function chunk<T>(values: T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid size")
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size))
  return result
}\n`)
    expect((await checkEvaluationFixture("feature", directory)).passed).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("unavailable connected models refuse before admitting a native conversation", async () => {
  let admitted = 0
  const transport = scriptedFetch(request => {
    if (request.method === "POST") { admitted++; return Response.json({ error: "No native admission permitted" }, { status: 500 }) }
    return Response.json(new URL(request.url).pathname.includes("model") ? { data: [] } : { version: "2.0.25" })
  })
  await expect(runModelEvaluation(explicit, { fetch: transport })).rejects.toThrow("not available")
  expect(admitted).toBe(0)
})

test("observed cost over the allowance stops before requesting model work and writes an accounting report", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-"))
  let prompts = 0
  const options = parseEvaluationOptions(explicit)
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const transport = scriptedFetch(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/info") return Response.json({ version: "2.0.25" })
    if (path === "/api/model") return Response.json({ data: [{ ...options.model, capabilities: { tools: true }, variants: [{ id: "high" }] }] })
    if (path.endsWith("/config")) return Response.json({ output: { config: { models: { default: options.modelReference }, limits: options.limits }, promptVersion: "ultraopencode/test" } })
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: { id: "parent", model: options.model, cost: 0.5, tokens } })
    if (path === "/api/session/parent") return Response.json({ data: { id: "parent", model: options.model, cost: 0.5, tokens } })
    if (path.endsWith("/prompt")) { prompts++; return Response.json({ data: {} }) }
    if (path.endsWith("/wait")) return new Response(null, { status: 204 })
    if (path.endsWith("/interrupt")) return Response.json({ status: "interrupted" })
    return Response.json({ error: "Unexpected evaluation request" }, { status: 500 })
  })
  try {
    const args = [...explicit, "--scenario", "bugfix"]
    await expect(runModelEvaluation(args, { root, fetch: transport })).rejects.toThrow("cost allowance")
    expect(prompts).toBe(0)
    const report = JSON.parse(await Bun.file(join(root, "evaluation.json")).text())
    expect(report.usage.knownCost).toBe(0.5)
    expect(report.failure).toContain("cost allowance")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test.each(["failed", "interrupted", "succeeded"])("a native %s primary without workflow admission stops polling and saves its failure after parent cleanup", async outcome => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-")), directory = join(root, "planning")
  const options = parseEvaluationOptions(explicit), tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  let prompted = false, statusCalls = 0, prompts = 0
  const interrupted: string[] = [], settled: string[] = []
  const parent = () => ({ id: "parent", ...(prompted ? { outcome } : {}), projectID: "fixture", agent: "ultraopencode", model: options.model, cost: 0.01, tokens, time: { created: 1, updated: 2, ...(prompted ? { idle: 2 } : {}) }, location: { directory } })
  const transport = scriptedFetch(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/info") return Response.json({ version: "2.0.25" })
    if (path === "/api/model") return Response.json({ data: [{ ...options.model, capabilities: { tools: true }, variants: [{ id: "high" }] }] })
    if (path.endsWith("/config")) return Response.json({ output: { config: JSON.parse(await readFile(join(directory, "ultraopencode.json"), "utf8")), promptVersion: "ultraopencode/test" } })
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: parent() })
    if (path.endsWith("/prompt")) { prompts++; prompted = true; return Response.json({ data: { id: "receipt" } }) }
    if (path.endsWith("/status")) {
      if (++statusCalls > 1) return Response.json({ type: "RpcInternalError", message: "Unexpected repeated status polling after terminal primary" }, { status: 500 })
      return Response.json({ output: { runs: [] } })
    }
    if (path === "/api/session") return Response.json({ data: [parent()], cursor: {} })
    if (path === "/api/session/parent") return Response.json({ data: parent() })
    if (path.endsWith("/interrupt")) { interrupted.push(path.split("/").at(-2)!); return Response.json({ status: "interrupted" }) }
    if (path.endsWith("/wait")) { settled.push(path.split("/").at(-2)!); return new Response(null, { status: 204 }) }
    return Response.json({ error: `Unexpected ${path}` }, { status: 500 })
  })
  try {
    const failure = outcome === "succeeded" ? "The model finished without admitting the requested project workflow" : `The native primary ended with outcome ${outcome} without admitting the requested project workflow`
    await expect(runModelEvaluation([...explicit, "--scenario", "planning"], { root, fetch: transport })).rejects.toThrow(failure)
    expect(prompts).toBe(1)
    expect(statusCalls).toBe(1)
    expect(interrupted).toEqual(["parent"])
    expect(settled).toEqual(["parent"])
    const report = JSON.parse(await readFile(join(root, "evaluation.json"), "utf8"))
    expect(report.failure).toBe(failure)
    expect(report.cases[0]).toMatchObject({ error: failure, cleanupSettledSessions: ["parent"], cleanupErrors: [] })
    expect(report.cases[0].observedRun).toBeNull()
    expect(report.cases[0].score).toBeUndefined()
    expect(report.usage.cost).toBe(0.01)
    expect(await readFile(join(root, "evaluation.md"), "utf8")).toContain(failure)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 5_000)

test("scripted native responses allow a final response beyond ten seconds within the scenario budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-")), directory = join(root, "bugfix")
  const args = [...explicit, "--scenario", "bugfix"]
  args[5] = JSON.stringify({ ...JSON.parse(budget), runMs: 30_000 })
  const options = parseEvaluationOptions(args), tokens = { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }
  let run: Run | undefined, supervisorSettled = false, parentSettled = false
  const parent = { id: "parent", projectID: "fixture", agent: "ultraopencode", model: options.model, cost: 0.01, tokens, time: { created: 1, updated: 2, idle: 2 }, location: { directory } }
  const family = () => run ? [{ ...parent, outcome: "succeeded" }, ...evidence().sessions.slice(1).map(session => ({ ...session, projectID: "fixture", cost: 0.01, tokens, time: { created: 1, updated: 2, idle: 2 }, location: { directory } }))] : [parent]
  const transport = scriptedFetch(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/info") return Response.json({ version: "2.0.25" })
    if (path === "/api/model") return Response.json({ data: [{ ...options.model, capabilities: { tools: true }, variants: [{ id: "high" }] }] })
    if (path.endsWith("/config")) return Response.json({ output: { config: JSON.parse(await readFile(join(directory, "ultraopencode.json"), "utf8")), promptVersion: "ultraopencode/test" } })
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: parent })
    if (path.endsWith("/prompt")) {
      const before = await manifest(directory)
      await writeFile(join(directory, "src", "parse.ts"), 'export function parseDuration(value: string): number { const match = /^(\\d+)(ms|s)$/.exec(value); if (!match) throw new Error("Invalid"); const result = BigInt(match[1]!) * (match[2] === "s" ? 1000n : 1n); if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe"); return Number(result) }\n')
      const after = await manifest(directory), input = evidence()
      addNativeCheck(input); run = input.run; run.directory = directory; run.workspaceHash = before.hash; run.candidateHash = after.hash
      run.config = JSON.parse(await readFile(join(directory, "ultraopencode.json"), "utf8"))
      for (const task of run.tasks) {
        task.attempts[0]!.workspaceHash = task.spec.writes ? before.hash : after.hash
        task.attempts[0]!.candidateHash = after.hash
        for (const check of task.attempts[0]!.checks) { check.cwd = directory; check.workspaceHash = after.hash; check.checkId = "fixture-tests" }
        if (task.spec.checkIds) task.spec.checkIds = ["fixture-tests"]
      }
      return Response.json({ data: { id: "prompt_receipt" } })
    }
    if (path.endsWith("/status")) return Response.json({ output: { runs: run ? [run] : [] } })
    if (path === "/api/session") return Response.json({ data: family(), cursor: {} })
    if (path.endsWith("/wait")) {
      if (path.includes("/supervisor/")) supervisorSettled = true
      if (path.includes("/parent/")) {
        request.signal.throwIfAborted()
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(request.signal.reason) }
          const timer = setTimeout(() => { request.signal.removeEventListener("abort", aborted); resolve() }, 11_000)
          request.signal.addEventListener("abort", aborted, { once: true })
        })
        parentSettled = true
      }
      return new Response(null, { status: 204 })
    }
    if (path.endsWith("/context")) return Response.json({ data: [{ type: "assistant", content: [{ type: "text", text: supervisorSettled && parentSettled ? "Boundary fix verified. Bearer sk-12345678901234567890" : "The parent is still producing its final response." }] }] })
    return Response.json({ error: `Unexpected ${path}` }, { status: 500 })
  })
  try {
    const report = await runModelEvaluation(args, { root, fetch: transport })
    expect(report.cases[0]!.score!.passed).toBe(true)
    expect(report.cases[0]!.score!.quality.every(item => item.status === "needs-review")).toBe(true)
    expect(report.cases[0]!.primaryResponse).toContain("Boundary fix verified")
    expect(report.usage.cost).toBeCloseTo(0.05)
    expect(report.usage.tokens).toBe(25)
    const saved = await readFile(join(root, "evaluation.json"), "utf8")
    expect(saved).toContain("[REDACTED]")
    expect(saved).not.toContain("12345678901234567890")
    expect(JSON.stringify(report)).not.toContain("12345678901234567890")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)

test("the interruption runner waits for accepted predecessor work and authoritative recovery before resuming", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-")), directory = join(root, "interrupted")
  const options = parseEvaluationOptions(explicit), tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  let run: Run | undefined, observations = 0, recoveryObservations = 0, resumes = 0, stopped = false
  const session = (id: string, parentID?: string, outcome?: "succeeded" | "interrupted") => ({ id, ...(parentID ? { parentID } : {}), ...(outcome ? { outcome } : {}), projectID: "fixture", model: options.model, cost: 0.01, tokens, time: { created: 1, updated: 2 }, location: { directory } })
  const family = () => [session("parent", undefined, run?.status === "ready" ? "succeeded" : undefined), session("supervisor", "parent", stopped ? "interrupted" : undefined), ...(run?.supervisorSessionId === "resumed" ? [session("resumed", "parent", "succeeded")] : []), ...(run?.tasks.flatMap(task => task.attempts.map(attempt => session(attempt.sessionId!, "supervisor", attempt.status === "succeeded" ? "succeeded" : undefined))) ?? [])]
  const transport = scriptedFetch(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/info") return Response.json({ version: "2.0.25" })
    if (path === "/api/model") return Response.json({ data: [{ ...options.model, capabilities: { tools: true }, variants: [{ id: "high" }] }] })
    if (path.endsWith("/config")) return Response.json({ output: { config: JSON.parse(await readFile(join(directory, "ultraopencode.json"), "utf8")), promptVersion: "ultraopencode/test" } })
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: session("parent") })
    if (path.endsWith("/prompt")) {
      const input = evidence(), workspaceHash = (await manifest(directory)).hash
      run = input.run; run.mode = "plan"; run.phase = "planning"; run.status = "planning"; run.directory = directory; run.workspaceHash = workspaceHash
      const source = run.tasks[1]!
      const inspect = structuredClone(source), design = structuredClone(source)
      inspect.spec = { ...inspect.spec, id: "inspect", role: "explorer", stage: "discovery", dependencies: [] }; inspect.status = "running"; delete inspect.acceptedAttemptId
      inspect.attempts[0] = { ...inspect.attempts[0]!, id: "attempt_inspect", taskId: "inspect", sessionId: "worker_inspect", status: "running", workspaceHash }
      design.spec = { ...design.spec, id: "design", role: "planner", stage: "design", dependencies: ["inspect"] }; design.status = "pending"; design.attempts = []; delete design.acceptedAttemptId
      run.tasks = [inspect, design]
      return Response.json({ data: { id: "receipt" } })
    }
    if (path.endsWith("/status")) {
      if (stopped && run?.status === "planning") {
        if (++recoveryObservations >= 3) run.status = "recovering"
      } else if (++observations >= 2 && run?.status === "planning") {
        run.tasks[0]!.status = "succeeded"; run.tasks[0]!.acceptedAttemptId = "attempt_inspect"; run.tasks[0]!.attempts[0]!.status = "succeeded"
        run.tasks[1]!.status = "running"; run.tasks[1]!.attempts = [{ ...run.tasks[0]!.attempts[0]!, id: "attempt_design", taskId: "design", sessionId: "worker_design", status: "running" }]
      }
      const body = await request.json() as { input: { runId?: string } }
      return Response.json({ output: body.input.runId ? { run } : { runs: run ? [run] : [] } })
    }
    if (path.endsWith("/control")) {
      const body = await request.json() as { input: { text: string } }
      if (body.input.text.startsWith("resume") && run) {
        if (run.status !== "recovering") return Response.json({ type: "RpcInternalError", message: "Only paused or waiting runs can resume after the interrupted driver drains" }, { status: 500 })
        resumes++
        run.tasks[1]!.status = "succeeded"; run.tasks[1]!.acceptedAttemptId = "attempt_design"
        if (!run.tasks[1]!.attempts.length) run.tasks[1]!.attempts = [{ ...run.tasks[0]!.attempts[0]!, id: "attempt_design", taskId: "design", sessionId: "worker_design" }]
        run.tasks[1]!.attempts[0]!.status = "succeeded"; run.tasks[0]!.status = "succeeded"; run.tasks[0]!.acceptedAttemptId = "attempt_inspect"; run.tasks[0]!.attempts[0]!.status = "succeeded"
        run.supervisorHistory = ["supervisor"]; run.supervisorSessionId = "resumed"; run.status = "ready"
      }
      return Response.json({ output: { run } })
    }
    if (path.endsWith("/supervisor/interrupt")) { stopped = true; return Response.json({ status: "interrupted" }) }
    if (path.endsWith("/wait")) return new Response(null, { status: 204 })
    if (path === "/api/session") return Response.json({ data: family(), cursor: {} })
    if (path === "/api/session/supervisor") return Response.json({ data: session("supervisor", "parent", stopped ? "interrupted" : undefined) })
    if (path.endsWith("/context")) return Response.json({ data: [{ type: "assistant", content: [{ type: "text", text: "The accepted investigation was retained and the dependent design completed after interruption." }] }] })
    return Response.json({ error: `Unexpected ${path}` }, { status: 500 })
  })
  try {
    const report = await runModelEvaluation([...explicit, "--scenario", "interrupted"], { root, fetch: transport })
    expect(recoveryObservations).toBe(3)
    expect(resumes).toBe(1)
    expect(report.cases[0]!.evidence!.interrupted!.acceptedAttemptIds).toEqual(["attempt_inspect"])
    expect(report.cases[0]!.score!.passed).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a completed one-worker plan reports that the requested interruption boundary was never demonstrated", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-")), directory = join(root, "interrupted"), options = parseEvaluationOptions(explicit)
  const run = evidence().run
  run.mode = "plan"; run.phase = "planning"; run.status = "ready"; run.directory = directory
  run.tasks = [run.tasks[1]!]; run.tasks[0]!.spec.dependencies = []
  const native = evidence().sessions.filter(session => ["parent", "supervisor", "worker_review"].includes(session.id)).map(session => ({ ...session, cost: 0.01, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, projectID: "fixture", time: { created: 1, updated: 2, idle: 2 }, location: { directory } }))
  const transport = scriptedFetch(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/info") return Response.json({ version: "2.0.25" })
    if (path === "/api/model") return Response.json({ data: [{ ...options.model, capabilities: { tools: true }, variants: [{ id: "high" }] }] })
    if (path.endsWith("/config")) return Response.json({ output: { config: JSON.parse(await readFile(join(directory, "ultraopencode.json"), "utf8")), promptVersion: "ultraopencode/test" } })
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: native[0] })
    if (path === "/api/session") return Response.json({ data: native, cursor: {} })
    if (path.endsWith("/prompt")) return Response.json({ data: { id: "receipt" } })
    if (path.endsWith("/status")) return Response.json({ output: { runs: [run] } })
    if (path.endsWith("/control")) return Response.json({ output: { run } })
    if (path.endsWith("/interrupt")) return Response.json({ status: "interrupted" })
    if (path.endsWith("/wait")) return new Response(null, { status: 204 })
    if (path.startsWith("/api/session/")) return Response.json({ data: native.find(session => session.id === path.split("/").at(-1)) })
    return Response.json({ error: `Unexpected ${path}` }, { status: 500 })
  })
  try {
    await expect(runModelEvaluation([...explicit, "--scenario", "interrupted"], { root, fetch: transport })).rejects.toThrow("requested recovery graph was not demonstrated")
    const report = JSON.parse(await readFile(join(root, "evaluation.json"), "utf8"))
    expect(report.cases[0].observedRun.status).toBe("ready")
    expect(report.failure).toContain("accepted predecessor work with a running dependent successor")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a status failure stops discovered orphan descendants and refreshes their final accounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-")), directory = join(root, "planning")
  const options = parseEvaluationOptions(explicit), tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  const stopped = new Set<string>()
  let observations = 0, snapshotFailed = false
  const native = (id: string) => ({ id, ...(id === "orphan" ? { parentID: "parent" } : id === "late_child" ? { parentID: "orphan" } : {}), ...(stopped.has(id) ? { outcome: "interrupted" } : {}), projectID: "fixture", model: options.model, cost: id === "orphan" ? stopped.has(id) ? 0.2 : 0.1 : 0.01, tokens, time: { created: 1, updated: 2, ...(stopped.has(id) ? { idle: 2 } : {}) }, location: { directory } })
  const transport = scriptedFetch(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/info") return Response.json({ version: "2.0.25" })
    if (path === "/api/model") return Response.json({ data: [{ ...options.model, capabilities: { tools: true }, variants: [{ id: "high" }] }] })
    if (path.endsWith("/config")) return Response.json({ output: { config: JSON.parse(await readFile(join(directory, "ultraopencode.json"), "utf8")), promptVersion: "ultraopencode/test" } })
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: native("parent") })
    if (path.endsWith("/prompt")) return Response.json({ data: { id: "receipt" } })
    if (path.endsWith("/status")) return ++observations === 1 ? Response.json({ output: { runs: [] } }) : Response.json({ type: "RpcInternalError", message: "Injected status failure" }, { status: 500 })
    if (path === "/api/session") return Response.json({ data: [native("parent"), ...(stopped.has("parent") && !snapshotFailed ? [] : [native("orphan")]), ...(stopped.has("parent") ? [native("late_child")] : [])], cursor: {} })
    if (path.endsWith("/interrupt")) { stopped.add(path.split("/").at(-2)!); return Response.json({ status: "interrupted" }) }
    if (path.endsWith("/wait")) return new Response(null, { status: 204 })
    if (path === "/api/session/orphan" && stopped.has("parent") && !snapshotFailed) { snapshotFailed = true; return Response.json({ error: "Snapshot temporarily unavailable" }, { status: 503 }) }
    if (path.startsWith("/api/session/")) return Response.json({ data: native(path.split("/").at(-1)!) })
    return Response.json({ error: `Unexpected ${path}` }, { status: 500 })
  })
  try {
    const args = [...explicit, "--scenario", "planning"]; args[7] = "0.5"
    await expect(runModelEvaluation(args, { root, fetch: transport })).rejects.toThrow()
    expect(native("orphan").outcome).toBe("interrupted")
    expect(native("late_child").outcome).toBe("interrupted")
    const report = JSON.parse(await readFile(join(root, "evaluation.json"), "utf8"))
    expect(report.usage.cost).toBeCloseTo(0.22)
    expect(report.cases[0].cleanupErrors).toEqual([expect.stringContaining("Descendant discovery failed")])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("unconfirmed native settlement and unavailable final usage remain explicit in saved reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-")), directory = join(root, "planning")
  const options = parseEvaluationOptions(explicit), tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  const parent = { id: "parent", projectID: "fixture", model: options.model, cost: 0.5, tokens, time: { created: 1, updated: 2 }, location: { directory } }
  const transport = scriptedFetch(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/info") return Response.json({ version: "2.0.25" })
    if (path === "/api/model") return Response.json({ data: [{ ...options.model, capabilities: { tools: true }, variants: [{ id: "high" }] }] })
    if (path.endsWith("/config")) return Response.json({ output: { config: JSON.parse(await readFile(join(directory, "ultraopencode.json"), "utf8")), promptVersion: "ultraopencode/test" } })
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: parent })
    if (path === "/api/session") return Response.json({ data: [parent], cursor: {} })
    if (path.endsWith("/interrupt")) return Response.json({ status: "interrupted" })
    return Response.json({ error: "Native state unavailable" }, { status: 503 })
  })
  try {
    await expect(runModelEvaluation([...explicit, "--scenario", "planning"], { root, fetch: transport })).rejects.toThrow("cost allowance")
    const report = JSON.parse(await readFile(join(root, "evaluation.json"), "utf8"))
    expect(report.usage.cost).toBeNull()
    expect(report.usage.unknownCostSessions).toEqual(["parent"])
    expect(report.cases[0].cleanupSettledSessions).toEqual([])
    const markdown = await readFile(join(root, "evaluation.md"), "utf8")
    expect(markdown).toContain("parent native settlement unconfirmed")
    expect(markdown).toContain("parent final usage unavailable")
  } finally { await rm(root, { recursive: true, force: true }) }
})

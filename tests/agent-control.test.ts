import { expect, test } from "bun:test"
import { Schema } from "effect"
import { agentControlSchema, agentTaskSchema, controlCommand } from "../src/agent-control.ts"
import * as agentControl from "../src/agent-control.ts"
import type { CheckEvidence, Run } from "../src/types.ts"

test("agent tools expose object schemas and explicit provider-independent fields", () => {
  for (const schema of [agentControlSchema, agentTaskSchema]) {
    const document = Schema.toJsonSchemaDocument(schema)
    expect(document.schema.type).toBe("object")
    expect(document.schema.anyOf).toBeUndefined()
  }
  const decode = Schema.decodeUnknownSync(agentControlSchema)
  expect(() => decode({ action: "start" })).toThrow()
  expect(() => decode({ action: "run", runId: "run_1", revision: 0 })).toThrow()
  expect(() => decode({ action: "budget", runId: "run_1", limits: { workers: -1 } })).toThrow()
})

test("typed controls share native command validation and preserve multiline answers", () => {
  expect(controlCommand({ action: "run", runId: "run_1", revision: 3 })).toEqual({ type: "run", id: "run_1", revision: 3 })
  const answer = 'Use the existing API.\nPreserve "quoted values" and $literal text.'
  expect(controlCommand({ action: "input", runId: "run_1", answer })).toEqual({ type: "input", id: "run_1", answer })
  expect(controlCommand({ action: "budget", runId: "run_1", limits: { workers: 2 } })).toEqual({ type: "budget", id: "run_1", limits: { workers: 2 } })
  for (const input of [
    { action: "pause" }, { action: "retry", runId: "run_1" }, { action: "run", runId: "run_1" },
    { action: "config", runId: "run_1" }, { action: "status", runId: "bad id" },
    { action: "budget", runId: "run_1", limits: {} }, { action: "input", runId: "run_1", answer: " " },
  ] as any[]) expect(() => controlCommand(input)).toThrow()
})

function inspectedRun(checkCount = 2): Run {
  const checks: CheckEvidence[] = Array.from({ length: checkCount }, (_, index) => ({
    id: `evidence_${index}`, checkId: index ? "green" : "red", criterionIds: ["tests"],
    attemptId: "attempt_verify", taskId: "verify", sessionId: "native_worker", callId: `call_${index}`,
    command: index ? "bun test" : "bun test tests/regression.test.ts", cwd: process.cwd(),
    startedAt: 100 + index, finishedAt: 200 + index, exit: index ? 0 : 1, outcome: index ? "passed" : "failed",
    workspaceHash: index ? "current" : "before", output: index ? "2 tests passed" : "Expected 0, received 1\n1 test failed",
  }))
  return {
    id: "run_inspect", status: "succeeded", mode: "execute", phase: "execution", revision: 2,
    workspaceHash: "initial", candidateHash: "current", objective: "PRIVATE_OBJECTIVE".repeat(10_000),
    criteria: [{ id: "tests", description: "PRIVATE_CRITERIA", required: true, kind: "check" }],
    tasks: [{ spec: { id: "verify", role: "verifier", stage: "verification", instructions: "PRIVATE_INSTRUCTIONS" },
      status: "succeeded", acceptedAttemptId: "attempt_verify", attempts: [{
        id: "attempt_verify", sessionId: "native_worker", number: 1, status: "succeeded",
        model: { ref: { providerID: "fixture", id: "model", variant: "high" }, requested: "fixture/model#high", origin: "captured" },
        inputHash: "input", workspaceHash: "current", candidateHash: "current", createdAt: 10, startedAt: 20, finishedAt: 300,
        prompt: "PRIVATE_PROMPT".repeat(100_000), result: { summary: "Verifier observed the red and green checks.", proposal: { private: "PRIVATE_PROPOSAL" } }, checks,
      }] }], errors: ["PRIVATE_EVENT_PAYLOAD".repeat(100_000)],
  } as unknown as Run
}

test("task inspection gives the model actual red and green evidence without prompts or event payloads", () => {
  const run = inspectedRun(), original = structuredClone(run)
  const content = agentControl.inspectionContent(run, "verify")
  const view = JSON.parse(content), attempt = view.tasks[0].attempts[0]
  expect(view.run).toMatchObject({ id: run.id, status: "succeeded", candidateHash: "current" })
  expect(view.tasks[0]).toMatchObject({ id: "verify", acceptedAttemptId: "attempt_verify" })
  expect(attempt).toMatchObject({ id: "attempt_verify", sessionId: "native_worker", status: "succeeded", model: run.tasks[0]!.attempts[0]!.model })
  for (const check of attempt.checks) expect(check).toMatchObject(run.tasks[0]!.attempts[0]!.checks.find(item => item.id === check.id)!)
  expect(attempt.resultSummary).toContain("red and green")
  expect(content).toContain("taskId")
  expect(content).toContain("export")
  for (const marker of ["PRIVATE_OBJECTIVE", "PRIVATE_CRITERIA", "PRIVATE_INSTRUCTIONS", "PRIVATE_PROMPT", "PRIVATE_EVENT_PAYLOAD", "PRIVATE_PROPOSAL"]) expect(content).not.toContain(marker)
  expect(run).toEqual(original)
})

test("inspection bounds model content as valid JSON with explicit record and output omissions", () => {
  const run = inspectedRun(150)
  for (const check of run.tasks[0]!.attempts[0]!.checks) check.output = "HEAD_FAILURE\n" + "中".repeat(40_000) + "\nTAIL_RESULT Bearer sk-1234567890123456"
  run.tasks[0]!.attempts[0]!.result!.summary = "Observed result " + "summary ".repeat(40_000)
  const content = agentControl.inspectionContent(run, "verify"), view = JSON.parse(content)
  expect(Buffer.byteLength(content, "utf8")).toBeLessThan(32 * 1024)
  expect(view.omitted.checks).toBeGreaterThan(0)
  const included = view.tasks.flatMap((task: any) => task.attempts.flatMap((attempt: any) => attempt.checks))
  expect(included.length + view.omitted.checks).toBe(150)
  expect(included.length).toBeGreaterThan(0)
  for (const check of included) {
    const original = run.tasks[0]!.attempts[0]!.checks.find(item => item.id === check.id)!
    const { output, ...metadata } = original
    expect(check).toMatchObject(metadata)
    expect(check.output).toContain("HEAD_FAILURE")
    expect(check.output).toContain("TAIL_RESULT")
    expect(check.output).toContain("omitted")
  }
  expect(view.tasks[0].attempts[0].resultSummary).toContain("omitted")
  expect(content).toContain("[REDACTED]")
  expect(content).not.toContain("1234567890123456")
})

test("whole-run inspection summarizes evidence and records while task inspection includes bounded narrative", () => {
  const run = inspectedRun()
  const view = JSON.parse(agentControl.inspectionContent(run))
  expect(view.counts).toEqual({ tasks: 1, attempts: 1, checks: 2 })
  expect(view.omitted).toEqual({ tasks: 0, attempts: 0, checks: 0 })
  expect(view.tasks[0].attempts[0].resultSummary).toBeUndefined()
  expect(Object.fromEntries(view.tasks[0].attempts[0].checks.map((check: CheckEvidence) => [check.checkId, [check.exit, check.outcome]]))).toEqual({ red: [1, "failed"], green: [0, "passed"] })
})

test("focused inspection retains a normal complete failure log and bounds many tasks by whole records", () => {
  const run = inspectedRun(1), failure = "Expected empty array, received [1]\n" + "test case evidence\n".repeat(200)
  run.tasks[0]!.attempts[0]!.checks[0]!.output = failure
  expect(JSON.parse(agentControl.inspectionContent(run, "verify")).tasks[0].attempts[0].checks[0].output).toBe(failure)
  run.tasks[0]!.attempts[0]!.prompt = ""
  run.tasks = Array.from({ length: 200 }, (_, index) => {
    const task = structuredClone(run.tasks[0]!)
    task.spec.id = `verify_${index}`
    return task
  })
  // One unbounded configured command cannot make the compact view truncate its canonical record halfway.
  run.tasks[0]!.attempts[0]!.checks[0]!.command = "oversized-command-".repeat(10_000)
  const content = agentControl.inspectionContent(run), view = JSON.parse(content)
  expect(Buffer.byteLength(content, "utf8")).toBeLessThan(32 * 1024)
  expect(view.omitted.tasks).toBeGreaterThan(0)
  expect(view.tasks.length + view.omitted.tasks).toBe(200)
  const attempts = view.tasks.flatMap((task: any) => task.attempts), checks = attempts.flatMap((attempt: any) => attempt.checks)
  expect(attempts.length + view.omitted.attempts).toBe(200)
  expect(checks.length + view.omitted.checks).toBe(200)
  expect(content).not.toContain("oversized-command-")
  for (const check of checks) expect(check).toMatchObject({ id: "evidence_0", exit: 1, outcome: "failed", workspaceHash: "before", command: "bun test tests/regression.test.ts" })
})

test("capped inspection preserves accepted evidence first and then the newest remaining attempts", () => {
  const run = inspectedRun(1), task = run.tasks[0]!
  task.attempts[0]!.prompt = ""
  task.attempts = Array.from({ length: 24 }, (_, index) => {
    const attempt = structuredClone(task.attempts[0]!)
    attempt.id = `attempt_${index}`; attempt.number = index + 1; attempt.sessionId = `native_${index}`
    attempt.status = index === 20 ? "succeeded" : "failed"
    attempt.result = { summary: `Observed attempt ${index}: ` + "evidence ".repeat(400) }
    attempt.checks[0] = { ...attempt.checks[0]!, id: `check_${index}`, attemptId: attempt.id, sessionId: attempt.sessionId, exit: index === 20 ? 0 : 1, outcome: index === 20 ? "passed" : "failed", output: `Native attempt ${index} evidence\n` + "failure details\n".repeat(100) }
    return attempt
  })
  task.acceptedAttemptId = "attempt_20"
  const original = structuredClone(run)
  const content = agentControl.inspectionContent(run, "verify"), view = JSON.parse(content), attempts = view.tasks[0].attempts
  expect(Buffer.byteLength(content, "utf8")).toBeLessThan(32 * 1024)
  expect(view.omitted.attempts).toBeGreaterThan(0)
  expect(attempts[0].id).toBe("attempt_20")
  expect(attempts[0].checks[0]).toMatchObject({ id: "check_20", exit: 0, outcome: "passed" })
  expect(attempts[1].id).toBe("attempt_23")
  expect(attempts.slice(1).map((attempt: any) => attempt.number)).toEqual(attempts.slice(1).map((attempt: any) => attempt.number).toSorted((a: number, b: number) => b - a))
  expect(attempts.length + view.omitted.attempts).toBe(24)
  expect(attempts.reduce((sum: number, attempt: any) => sum + attempt.checks.length, 0) + view.omitted.checks).toBe(24)
  expect(run).toEqual(original)

  const repeated = inspectedRun(150), checks = repeated.tasks[0]!.attempts[0]!.checks
  for (const check of checks) Object.assign(check, { checkId: "unit", command: "bun test", exit: 0, outcome: "passed", output: "Older passing evidence\n".repeat(100) })
  // The latest completion need not be the last appended record when native calls overlap.
  Object.assign(checks[120]!, { finishedAt: 99_999, exit: 1, outcome: "failed", output: "Newest observed failure" })
  const checkOrder = checks.map(check => check.id)
  const freshView = JSON.parse(agentControl.inspectionContent(repeated, "verify")), visible = freshView.tasks[0].attempts[0].checks
  expect(freshView.omitted.checks).toBeGreaterThan(0)
  expect(visible[0]).toMatchObject({ id: "evidence_120", finishedAt: 99_999, exit: 1, outcome: "failed", output: "Newest observed failure" })
  expect(visible.length + freshView.omitted.checks).toBe(150)
  expect(checks.map(check => check.id)).toEqual(checkOrder)
})

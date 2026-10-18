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

test("task tools reuse typed graph fields without handing the model acceptance criteria", () => {
  const decode = Schema.decodeUnknownSync(agentTaskSchema, { onExcessProperty: "error" })
  const task = { id: "inspect", title: "Inspect the parser", role: "planner" as const, stage: "design" as const, instructions: "Read the parser and propose the smallest useful change.", dependencies: [], writes: false }
  const input = { objective: "Design a parser fix", mode: "plan" as const, workflow: { rationale: "One bounded investigation", tasks: [task] } }
  expect(decode(input)).toEqual(input)
  expect(decode({ objective: "Design a parser fix", mode: "plan" })).toEqual({ objective: "Design a parser fix", mode: "plan" })
  for (const workflow of [
    { rationale: "One worker", tasks: [] }, { rationale: "One worker", tasks: [{ ...task, role: "router" }] },
    { ...input.workflow, criteria: [] }, { ...input.workflow, revision: 99 },
  ]) expect(() => decode({ ...input, workflow })).toThrow()
})

test("task recipes are explicit plan-only alternatives to authored graphs", () => {
  const decode = Schema.decodeUnknownSync(agentTaskSchema, { onExcessProperty: "error" })
  expect(decode({ objective: "Review the parser", mode: "plan", recipe: "deep-review" })).toEqual({ objective: "Review the parser", mode: "plan", recipe: "deep-review" })
  const workflow = { rationale: "One reader", tasks: [{ id: "read", title: "Read", role: "explorer", stage: "discovery", instructions: "Inspect", dependencies: [], writes: false }] }
  for (const input of [
    { objective: "Review", mode: "plan", recipe: "unknown" },
    { objective: "Review", mode: "execute", recipe: "deep-review" },
    { objective: "Review", mode: "plan", recipe: "deep-review", workflow },
  ]) expect(() => decode(input)).toThrow()
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
      }] }], errors: ["IRRELEVANT_HISTORICAL_ERROR", "Earlier native launch failed.", "PRIVATE_EVENT_PAYLOAD".repeat(100_000) + " Bearer sk-1234567890123456", "Latest native review retained a limitation."],
  } as unknown as Run
}

test("check previews bound multilingual logs by UTF-8 bytes while retaining provenance and redacted head and tail", () => {
  const evidence = inspectedRun(1).tasks[0]!.attempts[0]!.checks[0]!
  evidence.output = "HEAD_FAILURE Bearer sk-1234567890123456\n" + "中😀é\"\n".repeat(20_000) + "\nTAIL_RESULT password=credential-value"
  const original = structuredClone(evidence), { output, ...metadata } = evidence
  for (const budget of [6_000, 2_000, 64_000]) {
    const content = agentControl.checkContent(evidence, budget), view = JSON.parse(content)
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(Math.min(budget, 6_000))
    expect(view).toMatchObject(metadata)
    expect(view.output).toContain("HEAD_FAILURE")
    expect(view.output).toContain("TAIL_RESULT")
    expect(view.output).toContain("[REDACTED]")
    expect(view.output).toContain("characters omitted")
    expect(view.output).not.toContain("�")
    expect(view.omittedCharacters).toBeGreaterThan(0)
    expect(view.output).toContain(`[${view.omittedCharacters} characters omitted]`)
    expect(view.fullEvidence).toEqual({ runAudit: "gigacode_control export", evidenceId: evidence.id, checkId: evidence.checkId })
    expect(view.note).toContain("log text may be omitted")
    for (const secret of ["1234567890123456", "credential-value"]) expect(content).not.toContain(secret)
  }
  expect(Buffer.byteLength(agentControl.checkContent(evidence), "utf8")).toBeLessThanOrEqual(6_000)
  expect(evidence).toEqual(original)
})

test("check previews retain complete small logs and required metadata when an allowance is too small", () => {
  const evidence = inspectedRun(1).tasks[0]!.attempts[0]!.checks[0]!
  expect(JSON.parse(agentControl.checkContent(evidence))).toMatchObject({ ...evidence, omittedCharacters: 0 })
  evidence.command += " password=credential-value"
  const original = structuredClone(evidence), view = JSON.parse(agentControl.checkContent(evidence, 1))
  expect(view).toMatchObject({ id: evidence.id, checkId: evidence.checkId, attemptId: evidence.attemptId, taskId: evidence.taskId, sessionId: evidence.sessionId, callId: evidence.callId, outcome: "failed", exit: 1, workspaceHash: "before", command: "bun test tests/regression.test.ts password=[REDACTED]", output: "", omittedCharacters: Array.from(evidence.output).length })
  expect(view.note).toContain("metadata exceeds the requested byte allowance")
  expect(view.fullEvidence.evidenceId).toBe(evidence.id)
  expect(evidence).toEqual(original)
})

test("inspection and progress respect a smaller configured byte cap without slicing metadata records", () => {
  const run = inspectedRun(1), template = run.tasks[0]!
  run.config = { limits: { contextChars: 4_000 } } as Run["config"]
  run.objective = "Verify the regression at the saved candidate."
  run.errors = ["An earlier candidate failed the regression."]
  template.spec.title = "Verify saved candidate"
  template.spec.instructions = "Run the configured regression check."
  template.attempts[0]!.checks[0]!.output = "HEAD_FAILURE\n" + "中😀".repeat(40_000) + "\nTAIL_RESULT"
  run.tasks = Array.from({ length: 20 }, (_, index) => ({ ...template, spec: { ...template.spec, id: `verify-${index}` } }))
  const original = structuredClone(run)
  for (const content of [agentControl.inspectionContent(run), agentControl.progressContent(run)]) {
    const view = JSON.parse(content)
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(4_000)
    expect(view.run).toMatchObject({ id: run.id, status: run.status, candidateHash: run.candidateHash, revision: run.revision })
    expect(view.omitted.tasks).toBeGreaterThan(0)
    expect(view.tasks.length + view.omitted.tasks).toBe(20)
    const attempts = view.tasks.flatMap((task: any) => task.attempts), checks = attempts.flatMap((attempt: any) => attempt.checks)
    expect(attempts.length + view.omitted.attempts).toBe(20)
    expect(checks.length + view.omitted.checks).toBe(20)
    for (const check of checks) expect(check).toMatchObject({ id: "evidence_0", exit: 1, outcome: "failed", workspaceHash: "before", command: "bun test tests/regression.test.ts" })
  }
  expect(run).toEqual(original)
})

test("a configured cap below the base run view retains metadata and explicitly omits all records", () => {
  const run = inspectedRun(2)
  run.config = { limits: { contextChars: 1 } } as Run["config"]
  const view = JSON.parse(agentControl.inspectionContent(run))
  expect(view.run).toMatchObject({ id: run.id, status: run.status, candidateHash: run.candidateHash, revision: run.revision })
  expect(view.tasks).toEqual([])
  expect(view.omitted).toEqual(view.counts)
  expect(view.note).toContain("metadata exceeds the configured byte allowance")
})

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
  for (const marker of ["PRIVATE_OBJECTIVE", "PRIVATE_CRITERIA", "PRIVATE_INSTRUCTIONS", "PRIVATE_PROMPT", "IRRELEVANT_HISTORICAL_ERROR", "PRIVATE_PROPOSAL", "1234567890123456"]) expect(content).not.toContain(marker)
  expect(view.run.omittedErrors).toBe(1)
  expect(view.run.errors).toHaveLength(3)
  expect(view.run.errors[1]).toContain("characters omitted")
  expect(view.run.errors[1]).toContain("[REDACTED]")
  for (const reason of view.run.errors) expect(reason.length).toBeLessThanOrEqual(1_000)
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

test("whole-run inspection includes bounded current accepted conclusions alongside evidence", () => {
  const run = inspectedRun()
  const view = JSON.parse(agentControl.inspectionContent(run))
  expect(view.counts).toEqual({ tasks: 1, attempts: 1, checks: 2 })
  expect(view.omitted).toEqual({ tasks: 0, attempts: 0, checks: 0 })
  expect(view.tasks[0].attempts[0].resultSummary).toContain("red and green")
  expect(view.tasks[0].attempts[0]).toMatchObject({ accepted: true, current: true })
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

test("ready design inspection describes the accepted conclusion and exact proposal revision", () => {
  const run = inspectedRun(0), design = run.tasks[0]!
  run.status = "ready"; run.mode = "plan"; run.phase = "planning"
  run.candidateHash = undefined
  run.proposal = { revision: 7, tasks: [], criteria: [], rationale: "Use native sessions and durable task state." }
  design.spec.id = "chosen-approach"; design.spec.role = "synthesizer"; design.spec.stage = "design"
  design.attempts[0]!.workspaceHash = run.workspaceHash
  design.attempts[0]!.prompt = ""; design.attempts[0]!.result = { summary: "Use SQLite WAL for durable task state and native sessions for workers." }
  const discovery = structuredClone(design)
  discovery.spec.id = "repository-facts"; discovery.spec.role = "explorer"; discovery.spec.stage = "discovery"
  discovery.attempts[0]!.id = "discovery_attempt"; discovery.acceptedAttemptId = "discovery_attempt"
  discovery.attempts[0]!.result = { summary: "Earlier repository inventory." }
  run.tasks.unshift(discovery)
  const original = structuredClone(run), view = JSON.parse(agentControl.inspectionContent(run))
  expect(view.run).toMatchObject({ status: "ready", proposalRevision: 7 })
  expect(view.tasks[0].id).toBe("chosen-approach")
  expect(view.tasks[0].attempts[0].resultSummary).toContain("SQLite WAL")
  expect(view.tasks[0].attempts[0]).toMatchObject({ accepted: true, current: true })
  expect(run).toEqual(original)
})

test.each(["partial", "failed"] as const)("%s execution without reporting exposes technical conclusions while stale claims remain historical", status => {
  const run = inspectedRun(0), template = run.tasks[0]!
  template.attempts[0]!.prompt = ""
  run.status = status
  run.errors = ["Earlier unrelated diagnostic", "Required native regression failed; the reviewed candidate is retained."]
  const stale = structuredClone(template)
  stale.spec.id = "previous-review"; stale.spec.role = "reviewer"; stale.spec.stage = "review"; stale.spec.writes = false
  stale.attempts[0]!.workspaceHash = "before"; stale.attempts[0]!.candidateHash = "current"
  stale.attempts[0]!.result = { summary: "Old candidate accepts negative durations." }
  const implementation = structuredClone(template)
  implementation.spec.id = "duration-validation"; implementation.spec.role = "implementer"; implementation.spec.stage = "implementation"; implementation.spec.writes = true
  implementation.attempts[0]!.workspaceHash = "before"; implementation.attempts[0]!.candidateHash = "current"
  implementation.attempts[0]!.result = { summary: "Added explicit rejection of negative durations in parseDuration." }
  const verification = structuredClone(template)
  verification.spec.id = "native-tests"; verification.spec.role = "verifier"; verification.spec.stage = "verification"; verification.spec.writes = false
  verification.attempts[0]!.result = { summary: "Observed the regression fail before the fix, then pass after rejection was added." }
  run.tasks = [stale, implementation, verification]
  const view = JSON.parse(agentControl.inspectionContent(run))
  expect(view.run.status).toBe(status)
  expect(view.run.errors.at(-1)).toBe("Required native regression failed; the reviewed candidate is retained.")
  expect(view.run.omittedErrors).toBe(0)
  expect(view.tasks[0].id).toBe("native-tests")
  expect(view.tasks[0].attempts[0].resultSummary).toContain("regression fail before the fix")
  const writer = view.tasks.find((task: any) => task.id === "duration-validation").attempts[0]
  expect(writer).toMatchObject({ current: true, accepted: true })
  expect(writer.resultSummary).toContain("parseDuration")
  const historic = view.tasks.find((task: any) => task.id === "previous-review").attempts[0]
  expect(historic).toMatchObject({ accepted: true, current: false })
  expect(historic.resultSummary).toBeUndefined()
  const focused = JSON.parse(agentControl.inspectionContent(run, "previous-review"))
  expect(focused.tasks[0].attempts[0]).toMatchObject({ current: false, resultSummary: "Old candidate accepts negative durations." })
  verification.attempts[0]!.status = "failed"
  expect(JSON.parse(agentControl.inspectionContent(run)).tasks.find((task: any) => task.id === "native-tests").attempts[0].resultSummary).toBeUndefined()
})

test("whole-run cap retains substantive current conclusions before noisy old discovery without fixed task IDs", () => {
  const run = inspectedRun(1), template = run.tasks[0]!
  template.attempts[0]!.prompt = ""
  run.tasks = Array.from({ length: 100 }, (_, index) => {
    const task = structuredClone(template)
    task.spec.id = `repository-topic-${index}`; task.spec.role = "explorer"; task.spec.stage = "discovery"
    task.attempts[0]!.result = { summary: "Earlier observed repository context. ".repeat(100) }
    return task
  })
  const final = structuredClone(template)
  final.spec.id = "final-native-evidence"; final.spec.role = "verifier"; final.spec.stage = "verification"; final.spec.writes = false
  final.attempts[0]!.result = { summary: "The public API now rejects negative durations; exact native regressions passed." }
  run.tasks.push(final)
  const order = run.tasks.map(task => task.spec.id), content = agentControl.inspectionContent(run), view = JSON.parse(content)
  expect(Buffer.byteLength(content, "utf8")).toBeLessThan(32 * 1024)
  expect(view.omitted.tasks).toBeGreaterThan(0)
  expect(view.tasks[0].id).toBe("final-native-evidence")
  expect(view.tasks[0].attempts[0].resultSummary).toContain("rejects negative durations")
  expect(view.tasks.length + view.omitted.tasks).toBe(101)
  expect(view.run.errors.every((reason: string) => reason.length <= 1_000)).toBe(true)
  expect(view.run.omittedErrors).toBe(1)
  expect(run.tasks.map(task => task.spec.id)).toEqual(order)
})

test("progress describes the requested work and task purposes without presenting intentions as findings", () => {
  const run = inspectedRun(0), task = run.tasks[0]!
  run.status = "planning"; run.phase = "planning"
  run.objective = "Add exact duration formatting alongside parseDuration."
  task.spec.title = "Inspect duration validation and existing regression tests"
  task.spec.instructions = "Read src/duration.ts and tests/duration.test.ts to establish integer validation and roundtrip behavior."
  task.status = "running"; task.acceptedAttemptId = undefined
  task.attempts[0]!.status = "running"
  task.attempts[0]!.result = { summary: "UNSETTLED_WORKER_CLAIM" }
  const original = structuredClone(run), view = JSON.parse(agentControl.progressContent(run))
  expect(view.run).toMatchObject({ id: run.id, objective: run.objective, status: "planning", mode: "execute", revision: 2 })
  expect(view.tasks[0]).toMatchObject({ id: "verify", title: task.spec.title, instructions: task.spec.instructions, status: "running" })
  expect(view.tasks[0].attempts[0]).toMatchObject({ accepted: false, current: false })
  expect(view.tasks[0].attempts[0].resultSummary).toBeUndefined()
  expect(view.note).toContain("intended work")
  expect(view.note).toContain("not findings")
  const inspection = JSON.parse(agentControl.inspectionContent(run))
  expect(inspection.run.objective).toBeUndefined()
  expect(inspection.tasks[0].title).toBeUndefined()
  expect(inspection.tasks[0].instructions).toBeUndefined()
  expect(run).toEqual(original)
})

test("progress prioritizes accepted current conclusions and active purposes before stale history", () => {
  const run = inspectedRun(1), template = run.tasks[0]!
  run.objective = "Reject invalid duration inputs without changing the public API."
  run.status = "running"
  template.spec.title = "Verify duration validation"
  template.spec.instructions = "Run the configured regression check."
  template.attempts[0]!.prompt = ""
  template.attempts[0]!.result = { summary: "The public parser now rejects negative durations; the native regression passed." }
  const active = structuredClone(template)
  active.spec.id = "public-api-review"; active.spec.role = "reviewer"; active.spec.stage = "review"
  active.spec.title = "Review parseDuration integer and overflow behavior"
  active.spec.instructions = "Inspect safe-integer boundaries and preserve existing suffix parsing."
  active.status = "running"; active.acceptedAttemptId = undefined
  active.attempts[0]!.status = "running"; active.attempts[0]!.checks = []
  active.attempts[0]!.result = { summary: "UNSETTLED_REVIEW_CLAIM" }
  const pending = structuredClone(active)
  pending.spec.id = "public-api-report"; pending.spec.stage = "reporting"
  pending.spec.title = "Explain the resulting duration behavior"
  pending.status = "pending"; pending.attempts = []
  const history = Array.from({ length: 100 }, (_, index) => {
    const task = structuredClone(template)
    task.spec.id = `old-inspection-${index}`; task.spec.stage = "discovery"
    task.attempts[0]!.workspaceHash = "before"; task.attempts[0]!.candidateHash = "current"
    task.attempts[0]!.result = { summary: "STALE_CANDIDATE_CLAIM" }
    task.attempts[0]!.checks[0]!.output = "Old diagnostic\n".repeat(500)
    return task
  })
  run.tasks = [...history, pending, active, template]
  const original = structuredClone(run), content = agentControl.progressContent(run), view = JSON.parse(content)
  expect(view.tasks.slice(0, 3).map((task: any) => task.id)).toEqual(["verify", "public-api-review", "public-api-report"])
  expect(view.tasks[0].attempts[0]).toMatchObject({ accepted: true, current: true, resultSummary: template.attempts[0]!.result!.summary })
  expect(view.tasks[0].attempts[0].checks[0]).toMatchObject(template.attempts[0]!.checks[0]!)
  expect(view.tasks[1]).toMatchObject({ title: active.spec.title, instructions: active.spec.instructions })
  expect(content).not.toContain("UNSETTLED_REVIEW_CLAIM")
  expect(content).not.toContain("STALE_CANDIDATE_CLAIM")
  expect(view.omitted.tasks).toBeGreaterThan(0)
  expect(view.tasks.length + view.omitted.tasks).toBe(run.tasks.length)
  expect(run).toEqual(original)
})

test("progress bounds and redacts Unicode objectives and purposes while retaining complete evidence records", () => {
  const run = inspectedRun(1), template = run.tasks[0]!
  run.objective = "FORMAT_OBJECTIVE\n" + "中😀".repeat(40_000) + "\nOBJECTIVE_END Bearer sk-1234567890123456"
  template.spec.title = "DURATION_TITLE\n" + "中😀".repeat(40_000) + "\nTITLE_END Bearer sk-1234567890123456"
  template.spec.instructions = "DURATION_PURPOSE\n" + "中😀".repeat(40_000) + "\nPURPOSE_END Bearer sk-1234567890123456"
  template.attempts[0]!.prompt = "PRIVATE_PROMPT"
  template.attempts[0]!.result = { summary: "Reject fractions before formatting." }
  run.tasks = Array.from({ length: 40 }, (_, index) => ({ ...template, spec: { ...template.spec, id: `duration-${index}` } }))
  const original = structuredClone(run), content = agentControl.progressContent(run), view = JSON.parse(content)
  expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(30_000)
  expect(view.run.objective).toContain("FORMAT_OBJECTIVE")
  expect(view.run.objective).toContain("OBJECTIVE_END")
  expect(view.run.objective).toContain("omitted")
  expect(view.run.objective).toContain("[REDACTED]")
  expect(view.tasks.length).toBeGreaterThan(0)
  expect(view.omitted.tasks).toBeGreaterThan(0)
  for (const task of view.tasks) {
    expect(task.title).toContain("DURATION_TITLE")
    expect(task.title).toContain("TITLE_END")
    expect(task.instructions).toContain("DURATION_PURPOSE")
    expect(task.instructions).toContain("PURPOSE_END")
    for (const purpose of [task.title, task.instructions]) {
      expect(purpose).toContain("omitted")
      expect(purpose).toContain("[REDACTED]")
    }
    for (const attempt of task.attempts) {
      expect(attempt.resultSummary).toBe("Reject fractions before formatting.")
      for (const check of attempt.checks) expect(check).toEqual(template.attempts[0]!.checks[0]!)
    }
  }
  expect(view.tasks[0].attempts[0].checks).toHaveLength(1)
  expect(view.run.errors.at(-1)).toBe("Latest native review retained a limitation.")
  expect(view.run.omittedErrors).toBe(1)
  for (const marker of ["1234567890123456", "PRIVATE_PROMPT", "PRIVATE_CRITERIA", "PRIVATE_PROPOSAL"]) expect(content).not.toContain(marker)
  expect(run).toEqual(original)
})

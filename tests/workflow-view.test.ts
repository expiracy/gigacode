import { expect, test } from "bun:test"
import { defaultConfig } from "../src/config.ts"
import { workflowView } from "../src/workflow-view.ts"
import { inspectionContent } from "../src/agent-control.ts"
import type { Attempt, Run } from "../src/types.ts"

function run(): Run {
  const attempt: Attempt = { id: "attempt", taskId: "inspect", number: 1, status: "running", ownerEpoch: 1,
    sessionId: "worker", model: { ref: { providerID: "fixture", id: "model" }, requested: "fixture/model", origin: "captured" },
    inputHash: "input", prompt: "PRIVATE_PROMPT", workspaceHash: "current", createdAt: 100, startedAt: 200, checks: [], steps: 2 }
  return { id: "run_1", projectId: "project", directory: "/project", parentSessionId: "parent", supervisorSessionId: "supervisor",
    intentId: "intent", intentExpiresAt: 100, objective: "Inspect the parser", mode: "execute", status: "running", phase: "execution", revision: 2,
    plans: [], tasks: [{ spec: { id: "inspect", title: "Inspect parser", role: "reviewer", stage: "review", instructions: "PRIVATE_INSTRUCTIONS", dependencies: [], writes: false }, status: "running", attempts: [attempt] }],
    criteria: [], capturedModel: attempt.model.ref, modelOptions: {}, config: structuredClone(defaultConfig), policy: [], workspaceHash: "current",
    createdAt: 100, updatedAt: 300, activeMs: 50, activeSince: 200, repairRound: 0, continuation: 0, ownerEpoch: 1, generation: 3, errors: [], notifications: [] }
}

test("accepted isolated writer conclusions remain current after their exact root integration", () => {
  const original = run(), writer = original.tasks[0]!, attempt = writer.attempts[0]!
  writer.spec.role = "implementer"; writer.spec.stage = "implementation"; writer.spec.writes = true; writer.spec.ownedPaths = ["first.txt"]
  writer.status = "succeeded"; writer.acceptedAttemptId = attempt.id; attempt.status = "succeeded"
  attempt.candidateHash = "isolated-first"; attempt.worktree = { directory: "/first", state: "settled", changes: [] }; attempt.result = { summary: "Implemented the first requested behavior" }
  const second = structuredClone(writer); second.spec.id = "second"; second.acceptedAttemptId = "second-attempt"; second.attempts[0]!.id = "second-attempt"; second.attempts[0]!.taskId = "second"; second.attempts[0]!.candidateHash = "isolated-second"
  const integration = structuredClone(writer); integration.spec.id = "integration"; integration.spec.dependencies = ["inspect", "second"]; integration.acceptedAttemptId = "integrated"; integration.attempts[0]!.id = "integrated"; integration.attempts[0]!.taskId = "integration"; integration.attempts[0]!.worktree = undefined; integration.attempts[0]!.candidateHash = "root"; integration.attempts[0]!.integrationAppliedHash = "root"
  original.tasks.push(second, integration); original.candidateHash = "root"
  original.parallel = { baseline: { commit: "commit", hash: "baseline", files: {} }, preparationTaskId: "preparation", integrationTaskId: "integration", checkouts: [], integratedHash: "root" }
  expect(workflowView(original).tasks[0]!.result?.current).toBe(true)
  expect(JSON.parse(inspectionContent(original)).tasks.find((task: any) => task.id === "inspect").attempts[0].resultSummary).toBe("Implemented the first requested behavior")
  original.candidateHash = "later-repair"
  expect(workflowView(original).tasks[0]!.result?.current).toBe(false)
})

test("workflow snapshots expose durable state and worker identity without captured prompts", () => {
  const original = run(), view = workflowView(original, 400)
  expect(view).toMatchObject({ id: "run_1", parentSessionId: "parent", generation: 3, revision: 2, phase: "execution", status: "running", objective: "Inspect the parser", supervisorSessionId: "supervisor" })
  expect(view.tasks[0]).toMatchObject({ id: "inspect", title: "Inspect parser", status: "running", sessionId: "worker", model: original.tasks[0]!.attempts[0]!.model, attempts: 1 })
  expect(view.usage).toMatchObject({ workers: 1, attempts: 1, activeMs: 250, elapsedMs: 300 })
  for (const marker of ["PRIVATE_PROMPT", "PRIVATE_INSTRUCTIONS", "intentId", "policy"]) expect(JSON.stringify(view)).not.toContain(marker)
})

test("worker usage preserves missing observations and reports the observed coverage", () => {
  const original = run(), attempt = original.tasks[0]!.attempts[0]!
  expect(workflowView(original).usage).toMatchObject({ tokens: null, cost: null, tokenObservations: 0, costObservations: 0 })
  attempt.tokens = 0; attempt.cost = 0
  original.tasks[0]!.attempts.push({ ...attempt, id: "unobserved", tokens: undefined, cost: undefined })
  expect(workflowView(original).usage).toMatchObject({ tokens: 0, cost: 0, tokenObservations: 1, costObservations: 1, attempts: 2 })
})

test("accepted results and native checks retain their candidate freshness", () => {
  const original = run(), task = original.tasks[0]!, attempt = task.attempts[0]!
  task.spec.role = "verifier"; task.spec.stage = "verification"; task.spec.checkIds = ["types"]
  original.plans = [{ revision: 2, tasks: [task.spec], criteria: [], rationale: "Final configured verification" }]
  task.status = "succeeded"; task.acceptedAttemptId = attempt.id; attempt.status = "succeeded"
  attempt.result = { summary: "The parser rejects empty input." }
  attempt.checks = [{ id: "check", attemptId: attempt.id, taskId: task.spec.id, sessionId: "worker", callId: "call", checkId: "types", command: "bun run typecheck", criterionIds: ["types"], cwd: "/project", startedAt: 100, finishedAt: 300, exit: 0, outcome: "passed", output: "Types passed", workspaceHash: "current" }]
  expect(workflowView(original).tasks[0]).toMatchObject({ result: { summary: "The parser rejects empty input.", current: true }, checks: [{ id: "check", current: true, outcome: "passed", exit: 0 }] })
  original.candidateHash = "changed"
  expect(workflowView(original).tasks[0]).toMatchObject({ result: { current: false }, checks: [{ current: false }] })
})

test("unaccepted historical checks are never current proof even at the unchanged candidate", () => {
  const original = run(), task = original.tasks[0]!, attempt = task.attempts[0]!
  task.status = "succeeded"; task.acceptedAttemptId = attempt.id; attempt.status = "succeeded"
  task.spec.role = "verifier"; task.spec.stage = "verification"; task.spec.checkIds = ["types"]
  original.plans = [{ revision: 2, tasks: [task.spec], criteria: [], rationale: "Final configured verification" }]
  const check = { id: "old", attemptId: "historical", taskId: task.spec.id, sessionId: "old-worker", callId: "old-call", checkId: "types", command: "bun run typecheck", criterionIds: ["types"], cwd: "/project", startedAt: 100, finishedAt: 200, exit: 0, outcome: "passed" as const, output: "Types passed", workspaceHash: "current" }
  task.attempts.unshift({ ...structuredClone(attempt), id: "historical", checks: [check] })
  attempt.checks = [{ ...check, id: "fresh", attemptId: attempt.id, sessionId: attempt.sessionId!, finishedAt: 300 }]
  const checks = workflowView(original).tasks[0]!.checks
  expect(checks.find(check => check.id === "old")!.current).toBe(false)
  expect(checks.find(check => check.id === "fresh")!.current).toBe(true)
})

test("baseline checks before writers stay historical until final verification follows every writer", () => {
  const original = run(), task = original.tasks[0]!, attempt = task.attempts[0]!
  task.status = "succeeded"; task.acceptedAttemptId = attempt.id; attempt.status = "succeeded"
  task.spec.role = "verifier"; task.spec.stage = "verification"; task.spec.checkIds = ["types"]
  const writer = { ...task.spec, id: "write", role: "implementer" as const, stage: "implementation" as const, writes: true, dependencies: [] }
  original.tasks.push({ spec: writer, status: "succeeded", attempts: [] })
  original.plans = [{ revision: 2, tasks: [task.spec, writer], criteria: [], rationale: "Test first then implement" }]
  attempt.checks = [{ id: "baseline", attemptId: attempt.id, taskId: task.spec.id, sessionId: "worker", callId: "call", checkId: "types", command: "bun run typecheck", criterionIds: ["types"], cwd: "/project", startedAt: 100, finishedAt: 200, exit: 0, outcome: "passed", output: "Types passed", workspaceHash: "current" }]
  expect(workflowView(original).tasks[0]!.checks[0]!.current).toBe(false)
  task.spec.dependencies = [writer.id]
  expect(workflowView(original).tasks[0]!.checks[0]!.current).toBe(true)
})

test("checks from a prior repair graph remain historical when the candidate hash did not change", () => {
  const original = run(), task = original.tasks[0]!, attempt = task.attempts[0]!
  task.status = "succeeded"; task.acceptedAttemptId = attempt.id; attempt.status = "succeeded"
  task.spec.role = "verifier"; task.spec.stage = "verification"; task.spec.checkIds = ["types"]
  const next = { ...task.spec, id: "repair_verify" }
  original.repairRound = 1
  original.plans = [{ revision: 1, tasks: [task.spec], criteria: [], rationale: "Previous graph" }, { revision: 2, tasks: [task.spec, next], criteria: [], rationale: "Repair graph" }]
  attempt.checks = [{ id: "prior", attemptId: attempt.id, taskId: task.spec.id, sessionId: "worker", callId: "call", checkId: "types", command: "bun run typecheck", criterionIds: ["types"], cwd: "/project", startedAt: 100, finishedAt: 200, exit: 0, outcome: "passed", output: "Types passed", workspaceHash: "current" }]
  expect(workflowView(original).tasks[0]!.checks[0]!.current).toBe(false)
})

test("the latest configured check supersedes earlier evidence within an accepted verifier attempt", () => {
  const original = run(), task = original.tasks[0]!, attempt = task.attempts[0]!
  task.status = "succeeded"; task.acceptedAttemptId = attempt.id; attempt.status = "succeeded"
  task.spec.role = "verifier"; task.spec.stage = "verification"; task.spec.checkIds = ["types"]
  original.plans = [{ revision: 2, tasks: [task.spec], criteria: [], rationale: "Final configured verification" }]
  const first = { id: "older", attemptId: attempt.id, taskId: task.spec.id, sessionId: "worker", callId: "call", checkId: "types", command: "bun run typecheck", criterionIds: ["types"], cwd: "/project", startedAt: 100, finishedAt: 200, exit: 0, outcome: "passed" as const, output: "Types passed", workspaceHash: "current" }
  attempt.checks = [first, { ...first, id: "newer", finishedAt: 300, exit: 1, outcome: "failed", output: "Types failed" }]
  expect(workflowView(original).tasks[0]!.checks.map(check => check.current)).toEqual([false, true])
})

test("a newer failed check supersedes an older pass across final verifier tasks", () => {
  const original = run(), first = original.tasks[0]!, attempt = first.attempts[0]!
  first.status = "succeeded"; first.acceptedAttemptId = attempt.id; attempt.status = "succeeded"
  first.spec.role = "verifier"; first.spec.stage = "verification"; first.spec.checkIds = ["types"]
  attempt.result = { summary: "Types passed" }
  attempt.checks = [{ id: "older-pass", attemptId: attempt.id, taskId: first.spec.id, sessionId: "worker", callId: "call", checkId: "types", command: "bun run typecheck", criterionIds: ["types"], cwd: "/project", startedAt: 100, finishedAt: 200, exit: 0, outcome: "passed", output: "Types passed", workspaceHash: "current" }]
  const second = structuredClone(first)
  second.spec.id = "second-verifier"; second.spec.title = "Verify again"; second.acceptedAttemptId = "second-attempt"
  const secondAttempt = second.attempts[0]!
  secondAttempt.id = "second-attempt"; secondAttempt.taskId = second.spec.id; secondAttempt.sessionId = "second-worker"
  secondAttempt.checks = [{ ...attempt.checks[0]!, id: "newer-fail", taskId: second.spec.id, attemptId: secondAttempt.id, sessionId: secondAttempt.sessionId, finishedAt: 300, exit: 1, outcome: "failed", output: "Types failed" }]
  original.tasks.push(second)
  original.plans = [{ revision: 2, tasks: [first.spec, second.spec], criteria: [], rationale: "Independent final verifiers" }]
  const current = workflowView(original).tasks.flatMap(task => task.checks).filter(check => check.current)
  expect(current.map(check => ({ id: check.id, outcome: check.outcome }))).toEqual([{ id: "newer-fail", outcome: "failed" }])
})

test("snapshots explain dependency and permission waits with unresolved findings and questions", () => {
  const original = run(), task = original.tasks[0]!, attempt = task.attempts[0]!
  task.status = "waiting_permission"; task.spec.dependencies = ["prepare"]
  original.tasks.push({ spec: { ...task.spec, id: "prepare", dependencies: [] }, status: "pending", attempts: [] })
  original.plans = [{ revision: 2, tasks: original.tasks.map(task => task.spec), criteria: [], rationale: "Current graph" }]
  task.acceptedAttemptId = attempt.id
  attempt.result = { summary: "A setting needs a decision", needsInput: "Which format?", findings: [
    { id: "open", description: "Invalid parser option", blocking: true },
    { id: "fixed", description: "Corrected parser", blocking: true, disposition: "fixed", evidence: "types passed" },
  ] }
  expect(workflowView(original).tasks[0]).toMatchObject({ waits: ["Permission approval", "prepare: pending"], blockers: [{ id: "open" }], question: "Which format?" })
  original.clarifications = [{ taskId: task.spec.id, question: "Which format?", answer: "JSON", at: 300 }]
  expect(workflowView(original).tasks[0]!.question).toBeUndefined()
})

test("previous repair graph findings do not remain live blockers while current discovery findings survive hash changes", () => {
  const original = run(), previous = original.tasks[0]!, previousAttempt = previous.attempts[0]!
  previous.status = "succeeded"; previous.acceptedAttemptId = previousAttempt.id; previousAttempt.status = "succeeded"
  previousAttempt.result = { summary: "Earlier review found a defect", findings: [{ id: "old-finding", description: "Earlier parser defect", blocking: true }] }
  const current = structuredClone(previous)
  current.spec.id = "discover-repair"; current.spec.role = "explorer"; current.spec.stage = "discovery"; current.acceptedAttemptId = "current-attempt"
  const currentAttempt = current.attempts[0]!
  currentAttempt.id = "current-attempt"; currentAttempt.taskId = current.spec.id; currentAttempt.workspaceHash = "before-writer"
  currentAttempt.result = { summary: "Current discovery found a contract defect", findings: [{ id: "current-finding", description: "Current contract defect", blocking: true }] }
  original.tasks.push(current); original.repairRound = 1
  original.plans = [{ revision: 1, tasks: [previous.spec], criteria: [], rationale: "Previous graph" }, { revision: 2, tasks: [previous.spec, current.spec], criteria: [], rationale: "Repair graph" }]
  const view = workflowView(original)
  expect(view.tasks[0]!.blockers).toEqual([])
  expect(view.tasks[1]!.blockers.map(finding => finding.id)).toEqual(["current-finding"])
  currentAttempt.result.findings![0]!.disposition = "fixed"; currentAttempt.result.findings![0]!.evidence = "Current verification passed"
  original.status = "succeeded"
  expect(workflowView(original).tasks.flatMap(task => task.blockers)).toEqual([])
})

test("display text is redacted and bounded with explicit omissions without changing saved state", () => {
  const original = run(), task = original.tasks[0]!, attempt = task.attempts[0]!
  original.objective = "Bearer sk-1234567890123456 " + "objective ".repeat(10_000)
  original.errors = Array.from({ length: 20 }, () => "error ".repeat(1000))
  task.acceptedAttemptId = attempt.id; attempt.result = { summary: "summary ".repeat(10_000) }
  const saved = structuredClone(original), view = workflowView(original)
  expect(view.objective.length).toBeLessThan(1600)
  expect(view.tasks[0]!.result!.summary.length).toBeLessThan(2100)
  expect(view.objective).toContain("omitted")
  expect(view.tasks[0]!.result!.summary).toContain("omitted")
  expect(JSON.stringify(view)).not.toContain("1234567890123456")
  expect(view.errors).toHaveLength(6)
  expect(view.omittedErrors).toBe(14)
  expect(original).toEqual(saved)
})

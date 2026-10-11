import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactStore, renderReport } from "../src/artifacts.ts"
import { parseConfig } from "../src/config.ts"
import type { Attempt, CheckEvidence, Run, Task, TaskResult } from "../src/types.ts"

test("artifacts are content addressed and exports disclose redactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ultra-artifacts-"))
  const store = new ArtifactStore(root)
  const one = await store.put({ summary: "facts", apiKey: "never-export", value: "Bearer sk-1234567890123456" })
  const two = await store.put({ summary: "facts", apiKey: "different-secret", value: "Bearer sk-9999999999999999" })
  expect(one).toBe(two)
  const contents = await readFile(one, "utf8")
  expect(contents).not.toContain("never-export")
  expect(contents).not.toContain("1234567890123456")
  expect(contents).toContain("redacted")
  await expect(store.write("../escape", "bad", {})).rejects.toThrow()
})

function evidence(id: string, workspaceHash: string, finishedAt: number, outcome: CheckEvidence["outcome"]): CheckEvidence {
  return { id, checkId: "unit", criterionIds: ["tests"], workspaceHash, finishedAt, startedAt: finishedAt - 1, exit: outcome === "passed" ? 0 : 1, outcome, attemptId: "attempt", taskId: "verify", sessionId: "session", callId: "call", command: "bun test", cwd: process.cwd(), output: "observed output" }
}

function task(id: string, workspaceHash: string, result: TaskResult, checks: CheckEvidence[] = []): Task {
  const attempt = { id: `${id}-attempt`, status: "succeeded", model: { ref: { providerID: "fixture", id: "model" }, requested: "fixture/model", origin: "captured" }, workspaceHash, checks, result } as Attempt
  return { spec: { id, title: id, role: id.includes("review") ? "reviewer" : id.includes("verify") ? "verifier" : "synthesizer", stage: id.includes("review") ? "review" : id.includes("verify") ? "verification" : "reporting", instructions: "", dependencies: [], writes: false }, status: "succeeded", acceptedAttemptId: attempt.id, attempts: [attempt] }
}

function run(tasks: Task[]): Run {
  return { id: "run-report", objective: "Fix cancellation", status: "partial", mode: "execute", phase: "execution", revision: 2, workspaceHash: "initial", candidateHash: "current", repairRound: 1, tasks, criteria: [{ id: "tests", description: "Real tests pass", required: true, kind: "check" }, { id: "request", description: "Cancellation works", required: true, kind: "assessment" }], config: parseConfig({ checks: [{ id: "unit", command: "bun test", criterionIds: ["tests"] }] }), errors: ["Earlier launch failed but was retried"] } as unknown as Run
}

test("report separates current latest evidence from older checks, assessments and findings", () => {
  const saved = run([
    task("review", "previous", { summary: "Old review", findings: [{ id: "old-blocker", description: "Old candidate fails cancellation", blocking: true }], assessments: [{ criterionId: "request", passed: true, explanation: "Old model claim" }] }),
    task("verify", "previous", { summary: "Old checks" }, [evidence("old-pass", "previous", 10, "passed")]),
    task("repair.review.1", "current", { summary: "Current independent review", assessments: [{ criterionId: "request", passed: true, explanation: "Current model assessment" }] }),
    task("repair.verify.1", "current", { summary: "Current checks" }, [evidence("superseded-pass", "current", 20, "passed"), evidence("latest-failure", "current", 30, "failed")]),
  ])
  const report = renderReport(saved)
  const historical = report.indexOf("## Historical evidence and findings")
  expect(historical).toBeGreaterThan(0)
  const coverage = report.slice(report.indexOf("## Acceptance coverage"), historical)
  expect(coverage).toContain("latest-failure")
  expect(coverage).toContain("failed")
  expect(coverage).toContain("Current model assessment")
  for (const value of ["old-pass", "superseded-pass", "Old model claim", "old-blocker"]) expect(coverage).not.toContain(value)
  for (const value of ["old-pass", "superseded-pass", "Old model claim", "old-blocker"]) expect(report.slice(historical)).toContain(value)
  expect(report).toContain("## Recorded diagnostics")
  expect(report).not.toContain("## Unresolved conditions")
})

test("report labels a superseded review finding historical even when a repair leaves source contents identical", () => {
  const saved = run([
    task("review", "current", { summary: "Earlier review", findings: [{ id: "superseded-blocker", description: "Original review allegation", blocking: true }] }),
    task("repair.review.1", "current", { summary: "Independent repair review", findings: [] }),
  ])
  const report = renderReport(saved)
  expect(report.slice(0, report.indexOf("## Historical evidence and findings"))).not.toContain("superseded-blocker")
  expect(report.slice(report.indexOf("## Historical evidence and findings"))).toContain("superseded-blocker")
})

test("report preserves earlier unaccepted attempts as history without promoting their evidence", () => {
  const current = task("repair.verify.1", "current", { summary: "Current checks" }, [evidence("accepted-pass", "current", 30, "passed")])
  const previous = { ...structuredClone(current.attempts[0]!), id: "rejected-attempt", status: "failed" as const, checks: [evidence("unaccepted-failure", "current", 20, "failed")], result: { summary: "Failed earlier attempt", findings: [{ id: "unaccepted-finding", description: "Earlier attempt failed", blocking: true }] } }
  current.attempts.unshift(previous)
  const report = renderReport(run([current]))
  const historical = report.indexOf("## Historical evidence and findings")
  expect(historical).toBeGreaterThan(0)
  expect(report.slice(0, historical)).toContain("accepted-pass")
  expect(report.slice(0, historical)).not.toContain("unaccepted-failure")
  expect(report.slice(historical)).toContain("unaccepted-failure")
  expect(report.slice(historical)).toContain("unaccepted-finding")
})

test("report includes a fresh final task's actual result with model attribution", () => {
  const saved = run([task("report", "current", { summary: "Cancellation now drains children before releasing capacity." })])
  saved.repairRound = 0
  const report = renderReport(saved)
  expect(report).toContain("Cancellation now drains children before releasing capacity.")
  expect(report).toContain("Model report")
})

test("refuses a symlinked artifact root without creating anything in its target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ultra-artifact-scope-"))
  const target = join(directory, "outside")
  const linkedRoot = join(directory, "linked")
  await mkdir(target)
  await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir")
  expect(() => new ArtifactStore(linkedRoot)).toThrow(/symlink|junction|plain|symbolic/i)
  expect(await readdir(target)).toEqual([])
})

test("refuses a runs junction introduced after construction without writing outside the root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ultra-artifact-scope-"))
  const target = join(directory, "outside")
  const root = join(directory, "root")
  await mkdir(target)
  const artifacts = new ArtifactStore(root)
  await symlink(target, join(root, "runs"), process.platform === "win32" ? "junction" : "dir")
  await expect(artifacts.write("run-scope", "state.json", { contents: "private" })).rejects.toThrow(/symlink|junction|plain|symbolic/i)
  expect(await readdir(target)).toEqual([])
  expect(existsSync(join(target, "run-scope"))).toBe(false)
})

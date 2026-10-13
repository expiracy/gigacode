import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Engine } from "../src/engine.ts"
import { parseConfig } from "../src/config.ts"
import { SQLiteStore } from "../src/store.ts"
import { FakeHost, invocation } from "./fake-host.ts"
import type { TaskSpec } from "../src/types.ts"

test("legacy runs cannot decrease their implicit context limit through a budget increase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ultra-legacy-context-")), store = new SQLiteStore(join(directory, "state.sqlite")), host = new FakeHost()
  const engine = new Engine(store, host, "project", directory, parseConfig({}))
  try {
    const run = await engine.start({ objective: "Inspect behavior", mode: "plan", parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, policy: [] })
    await engine.pause(run.id)
    store.mutate(run.id, value => { delete value.config.limits.contextChars })
    expect(() => engine.setBudget(run.id, { contextChars: 10_000 })).toThrow("only increase")
    expect(engine.setBudget(run.id, { contextChars: 80_000 }).config.limits.contextChars).toBe(80_000)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test("an insufficient mandatory context budget stops dispatch and can be explicitly increased", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ultra-context-budget-")), store = new SQLiteStore(join(directory, "state.sqlite")), host = new FakeHost()
  const config = parseConfig({ limits: { contextChars: 100 } }), engine = new Engine(store, host, "project", directory, config)
  try {
    const run = await engine.start({ objective: "Inspect stable ordering", mode: "plan", parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, policy: [] })
    engine.consumeStartIntent(run.id, run.intentId, "parent"); engine.bindSupervisor(run.id, run.intentId, "supervisor")
    await engine.tick(run.id, invocation())
    expect(engine.get(run.id)!.status).toBe("waiting_budget")
    expect(engine.get(run.id)!.errors.at(-1)).toContain("Mandatory task context")
    expect(engine.get(run.id)!.tasks[0]!.attempts).toHaveLength(0)
    expect(host.launches).toHaveLength(0)
    engine.setBudget(run.id, { contextChars: 64_000 })
    const resumed = await engine.resume(run.id)
    engine.consumeStartIntent(run.id, resumed.intentId, "parent"); engine.bindSupervisor(run.id, resumed.intentId, "supervisor-next")
    await engine.tick(run.id, invocation("supervisor-next"))
    expect(host.launches).toHaveLength(1)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test("a bound worker retrieves only its saved predecessor and leaves an attributable audit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ultra-dependency-")), store = new SQLiteStore(join(directory, "state.sqlite")), host = new FakeHost()
  const engine = new Engine(store, host, "project", directory, parseConfig({ limits: { contextChars: 12_000 } }))
  const source: TaskSpec = { id: "source", title: "Inspect", role: "explorer", stage: "discovery", instructions: "Inspect the code", dependencies: [], writes: false }
  const consumer: TaskSpec = { id: "consumer", title: "Reconcile", role: "planner", stage: "design", instructions: "Reconcile evidence", dependencies: ["source"], writes: false }
  try {
    const run = await engine.start({ objective: "Explain behavior", mode: "plan", parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, policy: [], workflow: { rationale: "Independent inspection then synthesis", tasks: [source, consumer] } })
    engine.consumeStartIntent(run.id, run.intentId, "parent"); engine.bindSupervisor(run.id, run.intentId, "supervisor")
    await engine.tick(run.id, invocation())
    const first = host.launches[0]!
    engine.submit(first.sessionId, { summary: "Source evidence", findings: [{ id: "long", description: "evidence ".repeat(10000), blocking: false }] })
    host.settle(first.sessionId)
    await engine.tick(run.id, invocation())
    const second = host.launches[1]!, saved = engine.get(run.id)!
    expect(saved.tasks[1]!.attempts[0]!.dependencyResults).toEqual([{ taskId: "source", attemptId: first.attempt.id, resultHash: saved.tasks[0]!.attempts[0]!.resultHash! }])
    const page = (engine as any).dependency(second.sessionId, "source", 0)
    expect(page.attemptId).toBe(first.attempt.id)
    expect(page.nextOffset).not.toBeNull()
    expect(() => (engine as any).dependency("parent", "source", 0)).toThrow("bound")
    expect(() => (engine as any).dependency(second.sessionId, "consumer", 0)).toThrow("captured dependency")
    expect(store.events("project", run.id).filter(event => event.kind === "dependency.retrieved").map(event => event.attemptId)).toEqual([second.attempt.id])
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

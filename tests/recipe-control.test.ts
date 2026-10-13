import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Engine } from "../src/engine.ts"
import { parseConfig } from "../src/config.ts"
import { SQLiteStore } from "../src/store.ts"
import { FakeHost, invocation } from "./fake-host.ts"

test("read-only review recipe completes a report without manufacturing an implementation proposal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ultra-recipe-")), store = new SQLiteStore(join(directory, "state.sqlite")), host = new FakeHost()
  const engine = new Engine(store, host, "project", directory, parseConfig({}))
  try {
    const options = { objective: "Review queue ordering", mode: "plan", parentSessionId: "parent", capturedModel: { providerID: "fixture", id: "test" }, policy: [], recipe: "deep-review" }
    const run = await engine.start(options as any)
    expect(run.recipe).toBe("deep-review")
    expect(run.tasks.filter(task => task.spec.role === "reviewer")).toHaveLength(2)
    engine.consumeStartIntent(run.id, run.intentId, "parent"); engine.bindSupervisor(run.id, run.intentId, "supervisor")
    for (let round = 0; round < 3; round++) {
      await engine.tick(run.id, invocation())
      for (const task of engine.get(run.id)!.tasks.filter(task => task.status === "running")) {
        const attempt = task.attempts.at(-1)!
        engine.submit(attempt.sessionId!, { summary: "The queue preserves insertion order", findings: [], assessments: [{ criterionId: "request", passed: true, explanation: "Inspected ordering and relevant callers" }] })
        host.settle(attempt.sessionId!)
      }
    }
    const report = engine.get(run.id)!
    expect(report.status).toBe("ready")
    expect(report.errors).toEqual([])
    expect(report.proposal).toBeUndefined()
    expect(report.tasks.every(task => !task.spec.writes)).toBe(true)
    await expect(engine.runSaved(run.id, report.revision)).rejects.toThrow()
    await expect(engine.start({ ...options, mode: "execute" } as any)).rejects.toThrow("plan")
    await expect(engine.start({ ...options, workflow: { rationale: "Conflicting graph", tasks: [] } } as any)).rejects.toThrow("combined")
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

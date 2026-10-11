import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { LeaseFenceError, SQLiteStore, StoreConflictError, sanitizeEventData } from "../src/store.ts"
import type { Run } from "../src/types.ts"

const fixtures: { directory: string; stores: SQLiteStore[] }[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ultra-store-test-"))
  const path = join(directory, "store.sqlite")
  const first = new SQLiteStore(path)
  const item = { directory, stores: [first] }
  fixtures.push(item)
  return { directory, path, first, connect: () => { const store = new SQLiteStore(path); item.stores.push(store); return store } }
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    for (const store of fixture.stores) store.close()
    const target = realpathSync(fixture.directory), part = relative(realpathSync(tmpdir()), target)
    if (part.startsWith("..") || !basename(target).startsWith("ultra-store-test-")) throw new Error("Unsafe fixture cleanup target")
    rmSync(target, { recursive: true, force: true })
  }
})

function run(id = "run-one", projectId = "project-one"): Run {
  return {
    id, projectId, directory: "/fixture", parentSessionId: "parent", intentId: "intent", intentExpiresAt: 10,
    objective: "Inspect the fixture", mode: "execute", status: "ready", phase: "execution", revision: 1,
    plans: [], tasks: [], criteria: [], capturedModel: { providerID: "fixture", id: "test" }, modelOptions: {},
    config: { models: {}, limits: { workers: 2, runs: 2, attempts: 2, repairRounds: 1, workerMs: 1_000, runMs: 10_000, elapsedMs: 20_000, steps: 4 }, checks: [], parallelWrites: false, autoThreshold: 1 },
    policy: [], workspaceHash: "hash", createdAt: 1, updatedAt: 1, activeMs: 0, repairRound: 0, continuation: 0,
    ownerEpoch: 0, generation: 0, errors: [], notifications: [],
  }
}

describe("SQLiteStore", () => {
  test("does not create SQLite files through a dangling runtime metadata junction", () => {
    const { directory } = fixture()
    const target = join(directory, "outside-target"), link = join(directory, "metadata")
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
    expect(() => {
      const opened = new SQLiteStore(join(link, "state.sqlite"))
      opened.close()
    }).toThrow(/symlink|junction/i)
    expect(existsSync(target)).toBe(false)
  })
  test("persists detached aggregates and filters projects across reopen", () => {
    const { first, connect } = fixture()
    const original = run()
    first.create(original)
    first.create(run("foreign", "project-two"))
    original.objective = "outside mutation"
    const loaded = first.get(original.id)!
    loaded.objective = "outside loaded mutation"
    expect(first.get(original.id)?.objective).toBe("Inspect the fixture")
    expect(first.list("project-one").map(value => value.id)).toEqual([original.id])
    expect(() => first.create(run())).toThrow(StoreConflictError)
    first.close()
    expect(connect().get(original.id)).toEqual(run())
  })

  test("increments only changed generations and commits safe change events", () => {
    const { first } = fixture()
    first.create(run())
    const initial = first.events("project-one").length
    expect(first.mutate("run-one", value => value.status)).toBe("ready")
    expect(first.get("run-one")?.generation).toBe(0)
    expect(first.events("project-one")).toHaveLength(initial)
    first.mutate("run-one", value => { value.status = "running"; value.objective = "apiKey=private-value" })
    expect(first.get("run-one")?.generation).toBe(1)
    const event = first.events("project-one").at(-1)!
    expect(event.kind).toBe("run.changed")
    expect(event.runId).toBe("run-one")
    expect(JSON.stringify(event.data)).toContain("objective")
    expect(JSON.stringify(event.data)).not.toContain("private-value")
  })

  test("rolls back all project aggregates and emitted events on callback failure", () => {
    const { first } = fixture()
    first.create(run())
    first.create(run("run-two"))
    const before = first.events("project-one")
    expect(() => first.project("project-one", runs => {
      runs[0]!.status = "failed"
      runs[1]!.status = "running"
      runs.push(run("new-run"))
      throw new Error("callback failed")
    })).toThrow("callback failed")
    expect(first.list("project-one").every(value => value.status === "ready")).toBe(true)
    expect(first.get("new-run")).toBeUndefined()
    expect(first.events("project-one")).toEqual(before)
  })

  test("atomically updates and admits aggregates within one project", () => {
    const { first, connect } = fixture()
    first.create(run())
    first.create(run("unchanged"))
    first.create(run("foreign", "project-two"))
    const lease = first.lease("project-one", "worker", Date.now(), 10_000)!
    first.project("project-one", runs => {
      runs[0]!.status = "running"
      runs.push(run("new"))
    }, lease)
    const second = connect()
    expect(second.get("run-one")?.generation).toBe(1)
    expect(second.get("new")?.generation).toBe(0)
    expect(second.get("unchanged")?.generation).toBe(0)
    expect(second.get("foreign")?.status).toBe("ready")
    expect(first.events("project-one").filter(value => value.kind === "run.changed")).toHaveLength(4)
  })

  test("rolls back already-written state and audit rows when a later admission conflicts", () => {
    const { first, connect } = fixture()
    first.create(run())
    first.create(run("foreign", "project-two"))
    const before = first.events("project-one")
    expect(() => first.project("project-one", values => {
      values[0]!.status = "failed"
      values.push(run("foreign"))
    })).toThrow(StoreConflictError)
    const second = connect()
    expect(second.get("run-one")).toEqual(run())
    expect(second.get("foreign")?.projectId).toBe("project-two")
    expect(second.events("project-one")).toEqual(before)
  })

  test("rejects aggregate identity, project, and optimistic generation rewrites without partial writes", () => {
    const { first } = fixture()
    first.create(run())
    const before = first.events("project-one")
    expect(() => first.mutate("run-one", value => { value.id = "renamed" })).toThrow(StoreConflictError)
    expect(() => first.mutate("run-one", value => { value.generation = 17 })).toThrow(StoreConflictError)
    expect(() => first.project("project-one", values => { values[0]!.projectId = "project-two" })).toThrow(StoreConflictError)
    expect(() => first.project("project-one", values => { values.push(run("foreign", "project-two")) })).toThrow(StoreConflictError)
    expect(() => first.project("project-one", values => { values.pop() })).toThrow(StoreConflictError)
    expect(first.get("run-one")).toEqual(run())
    expect(first.events("project-one")).toEqual(before)
  })

  test("serializes two connections and refuses nested admission during a write transaction", () => {
    const { first, connect } = fixture()
    const second = connect()
    first.create(run())
    first.mutate("run-one", value => { value.revision += 1 })
    second.mutate("run-one", value => { value.revision += 1 })
    expect(first.get("run-one")?.revision).toBe(3)
    expect(second.get("run-one")?.generation).toBe(2)
    expect(() => first.project("project-one", values => {
      values[0]!.status = "running"
      second.mutate("run-one", value => { value.status = "failed" })
    })).toThrow()
    expect(first.get("run-one")?.status).toBe("ready")
    expect(first.get("run-one")?.generation).toBe(2)
  })

  test("racing independent processes acquire one lease and preserve every aggregate update", async () => {
    const { first, directory, path } = fixture()
    first.create(run())
    const start = join(directory, "start")
    const module = pathToFileURL(resolve("src/store.ts")).href
    const children = ["first", "second"].map(owner => {
      const ready = join(directory, owner + ".ready")
      const code = `
        import { SQLiteStore } from ${JSON.stringify(module)};
        import { existsSync, writeFileSync } from "node:fs";
        const store = new SQLiteStore(${JSON.stringify(path)});
        writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!existsSync(${JSON.stringify(start)})) await Bun.sleep(5);
        const lease = store.lease("project-one", ${JSON.stringify(owner)}, Date.now(), 5000);
        for (let index = 0; index < 25; index++) {
          store.mutate("run-one", value => { value.revision += 1 });
        }
        store.close();
        console.log(JSON.stringify({ lease }));
      `
      return { ready, process: Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10_000 }) }
    })
    try {
      const deadline = Date.now() + 5_000
      while (!children.every(child => existsSync(child.ready)) && Date.now() < deadline) await Bun.sleep(5)
      expect(children.every(child => existsSync(child.ready))).toBe(true)
      writeFileSync(start, "start")
      const results = await Promise.all(children.map(async child => ({
        exit: await child.process.exited,
        output: await new Response(child.process.stdout).text(),
        error: await new Response(child.process.stderr).text(),
      })))
      for (const result of results) { expect(result.error).toBe(""); expect(result.exit).toBe(0) }
      expect(results.filter(result => JSON.parse(result.output).lease)).toHaveLength(1)
      expect(first.get("run-one")?.revision).toBe(51)
      expect(first.get("run-one")?.generation).toBe(50)
      expect(first.events("project-one", "run-one")).toHaveLength(51)
    } finally {
      for (const child of children) if (child.process.exitCode === null) child.process.kill()
      await Promise.all(children.map(child => child.process.exited))
    }
  })

  test("fences stale owners after lease takeover and keeps epochs monotonic after release", () => {
    const { first, connect } = fixture()
    const second = connect()
    first.create(run())
    const now = Date.now()
    const old = first.lease("project-one", "first", now, 1_000)!
    expect(second.lease("project-one", "second", now, 1_000)).toBeUndefined()
    const renewed = second.lease("project-one", "first", now + 1, 1_000)!
    expect(renewed.epoch).toBe(old.epoch)
    const replacement = second.lease("project-one", "second", now + 1_001, 5_000)!
    expect(replacement.epoch).toBe(old.epoch + 1)
    expect(() => first.mutate("run-one", value => { value.status = "failed" }, old)).toThrow(LeaseFenceError)
    expect(() => first.renew(old, now + 1_002, 5_000)).toThrow(LeaseFenceError)
    first.release(old)
    second.mutate("run-one", value => { value.status = "running" }, replacement)
    second.release(replacement)
    const next = first.lease("project-one", "third", now + 1_003, 5_000)!
    expect(next.epoch).toBe(replacement.epoch + 1)
  })

  test("checks actual lease expiry and project before allowing aggregate writes", () => {
    const { first } = fixture()
    first.create(run())
    const expired = first.lease("project-one", "first", Date.now() - 10_000, 1)!
    expect(() => first.mutate("run-one", value => { value.status = "failed" }, expired)).toThrow(LeaseFenceError)
    const foreign = first.lease("project-two", "first", Date.now(), 10_000)!
    expect(() => first.project("project-one", values => { values[0]!.status = "failed" }, foreign)).toThrow(LeaseFenceError)
    expect(first.get("run-one")?.status).toBe("ready")
  })

  test("rechecks fences at commit when the callback outlives its lease", () => {
    const { first } = fixture()
    first.create(run())
    const lease = first.lease("project-one", "first", Date.now(), 25)!
    const before = first.events("project-one")
    expect(() => first.mutate("run-one", value => {
      value.status = "failed"
      const until = Date.now() + 35
      while (Date.now() < until) { /* exercise lease expiry inside a synchronous callback */ }
    }, lease)).toThrow(LeaseFenceError)
    expect(first.get("run-one")?.status).toBe("ready")
    expect(first.events("project-one")).toEqual(before)
  })

  test("deduplicates events durably while filtering projects, runs, and sequence cursors", () => {
    const { first, connect } = fixture()
    const input = { id: "native-one", kind: "worker.done", runId: "run-one", data: { answer: 42 } }
    expect(first.event("project-one", input)).toBe(true)
    expect(connect().event("project-one", input)).toBe(false)
    expect(first.event("project-two", input)).toBe(true)
    first.event("project-one", { id: "native-two", kind: "worker.done", runId: "run-two" })
    const cursor = first.events("project-one", "run-one")[0]!.seq
    expect(first.events("project-one", "run-one", cursor)).toEqual([])
    expect(first.events("project-one", undefined, cursor).map(value => value.id)).toEqual(["native-two"])
    expect(first.events("project-two")).toHaveLength(1)
    first.close()
    expect(connect().event("project-one", input)).toBe(false)
  })

  test("redacts nested event credentials and recognizable credentials in strings without mutating inputs", () => {
    const { first } = fixture()
    const data = { apiKey: "private-key", nested: { authorization: "Bearer private-token", password: "private-password" }, environment: { OPENAI_API_KEY: "environment-private", OPENCODE_PASSWORD: "host-private" }, message: "Authorization: Bearer top-secret\napi_key=hidden-value\n{\"apiKey\":\"json-private\"}\nhttps://user:url-private@example.invalid", tokens: 12 }
    first.event("project-one", { kind: "worker.output", data })
    const saved = JSON.stringify(first.events("project-one")[0]!.data)
    for (const secret of ["private-key", "private-token", "private-password", "top-secret", "hidden-value", "environment-private", "host-private", "json-private", "url-private"]) expect(saved).not.toContain(secret)
    expect(saved).toContain("[REDACTED]")
    expect(first.events("project-one")[0]!.data).toMatchObject({ tokens: 12 })
    expect(data.apiKey).toBe("private-key")
    expect(sanitizeEventData({ access_token: "secret", ordinary: "safe" })).toEqual({ access_token: "[REDACTED]", ordinary: "safe" })
  })

  test("rejects asynchronous callbacks without committing aggregate changes", () => {
    const { first } = fixture()
    first.create(run())
    expect(() => first.mutate("run-one", async value => { value.status = "failed" })).toThrow(StoreConflictError)
    expect(first.get("run-one")?.status).toBe("ready")
  })
})

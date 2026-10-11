import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import { tmpdir } from "node:os"
import { Schema, SchemaRepresentation } from "effect"
import plugin from "../src/plugin.ts"
import { UltraRpc } from "../src/rpc.ts"
import { SQLiteStore } from "../src/store.ts"
import { promptVersion } from "../src/workflow.ts"

const fixtures: { directory: string; events: { mockRestore(): void }; close: { mockRestore(): void }; readonly store: SQLiteStore | undefined }[] = []
function fixture(options: { failRegistration?: string; failDisposal?: string; failFeedback?: boolean; configuration?: unknown } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ultra-plugin-")))
  const commands = new Map<string, any>(), hooks = new Map<string, any>(), disposals: string[] = []
  const feedback: { name: string; data: any }[] = [], synthetics: unknown[] = []
  const rpcEvents = { async emit(name: string, data: unknown) { if (options.failFeedback) throw new Error("Client feedback unavailable"); feedback.push({ name, data }) } }
  let store: SQLiteStore | undefined
  const originalEvents = SQLiteStore.prototype.events
  const events = spyOn(SQLiteStore.prototype, "events").mockImplementation(function (this: SQLiteStore, ...args) {
    store ??= this
    return originalEvents.apply(this, args)
  })
  const close = spyOn(SQLiteStore.prototype, "close")
  const register = async (name: string, callback?: unknown) => {
    if (options.failRegistration === name) throw new Error(`Registration failed: ${name}`)
    if (callback) hooks.set(name, callback)
    return { async dispose() { disposals.push(name); if (options.failDisposal === name) throw new Error(`Disposal failed: ${name}`) } }
  }
  const context = {
    app: { version: "2.0.25" },
    location: { directory, project: { id: "project", directory } },
    options: options.configuration ?? { checks: [] },
    command: { async transform(callback: any) { callback({ add(command: any) { commands.set(command.name, command) } }); return register("command") } },
    tool: { async transform(callback: any) { callback({ add() {} }); return register("tools") }, async hook(name: string, callback: unknown) { return register(`tool.${name}`, callback) } },
    permission: { async hook(name: string, callback: unknown) { return register(`permission.${name}`, callback) } },
    session: {
      async hook(name: string, callback: unknown) { return register(`session.${name}`, callback) },
      async get({ sessionID }: any) { return { id: sessionID, projectID: "project", location: { directory }, agent: "build", permissions: [], model: { providerID: "fixture", id: "test" } } },
      async synthetic(input: unknown) { synthetics.push(input) },
    },
    agent: { async transform(callback: any) { callback({ update() {} }); return register("agents") }, async list() { return { data: [{ id: "build", mode: "primary", permissions: [] }, { id: "ultra-supervisor" }, { id: "ultra-worker" }] } } },
    model: { async list() { return { data: [{ providerID: "fixture", id: "test", variants: [], capabilities: { tools: true } }] } } },
    rpc: { async register(_contract: unknown, handlers: unknown) { return { ...await register("rpc", handlers), events: rpcEvents } } },
    event: { subscribe({ signal }: { signal: AbortSignal }) { return { async *[Symbol.asyncIterator]() { if (!signal.aborted) await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true })) } } } },
  }
  const value = { directory, context, commands, hooks, disposals, close, events, feedback, synthetics, rpcEvents, get store() { return store } }
  fixtures.push(value)
  return value
}

afterEach(() => {
  for (const value of fixtures.splice(0).reverse()) {
    value.events.mockRestore(); value.close.mockRestore(); value.store?.close()
    const root = realpathSync(tmpdir()), target = realpathSync(value.directory), child = relative(root, target)
    if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..\\`) || child.startsWith("../") || !basename(target).startsWith("ultra-plugin-")) throw new Error("Unsafe plugin test cleanup target")
    rmSync(target, { recursive: true, force: true })
  }
})

describe("plugin lifecycle", () => {
  test.each(["2.0.25", "2.0.26"])("reports the actual supported host %s through config and command feedback", async version => {
    const value = fixture()
    value.context.app.version = version
    const cleanup = await plugin.setup(value.context as any)
    try {
      const handlers = value.hooks.get("rpc")
      expect((await handlers.config({})).hostVersion).toBe(version)
      expect((await handlers.control({ text: "config", sessionId: "parent" })).hostVersion).toBe(version)
      await value.commands.get("ultracode").execute({ sessionID: "parent", prompt: { text: "config" } })
      expect(value.feedback[0]!.data.result.hostVersion).toBe(version)
    } finally { await cleanup!() }
  })

  test.each(["2.0.24", "2.0.27", "2.1.0"])("rejects unverified host %s before creating state or registrations", async version => {
    const value = fixture()
    value.context.app.version = version
    await expect(plugin.setup(value.context as any)).rejects.toThrow("requires tested OpenCode")
    expect(existsSync(join(value.directory, ".ultracode"))).toBe(false)
    expect(value.commands.size).toBe(0)
    expect(value.disposals).toEqual([])
  })

  test("command feedback schema compiles with the host validator and admits one result or error", () => {
    const schema = SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema: UltraRpc.events.commandResult.schema, definitions: {} })
    const decode = Schema.decodeUnknownSync(Schema.toType(schema))
    const base = { sessionId: "parent", command: "config" }
    for (const value of [{ ...base, result: { config: {} } }, { ...base, error: "Unknown command" }]) expect(decode(value)).toEqual(value)
    for (const value of [base, { ...base, result: {}, error: "Ambiguous" }, { ...base, error: "" }]) expect(() => decode(value)).toThrow()
    expect(decode({ ...base, result: {}, extra: true })).toEqual({ ...base, result: {} })
  })

  test("invalid configuration fails before creating project state", async () => {
    const value = fixture({ configuration: { unknown: true } })
    await expect(plugin.setup(value.context as any)).rejects.toThrow("Unknown configuration field")
    expect(existsSync(join(value.directory, ".ultracode"))).toBe(false)
    expect(value.disposals).toEqual([])
    expect(value.close).not.toHaveBeenCalled()
  })

  test("setup failure disposes completed registrations and closes state even if one disposal fails", async () => {
    const value = fixture({ failRegistration: "permission.evaluate", failDisposal: "tools" })
    await expect(plugin.setup(value.context as any)).rejects.toThrow("Registration failed: permission.evaluate")
    expect(value.disposals).toEqual(["tools", "command", "agents"])
    expect(value.close).toHaveBeenCalledTimes(1)
    expect(() => value.store!.list("project")).toThrow(/closed/i)
  })

  test("shutdown is idempotent and drains all resources despite a failed disposer", async () => {
    const value = fixture({ failDisposal: "rpc" })
    const cleanup = await plugin.setup(value.context as any)
    expect(typeof cleanup).toBe("function")
    const first = Promise.resolve(cleanup!()), second = Promise.resolve(cleanup!())
    const results = await Promise.allSettled([first, second])
    expect(results.every(result => result.status === "rejected")).toBe(true)
    expect(value.disposals).toEqual(["rpc", "tool.execute.after", "tool.execute.before", "session.prompt", "session.model.request", "session.context", "permission.evaluate", "tools", "command", "agents"])
    expect(value.close).toHaveBeenCalledTimes(1)
    expect(() => value.store!.list("project")).toThrow(/closed/i)
  })

  test("shutdown refuses bound workflow activity while preserving unrelated session requests", async () => {
    const value = fixture()
    const cleanup = await plugin.setup(value.context as any)
    const rpc = value.hooks.get("rpc")
    const result = await rpc.control({ text: "plan Inspect this project", sessionId: "parent" })
    await rpc.control({ text: "on", sessionId: "auto" })
    value.store!.mutate(result.run.id, run => { run.supervisorSessionId = "bound" })
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(done => { release = done }), entry = new Promise<void>(done => { entered = done })
    value.rpcEvents.emit = async () => { entered(); await held }
    const active = value.commands.get("ultracode").execute({ sessionID: "parent", prompt: { text: "config" } })
    let draining: Promise<void> | undefined
    try {
      await Promise.race([entry, active.then(() => { throw new Error("Command completed without emitting UI feedback") })])
      draining = Promise.resolve(cleanup!())
      const unrelated = { sessionID: "other", action: "read", resources: ["file.txt"], effect: "allow" }
      const bound = { sessionID: "bound", action: "read", resources: ["file.txt"], effect: "allow" }
      await value.hooks.get("permission.evaluate")(unrelated)
      await value.hooks.get("permission.evaluate")(bound)
      expect(unrelated.effect).toBe("allow")
      expect(bound.effect).toBe("deny")
      const context = { sessionID: "other", tools: { read: {}, ultra_start: {}, ultra_execute: {}, ultra_submit: {}, ultra_check: {} } }
      const prompt = { sessionID: "other", prompt: { text: "Help me with ordinary project work. ".repeat(4) } }
      const modelRequest = { sessionID: "other", kind: "primary", model: { providerID: "fixture", id: "test" } }
      const requests = await Promise.allSettled([
        Promise.resolve().then(() => value.hooks.get("session.model.request")(modelRequest)),
        Promise.resolve().then(() => value.hooks.get("session.context")(context)),
        Promise.resolve().then(() => value.hooks.get("session.prompt")(prompt)),
      ])
      expect(requests.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
      expect(Object.keys(context.tools)).toEqual(["read", "ultra_start"])
      expect(prompt.prompt.text).toBe("Help me with ordinary project work. ".repeat(4))
      const workerRequests = await Promise.allSettled([
        Promise.resolve().then(() => value.hooks.get("session.model.request")({ ...modelRequest, sessionID: "bound" })),
        Promise.resolve().then(() => value.hooks.get("session.context")({ ...context, sessionID: "bound" })),
        Promise.resolve().then(() => value.hooks.get("session.prompt")({ ...prompt, sessionID: "bound" })),
        Promise.resolve().then(() => value.hooks.get("session.prompt")({ ...prompt, sessionID: "auto" })),
      ])
      expect(workerRequests.map(result => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"])
      expect(value.close).not.toHaveBeenCalled()
    } finally { release(); await active; await (draining ?? cleanup!()) }
    expect(value.close).toHaveBeenCalledTimes(1)
  })

  test("configuration reports the version of the prompts used by the workflow", async () => {
    const value = fixture()
    const cleanup = await plugin.setup(value.context as any)
    try {
      const result = await value.hooks.get("rpc").control({ text: "config", sessionId: "parent" })
      expect(result.promptVersion).toBe(promptVersion)
      expect((await value.hooks.get("rpc").config({})).promptVersion).toBe(promptVersion)
    } finally { await cleanup!() }
  })

  test("native config commands emit deterministic UI feedback without queuing model input", async () => {
    const value = fixture()
    const cleanup = await plugin.setup(value.context as any)
    try {
      await value.commands.get("ultracode").execute({ sessionID: "parent", prompt: { text: "config" } })
      expect(value.feedback).toHaveLength(1)
      expect(value.feedback[0]).toMatchObject({ name: "commandResult", data: { sessionId: "parent", command: "config", result: { promptVersion } } })
      expect(value.feedback[0]!.data.error).toBeUndefined()
      expect(value.synthetics).toEqual([])
      expect(value.store!.list("project")).toEqual([])
    } finally { await cleanup!() }
  })

  test("native command errors emit UI feedback and preserve command failure without creating a run", async () => {
    const value = fixture()
    const cleanup = await plugin.setup(value.context as any)
    try {
      await expect(value.commands.get("ultracode").execute({ sessionID: "parent", prompt: { text: "unknown-verb" } })).rejects.toThrow("Unknown ultracode command")
      expect(value.feedback).toHaveLength(1)
      expect(value.feedback[0]).toMatchObject({ name: "commandResult", data: { sessionId: "parent", command: "unknown-verb", error: expect.stringContaining("Unknown ultracode command") } })
      expect(value.feedback[0]!.data.result).toBeUndefined()
      expect(value.synthetics).toEqual([])
      expect(value.store!.list("project")).toEqual([])
    } finally { await cleanup!() }
  })

  test("a failed UI delivery cannot fail or duplicate a completed command mutation", async () => {
    const value = fixture({ failFeedback: true })
    const cleanup = await plugin.setup(value.context as any)
    try {
      await expect(value.commands.get("ultracode").execute({ sessionID: "parent", prompt: { text: "on" } })).resolves.toBeUndefined()
      const events = value.store!.events("project")
      expect(events.filter(event => event.kind === "session.auto")).toHaveLength(1)
      expect(events.find(event => event.kind === "session.auto")!.data).toEqual({ sessionId: "parent", enabled: true })
      expect(events.find(event => event.kind === "command.feedback.failed")!.data).toMatchObject({ sessionId: "parent", command: "on", error: expect.stringContaining("Client feedback unavailable") })
      expect(value.synthetics).toEqual([])
    } finally { await cleanup!() }
  })

  test("missing agent diagnostics direct the user to global installation", async () => {
    const value = fixture()
    value.context.agent.list = async () => ({ data: [] })
    const cleanup = await plugin.setup(value.context as any)
    try { await expect(value.hooks.get("rpc").control({ text: "plan Inspect this project", sessionId: "parent" })).rejects.toThrow("bun run install:global") }
    finally { await cleanup!() }
  })
})

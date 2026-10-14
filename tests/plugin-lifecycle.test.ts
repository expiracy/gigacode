import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
    location: { directory, project: { id: "project", directory, canonical: directory } },
    options: options.configuration ?? { checks: [] },
    plugin: { async list() { return { data: [{ id: "ultra.open-code", source: { type: "local", path: directory } }] } } },
    command: { async transform(callback: any) { callback({ add(command: any) { commands.set(command.name, command) } }); return register("command") } },
    tool: { async transform(callback: any) { callback({ add() {} }); return register("tools") }, async hook(name: string, callback: unknown) { return register(`tool.${name}`, callback) } },
    permission: { async hook(name: string, callback: unknown) { return register(`permission.${name}`, callback) } },
    shell: { async hook(name: string, callback: unknown) { return register(`shell.${name}`, callback) } },
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
  test("advanced reset RPC is explicit, and new runs capture the saved advanced defaults", async () => {
    const value = fixture({ configuration: { prompts: { reviewer: "Inherited review" }, autoThreshold: 90, checks: [] } })
    writeFileSync(join(value.directory, "ultracode.json"), '{"prompts":{"reviewer":"Project review"},"parallelWrites":true,"autoThreshold":120}')
    const cleanup = await plugin.setup(value.context as any)
    try {
      const rpc = value.hooks.get("rpc"), before = await rpc.settings({ sessionId: "parent" })
      const saved = await rpc.saveSettings({ sessionId: "parent", revision: before.revision, replaceAdvanced: true, options: { autoThreshold: 150 } })
      expect(saved.effective.prompts.reviewer).toBe("Inherited review")
      expect(saved.effective.parallelWrites).toBe(false)
      expect(saved.effective.autoThreshold).toBe(150)
      const admitted = await rpc.control({ text: "plan Inspect advanced settings", sessionId: "parent" })
      expect(value.store!.get(admitted.run.id)!.config.autoThreshold).toBe(150)
      expect(value.store!.get(admitted.run.id)!.config.prompts?.reviewer).toBe("Inherited review")
    } finally { await cleanup!() }
  })
  test("global guided RPC edits the active shared profile without changing project overrides", async () => {
    const value = fixture({ configuration: { limits: { workers: 2 }, checks: [] } })
    const profile = join(value.directory, "profile.json")
    writeFileSync(profile, JSON.stringify({ plugins: [{ package: value.directory, options: { limits: { workers: 2 } } }] }))
    writeFileSync(join(value.directory, "ultracode.json"), '{"limits":{"workers":1}}')
    const previous = process.env.OPENCODE_CONFIG
    process.env.OPENCODE_CONFIG = profile
    let cleanup: Awaited<ReturnType<typeof plugin.setup>>
    try { cleanup = await plugin.setup(value.context as any) }
    finally { if (previous === undefined) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = previous }
    try {
      const rpc = value.hooks.get("rpc")
      const before = await rpc.settings({ sessionId: "parent", scope: "global" })
      expect(before.path).toBe(profile)
      expect(before.effective.limits.workers).toBe(2)
      const saved = await rpc.saveSettings({ sessionId: "parent", scope: "global", revision: before.revision, options: { limits: { workers: 3 } } })
      expect(saved.scope).toBe("global")
      expect(saved.reloadRequired).toBe(true)
      expect(JSON.parse(readFileSync(profile, "utf8")).plugins[0].options.limits.workers).toBe(3)
      expect(JSON.parse(readFileSync(join(value.directory, "ultracode.json"), "utf8"))).toEqual({ limits: { workers: 1 } })
      expect((await rpc.config({})).config.limits.workers).toBe(1)
    } finally { await cleanup!() }
  })
  test("guided settings RPC omits absent values so native JSON validation accepts the snapshot", async () => {
    const value = fixture(), cleanup = await plugin.setup(value.context as any)
    try {
      const settings = await value.hooks.get("rpc").settings({ sessionId: "parent" })
      expect(Object.hasOwn(settings, "blocked")).toBe(false)
      expect(JSON.parse(JSON.stringify(settings))).toEqual(settings)
    } finally { await cleanup!() }
  })
  test("guided model choices include enabled beta models and omit disabled or tool-less entries", async () => {
    const value = fixture()
    value.context.model.list = async () => ({ data: [
      { providerID: "fixture", id: "beta", enabled: true, status: "beta", variants: [], capabilities: { tools: true } },
      { providerID: "fixture", id: "disabled", enabled: false, status: "active", variants: [], capabilities: { tools: true } },
      { providerID: "fixture", id: "no-tools", enabled: true, status: "active", variants: [], capabilities: { tools: false } },
    ] })
    const cleanup = await plugin.setup(value.context as any)
    try { expect((await value.hooks.get("rpc").settings({ sessionId: "parent" })).models.map((model: any) => model.id)).toEqual(["beta"]) }
    finally { await cleanup!() }
  })
  test("cancelled guided RPC requests cannot save project settings", async () => {
    const value = fixture(), cleanup = await plugin.setup(value.context as any)
    try {
      const rpc = value.hooks.get("rpc"), settings = await rpc.settings({ sessionId: "parent" })
      const controller = new AbortController(); controller.abort()
      await expect(rpc.saveSettings({ sessionId: "parent", revision: settings.revision, options: { limits: { workers: 1 } } }, { signal: controller.signal })).rejects.toThrow()
      expect(existsSync(settings.path)).toBe(false)
      expect((await rpc.config({})).config.limits.workers).toBe(4)
    } finally { await cleanup!() }
  })
  test("guided settings RPC saves project values and applies them to future admissions", async () => {
    const value = fixture(), cleanup = await plugin.setup(value.context as any)
    try {
      const rpc = value.hooks.get("rpc")
      const settings = await rpc.settings({ sessionId: "parent" })
      expect(settings.models).toEqual([expect.objectContaining({ providerID: "fixture", id: "test", variants: [] })])
      expect(settings.effective.limits.workers).toBe(4)
      await rpc.saveSettings({ sessionId: "parent", revision: settings.revision, options: { limits: { workers: 1 }, checks: [] } })
      expect(JSON.parse(readFileSync(join(value.directory, "ultracode.json"), "utf8"))).toEqual({ limits: { workers: 1 }, checks: [] })
      expect((await rpc.config({})).config.limits.workers).toBe(1)
      const admitted = await rpc.control({ text: "plan Inspect this project", sessionId: "parent" })
      expect(value.store!.get(admitted.run.id)!.config.limits.workers).toBe(1)
    } finally { await cleanup!() }
  })
  test("guided settings refuse writes while a workflow owns the project and preserve its captured config", async () => {
    const value = fixture(), cleanup = await plugin.setup(value.context as any)
    try {
      const rpc = value.hooks.get("rpc"), settings = await rpc.settings({ sessionId: "parent" })
      const admitted = await rpc.control({ text: "plan Inspect this project", sessionId: "parent" })
      expect((await rpc.settings({ sessionId: "parent" })).blocked).toContain("active workflows")
      await expect(rpc.saveSettings({ sessionId: "parent", revision: settings.revision, options: { limits: { workers: 1 } } })).rejects.toThrow("active workflows")
      expect(existsSync(settings.path)).toBe(false)
      expect(value.store!.get(admitted.run.id)!.config.limits.workers).toBe(4)
    } finally { await cleanup!() }
  })
  test("a child session cannot use the guided settings read or write endpoint", async () => {
    const value = fixture(), cleanup = await plugin.setup(value.context as any)
    try {
      const rpc = value.hooks.get("rpc"), get = value.context.session.get
      value.context.session.get = async input => ({ ...await get(input), parentID: "parent" })
      await expect(rpc.settings({ sessionId: "child" })).rejects.toThrow("initiating primary")
      await expect(rpc.saveSettings({ sessionId: "child", revision: "revision", options: { checks: [] } })).rejects.toThrow("initiating primary")
      expect(existsSync(join(value.directory, "ultracode.json"))).toBe(false)
    } finally { await cleanup!() }
  })
  test("bound worker context advertises only the result fields its role can submit", async () => {
    const value = fixture(), cleanup = await plugin.setup(value.context as any)
    try {
      const admitted = await value.hooks.get("rpc").control({ text: "plan Inspect behavior", sessionId: "parent" })
      value.store!.mutate(admitted.run.id, run => {
        run.criteria = [
          { id: "request", description: "Requested behavior", required: true, kind: "assessment" },
          { id: "compatibility", description: "Existing interfaces", required: false, kind: "assessment" },
          { id: "verification", description: "Native checks", required: true, kind: "check" },
        ]
        run.tasks[0]!.attempts.push({ id: "attempt", taskId: run.tasks[0]!.spec.id, number: 1, status: "running", ownerEpoch: 1, sessionId: "worker", inputHash: "inputs", prompt: "Task", model: { requested: "inherit", ref: { providerID: "fixture", id: "test" }, origin: "captured" }, createdAt: Date.now(), workspaceHash: "snapshot", checks: [], steps: 0 })
      })
      for (const role of ["planner", "reviewer", "verifier", "implementer", "synthesizer"] as const) {
        value.store!.mutate(admitted.run.id, run => { run.tasks[0]!.spec.role = role })
        const original = { ultra_submit: { name: "ultra_submit", input: { original: true } }, shell: { name: "shell" } }
        const event = { sessionID: "worker", tools: original, system: [], messages: [] }
        await value.hooks.get("session.context")(event)
        expect(JSON.stringify(event.tools.ultra_submit.input).includes('"proposal"')).toBe(["planner", "synthesizer"].includes(role))
        const properties = (event.tools.ultra_submit.input as any).properties.result.properties
        for (const field of ["summary", "findings", "artifacts", "needsInput"]) expect(properties).toHaveProperty(field)
        if (role === "implementer") expect(properties.assessments).toBeUndefined()
        else expect(properties.assessments.items.properties.criterionId.enum).toEqual(["request", "compatibility"])
        expect(properties.needsInput.description).toContain("never submit an empty string")
        expect(event.tools.ultra_submit.name).toBe("ultra_submit")
        expect(original.ultra_submit.input).toEqual({ original: true })
        expect(event.tools).not.toHaveProperty("shell")
      }
      value.store!.mutate(admitted.run.id, run => { run.criteria = run.criteria.filter(criterion => criterion.kind === "check") })
      const event = { sessionID: "worker", tools: { ultra_submit: { input: {} } }, system: [], messages: [] }
      await value.hooks.get("session.context")(event)
      expect((event.tools.ultra_submit.input as any).properties.result.properties.assessments).toBeUndefined()
    } finally { await cleanup!() }
  })
  test("registers the native preparation environment guard without changing unrelated shell calls", async () => {
    const value = fixture(), cleanup = await plugin.setup(value.context as any)
    try {
      expect(value.hooks.has("shell.create.before")).toBe(true)
      const event = { command: "echo unrelated", cwd: value.directory, env: { GIT_DIR: "unchanged" }, timeout: 1000, shell: "sh" }
      await value.hooks.get("shell.create.before")(event)
      expect(event.env.GIT_DIR).toBe("unchanged")
    } finally { await cleanup!() }
  })
  test("worktree locations share state at the host's canonical project root", async () => {
    const source = fixture(), cleanupSource = await plugin.setup(source.context as any)
    let cleanupDestination: (() => void | Promise<void>) | void = undefined
    try {
      const admitted = await source.hooks.get("rpc").control({ text: "plan Inspect the canonical project", sessionId: "parent" })
      const destination = mkdtempSync(join(source.directory, "destination-"))
      const context = { ...source.context, location: { directory: destination, project: { id: "project", directory: destination, canonical: source.directory } } }
      cleanupDestination = await plugin.setup(context as any)
      expect((await source.hooks.get("rpc").status({})).runs.map((run: any) => run.id)).toEqual([admitted.run.id])
      expect(existsSync(join(destination, ".ultracode", "state.sqlite"))).toBe(false)
    } finally { await cleanupDestination?.(); await cleanupSource!() }
  })
  test("explicit native recipe commands preserve their read-only graph and original objective", async () => {
    const value = fixture()
    const cleanup = await plugin.setup(value.context as any)
    try {
      const admitted = await value.hooks.get("rpc").control({ text: "plan --recipe deep-review Review queue ordering", sessionId: "parent" })
      const run = value.store!.get(admitted.run.id)!
      expect(run.recipe).toBe("deep-review")
      expect(run.objective).toBe("Review queue ordering")
      expect(run.tasks.filter(task => task.spec.role === "reviewer")).toHaveLength(2)
      expect(run.tasks.every(task => !task.spec.writes)).toBe(true)
    } finally { await cleanup!() }
  })
  test("shutdown drains an in-flight workflow snapshot before closing its state", async () => {
    const value = fixture()
    const cleanup = await plugin.setup(value.context as any)
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>(done => { release = done }), entry = new Promise<void>(done => { entered = done })
    const original = value.context.session.get
    value.context.session.get = async input => { entered(); await hold; return original(input) }
    const request = value.hooks.get("rpc").workflow({ sessionId: "parent" })
    await entry
    const draining = Promise.resolve(cleanup!())
    expect(value.close).not.toHaveBeenCalled()
    release()
    await expect(request).rejects.toThrow()
    await draining
    expect(value.close).toHaveBeenCalledTimes(1)
  })
  test("live workflow snapshots include only the initiating conversation's runs", async () => {
    const value = fixture()
    const cleanup = await plugin.setup(value.context as any)
    try {
      const rpc = value.hooks.get("rpc")
      const admitted = await rpc.control({ text: "plan Inspect queue ordering", sessionId: "parent" })
      expect(typeof rpc.workflow).toBe("function")
      const before = value.synthetics.length
      const snapshot = await rpc.workflow({ sessionId: "parent" })
      expect(snapshot.sessionId).toBe("parent")
      expect(snapshot.runs.map((run: any) => run.id)).toEqual([admitted.run.id])
      expect(snapshot.runs[0].objective).toBe("Inspect queue ordering")
      expect(snapshot.runs[0].usage.tokens).toBeNull()
      expect(snapshot.runs[0]).not.toHaveProperty("policy")
      expect(snapshot.runs[0]).not.toHaveProperty("config")
      expect(await rpc.workflow({ sessionId: "other" })).toEqual({ sessionId: "other", runs: [] })
      await expect(rpc.workflow({ sessionId: "other", runId: admitted.run.id })).rejects.toThrow("initiating")
      expect(value.synthetics).toHaveLength(before)
    } finally { await cleanup!() }
  })
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
    expect(value.disposals).toEqual(["rpc", "shell.create.before", "tool.execute.after", "tool.execute.before", "session.prompt", "session.model.request", "session.context", "permission.evaluate", "tools", "command", "agents"])
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

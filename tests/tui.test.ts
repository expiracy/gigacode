import { expect, mock, test } from "bun:test"
import { defaultConfig } from "../src/config.ts"

// Match OpenCode's shared reactive runtime rather than Solid's server entry.
const solidEntry = "solid-js/dist/solid.js"
const solid = await import(solidEntry) as typeof import("solid-js")
mock.module("solid-js", () => solid)
const plugin = (await import("../tui.ts")).default

function fixture() {
  let listener: (event: any) => Promise<void> | void = () => {}
  const [route, setRoute] = solid.createSignal<any>({ type: "home" })
  const [cache, setCache] = solid.createSignal<any[]>([])
  let selected: string | undefined
  let calls = 0, disposed = 0
  const layers: any[] = [], dialogs: any[] = [], reads: any[] = [], synced: string[] = [], toasts: any[] = []
  const sessions = new Map<string, any>(), events = new Map<string, Set<Function>>()
  let list: (input: any, options: any) => Promise<any> = async input => ({ data: [...sessions.values()].filter(info => info.parentID === input.parentID), cursor: {} })
  const response = { config: structuredClone(defaultConfig), hostVersion: "2.0.25", promptVersion: "ultra/2", directory: "C:/project", state: "C:/project/.ultracode/state.sqlite" }
  const context = {
    app: { version: "2.0.25" }, location: { directory: "C:/plugin-project" },
    client: { session: { async list(input: any, options: any) { reads.push(input); return list(input, options) } }, rpc() { return {
      async config() { calls++; return response },
      events: { on(name: string, callback: typeof listener) { expect(name).toBe("commandResult"); listener = callback; return () => { disposed++ } } },
    } } },
    keymap: { layer(factory: () => unknown) { layers.push(factory()) } },
    data: { on(name: string, callback: Function) { const listeners = events.get(name) ?? new Set(); listeners.add(callback); events.set(name, listeners); return () => listeners.delete(callback) },
      location: { default() { return { directory: "C:/default-project" } } }, session: {
        list: cache, get(id: string) { return cache().find(info => info.id === id) },
        root(id: string) { let current = id; const seen = new Set<string>(); while (!seen.has(current)) { seen.add(current); const parent = cache().find(info => info.id === current)?.parentID; if (!parent) return current; current = parent }; return current },
        async sync(id: string) { synced.push(id); const info = sessions.get(id); if (!info) throw new Error("Missing fixture session"); setCache(old => [...old.filter(value => value.id !== id), info]) },
      } },
    ui: { router: { current: route }, toast: { show(value: any) { toasts.push(value) } }, dialog: {
      async select(options: any) { dialogs.push({ kind: "select", ...options }); return selected },
      async alert(options: any) { dialogs.push({ kind: "alert", ...options }) },
    } },
  }
  return {
    context, layers, dialogs, response, reads, synced, toasts,
    get calls() { return calls }, get disposed() { return disposed },
    route(value: unknown) { setRoute(value) }, select(value?: string) { selected = value },
    seed(values: any[], cached: string[] = []) { values.forEach(info => sessions.set(info.id, info)); setCache(cached.map(id => sessions.get(id))) },
    list(callback: typeof list) { list = callback },
    async nativeEvent(name: string) { for (const callback of events.get(name) ?? []) callback({ type: name }); await settle() },
    async event(data: unknown) { await listener({ data }) },
  }
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve() }
const family = [
  { id: "parent", agent: "ultra" },
  { id: "supervisor", parentID: "parent", agent: "ultra-supervisor" },
  { id: "worker", parentID: "supervisor", agent: "ultra-worker" },
]

test("cold root attach hydrates existing native workers without opening the supervisor", async () => {
  const f = fixture()
  f.seed(family, ["parent", "supervisor"])
  f.route({ type: "session", sessionID: "parent" })
  const cleanup = await plugin.setup(f.context as any)
  try {
    await settle()
    expect(f.context.data.session.list().map(info => info.id).sort()).toEqual(["parent", "supervisor", "worker"])
    expect(f.synced).toEqual(["supervisor", "worker"])
    expect(f.calls).toBe(0)
    expect(f.dialogs).toHaveLength(0)
  } finally { await cleanup!() }
})

test("navigation and reconnect refresh Ultra descendants for legacy primary agents too", async () => {
  const f = fixture()
  f.seed([{ ...family[0], agent: "build" }, ...family.slice(1)], ["parent", "supervisor"])
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" }); await settle()
    expect(f.synced).toEqual(["supervisor", "worker"])
    await f.nativeEvent("server.connected")
    expect(f.synced).toEqual(["supervisor", "worker", "supervisor", "worker"])
  } finally { await cleanup!() }
})

test("cold child deep links resolve uncached ancestors before loading the family", async () => {
  for (const sessionID of ["supervisor", "worker"]) {
    const f = fixture()
    f.seed(family)
    f.route({ type: "session", sessionID })
    const cleanup = await plugin.setup(f.context as any)
    try {
      await settle()
      expect(f.context.data.session.list().map(info => info.id).sort()).toEqual(["parent", "supervisor", "worker"])
      expect(f.reads.map(input => input.parentID)).toEqual(["parent", "supervisor"])
    } finally { await cleanup!() }
  }
})

test("paged hydration deduplicates sessions and excludes unrelated families and agents", async () => {
  const f = fixture()
  f.seed(family, ["parent"])
  f.list(async input => {
    if (input.parentID === "parent") return input.cursor
      ? { data: [family[1]], cursor: {} }
      : { data: [family[1], { id: "other", parentID: "parent", agent: "general" }, { id: "foreign", parentID: "elsewhere", agent: "ultra-supervisor" }], cursor: { next: "next-page" } }
    return { data: [family[2], family[2], { id: "foreign-worker", parentID: "elsewhere", agent: "ultra-worker" }], cursor: {} }
  })
  f.route({ type: "session", sessionID: "parent" })
  const cleanup = await plugin.setup(f.context as any)
  try {
    await settle()
    expect(f.synced).toEqual(["supervisor", "worker"])
    expect(f.reads.filter(input => input.parentID === "parent").map(input => input.cursor)).toEqual([undefined, "next-page"])
    expect(f.reads.some(input => input.parentID === "other" || input.parentID === "foreign")).toBe(false)
  } finally { await cleanup!() }
})

test("switching conversation or disposing during a read stops stale family hydration", async () => {
  for (const dispose of [false, true]) {
    const f = fixture()
    f.seed(family, ["parent"])
    let release!: (value: any) => void
    f.list(() => new Promise(resolve => { release = resolve }))
    f.route({ type: "session", sessionID: "parent" })
    const cleanup = await plugin.setup(f.context as any)
    await settle()
    if (dispose) await cleanup!(); else f.route({ type: "home" })
    release({ data: [family[1]], cursor: {} }); await settle()
    expect(f.synced).toEqual([])
    expect(f.toasts).toEqual([])
    await cleanup!()
  }
})

test("failed family reads stay visible and retry on reconnect without polling", async () => {
  const f = fixture()
  f.seed(family, ["parent"])
  f.route({ type: "session", sessionID: "parent" })
  f.list(async () => { throw new Error("fixture disconnect") })
  const cleanup = await plugin.setup(f.context as any)
  try {
    await settle()
    expect(f.toasts).toHaveLength(1)
    expect(f.toasts[0].message).toContain("subagents")
    expect(f.reads).toHaveLength(1)
    f.list(async input => ({ data: family.filter(info => "parentID" in info && info.parentID === input.parentID), cursor: {} }))
    await f.nativeEvent("server.connected")
    expect(f.synced).toEqual(["supervisor", "worker"])
  } finally { await cleanup!() }
})

test("native ultracode config is the only terminal configuration entry point", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    expect(f.layers).toHaveLength(0)
    expect(f.calls).toBe(0)
    expect(f.dialogs).toHaveLength(0)
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[0].title).toBe("Ultra configuration")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("configuration uses the initiating session's effective server settings", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const directory = f.dialogs[0].options.find((option: any) => option.title === "Project directory")
    expect(directory.description).toBe("C:/project")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("configuration viewer includes effective role choices, checks, prompts, and state", async () => {
  const f = fixture()
  f.response.config.models.roles!.planner = "fixture/design#deep"
  f.response.config.prompts!.reviewer = "Inspect backwards compatibility."
  f.response.config.checks = [{ id: "types", command: "bun run typecheck", criterionIds: ["verification"] }]
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.select("Role instructions/Prompt: reviewer")
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const options = f.dialogs[0].options
    for (const text of ["fixture/design#deep", "bun run typecheck", "ultra/2", "state.sqlite"]) expect(JSON.stringify(options)).toContain(text)
    expect(f.dialogs[1].message).toBe("Inspect backwards compatibility.")
  } finally { await cleanup!() }
})

test("equal setting values retain the selected field's caption", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.select("Limits/Repair rounds")
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[1].title).toBe("Repair rounds")
    expect(f.dialogs[1].message).toBe("2")
    const values = f.dialogs[0].options.map((option: any) => option.value)
    expect(new Set(values).size).toBe(values.length)
  } finally { await cleanup!() }
})

test("native slash configuration result opens immediately without another RPC or model request", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[0].title).toBe("Ultra configuration")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("other command results are visible only in their initiating session", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "other", command: "status", result: { runs: [] } })
    expect(f.dialogs).toHaveLength(0)
    await f.event({ sessionId: "parent", command: "status", result: { runs: [] } })
    expect(f.dialogs[0].title).toBe("Ultra command result")
    expect(f.dialogs[0].message).toContain('"runs": []')
  } finally { await cleanup!() }
})

test("native command failures give actionable visible errors without another RPC", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "bogus", error: "Unknown ultracode command: bogus. Usage: /ultracode config" })
    expect(f.dialogs[0].title).toBe("Ultra command error")
    expect(f.dialogs[0].message).toContain("Unknown ultracode command")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("terminal reload unsubscribes once and does not display late results", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.route({ type: "session", sessionID: "parent" })
  await cleanup!(); await cleanup!()
  expect(f.disposed).toBe(1)
  await f.event({ sessionId: "parent", command: "config", result: f.response })
  expect(f.dialogs).toHaveLength(0)
})

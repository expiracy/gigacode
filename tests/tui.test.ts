import { expect, test } from "bun:test"
import plugin from "../tui.ts"
import { defaultConfig } from "../src/config.ts"

function fixture() {
  let listener: (event: any) => Promise<void> | void = () => {}
  let route: any = { type: "home" }, selected: string | undefined
  let calls = 0, disposed = 0
  const layers: any[] = [], dialogs: any[] = []
  const response = { config: structuredClone(defaultConfig), hostVersion: "2.0.25", promptVersion: "ultra/2", directory: "C:/project", state: "C:/project/.ultracode/state.sqlite" }
  const context = {
    app: { version: "2.0.25" }, location: { directory: "C:/plugin-project" },
    client: { rpc() { return {
      async config() { calls++; return response },
      events: { on(name: string, callback: typeof listener) { expect(name).toBe("commandResult"); listener = callback; return () => { disposed++ } } },
    } } },
    keymap: { layer(factory: () => unknown) { layers.push(factory()) } },
    data: { location: { default() { return { directory: "C:/default-project" } } }, session: { get() { return { location: { directory: "C:/session-project" } } } } },
    ui: { router: { current() { return route } }, dialog: {
      async select(options: any) { dialogs.push({ kind: "select", ...options }); return selected },
      async alert(options: any) { dialogs.push({ kind: "alert", ...options }) },
    } },
  }
  return {
    context, layers, dialogs, response,
    get calls() { return calls }, get disposed() { return disposed },
    route(value: unknown) { route = value }, select(value?: string) { selected = value },
    async event(data: unknown) { await listener({ data }) },
  }
}

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

import { expect, mock, test } from "bun:test"
import { defaultConfig } from "../src/config.ts"
import type { WorkflowSnapshot } from "../src/workflow-view.ts"
import type { SettingsView } from "../src/settings.ts"

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
  const selections: (string | undefined)[] = []
  const prompts: (string | undefined)[] = []
  let confirmation = false
  const confirmations: (boolean | undefined)[] = []
  let calls = 0, disposed = 0
  let finishDialog: ((value?: string) => void) | undefined
  const workflowReads: any[] = [], controls: any[] = [], navigations: any[] = []
  const settingsReads: any[] = [], settingsSaves: any[] = []
  const settingsView: SettingsView = { path: "C:/project/gigacode.json", revision: "settings-revision", overrides: {}, inherited: structuredClone(defaultConfig), effective: structuredClone(defaultConfig), models: [{ providerID: "fixture", id: "model", name: "Fixture model", variants: ["fast"], tools: true }] }
  const globalSettingsView: SettingsView = { ...structuredClone(settingsView), path: "C:/profile/opencode.jsonc", revision: "global-revision", scope: "global", reloadRequired: true }
  const workflowResponse: WorkflowSnapshot = { sessionId: "parent", runs: [{
    id: "run_1", parentSessionId: "parent", directory: "C:/project", generation: 1, revision: 2,
    status: "running", phase: "execution", objective: "Fix the parser", supervisorSessionId: "supervisor", errors: [], omittedErrors: 0,
    tasks: [{ id: "fix", title: "Fix parser", role: "implementer", stage: "implementation", status: "running", dependencies: [], attempts: 1, sessionId: "worker",
      model: { ref: { providerID: "fixture", id: "model" }, requested: "fixture/model", origin: "captured" }, waits: [], blockers: [], checks: [] }],
    usage: { workers: 1, attempts: 1, tokens: null, cost: null, tokenObservations: 0, costObservations: 0, activeMs: 100, elapsedMs: 200, limits: defaultConfig.limits },
  }] }
  let workflow = async (_input: any, _options: any) => structuredClone(workflowResponse)
  let control = async (_input: any, _options: any) => ({})
  const layers: any[] = [], dialogs: any[] = [], reads: any[] = [], synced: string[] = [], toasts: any[] = []
  const sessions = new Map<string, any>(), events = new Map<string, Set<Function>>()
  let list: (input: any, options: any) => Promise<any> = async input => ({ data: [...sessions.values()].filter(info => info.parentID === input.parentID), cursor: {} })
  const response = { config: structuredClone(defaultConfig), hostVersion: "2.0.25", promptVersion: "gigacode/2", directory: "C:/project", state: "C:/project/.gigacode/state.sqlite" }
  const context = {
    app: { version: "2.0.25" }, location: { directory: "C:/plugin-project" },
    client: { session: { async list(input: any, options: any) { reads.push(input); return list(input, options) } }, rpc() { return {
      async config() { calls++; return response },
      async settings(input: any, options: any) { settingsReads.push({ input, options }); return structuredClone(input.scope === "global" ? globalSettingsView : settingsView) },
      async saveSettings(input: any, options: any) { settingsSaves.push({ input, options }); return input.scope === "global" ? globalSettingsView : settingsView },
      async workflow(input: any, options: any) { workflowReads.push({ input, options }); return workflow(input, options) },
      async control(input: any, options: any) { controls.push({ input, options }); return control(input, options) },
      events: { on(name: string, callback: typeof listener) { expect(name).toBe("commandResult"); listener = callback; return () => { disposed++ } } },
    } } },
    keymap: { layer(factory: () => unknown) { layers.push(factory()) } },
    data: { on(name: string, callback: Function) { const listeners = events.get(name) ?? new Set(); listeners.add(callback); events.set(name, listeners); return () => listeners.delete(callback) },
      location: { default() { return { directory: "C:/default-project" } } }, session: {
        list: cache, get(id: string) { return cache().find(info => info.id === id) },
        root(id: string) { let current = id; const seen = new Set<string>(); while (!seen.has(current)) { seen.add(current); const parent = cache().find(info => info.id === current)?.parentID; if (!parent) return current; current = parent }; return current },
        async sync(id: string) { synced.push(id); const info = sessions.get(id); if (!info) throw new Error("Missing fixture session"); setCache(old => [...old.filter(value => value.id !== id), info]) },
      } },
    ui: { router: { current: route, navigate(value: unknown) { navigations.push(value); setRoute(value) } }, toast: { show(value: any) { toasts.push(value) } }, dialog: {
      async select(options: any) {
        dialogs.push(Object.assign(Object.create(options), { kind: "select" }))
        if (selections.length) return selections.shift()
        if (["GigaCode workflows", "GigaCode workflow actions"].includes(options.title) && !selected) return new Promise<string | undefined>(resolve => { finishDialog = resolve })
        return selected
      },
      async alert(options: any) { context.ui.dialog.clear(); dialogs.push({ kind: "alert", ...options }) },
      async prompt(options: any) { dialogs.push({ kind: "prompt", ...options }); return prompts.shift() },
      async confirm(options: any) { context.ui.dialog.clear(); dialogs.push({ kind: "confirm", ...options }); return confirmations.length ? confirmations.shift() : confirmation },
      clear() { finishDialog?.(); finishDialog = undefined },
    } },
  }
  return {
    context, layers, dialogs, response, reads, synced, toasts, workflowReads, workflowResponse, controls, navigations, settingsReads, settingsSaves, settingsView, globalSettingsView,
    get calls() { return calls }, get disposed() { return disposed },
    route(value: unknown) { setRoute(value) }, select(value?: string) { selected = value },
    choose(...values: (string | undefined)[]) { selections.push(...values) },
    enter(...values: (string | undefined)[]) { prompts.push(...values) },
    confirm(value = true) { confirmation = value },
    decide(...values: (boolean | undefined)[]) { confirmations.push(...values) },
    seed(values: any[], cached: string[] = []) { values.forEach(info => sessions.set(info.id, info)); setCache(cached.map(id => sessions.get(id))) },
    list(callback: typeof list) { list = callback },
    workflow(callback: typeof workflow) { workflow = callback },
    control(callback: typeof control) { control = callback },
    close() { context.ui.dialog.clear() },
    resolve(value?: string) { const finish = finishDialog; finishDialog = undefined; finish?.(value) },
    async nativeEvent(name: string) { for (const callback of events.get(name) ?? []) callback({ type: name }); await settle() },
    async event(data: unknown) { await listener({ data }) },
  }
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve() }
function workflowAction(f: ReturnType<typeof fixture>, panel: any, title: string) {
  const open = panel.actions.find((action: any) => action.title === "Actions")
  return open && { async onTrigger(value: string) {
    open.onTrigger(value)
    await settle()
    const menu = f.dialogs.at(-1)
    if (menu?.title !== "GigaCode workflow actions") return
    const option = menu.options.find((option: any) => option.title === title)
    if (!option || option.disabled) return
    f.resolve(option.value)
    await settle()
  } }
}
const family = [
  { id: "parent", agent: "gigacode" },
  { id: "supervisor", parentID: "parent", agent: "gigacode-supervisor" },
  { id: "worker", parentID: "supervisor", agent: "gigacode-worker" },
]

test("cold root attach hydrates GigaCode workers without opening the supervisor", async () => {
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

test("does not hydrate previous product worker sessions", async () => {
  const f = fixture()
  const previous = family.map((info, index) => ({ ...info, agent: index === 0 ? "ultraopencode" : `ultraopencode-${index === 1 ? "supervisor" : "worker"}` }))
  f.seed(previous, ["parent", "supervisor"])
  f.route({ type: "session", sessionID: "parent" })
  const cleanup = await plugin.setup(f.context as any)
  try {
    await settle()
    expect(f.synced).toEqual([])
    expect(f.context.data.session.list().map(info => info.id).sort()).toEqual(["parent", "supervisor"])
  } finally { await cleanup!() }
})

test("navigation and reconnect refresh GigaCode descendants after selecting Build", async () => {
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
      : { data: [family[1], { id: "other", parentID: "parent", agent: "general" }, { id: "foreign", parentID: "elsewhere", agent: "gigacode-supervisor" }], cursor: { next: "next-page" } }
    return { data: [family[2], family[2], { id: "foreign-worker", parentID: "elsewhere", agent: "gigacode-worker" }], cursor: {} }
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

test("native gigacode config is the only terminal configuration entry point", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    expect(f.layers).toHaveLength(0)
    expect(f.calls).toBe(0)
    expect(f.dialogs).toHaveLength(0)
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[0].title).toBe("GigaCode settings")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("settings offers separate help and about destinations beside scope choices", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[0].title).toBe("GigaCode settings")
    expect(f.dialogs[0].options.map((option: any) => option.title)).toEqual(["This project", "Global defaults", "Help", "About GigaCode"])
    expect(f.settingsReads).toHaveLength(0)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("advanced configuration lives in the chosen scope and uses its actual values", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.globalSettingsView.effective.prompts = { reviewer: "Global review instructions" }
  f.globalSettingsView.effective.autoThreshold = 45
  f.globalSettingsView.overrides = { prompts: { reviewer: "Global review instructions" }, autoThreshold: 45 }
  f.response.config.prompts = { reviewer: "Project-specific instructions" }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "advanced", "back", "back", "help", "back", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const advanced = f.dialogs.find(dialog => dialog.title === "Advanced configuration")
    expect(advanced?.placeholder).toContain("C:/profile/opencode.jsonc")
    expect(advanced?.options.find((option: any) => option.value === "prompts").description).toContain("1 custom")
    expect(advanced?.options.find((option: any) => option.value === "threshold").description).toContain("45 characters")
    expect(JSON.stringify(advanced?.options)).not.toContain("Project-specific instructions")
    const help = f.dialogs.find(dialog => dialog.title === "GigaCode help")
    expect(help?.options.map((option: any) => option.value)).not.toContain("about")
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("help offers focused guides and returns to the topic list before settings", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("help", "scopes", "saving", "advanced", "workflows", "back", "about", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const help = f.dialogs.filter(dialog => dialog.title === "GigaCode help")
    expect(help[0]?.options.map((option: any) => option.title)).toEqual(["Scopes & inheritance", "Editing & saving", "Advanced controls", "Workflow commands", "Back to GigaCode settings"])
    expect(help.map(dialog => dialog.current)).toEqual([undefined, "scopes", "saving", "advanced", "workflows"])
    const guides = f.dialogs.filter(dialog => dialog.kind === "alert")
    expect(guides.map(dialog => dialog.title)).toEqual(["Scopes & inheritance", "Editing & saving", "Advanced controls", "Workflow commands", "About GigaCode"])
    expect(guides[0].message).toContain("Project overrides take precedence")
    expect(guides[1].message).toContain("Reload OpenCode")
    expect(guides[2].message).toContain("/gigacode on")
    expect(guides[3].message).toContain("/gigacode status")
    expect(f.settingsReads).toHaveLength(0)
    expect(f.settingsSaves).toHaveLength(0)
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("about opens directly and returns focus to its settings entry with unknown metadata labelled", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  Object.assign(f.response, { hostVersion: undefined, promptVersion: undefined, directory: undefined, state: undefined })
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("about", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.map(dialog => dialog.title)).toEqual(["GigaCode settings", "About GigaCode", "GigaCode settings"])
    expect(f.dialogs[1].message).toContain("durable, multi-agent coding workflows")
    expect(f.dialogs[1].message).toContain("OpenCode: Unknown")
    expect(f.dialogs[1].message).toContain("Prompt version: Unknown")
    expect(f.dialogs[1].message).toContain("Project directory: Unknown")
    expect(f.dialogs[1].message).toContain("State database: Unknown")
    expect(f.dialogs[2].current).toBe("about")
    expect(f.settingsReads).toHaveLength(0)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("navigation retires a pending help guide before it can open an alert", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  const select = f.context.ui.dialog.select
  let release!: (value: string) => void
  f.context.ui.dialog.select = options => options.title === "GigaCode help" ? new Promise(resolve => { release = resolve }) : select(options)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("help")
    const opening = f.event({ sessionId: "parent", command: "config", result: f.response })
    await settle()
    f.route({ type: "home" })
    release("saving")
    await opening
    expect(f.dialogs.map(dialog => dialog.title)).toEqual(["GigaCode settings"])
    expect(f.settingsReads).toHaveLength(0)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("writer policy is editable in the advanced draft and saved only after confirmation", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "writer", "parallel", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ parallelWrites: true })
    expect(f.settingsSaves[0]?.input.replaceAdvanced).toBe(true)
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("Isolated parallel writers")
  } finally { await cleanup!() }
})

test("automatic-mode threshold edits explain opt-in behavior and preview the chosen value", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "threshold", "back", "save")
    f.enter("120"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const prompt = f.dialogs.find(dialog => dialog.kind === "prompt")
    expect(prompt?.value).toBe("80")
    expect(prompt?.description).toContain("/gigacode on")
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("120 characters")
    expect(f.settingsSaves[0]?.input.options).toEqual({ autoThreshold: 120 })
  } finally { await cleanup!() }
})

test("role instructions edit inherited multiline text and include the full change in the save preview", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  const inherited = "Review public contracts.\nCheck edge cases."
  const edited = "Review public contracts.\nCheck edge cases and integer limits."
  f.settingsView.inherited.prompts = { reviewer: inherited }
  f.settingsView.overrides.prompts = { planner: "Keep the implementation small." }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "prompts", "reviewer", "back", "back", "save")
    f.enter(edited); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.kind === "prompt")?.value).toBe(inherited)
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain(edited)
    expect(f.settingsSaves[0]?.input.options).toEqual({ prompts: { planner: "Keep the implementation small.", reviewer: edited } })
  } finally { await cleanup!() }
})

test("advanced overrides can all return to inherited values without copying them into the project", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.settingsView.overrides = { prompts: { reviewer: "Project review" }, parallelWrites: true, autoThreshold: 120 }
  f.settingsView.inherited.prompts = { reviewer: "Global review" }
  f.settingsView.inherited.autoThreshold = 90
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "writer", "reset", "threshold", "prompts", "reviewer", "back", "back", "save")
    f.enter("inherit", ""); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({})
    expect(f.settingsSaves[0]?.input.replaceAdvanced).toBe(true)
    const preview = f.dialogs.find(dialog => dialog.kind === "confirm")?.message
    expect(preview).toContain("Global review")
    expect(preview).toContain("90 characters")
    expect(preview).toContain("Serial writers")
  } finally { await cleanup!() }
})

test("invalid advanced thresholds stay available for correction and cannot enter the draft", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "threshold", "back", "save")
    f.enter("0", "120.5", "100"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.filter(dialog => dialog.title === "Invalid automatic-mode threshold")).toHaveLength(2)
    expect(f.dialogs.filter(dialog => dialog.kind === "prompt").map(dialog => dialog.value)).toEqual(["80", "0", "120.5"])
    expect(f.settingsSaves[0]?.input.options).toEqual({ autoThreshold: 100 })
  } finally { await cleanup!() }
})

test("resetting one role keeps other custom instructions and previews its inherited text", async () => {
  const f = fixture(), select = f.context.ui.dialog.select
  f.settingsView.overrides.prompts = { planner: "Plan narrowly", reviewer: "Project review" }
  f.settingsView.inherited.prompts = { reviewer: "Global review" }
  let reset = false
  f.context.ui.dialog.select = async options => {
    if (options.title === "Role instructions" && !reset) {
      reset = true
      options.actions[0].onTrigger("reviewer")
      return undefined
    }
    return select(options)
  }
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "prompts", "back", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ prompts: { planner: "Plan narrowly" } })
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("Global review")
  } finally { await cleanup!() }
})

test("cancelling an instruction edit preserves its text and other staged advanced changes", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.settingsView.overrides.prompts = { reviewer: "Keep the original review instructions." }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "writer", "parallel", "prompts", "reviewer", "back", "back", "save")
    f.enter(undefined); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ prompts: { reviewer: "Keep the original review instructions." }, parallelWrites: true })
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).not.toContain("Role instructions (reviewer)")
  } finally { await cleanup!() }
})

test("viewing advanced configuration preserves an unsaved draft without duplicating editable settings", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", "back", "advanced", "back", "save")
    f.enter("1"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const advanced = f.dialogs.find(dialog => dialog.title === "Advanced configuration")
    expect(advanced.placeholder).toContain("C:/project/gigacode.json")
    expect(advanced.options.map((option: any) => option.value)).toEqual(["prompts", "writer", "threshold", "back"])
    expect(f.settingsSaves).toHaveLength(1)
    expect(f.settingsSaves[0].input.options).toEqual({ limits: { workers: 1 } })
  } finally { await cleanup!() }
})

test("a scope selection resolved after reconnect cannot open a stale editor", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release!: (value: string) => void
  f.context.ui.dialog.select = () => new Promise(resolve => { release = resolve })
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    const opening = f.event({ sessionId: "parent", command: "config", result: f.response })
    await settle()
    await f.nativeEvent("server.connected")
    release("Configuration/Edit project settings")
    await opening
    expect(f.settingsReads).toHaveLength(0)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("scope selection identifies the initiating session's project", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const project = f.dialogs[0].options.find((option: any) => option.title === "This project")
    expect(project.description).toContain("C:/project")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("advanced configuration and support have separate destinations", async () => {
  const f = fixture()
  f.settingsView.effective.prompts!.reviewer = "Inspect backwards compatibility."
  f.settingsView.overrides.prompts = { reviewer: "Inspect backwards compatibility." }
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "advanced", "back", "back", "about", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const advanced = f.dialogs.find(dialog => dialog.title === "Advanced configuration")
    expect(advanced.options.find((option: any) => option.value === "prompts").description).toContain("1 custom")
    expect(advanced.options.find((option: any) => option.value === "threshold").description).toContain("80 characters")
    const about = f.dialogs.find(dialog => dialog.title === "About GigaCode")
    for (const text of ["2.0.25", "gigacode/2", "C:/project", "state.sqlite"]) expect(about.message).toContain(text)
    expect(f.dialogs.filter(dialog => dialog.title === "GigaCode help")).toHaveLength(0)
    expect(f.settingsReads).toHaveLength(1)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("deadlines have one editable location with current seconds prefilled", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workerMs", "back", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const prompt = f.dialogs.find(dialog => dialog.kind === "prompt")
    expect(prompt.title).toBe("Worker deadline (seconds)")
    expect(prompt.value).toBe("600")
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("equal limit values retain their editable field identity", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "repairRounds", "back", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const prompt = f.dialogs.find(dialog => dialog.kind === "prompt")
    expect(prompt.title).toBe("Repair rounds (whole number)")
    expect(prompt.value).toBe("2")
    const values = f.dialogs.find(dialog => dialog.title === "Workflow limits").options.map((option: any) => option.value)
    expect(new Set(values).size).toBe(values.length)
  } finally { await cleanup!() }
})

test("native slash configuration result opens immediately without another RPC or model request", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[0].title).toBe("GigaCode settings")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("the configuration viewer opens a guided project editor without saving on cancellation", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[0].options.some((option: any) => option.title === "This project")).toBe(true)
    expect(f.settingsReads[0].input).toEqual({ sessionId: "parent" })
    expect(f.dialogs[1].title).toBe("GigaCode project settings")
    expect(f.dialogs[1].options.map((option: any) => option.title)).toEqual(expect.arrayContaining(["Models", "Limits", "Checks"]))
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("the global editor previews all-project scope and saves only to the shared profile", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "models", "default", "inherit", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs[0].options.some((option: any) => option.title === "Global defaults")).toBe(true)
    expect(f.settingsReads[0].input).toEqual({ sessionId: "parent", scope: "global" })
    const confirmation = f.dialogs.find(dialog => dialog.kind === "confirm")
    expect(confirmation?.message).toContain("All projects")
    expect(confirmation?.message).toContain("Project overrides")
    expect(confirmation?.message).toContain("C:/profile/opencode.jsonc")
    expect(f.settingsSaves[0]?.input).toEqual({ sessionId: "parent", scope: "global", revision: "global-revision", replaceAdvanced: true, options: { models: { default: "inherit" } } })
    expect(f.toasts.at(-1)?.message).toContain("Reload OpenCode")
  } finally { await cleanup!() }
})

test("a global limit opens directly with its current value and an explanation of scope", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.globalSettingsView.overrides = { limits: { workers: 2 } }
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "limits", "workers", "back", "save")
    f.enter("1"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const prompt = f.dialogs.find(dialog => dialog.kind === "prompt")
    expect(prompt?.value).toBe("2")
    expect(prompt?.description).toContain("All projects")
    expect(f.settingsSaves[0]?.input.options).toEqual({ limits: { workers: 1 } })
  } finally { await cleanup!() }
})

test("limits stay open for several edits before returning to the scoped settings page", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", "steps", "back", "save")
    f.enter("1", "12"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ limits: { workers: 1, steps: 12 } })
    const limits = f.dialogs.filter(dialog => dialog.title === "Workflow limits")
    expect(limits).toHaveLength(3)
    expect(limits[1].options.find((option: any) => option.value === "workers").description).toContain("1 · project override")
  } finally { await cleanup!() }
})

test("models use the same stay-open list and Back navigation as limits", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "models", "roles.planner", "inherit", "roles.reviewer", "inherit", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ models: { roles: { planner: "inherit", reviewer: "inherit" } } })
    expect(f.dialogs.filter(dialog => dialog.title === "Workflow models")).toHaveLength(3)
  } finally { await cleanup!() }
})

test("settings restores focus through sections and names each Back destination", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "checks", "add", "back", "advanced", "writer", "back", "prompts", "back", "back", "limits", "back", "back", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.filter(dialog => dialog.title === "GigaCode global defaults").map(dialog => dialog.current)).toEqual([undefined, "checks", "advanced", "limits"])
    expect(f.dialogs.filter(dialog => dialog.title === "Advanced configuration").map(dialog => dialog.current)).toEqual([undefined, "writer", "prompts"])
    expect(f.dialogs.filter(dialog => dialog.title === "Verification checks").map(dialog => dialog.current)).toEqual([undefined, "add"])
    for (const title of ["Workflow limits", "Advanced configuration", "Verification checks"]) {
      expect(f.dialogs.find(dialog => dialog.title === title).options.at(-1).title).toBe("Back to global defaults")
    }
    expect(f.dialogs.find(dialog => dialog.title === "Writer policy").options.at(-1).title).toBe("Back to advanced configuration")
    expect(f.dialogs.find(dialog => dialog.title === "Role instructions").options.at(-1).title).toBe("Back to advanced configuration")
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("checks stay in their editable list while adding and updating a command", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "checks", "add", "check:0", "edit", "back", "save")
    f.enter("types", "bun run types", "verification", "", "types", "bun run typecheck", "verification", "30"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ checks: [{ id: "types", command: "bun run typecheck", criterionIds: ["verification"], timeoutMs: 30_000 }] })
    expect(f.dialogs.filter(dialog => dialog.title === "Verification checks")).toHaveLength(3)
  } finally { await cleanup!() }
})

test("the chosen scope remains visible in every editable section and model picker", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "models", "default", undefined, "back", "limits", "back", "checks", "back", "back", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    for (const title of ["Workflow models", "Select workflow model", "Workflow limits", "Verification checks"]) {
      expect(f.dialogs.find(dialog => dialog.title === title)?.placeholder).toContain("Global defaults")
    }
    expect(f.dialogs.find(dialog => dialog.title === "Workflow limits").options.find((option: any) => option.value === "workers").description).toContain("built-in default")
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("invalid limit input stays available for correction before returning to the limits list", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", "back", "save")
    f.enter("0", "2"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const prompts = f.dialogs.filter(dialog => dialog.kind === "prompt")
    expect(prompts).toHaveLength(2)
    expect(prompts[1].value).toBe("0")
    expect(f.settingsSaves[0]?.input.options).toEqual({ limits: { workers: 2 } })
  } finally { await cleanup!() }
})

test("the reset shortcut removes a global limit and previews its actual built-in value", async () => {
  const f = fixture(), select = f.context.ui.dialog.select
  f.globalSettingsView.overrides = { limits: { workers: 2 } }
  let resetOptions: any
  f.context.ui.dialog.select = async options => {
    if (options.title === "Workflow limits" && !resetOptions) {
      resetOptions = options
      options.actions?.find((action: any) => action.bind === "ctrl+r")?.onTrigger("workers")
      return undefined
    }
    return select(options)
  }
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "limits", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(resetOptions.actions?.[0].title).toContain("built-in")
    expect(f.settingsSaves[0]?.input.options).toEqual({})
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("2 → built-in default (4)")
  } finally { await cleanup!() }
})

test("closing a guided editor retires its request and retained reset callbacks", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let clears = 0
  const clear = f.context.ui.dialog.clear
  f.context.ui.dialog.clear = () => { clears++; clear() }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "back", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsReads[0].options.signal.aborted).toBe(true)
    const reset = f.dialogs.find(dialog => dialog.title === "Workflow limits").actions[0]
    reset.onTrigger("workers")
    expect(clears).toBe(0)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("resetting global checks explains per-project discovery instead of an empty required list", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.globalSettingsView.overrides = { checks: [] }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "checks", "reset", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const checks = f.dialogs.find(dialog => dialog.title === "Verification checks")
    expect(checks.options.find((option: any) => option.value === "reset").title).toBe("Use automatic discovery")
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("Automatic discovery in each project")
    expect(f.settingsSaves[0]?.input.options).toEqual({})
  } finally { await cleanup!() }
})

test("back to configuration lets the user choose another scope without copying project overrides", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.settingsView.overrides = { limits: { workers: 1 } }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "back", "Configuration/Edit global defaults", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsReads.map(read => read.input.scope ?? "project")).toEqual(["project", "global"])
    expect(f.dialogs.find(dialog => dialog.title === "GigaCode global defaults")).toBeDefined()
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("changing scope after editing requires explicit discard and starts with that scope's own values", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "models", "default", "inherit", "back", "back", "Configuration/Edit global defaults", undefined); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const discard = f.dialogs.find(dialog => dialog.title === "Discard unsaved changes?")
    expect(discard?.message).toContain("Workflow default")
    expect(discard?.message).toContain("C:/project/gigacode.json")
    expect(f.settingsReads.map(read => read.input.scope ?? "project")).toEqual(["project", "global"])
    expect(f.globalSettingsView.overrides).toEqual({})
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("cancelling discard after Escape keeps the draft available for an explicit save", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "models", "default", "inherit", "back", undefined, "save")
    f.decide(false, true)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.title === "Discard unsaved changes?")).toBeDefined()
    expect(f.settingsSaves[0]?.input.options).toEqual({ models: { default: "inherit" } })
  } finally { await cleanup!() }
})

test("restoring original model overrides leaves no unsaved draft despite object key order", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.settingsView.overrides = { models: { roles: { planner: "inherit", reviewer: "fixture/model" } } }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "models", "roles.planner", "reset", "roles.planner", "inherit", "back", "back", undefined)
    f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const editor = f.dialogs.findLast(dialog => dialog.title === "GigaCode project settings")
    expect(editor.options.find((option: any) => option.value === "save").disabled).toBe(true)
    expect(editor.placeholder).not.toContain("Unsaved changes")
    expect(f.dialogs.filter(dialog => dialog.kind === "confirm")).toHaveLength(0)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("global model resets show their actual fallback and a scope-labelled review", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.globalSettingsView.inherited.models = { roles: { reviewer: "fixture/model#fast" } }
  f.globalSettingsView.overrides = { models: { roles: { reviewer: "inherit" } } }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "models", "roles.reviewer", "reset", "back", "review", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const model = f.dialogs.find(dialog => dialog.title === "Workflow models").options.find((option: any) => option.value === "roles.reviewer")
    expect(model.description).toBe("Chat model · global default")
    const review = f.dialogs.find(dialog => dialog.title === "Global default changes")
    expect(review?.message).toContain("Chat model → built-in default (fixture/model#fast)")
    expect(review?.message).toContain("C:/profile/opencode.jsonc")
    expect(f.settingsSaves[0]?.input.options).toEqual({})
  } finally { await cleanup!() }
})

test("a server that returns project data for global scope is refused without any save", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  delete f.globalSettingsView.scope
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults")
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.title === "GigaCode settings unavailable")?.message).toContain("Reload")
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("a blocked editor can recheck save availability without losing its scoped draft", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.globalSettingsView.blocked = "Finish or cancel active workflows before saving settings."
  const prompt = f.context.ui.dialog.prompt
  f.context.ui.dialog.prompt = async options => {
    const value = await prompt(options)
    delete f.globalSettingsView.blocked
    return value
  }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "limits", "workers", "back", "refresh", "save"); f.enter("2"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const blocked = f.dialogs.find(dialog => dialog.title === "GigaCode global defaults")
    expect(blocked.placeholder).toContain("All projects")
    expect(blocked.options.find((option: any) => option.value === "refresh")?.title).toBe("Recheck save availability")
    expect(f.settingsReads.map(read => read.input.scope)).toEqual(["global", "global"])
    expect(f.settingsSaves[0]?.input.options).toEqual({ limits: { workers: 2 } })
    expect(f.settingsSaves[0]?.input.revision).toBe("global-revision")
  } finally { await cleanup!() }
})

test("rechecking changed settings preserves the draft and refuses to replace its revision", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.settingsView.blocked = "Finish active workflows before saving."
  const prompt = f.context.ui.dialog.prompt
  f.context.ui.dialog.prompt = async options => {
    const value = await prompt(options)
    f.settingsView.revision = "changed-on-disk"
    delete f.settingsView.blocked
    return value
  }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", "back", "refresh", "review", "back", undefined); f.enter("1"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.title === "Unable to recheck settings")?.message).toContain("Settings changed on disk")
    expect(f.dialogs.find(dialog => dialog.title === "Project setting changes")?.message).toContain("Workers: inherited (4) → 1")
    const editor = f.dialogs.findLast(dialog => dialog.title === "GigaCode project settings")
    expect(editor.options.find((option: any) => option.value === "save").disabled).toBe(true)
    expect(f.dialogs.find(dialog => dialog.title === "Discard unsaved changes?")).toBeDefined()
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("navigation retires a pending save-availability read before it can enable saving", async () => {
  const f = fixture(), rpc = f.context.client.rpc
  f.settingsView.blocked = "Finish active workflows before saving."
  let release!: (value: SettingsView) => void
  f.context.client.rpc = () => {
    const methods = rpc()
    return { ...methods, async settings(input: any, options: any) {
      const view = await methods.settings(input, options)
      return f.settingsReads.length === 2 ? new Promise<SettingsView>(resolve => { release = resolve }) : view
    } }
  }
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", "back", "refresh", "save"); f.enter("1"); f.confirm()
    const opening = f.event({ sessionId: "parent", command: "config", result: f.response })
    await settle()
    expect(release).toBeDefined()
    const dialogs = f.dialogs.length
    f.route({ type: "home" })
    release({ ...structuredClone(f.settingsView), blocked: undefined })
    await opening
    expect(f.settingsReads[1].options.signal.aborted).toBe(true)
    expect(f.dialogs).toHaveLength(dialogs)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("guided model selection stages a variant and saves only after a concrete confirmation", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "models", "default", "model:fixture/model", "variant:fast", "back", "save")
    f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const confirmation = f.dialogs.find(dialog => dialog.kind === "confirm")
    expect(confirmation).toBeDefined()
    expect(confirmation.message).toContain("fixture/model#fast")
    expect(f.settingsSaves).toHaveLength(1)
    expect(f.settingsSaves[0].input).toEqual({ sessionId: "parent", revision: "settings-revision", replaceAdvanced: true, options: { models: { default: "fixture/model#fast" } } })
    expect(f.settingsSaves[0].options.location.directory).toBe("C:/plugin-project")
  } finally { await cleanup!() }
})

test("model variant cancellation returns one level and keeps the mapping context and selection", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.globalSettingsView.overrides = { models: { roles: { reviewer: "fixture/model#fast" } } }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "models", "roles.reviewer", "model:fixture/model", undefined, "model:fixture/model", "base", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const pickers = f.dialogs.filter(dialog => dialog.title === "Select workflow model")
    expect(pickers).toHaveLength(2)
    for (const picker of pickers) {
      expect(picker.placeholder).toContain("Global defaults")
      expect(picker.placeholder).toContain("Role: reviewer")
      expect(picker.current).toBe("model:fixture/model")
      expect(picker.options.at(-1).title).toBe("Back to models")
    }
    for (const variant of f.dialogs.filter(dialog => dialog.title === "Model variant")) {
      expect(variant.current).toBe("variant:fast")
      expect(variant.placeholder).toContain("fixture/model")
      expect(variant.options.at(-1).title).toBe("Back to model selection")
    }
    expect(f.settingsSaves[0]?.input.options).toEqual({ models: { roles: { reviewer: "fixture/model" } } })
  } finally { await cleanup!() }
})

test("choice pickers distinguish inherited settings from explicit overrides", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.globalSettingsView.inherited.parallelWrites = true
  f.globalSettingsView.inherited.models = { roles: { reviewer: "fixture/model#fast" } }
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "advanced", "writer", "back", "writer", "serial", "writer", "back", "back", "models", "roles.reviewer", "back", "back", "save"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.filter(dialog => dialog.title === "Writer policy").map(dialog => dialog.current)).toEqual(["reset", "reset", "serial"])
    expect(f.dialogs.find(dialog => dialog.title === "Select workflow model")?.current).toBe("reset")
    expect(f.settingsSaves[0]?.input.options).toEqual({ parallelWrites: false })
  } finally { await cleanup!() }
})

test("guided limits convert deadline seconds to milliseconds in the reviewed save", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workerMs", "back", "save")
    f.enter("12.5"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.kind === "prompt")?.title).toContain("seconds")
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("12.5 seconds")
    expect(f.settingsSaves[0]?.input.options).toEqual({ limits: { workerMs: 12_500 } })
  } finally { await cleanup!() }
})

test("guided checks collect an executable command, criteria and timeout before saving", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "checks", "add", "back", "save")
    f.enter("types", "bun run typecheck", "verification, compatibility", "30"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ checks: [{ id: "types", command: "bun run typecheck", criterionIds: ["verification", "compatibility"], timeoutMs: 30_000 }] })
    const message = f.dialogs.find(dialog => dialog.kind === "confirm")?.message
    for (const value of ["types", "bun run typecheck", "compatibility", "30 seconds"]) expect(message).toContain(value)
  } finally { await cleanup!() }
})

test("invalid check fields retry in place with scope and keep earlier answers", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit global defaults", "checks", "add", "back", "save"); f.confirm()
    f.enter("types", "", "bun run typecheck", "verification", "0", "12.5")
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    const prompts = f.dialogs.filter(dialog => dialog.kind === "prompt")
    expect(prompts.map(dialog => dialog.title)).toEqual(["Check ID", "Check command", "Check command", "Criterion IDs", "Check timeout (seconds)", "Check timeout (seconds)"])
    expect(prompts[2].value).toBe("")
    expect(prompts[5].value).toBe("0")
    for (const prompt of prompts) expect(prompt.description).toContain("Global defaults")
    expect(f.settingsSaves[0]?.input.options).toEqual({ checks: [{ id: "types", command: "bun run typecheck", criterionIds: ["verification"], timeoutMs: 12_500 }] })
  } finally { await cleanup!() }
})

test("cancelling a partially completed check keeps other draft settings and stages no check", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", "back", "checks", "add", "back", "save"); f.confirm()
    f.enter("1", "types", "bun run typecheck", "verification", undefined)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ limits: { workers: 1 } })
    expect(f.dialogs.filter(dialog => dialog.title === "Invalid check")).toHaveLength(0)
  } finally { await cleanup!() }
})

test("guided limits reject invalid values and keep the draft unchanged", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", undefined)
    f.enter("0")
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.title === "Invalid limit")?.message).toContain("at least 1")
    expect(f.dialogs.findLast(dialog => dialog.title === "GigaCode project settings").options.find((option: any) => option.value === "save").disabled).toBe(true)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("guided reset removes only selected model and limit overrides and restores inherited checks", async () => {
  const f = fixture()
  Object.assign(f.settingsView.overrides, { models: { roles: { reviewer: "fixture/model" }, stages: { review: "inherit" } }, limits: { workers: 1, steps: 8 }, checks: [] })
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "models", "roles.reviewer", "reset", "back", "limits", "workers", "back", "checks", "reset", "back", "save")
    f.enter("inherit"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ models: { stages: { review: "inherit" } }, limits: { steps: 8 } })
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("inherited")
  } finally { await cleanup!() }
})

test("an interrupted guided prompt never saves or shows stale feedback", async () => {
  for (const interrupt of ["navigation", "reconnect", "dispose"]) {
    const f = fixture(), cleanup = await plugin.setup(f.context as any)
    try {
      f.seed(family, ["parent", "supervisor", "worker"])
      f.route({ type: "session", sessionID: "parent" })
      let release!: (value: string) => void
      f.context.ui.dialog.prompt = () => new Promise(resolve => { release = resolve })
      f.choose("Configuration/Edit project settings", "limits", "workers", "back", "save"); f.confirm()
      const editing = f.event({ sessionId: "parent", command: "config", result: f.response })
      await settle()
      expect(release).toBeDefined()
      if (interrupt === "navigation") f.route({ type: "home" })
      else if (interrupt === "reconnect") await f.nativeEvent("server.connected")
      else await cleanup!()
      release("2"); await editing
      expect(f.settingsReads[0].options.signal.aborted).toBe(true)
      expect(f.settingsSaves).toHaveLength(0)
      expect(f.toasts).toHaveLength(0)
      expect(f.dialogs.filter(dialog => dialog.kind === "confirm")).toHaveLength(0)
    } finally { await cleanup!() }
  }
})

test("editing and removing checks preserve the rest of the replacement list", async () => {
  const f = fixture()
  Object.assign(f.settingsView.overrides, { checks: [
    { id: "test", command: "bun test", criterionIds: ["verification"] },
    { id: "types", command: "bun run types", criterionIds: ["verification"] },
  ] })
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "checks", "check:1", "edit", "check:0", "remove", "back", "save")
    f.enter("types", "bun run typecheck", "verification", ""); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves[0]?.input.options).toEqual({ checks: [{ id: "types", command: "bun run typecheck", criterionIds: ["verification"] }] })
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("worker deadline")
  } finally { await cleanup!() }
})

test("declining a concrete save leaves project settings unwritten", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "models", "roles.reviewer", "inherit", "back", "save", undefined)
    f.decide(false, true)
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.kind === "confirm")?.message).toContain("Role: reviewer")
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("duplicate check IDs are rejected without changing inherited checks", async () => {
  const f = fixture()
  f.settingsView.inherited.checks = [{ id: "test", command: "bun test", criterionIds: ["verification"] }]
  const cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "checks", "add", undefined)
    f.enter("test", "bun test", "verification", "")
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.dialogs.find(dialog => dialog.title === "Invalid check")?.message).toContain("Duplicate check ID")
    expect(f.settingsSaves).toHaveLength(0)
    expect(f.settingsView.overrides).toEqual({})
  } finally { await cleanup!() }
})

test("new command feedback retires a pending settings edit before replacing its dialog", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    let release!: (value: string) => void
    f.context.ui.dialog.prompt = () => new Promise(resolve => { release = resolve })
    f.choose("Configuration/Edit project settings", "limits", "workers")
    const editing = f.event({ sessionId: "parent", command: "config", result: f.response })
    await settle()
    await f.event({ sessionId: "parent", command: "status", result: { runs: [] } }); await settle()
    expect(f.settingsReads[0].options.signal.aborted).toBe(true)
    const dialogs = f.dialogs.length
    release("1"); await editing
    expect(f.dialogs).toHaveLength(dialogs)
    expect(f.settingsSaves).toHaveLength(0)
  } finally { f.close(); await cleanup!() }
})

test("other command results are visible only in their initiating session", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "other", command: "status", result: { runs: [] } })
    expect(f.dialogs).toHaveLength(0)
    await f.event({ sessionId: "parent", command: "status", result: { runs: [] } })
    await settle()
    expect(f.dialogs[0].title).toBe("GigaCode workflows")
  } finally { f.close(); await cleanup!() }
})

test("native command failures give actionable visible errors without another RPC", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "bogus", error: "Unknown gigacode command: bogus. Usage: /gigacode config" })
    expect(f.dialogs[0].title).toBe("GigaCode command error")
    expect(f.dialogs[0].message).toContain("Unknown gigacode command")
    expect(f.calls).toBe(0)
  } finally { await cleanup!() }
})

test("an unexpected settings presentation failure shows a native error notification without replaying the command", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: {} })
    expect(f.toasts).toEqual([{ title: "GigaCode settings error", message: "GigaCode returned no effective configuration. Check the installation and restart OpenCode.", variant: "error", sessionID: "parent" }])
    expect(f.calls).toBe(0)
    expect(f.controls).toHaveLength(0)
  } finally { await cleanup!() }
})

test("presentation error notifications redact credentials and bound native notification text", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.context.ui.dialog.select = async () => { throw new Error("Connection failed:\nAuthorization: Bearer fixture-secret-abc " + "x".repeat(900)) }
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.toasts).toHaveLength(1)
    expect(f.toasts[0].message).not.toContain("fixture-secret-abc")
    expect(f.toasts[0].message).toContain("[REDACTED]")
    expect(f.toasts[0].message).not.toContain("\n")
    expect(f.toasts[0].message.length).toBeLessThanOrEqual(400)
  } finally { await cleanup!() }
})

test("an unexpected workflow dialog failure notifies once and does not replay controls on reconnect", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.context.ui.dialog.select = async () => { throw new Error("The native workflow dialog disconnected") }
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    expect(f.toasts).toEqual([{ title: "GigaCode workflow error", message: "The native workflow dialog disconnected", variant: "error", sessionID: "parent" }])
    await f.nativeEvent("server.connected")
    expect(f.toasts).toHaveLength(1)
    expect(f.controls).toHaveLength(0)
    expect(f.workflowReads).toHaveLength(1)
  } finally { await cleanup!() }
})

test("a normal native settings dialog abort does not show an error notification", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.context.ui.dialog.select = async () => { throw new DOMException("The dialog was dismissed", "AbortError") }
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.toasts).toEqual([])
    expect(f.settingsSaves).toHaveLength(0)
  } finally { await cleanup!() }
})

test("a failed command-result viewer falls back to a native error notification without retrying the command", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.context.ui.dialog.alert = async () => { throw new Error("The native command result viewer disconnected") }
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", error: "Unable to read workflow state" })
    expect(f.toasts).toEqual([{ title: "GigaCode command error", message: "The native command result viewer disconnected", variant: "error", sessionID: "parent" }])
    expect(f.calls).toBe(0)
    expect(f.controls).toHaveLength(0)
  } finally { await cleanup!() }
})

test("a command-viewer failure delivered after reconnect does not notify from the retired dialog", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let reject!: (error: Error) => void
  f.context.ui.dialog.alert = () => new Promise((_resolve, fail) => { reject = fail })
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    const pending = f.event({ sessionId: "parent", command: "status", error: "Unable to read workflow state" })
    await settle()
    await f.nativeEvent("server.connected")
    reject(new Error("The old command viewer disconnected"))
    await pending
    expect(f.toasts).toEqual([])
    expect(f.controls).toHaveLength(0)
  } finally { await cleanup!() }
})

test("unavailable native error notifications do not reject handlers or retry commands", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let notifications = 0
  f.context.ui.toast.show = () => { notifications++; throw new Error("Native notification delivery unavailable") }
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "config", result: {} })
    expect(notifications).toBe(1)
    expect(f.calls).toBe(0)
    expect(f.controls).toHaveLength(0)
  } finally { await cleanup!() }
})

test("a committed settings save stays successful when its native success notification is unavailable", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.context.ui.toast.show = () => { throw new Error("Native notification delivery unavailable") }
  try {
    f.seed(family, ["parent", "supervisor", "worker"])
    f.route({ type: "session", sessionID: "parent" })
    f.choose("Configuration/Edit project settings", "limits", "workers", "back", "save")
    f.enter("1"); f.confirm()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.settingsSaves).toHaveLength(1)
    expect(f.settingsSaves[0].input.options).toEqual({ limits: { workers: 1 } })
    expect(f.dialogs.filter(dialog => dialog.title === "Unable to confirm settings save")).toEqual([])
    expect(f.controls).toHaveLength(0)
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

test("existing status feedback opens a searchable workflow snapshot in its initiating conversation", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status run_1", result: { run: { id: "run_1" } } }); await settle()
    expect(f.workflowReads).toHaveLength(1)
    expect(f.workflowReads[0].input).toEqual({ sessionId: "parent", runId: "run_1" })
    expect(f.dialogs[0].title).toBe("GigaCode workflows")
    expect(f.dialogs[0].placeholder).toContain("Search")
    for (const text of ["execution", "running", "Fix parser", "fixture/model", "worker", "unknown"]) expect(JSON.stringify(f.dialogs[0].options)).toContain(text)
    expect(f.layers).toHaveLength(0)
  } finally { f.close(); await cleanup!() }
})

test("workflow rows show the run ID and exact saved proposal revision", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  Object.assign(f.workflowResponse.runs[0]!, { status: "ready", revision: 9, proposalRevision: 4 })
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const row = f.dialogs[0].options.find((row: any) => row.category === "Workflow")
    expect(row.description).toContain("run_1")
    expect(row.description).toContain("saved proposal @4")
    expect(row.description).not.toContain("proposal @9")
    expect(f.dialogs[0].options.find((row: any) => row.title === "Run ID").description).toBe("run_1")
    expect(f.dialogs[0].options.find((row: any) => row.title === "Status")?.description).toBe("execution · ready")
    expect(f.dialogs[0].options.find((row: any) => row.title === "Saved proposal revision").description).toBe("@4")
    expect(f.dialogs[0].actions.some((action: any) => /settings|config/i.test(action.title))).toBe(false)
  } finally { f.close(); await cleanup!() }
})

test("Enter on a workflow opens readable vertical actions and Back preserves the selected workflow", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const value = f.dialogs[0].options[0].value
    f.resolve(value); await settle()
    const menu = f.dialogs.at(-1)
    expect(menu.title).toBe("GigaCode workflow actions")
    expect(menu.options.map((option: any) => option.title)).toEqual(["Inspect", "Run saved proposal", "Export", "Pause", "Cancel", "Open agent session", "Back to workflows"])
    f.resolve("back"); await settle()
    expect(f.dialogs.at(-1)).toMatchObject({ title: "GigaCode workflows", current: value })
    expect(f.controls).toHaveLength(0)
  } finally { f.close(); await cleanup!() }
})

test("Inspect reads the selected run through scoped controls and returns to its selected row", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.workflowResponse.runs.push({ ...structuredClone(f.workflowResponse.runs[0]!), id: "run_2", objective: "Review the transport" })
  let release!: (value: object) => void
  f.control(() => new Promise(resolve => { release = resolve }))
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const panel = f.dialogs[0]
    const row = panel.options.find((row: any) => JSON.parse(row.value)[0] === "run_2" && row.category === "Tasks")
    const action = workflowAction(f, panel, "Inspect")
    expect(panel.actions.map((action: any) => action.title)).toEqual(["Actions"])
    expect(panel.actions[0].bind).toBe("ctrl+a")
    await action.onTrigger(row.value); await settle()
    expect(f.controls[0].input).toEqual({ text: "inspect run_2", sessionId: "parent" })
    expect(f.controls[0].options.location).toEqual({ directory: "C:/plugin-project" })
    expect(f.controls[0].options.signal).toBeInstanceOf(AbortSignal)
    f.choose("0", undefined)
    release({ run: { id: "run_2", objective: "transport findings", status: "running" }, events: [] }); await settle()
    expect(f.dialogs.find(dialog => dialog.title === "GigaCode inspection")?.kind).toBe("select")
    expect(f.dialogs.find(dialog => dialog.title === "Workflow overview")?.message).toContain("transport findings")
    expect(f.dialogs.findLast(dialog => dialog.title === "GigaCode workflows")).toMatchObject({ current: row.value })
  } finally { f.close(); await cleanup!() }
})

test("Run saved proposal confirms and executes the selected run's saved revision rather than its graph revision", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  Object.assign(f.workflowResponse.runs[0]!, { status: "ready", revision: 9, proposalRevision: 4 })
  f.workflowResponse.runs.push({ ...structuredClone(f.workflowResponse.runs[0]!), id: "run_2", objective: "Review the transport", revision: 12, proposalRevision: 7 })
  f.confirm()
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const panel = f.dialogs[0]
    const row = panel.options.find((row: any) => JSON.parse(row.value)[0] === "run_2" && row.category === "Workflow")
    const action = workflowAction(f, panel, "Run saved proposal")
    await action.onTrigger(row.value); await settle()
    const confirmation = f.dialogs.find(dialog => dialog.kind === "confirm")
    expect(confirmation.message).toContain("Review the transport")
    expect(confirmation.message).toContain("Run: run_2")
    expect(confirmation.message).toContain("Saved proposal revision: 7")
    expect(f.controls.map(call => call.input)).toEqual([{ text: "run run_2@7", sessionId: "parent" }])
    expect(f.controls[0].options.location).toEqual({ directory: "C:/plugin-project" })
    expect(f.dialogs.findLast(dialog => dialog.kind === "select").current).toBe(row.value)
  } finally { f.close(); await cleanup!() }
})

test("Run saved proposal refuses execution when its confirmation refresh fails", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  Object.assign(f.workflowResponse.runs[0]!, { status: "ready", proposalRevision: 4 })
  f.confirm()
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    f.workflow(async () => { throw new Error("confirmation refresh disconnected") })
    await workflowAction(f, f.dialogs[0], "Run saved proposal").onTrigger(f.dialogs[0].options[0].value)
    await settle()
    expect(f.controls).toHaveLength(0)
    expect(f.dialogs.findLast(dialog => dialog.kind === "select").options[0].description).toContain("confirmation refresh disconnected")
  } finally { f.close(); await cleanup!() }
})

test("a ready workflow without a saved proposal keeps Run unavailable despite its graph revision", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  Object.assign(f.workflowResponse.runs[0]!, { status: "ready", revision: 9 })
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    await workflowAction(f, f.dialogs[0], "Run saved proposal").onTrigger(f.dialogs[0].options[0].value)
    const option = f.dialogs.at(-1).options.find((option: any) => option.value === "run")
    expect(option.disabled).toBe(true)
    expect(option.description).toContain("saved proposal")
    expect(f.controls).toHaveLength(0)
    expect(f.dialogs.some(dialog => dialog.kind === "confirm")).toBe(false)
  } finally { f.close(); await cleanup!() }
})

test("a proposal changed during confirmation is never substituted for the exact confirmed revision", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  const run = f.workflowResponse.runs[0]!
  Object.assign(run, { status: "ready", proposalRevision: 4 })
  let release!: (value: boolean) => void
  const confirm = f.context.ui.dialog.confirm
  f.context.ui.dialog.confirm = async options => { await confirm(options); return new Promise(resolve => { release = resolve }) }
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    await workflowAction(f, f.dialogs[0], "Run saved proposal").onTrigger(f.dialogs[0].options[0].value)
    run.generation++; run.proposalRevision = 5
    release(true); await settle()
    expect(f.controls).toHaveLength(0)
    expect(f.dialogs.find(dialog => dialog.kind === "confirm").message).toContain("Saved proposal revision: 4")
    expect(f.toasts.some(toast => toast.message.includes("proposal changed"))).toBe(true)
  } finally { f.close(); await cleanup!() }
})

test("Run confirmation keeps the exact ID and saved revision above a bounded objective preview", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  Object.assign(f.workflowResponse.runs[0]!, { status: "ready", proposalRevision: 4, objective: "Long workflow description. ".repeat(60) })
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    await workflowAction(f, f.dialogs[0], "Run saved proposal").onTrigger(f.dialogs[0].options[0].value)
    const message = f.dialogs.find(dialog => dialog.kind === "confirm").message
    expect(message.startsWith("Run: run_1\nSaved proposal revision: 4")).toBe(true)
    expect(message).toContain("Objective (preview)")
    expect(message).toContain("[truncated]")
    expect(message.length).toBeLessThan(500)
    expect(f.controls).toHaveLength(0)
  } finally { f.close(); await cleanup!() }
})

test("retiring a pending Run confirmation prevents its late approval from executing", async () => {
  for (const interrupt of ["navigation", "replacement", "reconnect", "dispose"]) {
    const f = fixture(), cleanup = await plugin.setup(f.context as any)
    f.seed(family, ["parent", "supervisor", "worker"])
    Object.assign(f.workflowResponse.runs[0]!, { status: "ready", proposalRevision: 4 })
    let release!: (value: boolean) => void
    const confirm = f.context.ui.dialog.confirm
    f.context.ui.dialog.confirm = async options => { await confirm(options); return new Promise(resolve => { release = resolve }) }
    try {
      f.route({ type: "session", sessionID: "parent" })
      await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
      await workflowAction(f, f.dialogs[0], "Run saved proposal").onTrigger(f.dialogs[0].options[0].value)
      if (interrupt === "navigation") f.route({ type: "home" })
      else if (interrupt === "replacement") await f.event({ sessionId: "parent", command: "config", result: f.response })
      else if (interrupt === "reconnect") await f.nativeEvent("server.connected")
      else await cleanup!()
      const dialogs = f.dialogs.length
      release(true); await settle()
      expect(f.controls).toHaveLength(0)
      expect(f.dialogs).toHaveLength(dialogs)
      expect(f.toasts).toHaveLength(0)
    } finally { f.close(); await cleanup!() }
  }
})

test("Export suppresses duplicate pending requests and returns artifact paths to the selected workflow", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release!: (value: object) => void
  f.control(() => new Promise(resolve => { release = resolve }))
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const panel = f.dialogs[0], value = panel.options[0].value
    const action = workflowAction(f, panel, "Export")
    await action.onTrigger(value); await action.onTrigger(value); await settle()
    expect(f.controls.map(call => call.input)).toEqual([{ text: "export run_1", sessionId: "parent" }])
    expect(f.dialogs.map(dialog => dialog.title)).toEqual(["GigaCode workflows", "GigaCode workflow actions", "GigaCode workflows"])
    expect(panel.actions.some((action: any) => action.title === "Export")).toBe(false)
    f.choose("1", undefined)
    release({ json: "C:/project/.gigacode/artifacts/run_1.json", dashboard: "C:/project/.gigacode/artifacts/run_1.html" }); await settle()
    expect(f.dialogs.find(dialog => dialog.title === "GigaCode export")?.kind).toBe("select")
    expect(f.dialogs.find(dialog => dialog.title === "HTML dashboard")?.message).toContain("run_1.html")
    expect(f.dialogs.findLast(dialog => dialog.title === "GigaCode workflows").current).toBe(value)
    await action.onTrigger(value); await settle()
    expect(f.controls).toHaveLength(1)
  } finally { f.close(); await cleanup!() }
})

test("retiring or reconnecting the panel aborts pending inspection and suppresses its late result and old callbacks", async () => {
  for (const interrupt of ["close", "navigation", "replacement", "reconnect", "dispose"]) {
    const f = fixture(), cleanup = await plugin.setup(f.context as any)
    f.seed(family, ["parent", "supervisor", "worker"])
    let release!: (value: object) => void
    f.control(() => new Promise(resolve => { release = resolve }))
    try {
      f.route({ type: "session", sessionID: "parent" })
      await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
      const panel = f.dialogs[0], value = panel.options[0].value
      const action = workflowAction(f, panel, "Inspect")
      await action.onTrigger(value); await settle()
      if (interrupt === "close") { f.close(); await settle() }
      else if (interrupt === "navigation") f.route({ type: "home" })
      else if (interrupt === "replacement") await f.event({ sessionId: "parent", command: "config", result: f.response })
      else if (interrupt === "reconnect") await f.nativeEvent("server.connected")
      else await cleanup!()
      expect(f.controls[0].options.signal.aborted).toBe(true)
      const dialogs = f.dialogs.length
      release({ evidence: "late inspection" }); await settle()
      await action.onTrigger(value); await settle()
      expect(f.controls).toHaveLength(1)
      expect(f.dialogs).toHaveLength(dialogs)
      expect(f.toasts).toHaveLength(0)
    } finally { f.close(); await cleanup!() }
  }
})

test("an open workflow dialog refreshes durable rows without replacing the native dialog", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: { runs: [] } }); await settle()
    const dialog = f.dialogs[0]
    f.workflowResponse.runs[0]!.generation++
    f.workflowResponse.runs[0]!.tasks[0]!.status = "succeeded"
    await Bun.sleep(2100)
    expect(f.workflowReads).toHaveLength(2)
    expect(f.dialogs).toHaveLength(1)
    expect(dialog.options.find((row: any) => row.category === "Tasks").description).toContain("succeeded")
  } finally { f.close(); await cleanup!() }
})

test("workflow snapshot refreshes never overlap a held read", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release: ((value: WorkflowSnapshot) => void) | undefined
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    f.workflow(() => new Promise(resolve => { release = resolve }))
    await Bun.sleep(4100)
    expect(f.workflowReads).toHaveLength(2)
  } finally { release?.(f.workflowResponse); f.close(); await cleanup!(); await settle() }
})

test("reconnect immediately reloads an open workflow from durable state", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    f.workflowResponse.runs[0]!.generation++
    f.workflowResponse.runs[0]!.status = "paused"
    await f.nativeEvent("server.connected")
    expect(f.workflowReads).toHaveLength(2)
    expect(f.dialogs[0].options[0].description).toContain("paused")
  } finally { f.close(); await cleanup!() }
})

test("navigation aborts a pending workflow read and ignores its late snapshot", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release!: (value: WorkflowSnapshot) => void
  f.workflow(() => new Promise(resolve => { release = resolve }))
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    f.route({ type: "home" })
    expect(f.workflowReads[0].options.signal?.aborted).toBe(true)
    release(f.workflowResponse); await settle()
    expect(f.dialogs).toHaveLength(0)
  } finally { await cleanup!() }
})

test("configuration feedback replaces a pending workflow view without a late dialog takeover", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release!: (value: WorkflowSnapshot) => void
  f.workflow(() => new Promise(resolve => { release = resolve }))
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    await f.event({ sessionId: "parent", command: "config", result: f.response })
    expect(f.workflowReads[0].options.signal.aborted).toBe(true)
    release(f.workflowResponse); await settle()
    expect(f.dialogs.map(dialog => dialog.title)).toEqual(["GigaCode settings"])
  } finally { f.close(); await cleanup!() }
})

test("failed workflow snapshots remain visible and recover on reconnect", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.workflow(async () => { throw new Error("fixture disconnected") })
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    expect(f.dialogs).toHaveLength(1)
    expect(f.dialogs[0].options[0].title).toContain("unavailable")
    expect(f.dialogs[0].options[0].description).toContain("fixture disconnected")
    f.workflow(async () => f.workflowResponse)
    await f.nativeEvent("server.connected")
    expect(f.dialogs[0].options[0].title).toBe("Fix the parser")
  } finally { f.close(); await cleanup!() }
})

test("a refresh failure while workflow actions are open prevents a retained Pause selection from mutating stale state", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.seed(family, ["parent", "supervisor", "worker"])
  let reject!: (error: Error) => void
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const value = f.dialogs[0].options[0].value
    f.workflow(() => new Promise((_resolve, fail) => { reject = fail }))
    await f.nativeEvent("server.connected")
    f.resolve(value); await settle()
    expect(f.dialogs.at(-1).title).toBe("GigaCode workflow actions")
    f.workflow(async () => { throw new Error("workflow refresh disconnected") })
    reject(new Error("workflow refresh disconnected")); await settle()
    f.resolve("pause"); await settle()
    expect(f.controls).toHaveLength(0)
    expect(f.dialogs.at(-1).title).toBe("GigaCode workflows")
    expect(f.dialogs.at(-1).options[0].description).toContain("workflow refresh disconnected")
  } finally { f.close(); await cleanup!() }
})

test("disconnected workflow rows cannot open actions through Enter or a retained footer callback", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.seed(family, ["parent", "supervisor", "worker"])
  let reject!: (error: Error) => void
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const panel = f.dialogs[0], value = panel.options[0].value
    f.workflow(() => new Promise((_resolve, fail) => { reject = fail }))
    await f.nativeEvent("server.connected")
    const retained = panel.actions[0]
    reject(new Error("workflow refresh disconnected")); await settle()
    expect(panel.actions).toEqual([])
    retained.onTrigger(value); await settle()
    expect(f.dialogs).toHaveLength(1)
    f.resolve(value); await settle()
    expect(f.dialogs.some(dialog => dialog.title === "GigaCode workflow actions")).toBe(false)
    expect(f.dialogs.at(-1).title).toBe("GigaCode workflows")
    expect(f.controls).toHaveLength(0)
  } finally { f.close(); await cleanup!() }
})

test("Enter during a pending control cannot invalidate its request or open a second mutation menu", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release!: (value: object) => void
  f.control(async input => input.text.startsWith("pause ") ? new Promise(resolve => { release = resolve }) : {})
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const value = f.dialogs[0].options[0].value
    await workflowAction(f, f.dialogs[0], "Pause").onTrigger(value)
    const signal = f.controls[0].options.signal
    expect(signal.aborted).toBe(false)
    const menus = f.dialogs.filter(dialog => dialog.title === "GigaCode workflow actions").length
    f.resolve(value); await settle()
    if (f.dialogs.at(-1).title === "GigaCode workflow actions") { f.resolve("cancel"); await settle() }
    expect(f.controls).toHaveLength(1)
    expect(signal.aborted).toBe(false)
    expect(f.dialogs.filter(dialog => dialog.title === "GigaCode workflow actions")).toHaveLength(menus)
    expect(f.dialogs.at(-1).title).toBe("GigaCode workflows")
    release({}); await settle()
  } finally { release?.({}); f.close(); await cleanup!() }
})

test("pause acts through the initiating-session RPC and refreshes the durable snapshot", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const action = workflowAction(f, f.dialogs[0], "Pause")
    expect(action).toBeDefined()
    await action.onTrigger(f.dialogs[0].options[0].value); await settle()
    expect(f.controls[0].input).toEqual({ text: "pause run_1", sessionId: "parent" })
    expect(f.workflowReads).toHaveLength(2)
    expect(f.dialogs.map(dialog => dialog.title)).toEqual(["GigaCode workflows", "GigaCode workflow actions", "GigaCode workflows"])
  } finally { f.close(); await cleanup!() }
})

test("a paused workflow offers an explicit resume control", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.workflowResponse.runs[0]!.status = "paused"
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const action = workflowAction(f, f.dialogs[0], "Resume")
    expect(action).toBeDefined()
    await action.onTrigger(f.dialogs[0].options[0].value); await settle()
    expect(f.controls[0].input).toEqual({ text: "resume run_1", sessionId: "parent" })
  } finally { f.close(); await cleanup!() }
})

test("cancellation uses the existing control RPC once without adding transcript input", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const action = workflowAction(f, f.dialogs[0], "Cancel")
    expect(action).toBeDefined()
    await action.onTrigger(f.dialogs[0].options[0].value); await settle()
    expect(f.controls.map(call => call.input)).toEqual([{ text: "cancel run_1", sessionId: "parent" }])
    expect(f.calls).toBe(0)
  } finally { f.close(); await cleanup!() }
})

test("live updates preserve task selection identities when earlier results appear", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  const run = f.workflowResponse.runs[0]!
  run.tasks.push({ ...structuredClone(run.tasks[0]!), id: "other", sessionId: "other-worker" })
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const selected = f.dialogs[0].options.find((row: any) => row.description.includes("other-worker")).value
    run.generation++; run.tasks[0]!.result = { summary: "Parser fixed", current: true }
    await f.nativeEvent("server.connected")
    expect(f.dialogs[0].options.find((row: any) => row.value === selected).description).toContain("other-worker")
  } finally { f.close(); await cleanup!() }
})

test("older durable generations cannot regress the displayed workflow", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  const run = f.workflowResponse.runs[0]!
  run.generation = 5; run.status = "paused"
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    run.generation = 4; run.status = "running"
    await f.nativeEvent("server.connected")
    expect(f.dialogs[0].options[0].description).toContain("paused")
  } finally { f.close(); await cleanup!() }
})

test("post-control refresh waits for an older read then fetches a new durable snapshot", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release!: (value: WorkflowSnapshot) => void
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const old = structuredClone(f.workflowResponse)
    let reads = 0
    f.workflow(async () => ++reads === 1 ? new Promise(resolve => { release = resolve }) : f.workflowResponse)
    await f.nativeEvent("server.connected")
    f.workflowResponse.runs[0]!.generation++; f.workflowResponse.runs[0]!.status = "cancelled"
    await workflowAction(f, f.dialogs[0], "Cancel").onTrigger(f.dialogs[0].options[0].value)
    await settle()
    expect(f.workflowReads).toHaveLength(2)
    release(old); await settle()
    expect(f.workflowReads).toHaveLength(3)
    expect(f.dialogs[0].options[0].description).toContain("cancelled")
  } finally { f.close(); await cleanup!() }
})

test("Open agent session navigates to the selected worker's actual native conversation", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const action = workflowAction(f, f.dialogs[0], "Open agent session")
    expect(action).toBeDefined()
    await action.onTrigger(f.dialogs[0].options.find((row: any) => row.category === "Tasks").value)
    expect(f.navigations).toEqual([{ type: "session", sessionID: "worker" }])
    expect(f.controls).toHaveLength(0)
  } finally { f.close(); await cleanup!() }
})

test("a failed control is visible and never replayed by a reconnect", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  f.control(async () => { throw new Error("Cancellation could not establish native settlement") })
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    await workflowAction(f, f.dialogs[0], "Cancel").onTrigger(f.dialogs[0].options[0].value)
    await settle()
    expect(f.toasts.some(toast => toast.title === "GigaCode control error" && toast.message.includes("native settlement"))).toBe(true)
    await f.nativeEvent("server.connected")
    expect(f.controls).toHaveLength(1)
  } finally { f.close(); await cleanup!() }
})

test("closing the workflow dialog stops its timer and reconnect reads", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    f.close(); await settle()
    expect(f.workflowReads[0].options.signal.aborted).toBe(true)
    await f.nativeEvent("server.connected")
    await Bun.sleep(2100)
    expect(f.workflowReads).toHaveLength(1)
  } finally { await cleanup!() }
})

test("disposal aborts a pending snapshot and suppresses late workflow UI", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  let release!: (value: WorkflowSnapshot) => void
  f.workflow(() => new Promise(resolve => { release = resolve }))
  f.route({ type: "session", sessionID: "parent" })
  await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
  await cleanup!(); await cleanup!()
  expect(f.workflowReads[0].options.signal.aborted).toBe(true)
  release(f.workflowResponse); await settle()
  await f.nativeEvent("server.connected")
  expect(f.workflowReads).toHaveLength(1)
  expect(f.dialogs).toHaveLength(0)
  expect(f.disposed).toBe(1)
})

test("retained control callbacks cannot act after navigation to another initiating conversation", async () => {
  const f = fixture(), cleanup = await plugin.setup(f.context as any)
  try {
    f.route({ type: "session", sessionID: "parent" })
    await f.event({ sessionId: "parent", command: "status", result: {} }); await settle()
    const action = workflowAction(f, f.dialogs[0], "Cancel")
    const value = f.dialogs[0].options[0].value
    f.route({ type: "session", sessionID: "other" })
    await action.onTrigger(value); await settle()
    expect(f.controls).toHaveLength(0)
  } finally { f.close(); await cleanup!() }
})

import { describe, expect, test } from "bun:test"
import { ULTRA_AGENT_ID, ULTRA_AGENT_NAME, ULTRA_PRIMARY_SYSTEM } from "../src/agents.ts"
import { LEGACY_PRIMARY_SYSTEM } from "./legacy-primary-system.ts"
import { promptVersion } from "../src/workflow.ts"
import { agentModeFixture } from "./agent-mode-fixture.ts"
import type { Workflow } from "../src/types.ts"

type Fixture = Awaited<ReturnType<typeof agentModeFixture>>
function tool(value: Fixture, name: "ultra_task" | "ultra_control") {
  expect(value.tools.has(name)).toBe(true)
  return value.tools.get(name)!
}
async function launch(value: Fixture, update: Record<string, unknown> = {}) {
  return tool(value, "ultra_task").execute({ objective: "Design a clear workspace status view", mode: "plan" }, value.toolContext(update))
}
const offeredTools = () => Object.fromEntries([
  "read", "grep", "question", "edit", "write", "shell", "execute", "subagent", "third_party.read", "third_party.edit",
  "ultra_task", "ultra_control", "ultra_start", "ultra_execute", "ultra_submit", "ultra_check",
].map(name => [name, { name }]))

describe("Ultra primary agent", () => {
  test("updates the previous default in model context after native config precedence while preserving customization", async () => {
    const bundled = await agentModeFixture({ system: LEGACY_PRIMARY_SYSTEM })
    try {
      const agent = bundled.agents.get(ULTRA_AGENT_ID)
      expect(agent.system).toBe(LEGACY_PRIMARY_SYSTEM)
      const context = { sessionID: "parent", agent: "ultra", tools: offeredTools(), system: [{ type: "text", text: LEGACY_PRIMARY_SYSTEM }, { type: "text", text: "Preserve project-specific instructions." }] }
      await bundled.hooks.get("session.context")(context)
      expect(context.system[0]!.text).toBe(ULTRA_PRIMARY_SYSTEM)
      expect(context.system[1]!.text).toBe("Preserve project-specific instructions.")
      expect(agent.system).toBe(LEGACY_PRIMARY_SYSTEM)
      expect(agent.permissions).toEqual(bundled.policy)
      expect(agent.model).toEqual({ providerID: "fixture", id: "test" })
    } finally { await bundled.close() }
    const customized = LEGACY_PRIMARY_SYSTEM + "\nPrefer detailed explanations of the code."
    const custom = await agentModeFixture({ system: customized })
    try {
      const context = { sessionID: "parent", agent: "ultra", tools: offeredTools(), system: [{ type: "text", text: customized }] }
      await custom.hooks.get("session.context")(context)
      expect(context.system[0]!.text).toBe(customized)
      expect(custom.agents.get(ULTRA_AGENT_ID).system).toBe(customized)
    }
    finally { await custom.close() }
  })

  test("uses the native visible agent name without replacing the user's model or policies", async () => {
    const value = await agentModeFixture()
    try {
      expect(value.agents.get(ULTRA_AGENT_ID)).toMatchObject({ name: ULTRA_AGENT_NAME, mode: "primary", hidden: false, model: { providerID: "fixture", id: "test" }, permissions: value.policy })
      expect(value.agents.get("build").name).toBe("Build")
      expect(value.agents.get("ultra-worker").hidden).toBe(true)
    } finally { await value.close() }
  })

  test("configuration and status are ordinary native tool results with no graph or model input", async () => {
    const value = await agentModeFixture()
    try {
      const control = tool(value, "ultra_control")
      const config = await control.execute({ action: "config" }, value.toolContext())
      const status = await control.execute({ action: "status" }, value.toolContext({ id: "call_2" }))
      expect(config.content).toBeTruthy()
      expect(config.output).toMatchObject({ promptVersion, hostVersion: "2.0.25" })
      expect(status.content).toBeTruthy()
      expect(value.runs()).toEqual([])
      expect(value.synthetics).toEqual([])
      expect(value.feedback).toEqual([])
      expect(value.dispatches).toEqual([])
    } finally { await value.close() }
  })

  test("conversation in Ultra mode does not admit work from the text alone", async () => {
    const value = await agentModeFixture()
    try {
      const prompt = { sessionID: "parent", messageID: "message_1", prompt: { text: "Can you explain how this plugin works, including its limits and configuration? ".repeat(3) } }
      await value.hooks.get("session.prompt")(prompt)
      expect(prompt.prompt.text).toStartWith("Can you explain")
      expect(value.runs()).toEqual([])
      expect(value.dispatches).toEqual([])
      expect(value.synthetics).toEqual([])
    } finally { await value.close() }
  })

  test("a genuine task call binds one native supervisor and exact replay does not dispatch twice", async () => {
    const value = await agentModeFixture()
    try {
      const context = value.toolContext(), input = { objective: "Design a clear workspace status view", mode: "plan" }
      const first = await tool(value, "ultra_task").execute(input, context)
      const replay = await tool(value, "ultra_task").execute(input, context)
      expect(first.content).toBeTruthy()
      const progress = JSON.parse(first.content)
      expect(progress.run).toMatchObject({ id: first.output.run.id, objective: input.objective, mode: "plan" })
      expect(progress.tasks).toHaveLength(1)
      expect(progress.tasks[0]).toMatchObject({ role: "planner", instructions: expect.stringContaining("Objective") })
      expect(JSON.parse(replay.content)).toEqual(progress)
      expect(replay.output).toMatchObject({ run: first.output.run, replay: true })
      expect(value.runs()).toHaveLength(1)
      const run = value.runs()[0]!
      expect(run).toMatchObject({ parentSessionId: "parent", objective: input.objective, mode: "plan", supervisorSessionId: "child_1", capturedModel: { providerID: "fixture", id: "test" }, policy: value.policy })
      expect(value.dispatches).toHaveLength(1)
      expect(value.dispatches[0]).toMatchObject({ sessionID: "parent", messageID: "message_1", id: "call_1", input: { agent: "ultra-supervisor", background: true, model: "fixture/test" } })
      expect(value.progress).toEqual([expect.objectContaining({ sessionID: "child_1", runId: run.id, ultraPrelaunchBound: true })])
      expect(value.sessions.get("child_1").permissions.slice(0, value.policy.length)).toEqual(value.policy)
      expect(value.synthetics).toEqual([])
    } finally { await value.close() }
  })

  test("the primary supplies a small execution graph without starting a planning team", async () => {
    const value = await agentModeFixture({ checks: [{ id: "tests", command: "bun test", criterionIds: ["tests"] }] })
    const workflow: Workflow = { rationale: "The relevant file is already inspected; one scoped change needs review and a test run.", tasks: [
      { id: "fix", title: "Fix duration validation", role: "implementer", stage: "implementation", instructions: "Change only src/duration.ts to reject the inspected malformed input.", dependencies: [], writes: true, ownedPaths: ["src/duration.ts"] },
      { id: "review", title: "Review duration validation", role: "reviewer", stage: "review", instructions: "Inspect the change and assess the request against the resulting code.", dependencies: ["fix"], writes: false },
      { id: "verify", title: "Test duration validation", role: "verifier", stage: "verification", instructions: "Run the configured tests on the final candidate.", dependencies: ["fix"], writes: false, checkIds: ["tests"] },
    ] }
    try {
      const input = { objective: "Reject malformed duration input", mode: "execute", workflow }
      const context = value.toolContext()
      const result = await tool(value, "ultra_task").execute(input, context)
      const saved = value.runs()[0]!
      expect(result.output.run).toMatchObject({ phase: "execution", mode: "execute" })
      expect(saved.plans[0]!.rationale).toBe(workflow.rationale)
      expect(saved.tasks.map(task => task.spec)).toEqual(workflow.tasks)
      expect(saved.criteria).toEqual([
        { id: "request", description: input.objective, required: true, kind: "assessment" },
        { id: "tests", description: "Configured check evidence establishes tests.", required: true, kind: "check" },
      ])
      expect(value.dispatches).toHaveLength(1)
      expect((await tool(value, "ultra_task").execute(input, context)).output.replay).toBe(true)
      await expect(tool(value, "ultra_task").execute({ ...input, workflow: { ...workflow, rationale: "Changed graph rationale" } }, context)).rejects.toThrow("replay changed")
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("unsafe primary graphs fail before any native child is dispatched", async () => {
    const value = await agentModeFixture()
    try {
      await expect(tool(value, "ultra_task").execute({ objective: "Fix duration validation", mode: "execute", workflow: {
        rationale: "A small change", tasks: [{ id: "fix", title: "Fix duration", role: "implementer", stage: "implementation", instructions: "Change the parser.", dependencies: [], writes: true, ownedPaths: ["src/duration.ts"] }],
      } }, value.toolContext())).rejects.toThrow("review")
      expect(value.runs()).toEqual([])
      expect(value.dispatches).toEqual([])
    } finally { await value.close() }
  })

  test("model context guides proportionate delegation and exposes configured check IDs", async () => {
    const value = await agentModeFixture({ checks: [{ id: "tests", command: "bun test", criterionIds: ["tests"] }] })
    try {
      const context = { sessionID: "parent", agent: "ultra", tools: offeredTools(), system: [] as { type: string; text: string }[] }
      await value.hooks.get("session.context")(context)
      const text = context.system.map(part => part.text).join("\n")
      expect(text).toContain("smallest useful")
      expect(text).toContain("without spawning")
      expect(text).toContain("workflow")
      expect(text).toContain('"id":"tests"')
      expect(text).toContain("independent review")
    } finally { await value.close() }
  })

  test("specific status exposes technical work without changing the durable status receipt", async () => {
    const value = await agentModeFixture()
    try {
      const started = await launch(value)
      const run = value.runs()[0]!
      const status = await tool(value, "ultra_control").execute({ action: "status", runId: run.id }, value.toolContext({ id: "status_call" }))
      expect(status.output).toEqual({ run: started.output.run })
      const progress = JSON.parse(status.content)
      expect(progress.run).toMatchObject({ id: run.id, status: run.status, objective: run.objective })
      expect(progress.tasks.some((task: any) => task.instructions?.includes("Objective"))).toBe(true)
      expect(value.runs()).toHaveLength(1)
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("a replay cannot change the saved objective or mode", async () => {
    const value = await agentModeFixture()
    try {
      await launch(value)
      const context = value.toolContext()
      await expect(tool(value, "ultra_task").execute({ objective: "Replace the task with a different objective", mode: "plan" }, context)).rejects.toThrow()
      await expect(tool(value, "ultra_task").execute({ objective: "Design a clear workspace status view", mode: "execute" }, context)).rejects.toThrow()
      expect(value.runs()).toHaveLength(1)
      expect(value.runs()[0]!.objective).toBe("Design a clear workspace status view")
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("concurrent replay of one native invocation resolves with exactly one child dispatch", async () => {
    const value = await agentModeFixture()
    let entered!: () => void, release!: () => void
    const entry = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
    let first: Promise<any> | undefined, second: Promise<any> | undefined
    try {
      value.beforeDispatch(async () => { entered(); await held })
      const context = value.toolContext(), input = { objective: "Design a clear workspace status view", mode: "plan" }
      first = tool(value, "ultra_task").execute(input, context)
      await Promise.race([entry, first!.then(() => { throw new Error("Task did not enter native dispatch") })])
      second = tool(value, "ultra_task").execute(input, context)
      release()
      const results = await Promise.all([first, second])
      expect(results[1].output.run.id).toBe(results[0].output.run.id)
      expect(value.runs()).toHaveLength(1)
      expect(value.dispatches).toHaveLength(1)
      expect(value.progress).toHaveLength(1)
    } finally { release(); await Promise.allSettled([first, second]); await value.close() }
  })

  test.each(["child", "foreign", "wrong-mode", "forged-agent"])("refuses %s task contexts before admission", async kind => {
    const value = await agentModeFixture()
    try {
      const update: Record<string, unknown> = {}
      if (kind === "child") value.sessions.get("parent").parentID = "other"
      if (kind === "foreign") value.sessions.get("parent").projectID = "foreign-project"
      if (kind === "wrong-mode") { value.sessions.get("parent").agent = "build"; update.agent = "build" }
      if (kind === "forged-agent") update.agent = "build"
      await expect(launch(value, update)).rejects.toThrow()
      expect(value.runs()).toEqual([])
      expect(value.dispatches).toEqual([])
    } finally { await value.close() }
  })

  test.each(["selection", "primary-model"])("refuses %s changes during the final admission check", async change => {
    const value = await agentModeFixture()
    try {
      const original = value.context.agent.list
      let reads = 0
      value.context.agent.list = async () => {
        if (++reads === 2) {
          if (change === "selection") value.sessions.get("parent").agent = "build"
          else value.agents.get("ultra").model = { providerID: "fixture", id: "changed" }
        }
        return original()
      }
      await expect(launch(value)).rejects.toThrow()
      expect(reads).toBe(2)
      expect(value.runs()).toEqual([])
      expect(value.dispatches).toEqual([])
    } finally { await value.close() }
  })

  test("a different task call while work is active refuses a duplicate graph and directs inspection", async () => {
    const value = await agentModeFixture()
    try {
      await launch(value)
      const original = value.runs()[0]!
      await expect(tool(value, "ultra_task").execute({ objective: "Also include more explanatory detail", mode: "execute" }, value.toolContext({ id: "followup_call", messageID: "message_2" }))).rejects.toThrow("active workflow")
      expect(value.runs()).toHaveLength(1)
      expect(value.runs()[0]!.objective).toBe(original.objective)
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("native tool visibility confines Ultra and an active parent after switching to Build", async () => {
    const value = await agentModeFixture()
    try {
      const ultra = { sessionID: "parent", agent: "ultra", tools: offeredTools() }
      await value.hooks.get("session.context")(ultra)
      expect(ultra.tools).toHaveProperty("read")
      expect(ultra.tools).toHaveProperty("ultra_control")
      expect(ultra.tools).toHaveProperty("ultra_task")
      for (const name of ["edit", "write", "shell", "execute", "subagent", "third_party.read", "third_party.edit", "ultra_execute", "ultra_submit", "ultra_check"]) expect(ultra.tools).not.toHaveProperty(name)
      await launch(value)
      value.sessions.get("parent").agent = "build"
      const activeBuild = { sessionID: "parent", agent: "build", tools: offeredTools() }
      await value.hooks.get("session.context")(activeBuild)
      expect(activeBuild.tools).toHaveProperty("read")
      expect(activeBuild.tools).toHaveProperty("ultra_control")
      for (const name of ["edit", "shell", "subagent", "execute", "third_party.edit"]) expect(activeBuild.tools).not.toHaveProperty(name)
      const ordinaryBuild = { sessionID: "other", agent: "build", tools: offeredTools() }
      await value.hooks.get("session.context")(ordinaryBuild)
      expect(ordinaryBuild.tools).toHaveProperty("edit")
      expect(ordinaryBuild.tools).toHaveProperty("shell")
      expect(ordinaryBuild.tools).not.toHaveProperty("ultra_task")
      expect(ordinaryBuild.tools).not.toHaveProperty("ultra_control")
      const status = await tool(value, "ultra_control").execute({ action: "status" }, value.toolContext({ id: "status_build", agent: "build" }))
      expect(JSON.stringify(status.output)).toContain(value.runs()[0]!.id)
    } finally { await value.close() }
  })

  test("read controls stay scoped to their initiating conversation", async () => {
    const value = await agentModeFixture()
    try {
      await launch(value)
      const run = value.runs()[0]!
      value.sessions.get("other").agent = "ultra"
      const context = value.toolContext({ sessionID: "other", messageID: "other_message", id: "other_call" })
      const status = await tool(value, "ultra_control").execute({ action: "status" }, context)
      expect(status.output).toEqual({ runs: [] })
      for (const action of ["status", "inspect", "pause"]) await expect(tool(value, "ultra_control").execute({ action, runId: run.id }, context)).rejects.toThrow("initiating session")
      for (const sessionID of ["child_1", "foreign"]) {
        if (sessionID === "foreign") value.seed(sessionID, { projectID: "foreign-project" })
        await expect(tool(value, "ultra_control").execute({ action: "config" }, value.toolContext({ sessionID }))).rejects.toThrow()
      }
      expect(value.runs()[0]!.status).toBe(run.status)
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("a typed pause control mutates once on exact replay and rejects a changed payload", async () => {
    const value = await agentModeFixture()
    try {
      await launch(value)
      const runId = value.runs()[0]!.id
      const context = value.toolContext({ id: "pause_call", messageID: "control_message" })
      const control = tool(value, "ultra_control"), request = { action: "pause", runId }
      const first = await control.execute(request, context)
      const paused = value.runs()[0]!
      expect(paused.status).toBe("paused")
      const replay = await control.execute(request, context)
      expect(replay.output).toEqual(first.output)
      expect(value.runs()[0]!).toEqual(paused)
      expect(value.audit().filter(event => event.kind === "run.pause")).toHaveLength(1)
      expect(value.audit().filter(event => event.kind === "agent.control.admitted")).toHaveLength(1)
      expect(value.audit().filter(event => event.kind === "agent.control.result")).toHaveLength(1)
      await expect(control.execute({ action: "cancel", runId }, context)).rejects.toThrow("replay changed")
      expect(value.runs()[0]!).toEqual(paused)
      expect(value.synthetics).toEqual([])
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("a failed mutation receipt prevents replay but a new authorized control and status remain available", async () => {
    const value = await agentModeFixture()
    try {
      await launch(value)
      const saved = value.runs()[0]!, runId = saved.id
      const context = value.toolContext({ id: "failed_control", messageID: "control_message" })
      const control = tool(value, "ultra_control"), request = { action: "run", runId, revision: saved.revision }
      await expect(control.execute(request, context)).rejects.toThrow("not ready")
      expect(value.runs()[0]!).toEqual(saved)
      await expect(control.execute(request, context)).rejects.toThrow("already attempted")
      await expect(control.execute({ action: "pause", runId }, context)).rejects.toThrow("replay changed")
      expect(value.audit().filter(event => event.kind === "agent.control.admitted")).toHaveLength(1)
      expect(value.audit().filter(event => event.kind === "agent.control.result")).toHaveLength(0)
      const status = await control.execute({ action: "status", runId }, context)
      expect(status.output.run.status).toBe(saved.status)
      const paused = await control.execute({ action: "pause", runId }, value.toolContext({ id: "new_pause", messageID: "new_control_message" }))
      expect(paused.output.run.status).toBe("paused")
      expect(value.audit().filter(event => event.kind === "run.pause")).toHaveLength(1)
      expect(value.audit().filter(event => event.kind === "agent.control.admitted")).toHaveLength(2)
      expect(value.audit().filter(event => event.kind === "agent.control.result")).toHaveLength(1)
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("parent permissions deny direct mutation while retaining native read asks and denies", async () => {
    const value = await agentModeFixture()
    try {
      for (const action of ["edit", "write", "shell", "execute", "subagent", "third_party.edit"]) {
        const event = { sessionID: "parent", agent: "ultra", action, resources: ["*"], effect: "allow" }
        await value.hooks.get("permission.evaluate")(event)
        expect(event.effect).toBe("deny")
      }
      for (const action of ["read", "question", "external_directory"]) {
        for (const effect of ["allow", "ask", "deny"]) {
          const event = { sessionID: "parent", agent: "ultra", action, resources: ["README.md"], effect }
          await value.hooks.get("permission.evaluate")(event)
          expect(event.effect).toBe(effect)
        }
      }
      await launch(value)
      value.sessions.get("parent").agent = "build"
      const active = { sessionID: "parent", agent: "build", action: "edit", resources: ["view.ts"], effect: "allow" }
      const unrelated = { sessionID: "other", agent: "build", action: "edit", resources: ["view.ts"], effect: "ask" }
      await value.hooks.get("permission.evaluate")(active)
      await value.hooks.get("permission.evaluate")(unrelated)
      expect(active.effect).toBe("deny")
      expect(unrelated.effect).toBe("ask")
    } finally { await value.close() }
  })

  test("native supervisor delegation retains an ask and refuses a mismatched invocation source", async () => {
    const value = await agentModeFixture()
    try {
      const effects: string[] = []
      value.beforeDispatch(async (input, context) => {
        for (const update of [{}, { effect: "deny" }, { source: { type: "tool", id: "foreign_call", messageID: context.messageID } }, { source: { type: "tool", id: context.id, messageID: "foreign_message" } }, { resources: ["ultra-worker"] }]) {
          const event = { sessionID: context.sessionID, agent: "ultra", action: "subagent", resources: [input.agent], source: { type: "tool", id: context.id, messageID: context.messageID }, effect: "ask", ...update }
          await value.hooks.get("permission.evaluate")(event)
          effects.push(event.effect)
        }
      })
      await launch(value)
      expect(effects).toEqual(["ask", "deny", "deny", "deny", "deny"])
      expect(value.dispatches).toHaveLength(1)
    } finally { await value.close() }
  })

  test("tool execution guard rejects direct and unknown tools without interfering with ordinary Build", async () => {
    const value = await agentModeFixture()
    try {
      const guard = value.hooks.get("tool.execute.before")
      expect(typeof guard).toBe("function")
      for (const name of ["edit", "shell", "subagent", "execute", "third_party.edit"]) {
        await expect(guard({ ...value.toolContext(), tool: name, input: {} })).rejects.toMatchObject({ _tag: "Tool.Error" })
      }
      await expect(guard({ ...value.toolContext(), tool: "read", input: {} })).resolves.toBeUndefined()
      await expect(guard({ ...value.toolContext({ sessionID: "other", agent: "build" }), tool: "edit", input: {} })).resolves.toBeUndefined()
      await launch(value)
      value.sessions.get("parent").agent = "build"
      await expect(guard({ ...value.toolContext({ agent: "build" }), tool: "edit", input: {} })).rejects.toThrow()
    } finally { await value.close() }
  })

  test("an already aborted native task does not admit or dispatch work", async () => {
    const value = await agentModeFixture()
    try {
      await expect(launch(value, { signal: AbortSignal.abort(new Error("Native call interrupted")) })).rejects.toThrow("Native call interrupted")
      expect(value.runs()).toEqual([])
      expect(value.dispatches).toEqual([])
    } finally { await value.close() }
  })

  test("shutdown refuses coordinator calls while preserving an unrelated Build during drain", async () => {
    const value = await agentModeFixture()
    let entered!: () => void, release!: () => void
    const entry = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
    let active: Promise<any> | undefined, draining: Promise<void> | undefined
    try {
      value.beforeDispatch(async () => { entered(); await held })
      active = launch(value)
      await Promise.race([entry, active.then(() => { throw new Error("Task did not enter native dispatch") })])
      draining = value.shutdown()
      const ultra = { sessionID: "parent", agent: "ultra", tools: offeredTools() }
      const ordinary = { sessionID: "other", agent: "build", tools: offeredTools() }
      await value.hooks.get("session.context")(ultra)
      await value.hooks.get("session.context")(ordinary)
      expect(ultra.tools).toEqual({})
      expect(ordinary.tools).toHaveProperty("edit")
      await expect(Promise.resolve().then(() => tool(value, "ultra_control").execute({ action: "config" }, value.toolContext()))).rejects.toThrow()
      await expect(Promise.resolve().then(() => value.hooks.get("tool.execute.before")({ ...value.toolContext(), tool: "read", input: {} }))).rejects.toThrow()
      await expect(Promise.resolve().then(() => value.hooks.get("tool.execute.before")({ ...value.toolContext({ sessionID: "other", agent: "build" }), tool: "edit", input: {} }))).resolves.toBeUndefined()
      const permission = { sessionID: "parent", agent: "ultra", action: "read", resources: ["README.md"], effect: "allow" }
      await value.hooks.get("permission.evaluate")(permission)
      expect(permission.effect).toBe("deny")
    } finally { release(); await Promise.allSettled([active]); await draining; await value.close() }
  })

  test.each([
    ["permission.evaluate", "parent", "ultra"], ["permission.evaluate", "other", "build"],
    ["session.context", "parent", "ultra"], ["session.context", "other", "build"],
    ["tool.execute.before", "parent", "ultra"], ["tool.execute.before", "other", "build"],
  ])("shutdown drains %s while native session lookup is pending in %s", async (name, sessionID, agent) => {
    const value = await agentModeFixture()
    let entered!: () => void, release!: () => void
    const entry = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
    const original = value.context.session.get
    let completed = false, active: Promise<{ error?: unknown }> | undefined, draining: Promise<void> | undefined
    const event = { ...value.toolContext({ sessionID, agent }), action: "read", resources: ["README.md"], effect: "ask", tools: offeredTools(), tool: "read", input: {} }
    try {
      value.context.session.get = async input => { if (input.sessionID === sessionID) { entered(); await held }; return original(input) }
      active = Promise.resolve().then(() => value.hooks.get(name)(event)).then(() => ({}), error => ({ error }))
      await Promise.race([entry, active.then(() => { throw new Error("Hook did not await native session lookup") })])
      draining = value.shutdown().then(() => { completed = true })
      // Advance one event-loop turn: cleanup would finish here if the hook were untracked.
      await new Promise<void>(done => setTimeout(done, 0))
      expect(completed).toBe(false)
      release()
      const result = await active
      if (agent === "ultra" && name === "tool.execute.before") expect(String(result.error)).toMatch(/shutting down|reloading/i)
      else expect(result.error).toBeUndefined()
      if (agent === "ultra" && name === "permission.evaluate") expect(event.effect).toBe("deny")
      if (agent === "ultra" && name === "session.context") expect(event.tools).toEqual({})
      if (agent === "build" && name === "permission.evaluate") expect(event.effect).toBe("ask")
      if (agent === "build" && name === "session.context") expect(event.tools).toHaveProperty("edit")
      await draining
      expect(completed).toBe(true)
    } finally { release(); await active; await draining; await value.close() }
  })

  test("fully retired callbacks preserve ordinary Build and refuse cached workflow sessions without native lookup", async () => {
    const value = await agentModeFixture()
    try {
      await launch(value)
      value.sessions.get("parent").agent = "build"
      await value.shutdown()
      value.context.session.get = async () => { throw new Error("A retired callback attempted native session lookup") }
      for (const [sessionID, agent] of [["parent", "build"], ["child_1", "ultra-supervisor"], ["other", "build"]]) {
        const workflow = sessionID !== "other"
        const permission = { sessionID: sessionID!, agent: agent!, action: "read", resources: ["README.md"], effect: "ask" }
        await value.hooks.get("permission.evaluate")(permission)
        expect(permission.effect).toBe(workflow ? "deny" : "ask")
        const context = { sessionID: sessionID!, agent: agent!, tools: offeredTools() }
        const request = Promise.resolve().then(() => value.hooks.get("session.context")(context))
        if (sessionID === "child_1") await expect(request).rejects.toThrow(/shutting down|reloading/i)
        else {
          await request
          if (workflow) expect(context.tools).toEqual({})
          else { expect(context.tools).toHaveProperty("edit"); expect(context.tools).not.toHaveProperty("ultra_control") }
        }
        const execute = Promise.resolve().then(() => value.hooks.get("tool.execute.before")({ ...value.toolContext({ sessionID, agent }), tool: "read", input: {} }))
        if (workflow) await expect(execute).rejects.toMatchObject({ _tag: "Tool.Error" })
        else await expect(execute).resolves.toBeUndefined()
      }
    } finally { await value.close() }
  })
})

import { expect, test } from "bun:test"
import { agentModeFixture } from "./agent-mode-fixture.ts"

test("dependency retrieval is hidden from primary conversations and refuses unbound invocation", async () => {
  const value = await agentModeFixture()
  try {
    expect(value.tools.has("ultra_dependency")).toBe(true)
    expect(value.tools.has("ultra_prepare")).toBe(true)
    expect(value.tools.has("ultra_integrate")).toBe(true)
    const context = { sessionID: "parent", agent: "ultra", tools: { read: {}, ultra_task: {}, ultra_control: {}, ultra_dependency: {}, ultra_integrate: {}, ultra_prepare: {} }, system: [] }
    await value.hooks.get("session.context")(context)
    expect(context.tools).not.toHaveProperty("ultra_dependency")
    expect(context.tools).not.toHaveProperty("ultra_integrate")
    expect(context.tools).not.toHaveProperty("ultra_prepare")
    await expect(value.tools.get("ultra_dependency").execute({ taskId: "source" }, value.toolContext())).rejects.toThrow("bound")
    await expect(value.tools.get("ultra_prepare").execute({}, value.toolContext())).rejects.toThrow("bound")
    await expect(value.tools.get("ultra_integrate").execute({}, value.toolContext())).rejects.toThrow("bound")
  } finally { await value.close() }
})

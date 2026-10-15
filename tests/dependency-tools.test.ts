import { expect, test } from "bun:test"
import { agentModeFixture } from "./agent-mode-fixture.ts"

test("dependency retrieval is hidden from primary conversations and refuses unbound invocation", async () => {
  const value = await agentModeFixture()
  try {
    expect(value.tools.has("ultraopencode_dependency")).toBe(true)
    expect(value.tools.has("ultraopencode_prepare")).toBe(true)
    expect(value.tools.has("ultraopencode_integrate")).toBe(true)
    const context = { sessionID: "parent", agent: "ultraopencode", tools: { read: {}, ultraopencode_task: {}, ultraopencode_control: {}, ultraopencode_dependency: {}, ultraopencode_integrate: {}, ultraopencode_prepare: {} }, system: [] }
    await value.hooks.get("session.context")(context)
    expect(context.tools).not.toHaveProperty("ultraopencode_dependency")
    expect(context.tools).not.toHaveProperty("ultraopencode_integrate")
    expect(context.tools).not.toHaveProperty("ultraopencode_prepare")
    await expect(value.tools.get("ultraopencode_dependency").execute({ taskId: "source" }, value.toolContext())).rejects.toThrow("bound")
    await expect(value.tools.get("ultraopencode_prepare").execute({}, value.toolContext())).rejects.toThrow("bound")
    await expect(value.tools.get("ultraopencode_integrate").execute({}, value.toolContext())).rejects.toThrow("bound")
  } finally { await value.close() }
})

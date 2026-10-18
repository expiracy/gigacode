import { expect, test } from "bun:test"
import { agentModeFixture } from "./agent-mode-fixture.ts"

test("dependency retrieval is hidden from primary conversations and refuses unbound invocation", async () => {
  const value = await agentModeFixture()
  try {
    expect(value.tools.has("gigacode_dependency")).toBe(true)
    expect(value.tools.has("gigacode_prepare")).toBe(true)
    expect(value.tools.has("gigacode_integrate")).toBe(true)
    const context = { sessionID: "parent", agent: "gigacode", tools: { read: {}, gigacode_task: {}, gigacode_control: {}, gigacode_dependency: {}, gigacode_integrate: {}, gigacode_prepare: {} }, system: [] }
    await value.hooks.get("session.context")(context)
    expect(context.tools).not.toHaveProperty("gigacode_dependency")
    expect(context.tools).not.toHaveProperty("gigacode_integrate")
    expect(context.tools).not.toHaveProperty("gigacode_prepare")
    await expect(value.tools.get("gigacode_dependency").execute({ taskId: "source" }, value.toolContext())).rejects.toThrow("bound")
    await expect(value.tools.get("gigacode_prepare").execute({}, value.toolContext())).rejects.toThrow("bound")
    await expect(value.tools.get("gigacode_integrate").execute({}, value.toolContext())).rejects.toThrow("bound")
  } finally { await value.close() }
})

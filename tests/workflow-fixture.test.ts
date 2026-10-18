import { afterEach, describe, expect, test } from "bun:test"
import { createWorkflowFixture, fixtureExecutionWorkflow, fixturePlanningWorkflow, type WorkflowFixture } from "./workflow-fixture.ts"
import { parseConfig } from "../src/config.ts"
import { validateExecutionCoverage, validatePlan } from "../src/graph.ts"

const fixtures: WorkflowFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.stop())) })

function fixture() {
  const value = createWorkflowFixture()
  fixtures.push(value)
  return value
}
async function send(value: WorkflowFixture, messages: Record<string, unknown>[], stream = false, tools = ["gigacode_task", "gigacode_control"]) {
  return fetch(`${value.baseURL}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", stream, messages, tools: tools.map(name => ({ type: "function", function: { name } })) }),
  })
}

describe("native workflow primary scripts", () => {
  test("preserves a model-selected branching planning graph in the native tool call", async () => {
    const value = fixture()
    const objective = "Investigate project behavior and uncertain API contracts before proposing a design."
    const workflow = fixturePlanningWorkflow(objective)
    const original = structuredClone(workflow)
    value.scriptPrimary({ prompt: objective, toolCalls: [{ name: "gigacode_task", arguments: { objective, mode: "plan", workflow } }] })
    workflow.tasks[0]!.instructions = "Changed after the script was registered"
    const response = await send(value, [{ role: "user", content: objective }])
    const call = (await response.json() as any).choices[0].message.tool_calls[0].function
    expect(JSON.parse(call.arguments)).toEqual({ objective, mode: "plan", workflow: original })
    const validated = validatePlan({ revision: 1, criteria: [{ id: "request", description: objective, required: true, kind: "assessment" }], ...original }, "plan", parseConfig({}))
    expect(validated.tasks.map(task => task.role)).toEqual(["explorer", "researcher", "planner"])
    expect(validated.tasks.find(task => task.role === "planner")!.dependencies).toEqual(["explore", "research"])
  })

  test("the direct implementation fixture needs exactly three workers and actual configured verification", () => {
    const config = parseConfig({ checks: [{ id: "fixture-check", command: "echo fixtureverified", criterionIds: ["verification"] }] })
    const workflow = fixtureExecutionWorkflow()
    const validated = validatePlan({ revision: 1, criteria: [
      { id: "request", description: "Implement the isolated fixture", required: true, kind: "assessment" },
      { id: "verification", description: "A native command establishes verification", required: true, kind: "check" },
    ], ...workflow }, "execute", config)
    expect(validated.tasks.map(task => task.role)).toEqual(["implementer", "reviewer", "verifier"])
    expect(() => validateExecutionCoverage(validated, config)).not.toThrow()
    expect(validated.tasks.every(task => !["discovery", "design", "reporting"].includes(task.stage))).toBe(true)
    expect(fixtureExecutionWorkflow(false).tasks.find(task => task.role === "verifier")!.checkIds).toEqual([])
  })

  test("scripts an ordinary task prompt once per model tool turn and records available tools", async () => {
    const value = fixture()
    const objective = "Plan the native GigaCode mode fixture."
    const scriptId = value.scriptPrimary({ prompt: objective, toolCalls: [{ name: "gigacode_task", arguments: { objective, mode: "plan" } }], text: "The graph is launched." })
    const messages = [{ role: "user", content: objective }]
    const first = await send(value, messages)
    const body = await first.json() as any
    expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: "gigacode_task", arguments: JSON.stringify({ objective, mode: "plan" }) })
    expect(value.requests[0]).toMatchObject({ marker: "primary", primaryScriptId: scriptId, calls: ["gigacode_task"], tools: ["gigacode_task", "gigacode_control"] })
    const settled = await send(value, [...messages, { role: "assistant", tool_calls: body.choices[0].message.tool_calls }, { role: "tool", tool_call_id: body.choices[0].message.tool_calls[0].id, content: "Launched one real native supervisor." }])
    expect((await settled.json() as any).choices[0].message).toEqual({ role: "assistant", content: "The graph is launched." })
    expect(value.requests[1]?.calls).toEqual([])
  })

  test("uses only the current human prompt and never overrides a native supervisor", async () => {
    const value = fixture()
    value.scriptPrimary({ prompt: "Fixture control request", toolCalls: [{ name: "gigacode_control", arguments: { action: "config" } }] })
    const ordinary = await send(value, [{ role: "user", content: "Fixture control request" }, { role: "assistant", content: "done" }, { role: "user", content: "A separate ordinary follow-up." }])
    expect((await ordinary.json() as any).choices[0].message.tool_calls).toBeUndefined()
    expect(value.requests[0]?.marker).toBe("ordinary")
    const supervisor = await send(value, [{ role: "user", content: 'GIGACODE_SUPERVISOR\n{"runId":"run-fixture","intentId":"intent-fixture"}\nFixture control request' }])
    const calls = (await supervisor.json() as any).choices[0].message.tool_calls
    expect(calls[0].function.name).toBe("gigacode_execute")
    expect(value.requests[1]?.marker).toBe("supervisor")
  })

  test("does not emit primary tools during auxiliary title generation", async () => {
    const value = fixture()
    const objective = "Plan the title and native GigaCode task."
    value.scriptPrimary({ prompt: objective, toolCalls: [{ name: "gigacode_task", arguments: { objective, mode: "plan" } }] })
    const title = await send(value, [{ role: "system", content: "Generate a short title." }, { role: "user", content: objective }], false, [])
    expect((await title.json() as any).choices[0].message.tool_calls).toBeUndefined()
    expect(value.requests[0]).toMatchObject({ marker: "ordinary", tools: [], calls: [] })
    const primary = await send(value, [{ role: "user", content: objective }])
    expect((await primary.json() as any).choices[0].message.tool_calls[0].function.name).toBe("gigacode_task")
    expect(value.requests[1]?.marker).toBe("primary")
  })

  test("streams deliberate duplicate task calls and typed read-only controls", async () => {
    const value = fixture()
    const task = { name: "gigacode_task", arguments: { objective: "Start one graph.", mode: "execute" } }
    const calls = [task, task, { name: "gigacode_control", arguments: { action: "status", runId: "run-fixture" } }]
    value.scriptPrimary({ prompt: "Exercise duplicate admission", toolCalls: calls })
    const response = await send(value, [{ role: "user", content: "Exercise duplicate admission" }], true)
    const frames = (await response.text()).split("\n\n").filter(frame => frame.startsWith("data: ") && !frame.includes("[DONE]")).map(frame => JSON.parse(frame.slice(6)))
    const deltas = frames.flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])
    for (const [index, call] of calls.entries()) {
      const chunks = deltas.filter((delta: any) => delta.index === index)
      expect(chunks[0].function.name).toBe(call.name)
      expect(JSON.parse(chunks.map((delta: any) => delta.function.arguments).join(""))).toEqual(call.arguments)
    }
    expect(value.requests[0]?.calls).toEqual(["gigacode_task", "gigacode_task", "gigacode_control"])
  })
})

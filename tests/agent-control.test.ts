import { expect, test } from "bun:test"
import { Schema } from "effect"
import { agentControlSchema, agentTaskSchema, controlCommand } from "../src/agent-control.ts"

test("agent tools expose object schemas and explicit provider-independent fields", () => {
  for (const schema of [agentControlSchema, agentTaskSchema]) {
    const document = Schema.toJsonSchemaDocument(schema)
    expect(document.schema.type).toBe("object")
    expect(document.schema.anyOf).toBeUndefined()
  }
  const decode = Schema.decodeUnknownSync(agentControlSchema)
  expect(() => decode({ action: "start" })).toThrow()
  expect(() => decode({ action: "run", runId: "run_1", revision: 0 })).toThrow()
  expect(() => decode({ action: "budget", runId: "run_1", limits: { workers: -1 } })).toThrow()
})

test("typed controls share native command validation and preserve multiline answers", () => {
  expect(controlCommand({ action: "run", runId: "run_1", revision: 3 })).toEqual({ type: "run", id: "run_1", revision: 3 })
  const answer = 'Use the existing API.\nPreserve "quoted values" and $literal text.'
  expect(controlCommand({ action: "input", runId: "run_1", answer })).toEqual({ type: "input", id: "run_1", answer })
  expect(controlCommand({ action: "budget", runId: "run_1", limits: { workers: 2 } })).toEqual({ type: "budget", id: "run_1", limits: { workers: 2 } })
  for (const input of [
    { action: "pause" }, { action: "retry", runId: "run_1" }, { action: "run", runId: "run_1" },
    { action: "config", runId: "run_1" }, { action: "status", runId: "bad id" },
    { action: "budget", runId: "run_1", limits: {} }, { action: "input", runId: "run_1", answer: " " },
  ] as any[]) expect(() => controlCommand(input)).toThrow()
})

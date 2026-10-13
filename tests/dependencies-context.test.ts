import { expect, test } from "bun:test"
import { dependencyPage } from "../src/dependencies.ts"
import { modelInputBudget } from "../src/context.ts"
import { sanitizeEventData } from "../src/store.ts"
import { digest } from "../src/workspace.ts"
import type { Attempt, ModelLimits, Run, TaskResult } from "../src/types.ts"

function fixture(result: TaskResult, limit?: ModelLimits) {
  const resultHash = digest(JSON.stringify(result))
  const run = { tasks: [{ spec: { id: "source" }, acceptedAttemptId: "newer", attempts: [{ id: "captured", result, resultHash }, { id: "newer", result: { summary: "Later evidence" } }] }] } as unknown as Run
  const attempt = { id: "consumer", model: { ref: { providerID: "local", id: "fixture" }, requested: "inherit", origin: "captured", ...(limit ? { limit } : {}) }, dependencyResults: [{ taskId: "source", attemptId: "captured", resultHash }] } as Attempt
  return { run, attempt, resultHash }
}

test.each([
  { context: 16_000, input: 14_000, output: 2_000 },
  { context: 40_000, output: 2_048 },
])("known model limits bound the complete serialized dependency page and reconstruct Unicode/escaped evidence: %j", limit => {
  const result = { summary: '中😀"\\\n'.repeat(4_000) + "CRITICAL_TAIL", apiKey: "secret-credential", findings: [{ id: "gap", description: "Complete evidence retained", blocking: true }] }
  const { run, attempt, resultHash } = fixture(result, limit)
  const original = structuredClone({ run, attempt, result })
  const budget = Math.min(12_000, modelInputBudget(limit)!)
  let text = "", offset = 0, pages = 0
  for (;;) {
    const page = dependencyPage(run, attempt, "source", offset)
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(budget)
    expect(page).toMatchObject({ taskId: "source", attemptId: "captured", resultHash, offset })
    expect(page.chunk.length).toBeGreaterThan(0)
    expect(page.chunk.length).toBeLessThanOrEqual(6_000)
    const last = page.chunk.charCodeAt(page.chunk.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    text += page.chunk
    pages++
    if (page.nextOffset === null) break
    expect(page.nextOffset).toBe(offset + page.chunk.length)
    offset = page.nextOffset
  }
  expect(pages).toBeGreaterThan(1)
  expect(text).toBe(JSON.stringify(sanitizeEventData(result)))
  expect(JSON.parse(text)).toEqual({ ...result, apiKey: "[REDACTED]" })
  expect(text).toContain("CRITICAL_TAIL")
  expect(text).not.toContain("secret-credential")
  expect({ run, attempt, result }).toEqual(original)
})

test("legacy dependency pages retain the exact 6000-character boundary without native limit metadata", () => {
  const result = { summary: '中\\"'.repeat(5_000) }
  const { run, attempt } = fixture(result)
  const serialized = JSON.stringify(sanitizeEventData(result))
  const page = dependencyPage(run, attempt, "source")
  expect(page.chunk).toBe(serialized.slice(0, 6_000))
  expect(page.nextOffset).toBe(6_000)
  expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeGreaterThan(12_000)
})

test("a model budget too small for metadata or one complete character refuses a zero-progress page", () => {
  const result = { summary: "Evidence" }
  const tiny = fixture(result, { context: 32, output: 0 })
  expect(() => dependencyPage(tiny.run, tiny.attempt, "source")).toThrow("metadata and one complete character")
  const { resultHash } = fixture(result)
  const totalChars = JSON.stringify(sanitizeEventData(result)).length
  const metadataBytes = Buffer.byteLength(JSON.stringify({ taskId: "source", attemptId: "captured", resultHash, offset: 0, totalChars, chunk: "", nextOffset: 0 }), "utf8")
  const { run, attempt } = fixture(result, { context: 10_000, input: metadataBytes * 2, output: 0 })
  expect(modelInputBudget(attempt.model.limit)).toBe(metadataBytes)
  expect(() => dependencyPage(run, attempt, "source")).toThrow("metadata and one complete character")
})

test("known capacity does not change captured-result authorization, immutable hashes or offset validation", () => {
  const result = { summary: "Captured evidence" }
  const { run, attempt } = fixture(result, { context: 16_000, output: 2_048 })
  expect(() => dependencyPage(run, attempt, "other")).toThrow("captured dependency")
  for (const offset of [-1, 0.5, NaN, 1_000]) expect(() => dependencyPage(run, attempt, "source", offset)).toThrow("offset")
  result.summary = "Changed after capture"
  expect(() => dependencyPage(run, attempt, "source")).toThrow("changed")
})

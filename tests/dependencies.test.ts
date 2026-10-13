import { expect, test } from "bun:test"
import { dependencyPage } from "../src/dependencies.ts"
import { digest } from "../src/workspace.ts"
import type { Attempt, Run } from "../src/types.ts"

test("retrieves the captured dependency result in bounded complete pages", () => {
  const result = { summary: "Long evidence ".repeat(1500), findings: [{ id: "tail", description: "The final claim", blocking: true }] }
  const attempt = { id: "consumer", dependencyResults: [{ taskId: "review", attemptId: "original", resultHash: digest(JSON.stringify(result)) }] } as Attempt
  const run = { tasks: [{ spec: { id: "review" }, acceptedAttemptId: "newer", attempts: [{ id: "original", result, resultHash: digest(JSON.stringify(result)) }, { id: "newer", result: { summary: "A different result" } }] }] } as Run
  let text = "", offset = 0, count = 0
  for (;;) {
    const page = dependencyPage(run, attempt, "review", offset)
    expect(page.attemptId).toBe("original")
    expect(page.chunk.length).toBeLessThanOrEqual(6000)
    text += page.chunk; count++
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  expect(count).toBeGreaterThan(1)
  expect(JSON.parse(text)).toEqual(result)
})

test("refuses unrelated or changed results and invalid offsets", () => {
  const result = { summary: "Captured result" }, hash = digest(JSON.stringify(result))
  const source = { id: "source", result, resultHash: hash }
  const run = { tasks: [{ spec: { id: "review" }, attempts: [source] }] } as Run
  const attempt = { dependencyResults: [{ taskId: "review", attemptId: "source", resultHash: hash }] } as Attempt
  expect(() => dependencyPage(run, attempt, "other")).toThrow("captured dependency")
  for (const offset of [-1, 0.5, NaN, 1000]) expect(() => dependencyPage(run, attempt, "review", offset)).toThrow("offset")
  source.result.summary = "Changed after capture"
  expect(() => dependencyPage(run, attempt, "review")).toThrow("changed")
})

test("redacts captured credentials without disclosing rejected result text", () => {
  const result = { summary: "Evidence", apiKey: "do-not-expose" }, hash = digest(JSON.stringify(result))
  const run = { tasks: [{ spec: { id: "review" }, attempts: [{ id: "source", result, resultHash: hash }] }] } as unknown as Run
  const attempt = { dependencyResults: [{ taskId: "review", attemptId: "source", resultHash: hash }] } as Attempt
  const page = dependencyPage(run, attempt, "review")
  expect(page.chunk).not.toContain("do-not-expose")
  expect(JSON.parse(page.chunk).apiKey).toBe("[REDACTED]")
})

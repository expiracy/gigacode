import { describe, expect, test } from "bun:test"
import { modelInputBudget } from "../src/context.ts"

describe("model input headroom estimate", () => {
  test("leaves absent metadata on the existing configured fallback", () => {
    expect(modelInputBudget()).toBeUndefined()
    expect(Math.min(64_000, modelInputBudget() ?? 64_000)).toBe(64_000)
  })

  test("reduces initial text for small context windows and reserves host headroom", () => {
    expect(modelInputBudget({ context: 8_192, output: 1_024 })).toBe(3_584)
    expect(modelInputBudget({ context: 4_096, output: 2_048 })).toBe(1_536)
    expect(modelInputBudget({ context: 1, output: 0 })).toBe(0)
  })

  test("obeys an explicit input maximum and the context window independently", () => {
    expect(modelInputBudget({ context: 8_192, input: 2_000, output: 1_024 })).toBe(1_000)
    expect(modelInputBudget({ context: 8_192, input: 32_768, output: 32_768 })).toBe(3_072)
  })

  test("treats zero output as unknown and caps the output reservation", () => {
    expect(modelInputBudget({ context: 16_384, output: 0 })).toBe(7_168)
    expect(modelInputBudget({ context: 16_384, output: 32_768 })).toBe(7_168)
    expect(modelInputBudget({ context: 16_384, output: 512 })).toBe(7_936)
  })

  test("large models retain the legacy configured cap and metadata stays untouched", () => {
    const limit = { context: 262_144, output: 32_768 }
    expect(modelInputBudget(limit)).toBe(130_048)
    expect(Math.min(64_000, modelInputBudget(limit)!)).toBe(64_000)
    expect(limit).toEqual({ context: 262_144, output: 32_768 })
  })
})

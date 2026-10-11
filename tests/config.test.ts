import { describe, expect, test } from "bun:test"
import { defaultConfig, parseConfig, resolveModel } from "../src/config.ts"
import type { AvailableModel, Config, ModelOptions, Run, TaskSpec } from "../src/types.ts"

const task: TaskSpec = { id: "design", title: "Design", role: "planner", stage: "design", instructions: "Design a fix", dependencies: [], writes: false }
const catalog: AvailableModel[] = [
  { providerID: "a", id: "base", variants: ["deep"] },
  { providerID: "b", id: "code", variants: ["fast"] },
  { providerID: "b", id: "review", variants: [] },
  { providerID: "a", id: "text-only", variants: [], tools: false },
]
const run = (modelOptions: ModelOptions = {}, config: Config = parseConfig({})): Pick<Run, "modelOptions" | "capturedModel" | "config"> => ({ modelOptions, config, capturedModel: { providerID: "a", id: "base", variant: "deep" } })

describe("workflow configuration and model selection", () => {
  test("uses design limits and returns independent configuration snapshots", () => {
    const first = parseConfig(undefined)
    expect(first.limits).toMatchObject({ workers: 4, runs: 2, attempts: 24, repairRounds: 2, workerMs: 600_000, runMs: 2_700_000, steps: 24 })
    first.models.roles!.planner = "b/code"
    first.checks.push({ id: "x", command: "echo check", criterionIds: ["goal"] })
    expect(parseConfig({}).checks).toEqual([])
    expect(defaultConfig.models.roles?.planner).toBeUndefined()
  })

  test("validates nested configuration instead of accepting secrets or misspellings", () => {
    for (const options of [
      { apiKey: "secret" }, { models: { roles: { unknown: "a/base" } } },
      { limits: { workers: 0 } }, { limits: { workerMs: Infinity } },
      { parallelWrites: "yes" }, { checks: [{ id: "bad", command: "", criterionIds: [] }] },
      { checks: [{ id: "same", command: "x", criterionIds: [] }, { id: "same", command: "y", criterionIds: [] }] },
      { prompts: { reviewer: 123 } }, { models: { default: "a/base#" } },
    ]) expect(() => parseConfig(options)).toThrow()
    expect(parseConfig({ limits: { repairRounds: 0 }, models: { roles: { planner: "a/base#deep" } }, prompts: { planner: "Focus on migration behavior." } }).models.roles?.planner).toBe("a/base#deep")
  })

  test("applies task, run stage, run role, project stage, project role, then default precedence", () => {
    const configured = parseConfig({ models: { default: "a/base", roles: { planner: "b/review" }, stages: { design: "b/code#fast" } } })
    expect(resolveModel(task, run({}, configured), catalog).requested).toBe("b/code#fast")
    expect(resolveModel(task, run({ roles: { planner: "b/review" } }, configured), catalog).requested).toBe("b/review")
    expect(resolveModel(task, run({ roles: { planner: "b/review" }, stages: { design: "a/base#deep" } }, configured), catalog).requested).toBe("a/base#deep")
    expect(resolveModel({ ...task, model: "b/code" }, run({ stages: { design: "a/base" } }, configured), catalog).requested).toBe("b/code")
    expect(resolveModel(task, run({ default: "b/code" }), catalog).requested).toBe("b/code")
  })

  test("treats the model and variant atomically and captures inheritance", () => {
    expect(resolveModel(task, run(), catalog).ref).toEqual({ providerID: "a", id: "base", variant: "deep" })
    expect(resolveModel({ ...task, model: "b/code" }, run(), catalog).ref).toEqual({ providerID: "b", id: "code" })
    const selected = resolveModel(task, run({ stages: { design: "inherit" } }), catalog)
    expect(selected.ref.variant).toBe("deep")
    expect(selected.origin).toContain("run.stage")
    expect(selected.requested).toBe("inherit")
  })

  test("rejects unavailable models, variants, and tool-less models without fallback", () => {
    for (const model of ["missing/model", "a/base#missing", "a/text-only", "b/code#deep", "a/base#fast#deep"]) {
      expect(() => resolveModel({ ...task, model }, run(), catalog)).toThrow()
    }
    expect(() => resolveModel(task, run(), [])).toThrow()
  })
})

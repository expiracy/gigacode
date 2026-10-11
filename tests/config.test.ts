import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as configuration from "../src/config.ts"
import { defaultConfig, loadProjectConfig, parseConfig, resolveModel } from "../src/config.ts"
import type { AvailableModel, Config, ModelOptions, Run, TaskSpec } from "../src/types.ts"

const task: TaskSpec = { id: "design", title: "Design", role: "planner", stage: "design", instructions: "Design a fix", dependencies: [], writes: false }
const catalog: AvailableModel[] = [
  { providerID: "a", id: "base", variants: ["deep"] },
  { providerID: "b", id: "code", variants: ["fast"] },
  { providerID: "b", id: "review", variants: [] },
  { providerID: "a", id: "text-only", variants: [], tools: false },
]
const run = (modelOptions: ModelOptions = {}, config: Config = parseConfig({})): Pick<Run, "modelOptions" | "capturedModel" | "config"> => ({ modelOptions, config, capturedModel: { providerID: "a", id: "base", variant: "deep" } })

async function withProject(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ultracode-config-"))
  try { await body(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

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

describe("global defaults and optional project overrides", () => {
  test("preserves omission while validating independent partial options", () => {
    expect(configuration.parseConfigOptions(undefined)).toEqual({})
    const input = { models: { roles: { planner: "a/base" } }, limits: { workers: 2 }, prompts: { planner: "Plan carefully." } }
    const parsed = configuration.parseConfigOptions(input)
    expect(parsed).toEqual(input)
    expect(parsed).not.toHaveProperty("checks")
    expect(parsed.models).not.toHaveProperty("default")
    parsed.models!.roles!.planner = "b/code"
    expect(input.models.roles.planner).toBe("a/base")
    expect(configuration.parseConfigOptions({ checks: [] }).checks).toEqual([])
  })

  test("deep merges model maps, limits, and prompts without mutating either layer", () => {
    const global = {
      models: { default: "a/base", roles: { planner: "a/base", reviewer: "b/review" }, stages: { design: "a/base#deep" } },
      limits: { workers: 3, attempts: 12 }, prompts: { planner: "Global planner.", reviewer: "Global reviewer." },
      checks: [{ id: "global", command: "echo global", criterionIds: ["verification"] }], autoThreshold: 120,
    }
    const project = {
      models: { roles: { planner: "b/code" }, stages: { verification: "b/review" } },
      limits: { workers: 1 }, prompts: { planner: "Project planner." }, checks: [], autoThreshold: 90,
    }
    const original = structuredClone({ global, project })
    const merged = configuration.mergeConfigOptions(global, project)
    expect(merged).toEqual({
      models: { default: "a/base", roles: { planner: "b/code", reviewer: "b/review" }, stages: { design: "a/base#deep", verification: "b/review" } },
      limits: { workers: 1, attempts: 12 }, prompts: { planner: "Project planner.", reviewer: "Global reviewer." }, checks: [], autoThreshold: 90,
    })
    merged.models!.roles!.reviewer = "a/base"
    expect({ global, project }).toEqual(original)
  })

  test("validates each layer before later overrides can hide invalid values", () => {
    const cases: [unknown, unknown, string][] = [
      [{ limits: { workers: 0 } }, { limits: { workers: 2 } }, "limits.workers"],
      [{ models: { default: "invalid" } }, { models: { default: "a/base" } }, "Invalid model reference"],
      [{ checks: "bad" }, { checks: [] }, "checks must be an array"],
      [{ prompts: { planner: "" } }, { prompts: { planner: "Valid." } }, "prompts.planner"],
      [{ apiKey: "secret" }, {}, "Unknown configuration field: apiKey"],
    ]
    for (const [invalid, overriding, message] of cases) expect(() => configuration.mergeConfigOptions(invalid, overriding)).toThrow(message)
  })

  test("automatically layers a project file over global defaults", async () => {
    await withProject(async directory => {
      await writeFile(join(directory, "ultracode.json"), JSON.stringify({ models: { roles: { planner: "b/code" } }, limits: { workers: 1 }, prompts: { planner: "Local." } }))
      const config = await loadProjectConfig({ models: { default: "a/base", roles: { reviewer: "b/review" } }, limits: { attempts: 9 }, prompts: { reviewer: "Global." } }, directory)
      expect(config.models).toEqual({ default: "a/base", roles: { reviewer: "b/review", planner: "b/code" }, stages: {} })
      expect(config.limits).toMatchObject({ workers: 1, attempts: 9, repairRounds: 2 })
      expect(config.prompts).toEqual({ reviewer: "Global.", planner: "Local." })
    })
  })

  test("replaces checks as a whole and explicit empty project checks disable discovery", async () => {
    await withProject(async directory => {
      await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
      const defaults = { checks: [{ id: "global", command: "echo global", criterionIds: ["verification"] }] }
      await writeFile(join(directory, "ultracode.json"), JSON.stringify({ checks: [{ id: "local", command: "echo local", criterionIds: ["verification"] }] }))
      expect((await loadProjectConfig(defaults, directory)).checks.map(check => check.id)).toEqual(["local"])
      await writeFile(join(directory, "ultracode.json"), JSON.stringify({ checks: [] }))
      expect((await loadProjectConfig(defaults, directory)).checks).toEqual([])
      expect((await loadProjectConfig(undefined, directory)).checks).toEqual([])
    })
  })

  test("discovers project package checks only when both layers omit checks", async () => {
    await withProject(async directory => {
      await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc", lint: "eslint" } }))
      await writeFile(join(directory, "bun.lock"), "")
      await writeFile(join(directory, "ultracode.json"), JSON.stringify({ models: { default: "b/code" } }))
      expect((await loadProjectConfig({ limits: { workers: 2 } }, directory)).checks.map(check => check.command)).toEqual(["bun run test", "bun run typecheck", "bun run lint"])
      const explicit = { checks: [{ id: "global", command: "echo global", criterionIds: [] }] }
      expect((await loadProjectConfig(explicit, directory)).checks).toEqual(explicit.checks)
    })
  })

  test("keeps global options independent across projects and returned snapshots", async () => {
    await withProject(async directory => {
      const first = join(directory, "first"), second = join(directory, "second")
      await mkdir(first); await mkdir(second)
      await writeFile(join(first, "ultracode.json"), JSON.stringify({ models: { roles: { planner: "b/code" } } }))
      const options = { models: { roles: { planner: "a/base" } }, checks: [] }
      const local = await loadProjectConfig(options, first)
      expect(local.models.roles?.planner).toBe("b/code")
      local.models.roles!.planner = "b/review"
      local.checks.push({ id: "modified", command: "x", criterionIds: [] })
      expect((await loadProjectConfig(options, second)).models.roles?.planner).toBe("a/base")
      expect((await loadProjectConfig(options, second)).checks).toEqual([])
      expect(options).toEqual({ models: { roles: { planner: "a/base" } }, checks: [] })
    })
  })

  test("reads only the exact runtime directory and does not inherit a parent's override", async () => {
    await withProject(async directory => {
      const child = join(directory, "child")
      await mkdir(child)
      await writeFile(join(directory, "ultracode.json"), JSON.stringify({ models: { default: "b/code" } }))
      expect((await loadProjectConfig({ models: { default: "a/base" } }, child)).models.default).toBe("a/base")
    })
  })

  test("applies explicit preview options last without hiding invalid project options", async () => {
    await withProject(async directory => {
      const path = join(directory, "ultracode.json")
      await writeFile(path, JSON.stringify({ models: { roles: { planner: "b/code" } }, limits: { workers: 2 }, checks: [] }))
      const config = await loadProjectConfig({ models: { default: "a/base" }, limits: { attempts: 10 } }, directory, { models: { roles: { planner: "b/review" } }, limits: { workers: 1 } })
      expect(config.models).toMatchObject({ default: "a/base", roles: { planner: "b/review" } })
      expect(config.limits).toMatchObject({ workers: 1, attempts: 10 })
      expect(config.checks).toEqual([])
      await writeFile(path, JSON.stringify({ limits: { workers: 0 } }))
      await expect(loadProjectConfig({}, directory, { limits: { workers: 1 } })).rejects.toThrow("limits.workers")
    })
  })

  test("rejects malformed project configuration with its path in the error", async () => {
    await withProject(async directory => {
      const path = join(directory, "ultracode.json")
      await writeFile(path, "{broken")
      await expect(loadProjectConfig(undefined, directory)).rejects.toThrow(path)
      await writeFile(path, JSON.stringify({ unknown: true }))
      await expect(loadProjectConfig(undefined, directory)).rejects.toThrow("Unknown configuration field: unknown")
      await writeFile(path, JSON.stringify({ limits: { workers: 2 } }))
      await expect(loadProjectConfig({ limits: { workers: 0 } }, directory)).rejects.toThrow("limits.workers")
    })
  })

  test("malformed project JSON reports its path without exposing source fragments", async () => {
    await withProject(async directory => {
      const path = join(directory, "ultracode.json"), secret = "synthetic-secret-fragment"
      await writeFile(path, `{"checks":[],"apiKey":"${secret}" broken}`)
      const error = await loadProjectConfig(undefined, directory).then(() => undefined, error => error as Error)
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain(path)
      expect(error!.message).not.toContain(secret)
      expect(error!.cause).toBeUndefined()
      expect(error!.message).toContain("invalid JSON")
    })
  })
})

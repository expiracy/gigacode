import { afterEach, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ProjectSettings } from "../src/settings.ts"

const directories: string[] = []
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ultra-settings-")))
  directories.push(directory)
  return directory
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

test("project editing starts fresh and leaves previous product settings untouched", async () => {
  const directory = await fixture(), previous = join(directory, "ultraopencode.json")
  const source = '{"limits":{"workers":1},"prompts":{"reviewer":"Old instructions"}}'
  await writeFile(previous, source)
  const settings = new ProjectSettings(directory, {}), before = await settings.read()
  expect(before.path).toBe(join(directory, "gigacode.json"))
  expect(before.overrides).toEqual({})
  const saved = await settings.save(before.revision, { limits: { workers: 2 } }, [])
  expect(saved.path).toBe(before.path)
  expect(JSON.parse(await readFile(saved.path, "utf8"))).toEqual({ limits: { workers: 2 } })
  expect(await readFile(previous, "utf8")).toBe(source)
})

test("settings show inherited values, project overrides and detected checks without rewriting the file", async () => {
  const directory = await fixture()
  const source = '{"limits":{"workers":1},"prompts":{"reviewer":"Keep the public API"}}\n'
  await writeFile(join(directory, "gigacode.json"), source)
  await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
  const snapshot = await new ProjectSettings(directory, { limits: { workers: 2 } }).read()
  expect(snapshot.path).toBe(join(directory, "gigacode.json"))
  expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/)
  expect(snapshot.inherited.limits.workers).toBe(2)
  expect(snapshot.effective.limits.workers).toBe(1)
  expect(snapshot.effective.prompts?.reviewer).toBe("Keep the public API")
  expect(snapshot.overrides).toEqual({ limits: { workers: 1 }, prompts: { reviewer: "Keep the public API" } })
  expect(snapshot.inherited.checks).toEqual([{ id: "test", command: "npm run test", criterionIds: ["verification"] }])
  expect(await readFile(snapshot.path, "utf8")).toBe(source)
})

test("project settings can save validated advanced options through the same settings writer", async () => {
  const directory = await fixture(), settings = new ProjectSettings(directory, {})
  const before = await settings.read()
  const options = { prompts: { reviewer: "Review contracts.\nKeep boundary cases." }, parallelWrites: true, autoThreshold: 120 }
  const saved = await settings.save(before.revision, options, [])
  expect(JSON.parse(await readFile(saved.path, "utf8"))).toEqual(options)
  expect(saved.overrides).toEqual(options)
  expect(saved.effective.prompts?.reviewer).toBe(options.prompts.reviewer)
  expect(saved.effective.parallelWrites).toBe(true)
  expect(saved.effective.autoThreshold).toBe(120)
})

test("an explicit advanced reset restores inherited values while core-only saves preserve them", async () => {
  const directory = await fixture(), settings = new ProjectSettings(directory, { prompts: { reviewer: "Global review" }, parallelWrites: true, autoThreshold: 90 })
  await writeFile(join(directory, "gigacode.json"), '{"prompts":{"reviewer":"Project review"},"parallelWrites":false,"autoThreshold":120}')
  const before = await settings.read()
  const kept = await settings.save(before.revision, { limits: { workers: 1 } }, [])
  expect(kept.effective.prompts?.reviewer).toBe("Project review")
  expect(kept.effective.parallelWrites).toBe(false)
  expect(kept.effective.autoThreshold).toBe(120)
  const reset = await settings.save(kept.revision, { limits: { workers: 1 } }, [], undefined, true)
  expect(reset.effective.prompts?.reviewer).toBe("Global review")
  expect(reset.effective.parallelWrites).toBe(true)
  expect(reset.effective.autoThreshold).toBe(90)
  expect(JSON.parse(await readFile(reset.path, "utf8"))).toEqual({ limits: { workers: 1 } })
})

test("saving models, limits and checks backs up the file and preserves other project settings", async () => {
  const directory = await fixture()
  const source = '{"limits":{"workers":1},"prompts":{"reviewer":"Keep the public API"},"parallelWrites":true,"autoThreshold":25}\n'
  await writeFile(join(directory, "gigacode.json"), source)
  const settings = new ProjectSettings(directory, { limits: { workers: 4 } })
  const before = await settings.read()
  const saved = await settings.save(before.revision, { models: { roles: { reviewer: "fixture/small#fast" } }, limits: { workers: 2 }, checks: [] }, [{ providerID: "fixture", id: "small", variants: ["fast"], tools: true }])
  expect(await readFile(saved.backup!, "utf8")).toBe(source)
  expect(JSON.parse(await readFile(saved.path, "utf8"))).toEqual({ models: { roles: { reviewer: "fixture/small#fast" } }, limits: { workers: 2 }, checks: [], prompts: { reviewer: "Keep the public API" }, parallelWrites: true, autoThreshold: 25 })
  expect(saved.effective.limits.workers).toBe(2)
  expect(saved.effective.checks).toEqual([])
  expect(saved.revision).not.toBe(before.revision)
  expect(before.effective.limits.workers).toBe(1)
})

test("saving never places temporary config files in the fingerprinted project source", async () => {
  const directory = await fixture()
  let checks = 0
  const settings = new ProjectSettings(directory, {}, undefined, () => {
    checks++
    expect(readdirSync(directory).filter(name => name.startsWith(".gigacode-settings-"))).toEqual([])
  })
  const before = await settings.read()
  await settings.save(before.revision, { limits: { workers: 1 } }, [])
  expect(checks).toBe(2)
})

test("removing editable overrides restores inherited models, limits and detected checks", async () => {
  const directory = await fixture()
  await writeFile(join(directory, "package.json"), '{"scripts":{"test":"bun test"}}')
  await writeFile(join(directory, "gigacode.json"), '{"models":{"default":"fixture/project"},"limits":{"workers":1},"checks":[],"prompts":{"reviewer":"Keep contracts"}}')
  const settings = new ProjectSettings(directory, { models: { default: "fixture/global" }, limits: { workers: 3 } })
  const saved = await settings.save((await settings.read()).revision, {}, [])
  expect(saved.effective.models.default).toBe("fixture/global")
  expect(saved.effective.limits.workers).toBe(3)
  expect(saved.effective.checks.map(check => check.id)).toEqual(["test"])
  expect(JSON.parse(await readFile(saved.path, "utf8"))).toEqual({ prompts: { reviewer: "Keep contracts" } })
})

test("competing editor saves reject the stale revision instead of overwriting the first save", async () => {
  const directory = await fixture(), settings = new ProjectSettings(directory, {})
  const before = await settings.read()
  const results = await Promise.allSettled([settings.save(before.revision, { limits: { workers: 1 } }, []), settings.save(before.revision, { limits: { workers: 2 } }, [])])
  expect(results[0].status).toBe("fulfilled")
  expect(results[1].status).toBe("rejected")
  if (results[1].status === "rejected") expect(results[1].reason.message).toContain("changed")
  expect((await settings.read()).effective.limits.workers).toBe(1)
})

test("an invalid limit cannot rewrite the existing project file", async () => {
  const directory = await fixture(), source = '{"limits":{"workers":2}}\n'
  await writeFile(join(directory, "gigacode.json"), source)
  const settings = new ProjectSettings(directory, {}), before = await settings.read()
  await expect(settings.save(before.revision, { limits: { workers: 0 } }, [])).rejects.toThrow("integer")
  expect(await readFile(before.path, "utf8")).toBe(source)
})

test("new unavailable model choices are refused while unchanged mappings can be repaired separately", async () => {
  const directory = await fixture(), settings = new ProjectSettings(directory, {})
  await writeFile(join(directory, "gigacode.json"), '{"models":{"default":"missing/old"}}')
  const before = await settings.read()
  await expect(settings.save(before.revision, { models: { default: "missing/new" } }, [])).rejects.toThrow("no fallback")
  const saved = await settings.save(before.revision, { ...before.overrides, limits: { workers: 1 } }, [])
  expect(saved.effective.models.default).toBe("missing/old")
  expect(saved.effective.limits.workers).toBe(1)
})

test("project settings refuse a symlink instead of following it to another file", async () => {
  const directory = await fixture(), target = join(directory, "original.json")
  await writeFile(target, '{"limits":{"workers":2}}')
  await symlink(target, join(directory, "gigacode.json"))
  await expect(new ProjectSettings(directory, {}).read()).rejects.toThrow("symlink")
  expect(await readFile(target, "utf8")).toBe('{"limits":{"workers":2}}')
})

test("saving unchanged preferences preserves formatting and creates no backup", async () => {
  const directory = await fixture(), source = '{"limits":{"workers":2},"prompts":{"reviewer":"Keep contracts"}}\n'
  await writeFile(join(directory, "gigacode.json"), source)
  const settings = new ProjectSettings(directory, {}), before = await settings.read()
  const saved = await settings.save(before.revision, before.overrides, [])
  expect(saved.backup).toBeUndefined()
  expect(saved.revision).toBe(before.revision)
  expect(await readFile(saved.path, "utf8")).toBe(source)
})

test("an aborted settings request cannot create or replace project configuration", async () => {
  const directory = await fixture(), settings = new ProjectSettings(directory, {})
  const before = await settings.read(), controller = new AbortController()
  controller.abort()
  await expect(settings.save(before.revision, { limits: { workers: 1 } }, [], controller.signal)).rejects.toThrow()
  expect((await settings.read()).revision).toBe(before.revision)
})

test("a workflow becoming active during a save blocks atomic replacement and removes the temporary file", async () => {
  const directory = await fixture(), source = '{"limits":{"workers":2}}\n'
  await writeFile(join(directory, "gigacode.json"), source)
  let guards = 0
  const settings = new ProjectSettings(directory, {}, undefined, () => { if (++guards === 2) throw new Error("Workflow became active") })
  const before = await settings.read()
  await expect(settings.save(before.revision, { limits: { workers: 1 } }, [])).rejects.toThrow("Workflow became active")
  expect(await readFile(before.path, "utf8")).toBe(source)
  expect(readdirSync(join(directory, ".gigacode", "settings-temp"))).toEqual([])
})

test("external file edits and changed detected checks invalidate an editor revision", async () => {
  const directory = await fixture(), settings = new ProjectSettings(directory, {})
  const before = await settings.read()
  const source = '{"prompts":{"reviewer":"External edit"}}\n'
  await writeFile(before.path, source)
  await expect(settings.save(before.revision, { limits: { workers: 1 } }, [])).rejects.toThrow("changed")
  expect(await readFile(before.path, "utf8")).toBe(source)
  const current = await settings.read()
  await writeFile(join(directory, "package.json"), '{"scripts":{"test":"bun test"}}')
  await expect(settings.save(current.revision, { limits: { workers: 1 } }, [])).rejects.toThrow("changed")
  expect(await readFile(before.path, "utf8")).toBe(source)
})

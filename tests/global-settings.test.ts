import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GlobalSettings } from "../src/global-settings.ts"

const directories: string[] = []
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ultra-global-settings-")))
  directories.push(directory)
  const packagePath = join(directory, "ultra")
  const path = join(directory, "opencode.json")
  return { directory, packagePath, path, settings: new GlobalSettings({ configDirectory: directory, packagePath }) }
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

test("global settings expose only Ultra options and built-in defaults, never native credentials", async () => {
  const f = await fixture()
  const source = JSON.stringify({ providers: { private: { apiKey: "fixture-secret" } }, plugins: [{ package: f.packagePath, options: { limits: { workers: 2 }, prompts: { reviewer: "Keep contracts" } } }] })
  await writeFile(f.path, source)
  const view = await f.settings.read()
  expect(view.path).toBe(f.path)
  expect(view.overrides).toEqual({ limits: { workers: 2 }, prompts: { reviewer: "Keep contracts" } })
  expect(view.inherited.limits.workers).toBe(4)
  expect(view.effective.limits.workers).toBe(2)
  expect(JSON.stringify(view)).not.toContain("fixture-secret")
  expect(await readFile(f.path, "utf8")).toBe(source)
})

test("global saves change only Ultra editable fields and preserve JSONC comments and unrelated configuration", async () => {
  const f = await fixture()
  const source = `{
  // Keep provider credentials and explanation.
  "providers": { "private": { "apiKey": "fixture-secret" } },
  "plugins": [
    "other-plugin", // Keep this comment too.
    { "package": ${JSON.stringify(f.packagePath)}, "options": { "limits": { "workers": 1 }, "prompts": { "reviewer": "Keep contracts" }, "parallelWrites": true } },
  ],
}\n`
  await writeFile(f.path, source)
  const before = await f.settings.read()
  const saved = await f.settings.save(before.revision, { limits: { workers: 2 }, models: { roles: { reviewer: "fixture/test#fast" } }, checks: [] }, [{ providerID: "fixture", id: "test", variants: ["fast"], tools: true }])
  expect(saved.effective.limits.workers).toBe(2)
  expect(saved.effective.prompts?.reviewer).toBe("Keep contracts")
  expect(saved.effective.parallelWrites).toBe(true)
  expect(saved.effective.models.roles?.reviewer).toBe("fixture/test#fast")
  const changed = await readFile(f.path, "utf8")
  expect(changed).toContain("// Keep provider credentials and explanation.")
  expect(changed).toContain('"other-plugin", // Keep this comment too.')
  expect(changed).toContain('"apiKey": "fixture-secret"')
  expect(await readFile(saved.backup!, "utf8")).toBe(source)
})

test("editing global writer policy and threshold leaves instruction comments untouched", async () => {
  const f = await fixture()
  const source = `{"plugins":[{"package":${JSON.stringify(f.packagePath)},"options":{
    "prompts": {
      // Keep the review rationale.
      "reviewer": "Preserve contracts"
    },
    "parallelWrites": false, "autoThreshold": 80
  }}]}`
  await writeFile(f.path, source)
  const before = await f.settings.read()
  const saved = await f.settings.save(before.revision, { ...before.overrides, parallelWrites: true, autoThreshold: 120 }, [])
  expect(saved.effective.parallelWrites).toBe(true)
  expect(saved.effective.autoThreshold).toBe(120)
  expect(saved.effective.prompts?.reviewer).toBe("Preserve contracts")
  expect(await readFile(f.path, "utf8")).toContain("// Keep the review rationale.")
  expect(await readFile(saved.backup!, "utf8")).toBe(source)
})

test("editing one global role preserves comments and instructions on the other roles", async () => {
  const f = await fixture()
  const source = `{"plugins":[{"package":${JSON.stringify(f.packagePath)},"options":{"prompts":{
    // Keep the planner explanation.
    "planner":"Plan carefully","reviewer":"Review carefully"
  }}}]}`
  await writeFile(f.path, source)
  const before = await f.settings.read()
  const saved = await f.settings.save(before.revision, { ...before.overrides, prompts: { ...before.overrides.prompts, reviewer: "Review boundary cases" } }, [])
  expect(saved.effective.prompts?.planner).toBe("Plan carefully")
  expect(saved.effective.prompts?.reviewer).toBe("Review boundary cases")
  expect(await readFile(f.path, "utf8")).toContain("// Keep the planner explanation.")
})

test("an explicit shared profile resolves relative plugin paths beside that file", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ plugins: [{ package: "./ultra", options: { limits: { workers: 2 } } }] }))
  const settings = new GlobalSettings({ path: f.path, configDirectory: join(f.directory, "other-default-profile"), packagePath: f.packagePath })
  expect((await settings.read()).effective.limits.workers).toBe(2)
})

test("concurrent editors in different instances cannot overwrite the first global save", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ plugins: [{ package: f.packagePath }] }))
  const other = new GlobalSettings({ configDirectory: f.directory, packagePath: f.packagePath })
  const before = await f.settings.read()
  const results = await Promise.allSettled([
    f.settings.save(before.revision, { limits: { workers: 1 } }, []),
    other.save(before.revision, { limits: { workers: 2 } }, []),
  ])
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"])
  expect((await f.settings.read()).effective.limits.workers).toBe(1)
})

test("invalid global limits are rejected without changing the native profile", async () => {
  const f = await fixture(), source = JSON.stringify({ plugins: [{ package: f.packagePath }] })
  await writeFile(f.path, source)
  const before = await f.settings.read()
  await expect(f.settings.save(before.revision, { limits: { workers: 0 } }, [])).rejects.toThrow("integer")
  expect(await readFile(f.path, "utf8")).toBe(source)
})

test("cancelled global writes preserve the original profile", async () => {
  const f = await fixture(), source = JSON.stringify({ plugins: [{ package: f.packagePath }] })
  await writeFile(f.path, source)
  const before = await f.settings.read(), controller = new AbortController()
  controller.abort()
  await expect(f.settings.save(before.revision, { limits: { workers: 1 } }, [], controller.signal)).rejects.toThrow()
  expect(await readFile(f.path, "utf8")).toBe(source)
})

test("ambiguous global registrations are refused before any profile write", async () => {
  const f = await fixture(), source = JSON.stringify({ plugins: [f.packagePath, { package: f.packagePath, options: { limits: { workers: 2 } } }] })
  await writeFile(f.path, source)
  await expect(f.settings.read()).rejects.toThrow("Multiple Ultra registrations")
  expect(await readFile(f.path, "utf8")).toBe(source)
})

test("duplicate JSONC properties cannot redirect a global edit to a shadowed configuration", async () => {
  const f = await fixture(), plugins = JSON.stringify([{ package: f.packagePath }])
  const source = `{"plugins":${plugins},"plugins":${plugins}}`
  await writeFile(f.path, source)
  await expect(f.settings.read()).rejects.toThrow("Duplicate")
  expect(await readFile(f.path, "utf8")).toBe(source)
})

test("global settings refuse a symlinked profile instead of following it", async () => {
  const f = await fixture(), target = join(f.directory, "real-profile.json")
  const source = JSON.stringify({ plugins: [{ package: f.packagePath }] })
  await writeFile(target, source)
  await symlink(target, f.path)
  await expect(f.settings.read()).rejects.toThrow("symlink")
  expect(await readFile(target, "utf8")).toBe(source)
})

test("moving a global profile from JSON to JSONC invalidates an editor's displayed target", async () => {
  const f = await fixture(), source = JSON.stringify({ plugins: [{ package: f.packagePath }] })
  await writeFile(f.path, source)
  const before = await f.settings.read(), target = join(f.directory, "opencode.jsonc")
  await rename(f.path, target)
  await expect(f.settings.save(before.revision, { limits: { workers: 1 } }, [])).rejects.toThrow("changed")
  expect(await readFile(target, "utf8")).toBe(source)
})

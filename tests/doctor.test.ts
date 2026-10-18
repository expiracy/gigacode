import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { doctor } from "../scripts/doctor.ts"
import { productionPluginDirectory } from "../scripts/install.ts"

async function fixture() {
  await mkdir(resolve(".spike"), { recursive: true })
  const root = await mkdtemp(resolve(".spike", "doctor-"))
  const directory = join(root, "project"), configDirectory = join(root, "config"), host = join(root, "host")
  await mkdir(directory)
  await mkdir(configDirectory)
  await mkdir(join(host, "bin"), { recursive: true })
  const binary = join(host, "bin", "opencode")
  await writeFile(binary, "fixture binary; never executed\n")
  await writeFile(join(host, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.28" }))
  const configuration = {
    plugins: [{ package: productionPluginDirectory, options: { limits: { workers: 2 } } }],
    agents: { gigacode: { mode: "primary", hidden: false }, "gigacode-supervisor": { mode: "subagent" }, "gigacode-worker": { mode: "subagent" } },
    experimental: { subagent_depth: 2 }, providers: { private: { settings: { apiKey: "doctor-provider-secret" } } },
  }
  const path = join(configDirectory, "opencode.json")
  await writeFile(path, JSON.stringify(configuration))
  const environment = { HOME: root, OPENCODE_BIN: binary, OPENAI_API_KEY: "doctor-environment-secret" }
  return { root, directory, configDirectory, binary, host, configuration, path, environment }
}

test("doctor reports a healthy installation without exposing configuration or changing files", async () => {
  const value = await fixture()
  const files = (await readdir(value.root, { recursive: true })).sort()
  const original = await readFile(value.path, "utf8")
  const report = await doctor(value)
  expect(report.ok).toBe(true)
  expect(report.package).toMatchObject({ name: "opencode-gigacode", directory: productionPluginDirectory })
  expect(report.bun.version).toBe(Bun.version)
  expect(report.host).toMatchObject({ executable: value.binary, version: "2.0.28", compatible: true })
  expect(report.profile).toMatchObject({ directory: value.configDirectory, files: [value.path] })
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "live-models", status: "unverified" }))
  expect(JSON.stringify(report)).not.toContain("doctor-provider-secret")
  expect(JSON.stringify(report)).not.toContain("doctor-environment-secret")
  expect(await readFile(value.path, "utf8")).toBe(original)
  expect((await readdir(value.root, { recursive: true })).sort()).toEqual(files)
})

test("doctor identifies a stale registration whose installed package directory was removed", async () => {
  const value = await fixture()
  value.configuration.plugins[0]!.package = join(value.root, "previous-prefix", "node_modules", "opencode-gigacode")
  await writeFile(value.path, JSON.stringify(value.configuration))
  const report = await doctor(value)
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "registration-target", status: "fail", message: expect.stringContaining("missing") }))
  expect(await readFile(value.path, "utf8")).toBe(JSON.stringify(value.configuration))
})

test("doctor inspects OPENCODE_CONFIG overrides and labels the setup-directory mismatch", async () => {
  const value = await fixture()
  const explicitFile = join(value.root, "custom-profile.json")
  const source = JSON.stringify({ agents: { gigacode: { hidden: true } }, providers: { private: { apiKey: "explicit-profile-secret" } } })
  await writeFile(explicitFile, source)
  const report = await doctor({ ...value, environment: { ...value.environment, OPENCODE_CONFIG: explicitFile } })
  expect(report.ok).toBe(false)
  expect(report.profile.explicitFile).toBe(explicitFile)
  expect(report.profile.files).toEqual([value.path, explicitFile])
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "profile-selection", status: "warning" }))
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "agent:gigacode", status: "fail" }))
  expect(JSON.stringify(report)).not.toContain("explicit-profile-secret")
  expect(await readFile(explicitFile, "utf8")).toBe(source)
})

test("doctor recognises a standalone project installation without requiring a global registration", async () => {
  const value = await fixture()
  const projectPath = join(value.directory, "opencode.json")
  await rename(value.path, projectPath)
  const report = await doctor(value)
  expect(report.ok).toBe(true)
  expect(report.project.files).toEqual([projectPath])
  expect(report.profile.files).toEqual([])
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "profile", status: "warning" }))
})

test("doctor reports malformed native syntax without printing source credentials", async () => {
  const value = await fixture()
  const source = '{"providers":{"secret":{"apiKey":"malformed-native-secret"}}, invalid json}'
  await writeFile(value.path, source)
  const report = await doctor(value)
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "profile", status: "fail" }))
  expect(JSON.stringify(report)).not.toContain("malformed-native-secret")
  expect(await readFile(value.path, "utf8")).toBe(source)
})

test("doctor validates project option contracts without exposing invalid field names or values", async () => {
  const value = await fixture()
  const path = join(value.directory, "gigacode.json")
  const source = JSON.stringify({ "private-field-secret": "private-value-secret", limits: { workers: 0 } })
  await writeFile(path, source)
  const report = await doctor(value)
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "project-options", status: "fail" }))
  expect(JSON.stringify(report)).not.toContain("private-field-secret")
  expect(JSON.stringify(report)).not.toContain("private-value-secret")
  expect(await readFile(path, "utf8")).toBe(source)
})

test("doctor rejects duplicate registrations even when they reference the same package", async () => {
  const value = await fixture()
  value.configuration.plugins.push(structuredClone(value.configuration.plugins[0]!))
  await writeFile(value.path, JSON.stringify(value.configuration))
  const report = await doctor(value)
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "registration", status: "fail", message: expect.stringContaining("Multiple") }))
})

test("doctor refuses malformed required-agent visibility instead of treating it as visible", async () => {
  const value = await fixture()
  value.configuration.agents.gigacode.hidden = "false" as any
  await writeFile(value.path, JSON.stringify(value.configuration))
  const report = await doctor(value)
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "agent:gigacode", status: "fail" }))
})

test("doctor reports a missing host without selecting an unrelated installation or invoking a process", async () => {
  const value = await fixture()
  const which = spyOn(Bun, "which").mockReturnValue(null)
  const spawn = spyOn(Bun, "spawnSync")
  try {
    const report = await doctor({ ...value, environment: { ...value.environment, OPENCODE_BIN: undefined } })
    expect(report.ok).toBe(false)
    expect(report.host).toEqual({ compatible: false })
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "host", status: "fail" }))
    expect(spawn).not.toHaveBeenCalled()
  } finally { which.mockRestore(); spawn.mockRestore() }
})

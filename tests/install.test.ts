import { describe, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import * as installer from "../scripts/install.ts"

async function fixture() {
  await mkdir(resolve(".spike"), { recursive: true })
  const root = await mkdtemp(resolve(".spike", "global-install-"))
  const plugin = join(root, "plugin")
  const configDirectory = join(root, "config")
  await mkdir(plugin)
  await writeFile(join(plugin, "index.ts"), "export default {}\n")
  return { root, plugin, configDirectory }
}

async function hostFixture(manifest?: Record<string, unknown>) {
  const value = await fixture()
  const packageDirectory = join(value.root, "host")
  const binary = join(packageDirectory, "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
  await mkdir(join(packageDirectory, "bin"), { recursive: true })
  await writeFile(binary, "fixture binary; never executed\n")
  if (manifest) await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest))
  const appData = join(value.root, "appdata")
  const unrelated = join(appData, "npm", "node_modules", "@opencode", "cli")
  await mkdir(unrelated, { recursive: true })
  await writeFile(join(unrelated, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.25" }))
  return { ...value, packageDirectory, binary, appData }
}

describe("installed host discovery", () => {
  const nativeName = `@opencode/cli-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  test("recognizes the exact official native package for the selected platform and architecture", async () => {
    const value = await hostFixture({ name: nativeName, version: "2.0.26", os: [process.platform], cpu: [process.arch] })
    expect(installer.installedVersion({ binary: value.binary, appData: value.appData })).toEqual({ version: "2.0.26", source: join(value.packageDirectory, "package.json") })
  })

  const mismatches: Record<string, unknown>[] = [
    { name: "some-opencode-wrapper", version: "2.0.26" },
    { name: process.platform === "win32" ? "@opencode/cli-linux-x64" : "@opencode/cli-windows-x64", version: "2.0.26", os: [process.platform], cpu: [process.arch] },
    { name: `@opencode/cli-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "x64" : "arm64"}`, version: "2.0.26", os: [process.platform], cpu: [process.arch] },
    { name: nativeName, version: "2.0.26", os: ["unsupported"], cpu: [process.arch] },
    { name: nativeName, version: "2.0.26", os: [process.platform], cpu: ["unsupported"] },
  ]
  test.each(mismatches)("refuses a mismatching selected manifest without using another installed CLI: %j", async manifest => {
    const value = await hostFixture(manifest)
    const spawn = spyOn(Bun, "spawnSync")
    try {
      expect(() => installer.installedVersion({ binary: value.binary, appData: value.appData })).toThrow("selected OpenCode")
      expect(spawn).not.toHaveBeenCalled()
    } finally { spawn.mockRestore() }
  })

  test("refuses a missing explicitly selected binary instead of using an unrelated CLI manifest", async () => {
    const value = await hostFixture()
    expect(() => installer.installedVersion({ binary: join(value.root, "missing", "opencode.exe"), appData: value.appData })).toThrow("selected OpenCode")
  })

  test("checks a bare selected executable with --version in an isolated environment", async () => {
    const value = await hostFixture()
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: new Uint8Array(Buffer.from("opencode v2.0.26\r\n")), stderr: new Uint8Array() } as any)
    try {
      expect(installer.installedVersion({ binary: value.binary, appData: value.appData })).toEqual({ version: "2.0.26", source: `${value.binary} --version (isolated profile)` })
      const [command, options] = spawn.mock.calls[0]!
      expect(command).toEqual([value.binary, "--version"])
      expect(options).toMatchObject({ timeout: 5_000, maxBuffer: 4096, windowsHide: true })
      expect(options!.env!.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1")
      expect(options!.env!.OPENCODE_CONFIG).toBeUndefined()
      expect(options!.env!.OPENCODE_CONFIG_CONTENT).toBeUndefined()
      expect(options!.env!.OPENAI_API_KEY).toBeUndefined()
      expect(options!.env!.ANTHROPIC_API_KEY).toBeUndefined()
      expect(options!.env!.USERPROFILE).toBe(options!.cwd)
      expect(existsSync(options!.cwd as string)).toBe(false)
    } finally { spawn.mockRestore() }
  })

  test("resolves a relative bare executable before changing its version probe directory", async () => {
    const value = await hostFixture()
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.from("2.0.26\n"), stderr: Buffer.alloc(0) } as any)
    try {
      expect(installer.installedVersion({ binary: relative(process.cwd(), value.binary), appData: value.appData }).version).toBe("2.0.26")
      expect(spawn.mock.calls[0]![0]).toEqual([value.binary, "--version"])
    } finally { spawn.mockRestore() }
  })

  test.each([
    { exitCode: 1, stdout: "2.0.26", stderr: "synthetic-secret" },
    { exitCode: 0, stdout: "Welcome!\n2.0.26", stderr: "" },
    { exitCode: 0, stdout: "2.0.26-dev", stderr: "" },
    { exitCode: null, stdout: "", stderr: "synthetic-secret" },
  ])("refuses failed or ambiguous bare-executable version output: %j", async output => {
    const value = await hostFixture()
    const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ ...output, stdout: Buffer.from(output.stdout), stderr: Buffer.from(output.stderr) } as any)
    try {
      let error: unknown
      try { installer.installedVersion({ binary: value.binary, appData: value.appData }) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("selected OpenCode")
      expect((error as Error).message).not.toContain("synthetic-secret")
      expect(existsSync(spawn.mock.calls[0]![1]!.cwd as string)).toBe(false)
    } finally { spawn.mockRestore() }
  })
})

describe("global installer", () => {
  test("accepts the exact 2.0.26 host version", async () => {
    const { plugin, configDirectory } = await fixture()
    const installed = await installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.26" })
    expect(installed.supportedVersion).toBe("2.0.26")
    expect(JSON.parse(await readFile(installed.path, "utf8")).plugins).toEqual([{ package: plugin }])
  })

  test("uses the pinned host's global path rules on every platform", () => {
    expect(installer.globalConfigDirectory({}, "/home/example")).toBe(resolve("/home/example/.config/opencode"))
    expect(installer.globalConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home/example")).toBe(resolve("/xdg/opencode"))
    expect(installer.globalConfigDirectory({ OPENCODE_CONFIG_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" }, "/home/example")).toBe(resolve("/custom"))
    expect(installer.globalConfigDirectory({ XDG_CONFIG_HOME: "" }, "/home/example")).toBe(resolve("/home/example/.config/opencode"))
  })

  test("installs once in a new global directory without creating project files", async () => {
    const { root, plugin, configDirectory } = await fixture()
    const installed = await installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(installed.scope).toBe("global")
    expect(installed.path).toBe(join(configDirectory, "opencode.json"))
    const config = JSON.parse(await readFile(installed.path, "utf8"))
    expect(config.plugins).toEqual([{ package: plugin }])
    expect(config.experimental.subagent_depth).toBe(2)
    expect(config.agents["ultra-supervisor"].mode).toBe("subagent")
    expect(config.agents["ultra-worker"].permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    expect(existsSync(join(root, "opencode.json"))).toBe(false)
    expect(existsSync(join(root, ".ultracode"))).toBe(false)
  })

  test("preserves global JSONC, unrelated settings and credentials in an original backup", async () => {
    const { plugin, configDirectory } = await fixture()
    await mkdir(configDirectory)
    const original = '{ // global defaults\n"model":"other/model", "providers":{"other":{"settings":{"apiKey":"synthetic-secret","baseURL":"https://example.invalid/a//b"}}}, "permissions":[{"action":"shell","resource":"*","effect":"ask"}], "plugins":[{"package":"other-plugin"}], "experimental":{"subagent_depth":4}, }'
    const path = join(configDirectory, "opencode.jsonc")
    await writeFile(path, original)
    const installed = await installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25", config: { models: { roles: { planner: "p/design" } }, limits: { workers: 2 } } })
    const config = JSON.parse(await readFile(path, "utf8"))
    expect(config.model).toBe("other/model")
    expect(config.providers.other.settings.apiKey).toBe("synthetic-secret")
    expect(config.permissions).toEqual([{ action: "shell", resource: "*", effect: "ask" }])
    expect(config.experimental.subagent_depth).toBe(4)
    expect(config.plugins[0]).toEqual({ package: "other-plugin" })
    expect(config.plugins[1].options).toEqual({ models: { roles: { planner: "p/design" } }, limits: { workers: 2 } })
    expect(await readFile(installed.backup!, "utf8")).toBe(original)
    expect(JSON.stringify(installed)).not.toContain("synthetic-secret")
  })

  test("reinstallation does not add duplicate registrations or backups", async () => {
    const { plugin, configDirectory } = await fixture()
    const options = { configDirectory, pluginPath: plugin, hostVersion: "2.0.25", config: { checks: [] } }
    const first = await installer.installGlobal(options)
    const contents = await readFile(first.path, "utf8")
    const second = await installer.installGlobal(options)
    expect(second.backup).toBeUndefined()
    expect(second.changes).toEqual([])
    expect(await readFile(first.path, "utf8")).toBe(contents)
    expect(await readdir(configDirectory)).toEqual(["opencode.json"])
  })

  test("accepts a relative existing package entry and normalises it without duplicating it", async () => {
    const { plugin, configDirectory } = await fixture()
    await mkdir(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [{ package: "../plugin", options: { limits: { runs: 1 } } }] }))
    const installed = await installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(JSON.parse(await readFile(installed.path, "utf8")).plugins).toEqual([{ package: plugin, options: { limits: { runs: 1 } } }])
  })

  test("migrates a named Ultra entry and preserves native string plugins", async () => {
    const { plugin, configDirectory } = await fixture()
    await mkdir(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: ["other-plugin", "-removed-plugin", { package: "ultra-open-code", options: { checks: [] } }] }))
    const installed = await installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(JSON.parse(await readFile(installed.path, "utf8")).plugins).toEqual(["other-plugin", "-removed-plugin", { package: plugin, options: { checks: [] } }])
  })

  test("rejects duplicate Ultra registrations before a later entry can hide the requested options", async () => {
    const { plugin, configDirectory } = await fixture()
    await mkdir(configDirectory)
    const path = join(configDirectory, "opencode.json")
    const original = JSON.stringify({ plugins: [{ package: "ultra-open-code", options: { limits: { workers: 1 } } }, { package: plugin, options: { limits: { workers: 3 } } }] })
    await writeFile(path, original)
    await expect(installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25", config: { limits: { workers: 2 } } })).rejects.toThrow("Multiple Ultra")
    expect(await readFile(path, "utf8")).toBe(original)
    expect(await readdir(configDirectory)).toEqual(["opencode.json"])
  })

  test("resolves a native platform relative package path from the global directory", async () => {
    const { plugin, configDirectory } = await fixture()
    await mkdir(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [{ package: relative(configDirectory, plugin) }] }))
    const installed = await installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(JSON.parse(await readFile(installed.path, "utf8")).plugins).toEqual([{ package: plugin }])
  })

  test("does not expose malformed native configuration source in an error", () => {
    let message = ""
    try { installer.parseNativeConfiguration('synthetic-secret {"providers":') } catch (error) { message = (error as Error).message }
    expect(message).toContain("configuration")
    expect(message).not.toContain("synthetic-secret")
  })

  test("rejects invalid input before creating a missing configuration directory", async () => {
    const { plugin, configDirectory } = await fixture()
    await expect(installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.27" })).rejects.toThrow("2.0.25")
    await expect(installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25", config: { limits: { workers: 0 } } })).rejects.toThrow("workers")
    expect(existsSync(configDirectory)).toBe(false)
  })

  test("rejects ambiguous config files and reserved agent conflicts without mutation", async () => {
    const { plugin, configDirectory } = await fixture()
    await mkdir(configDirectory)
    const path = join(configDirectory, "opencode.json")
    await writeFile(path, '{"agents":{"ultra-worker":{"mode":"primary"}}}')
    const original = await readFile(path, "utf8")
    await expect(installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25" })).rejects.toThrow("ultra-worker")
    await writeFile(join(configDirectory, "opencode.jsonc"), "{}")
    await expect(installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25" })).rejects.toThrow("Both")
    expect(await readFile(path, "utf8")).toBe(original)
    expect((await readdir(configDirectory)).sort()).toEqual(["opencode.json", "opencode.jsonc"])
  })

  test("refuses a dangling symlinked config instead of replacing it", async () => {
    const { root, plugin, configDirectory } = await fixture()
    await mkdir(configDirectory)
    const path = join(configDirectory, "opencode.json")
    await symlink(join(root, "missing-target"), path, "junction")
    await expect(installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.25" })).rejects.toThrow("symlink")
    expect((await readdir(configDirectory))).toEqual(["opencode.json"])
  })

  test("defaults installer arguments to global and keeps an explicit project mode", async () => {
    expect(await installer.parseInstallArguments([])).toMatchObject({ scope: "global" })
    expect(await installer.parseInstallArguments(["--project", "project"])).toMatchObject({ scope: "project", directory: "project" })
    expect(await installer.parseInstallArguments(["--local", "--project", "project"])).toMatchObject({ scope: "project", directory: "project" })
    expect(await installer.parseInstallArguments(["--global", "--config-dir", "config"])).toMatchObject({ scope: "global", configDirectory: "config" })
    await expect(installer.parseInstallArguments(["--global", "--project", "project"])).rejects.toThrow("together")
    await expect(installer.parseInstallArguments(["--local", "--config-dir", "config"])).rejects.toThrow("global")
    await expect(installer.parseInstallArguments(["--config-dir"])).rejects.toThrow("argument")
    await expect(installer.parseInstallArguments(["--unknown"])).rejects.toThrow("Unknown")
  })
})

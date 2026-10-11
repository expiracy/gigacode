import { describe, expect, test } from "bun:test"
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

describe("global installer", () => {
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
    await expect(installer.installGlobal({ configDirectory, pluginPath: plugin, hostVersion: "2.0.26" })).rejects.toThrow("2.0.25")
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

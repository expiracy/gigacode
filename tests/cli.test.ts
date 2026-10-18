import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { executeLocalCommand as localCommand } from "../scripts/cli.ts"
import { installProject, parseNativeConfiguration, productionPluginDirectory } from "../scripts/install.ts"
import { SQLiteStore } from "../src/store.ts"
import { parseConfig } from "../src/config.ts"
import type { Run } from "../src/types.ts"

// Every offline test uses an isolated config path; never read the user's defaults.
const isolatedGlobalConfig = join(process.cwd(), ".spike", `cli-unconfigured-global-${crypto.randomUUID()}`)
const executeLocalCommand = (args: string[], options: { directory?: string; configDirectory?: string } = {}) => localCommand(args, { configDirectory: isolatedGlobalConfig, ...options })

async function fixture() {
  const base = join(process.cwd(), ".spike")
  mkdirSync(base, { recursive: true })
  const directory = await mkdtemp(join(base, "cli-"))
  const plugin = join(directory, "plugin")
  mkdirSync(plugin)
  await writeFile(join(plugin, "index.ts"), "export default {}\n")
  return { directory, plugin }
}

async function setupFixture() {
  const { directory } = await fixture()
  const profile = join(directory, "profile")
  const configDirectory = join(profile, "config")
  const host = join(directory, "host")
  mkdirSync(join(host, "bin"), { recursive: true })
  const binary = join(host, "bin", "opencode")
  await writeFile(binary, "fixture binary; never executed\n")
  await writeFile(join(host, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.28" }))
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile, OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_CONFIG: undefined, OPENCODE_BIN: binary }
  const run = (args: string[]) => Bun.spawnSync([process.execPath, join(productionPluginDirectory, "scripts", "cli.ts"), ...args], { cwd: directory, env: environment, stdout: "pipe", stderr: "pipe" })
  return { directory, configDirectory, environment, run }
}

describe("project installer and local CLI", () => {
  test("doctor --help explains diagnostic flags without reading the selected project or profile", async () => {
    const result = await executeLocalCommand(["doctor", "--help"], { directory: "/missing-doctor-project", configDirectory: "/missing-doctor-profile" })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("gigacode doctor [--json] [--project <directory>] [--global-config <directory>]")
    expect(result.output).toContain("read-only")
    expect(result.output).toContain("live")
  })

  test("doctor exposes structured and human installed diagnostics without modifying the configured profile", async () => {
    const { directory, configDirectory, run } = await setupFixture()
    expect(run(["setup", "--global"]).exitCode).toBe(0)
    const path = join(configDirectory, "opencode.json")
    const original = await readFile(path, "utf8")
    const files = (await readdir(directory, { recursive: true })).sort()
    const command = run(["doctor", "--json", "--project", directory, "--global-config", configDirectory])
    expect(new TextDecoder().decode(command.stderr)).toBe("")
    expect(command.exitCode).toBe(0)
    const report = JSON.parse(new TextDecoder().decode(command.stdout))
    expect(report.ok).toBe(true)
    expect(report.host).toMatchObject({ version: "2.0.28", compatible: true })
    expect(report.profile.directory).toBe(configDirectory)
    const human = run(["doctor"])
    expect(human.exitCode).toBe(0)
    expect(new TextDecoder().decode(human.stdout)).toContain("GigaCode doctor")
    expect(new TextDecoder().decode(human.stdout)).toContain("UNVERIFIED")
    expect(await readFile(path, "utf8")).toBe(original)
    expect((await readdir(directory, { recursive: true })).sort()).toEqual(files)
  })

  test("setup fails before writing configuration when the selected host is invalid", async () => {
    const { directory, configDirectory, environment } = await setupFixture()
    const command = Bun.spawnSync([process.execPath, join(productionPluginDirectory, "scripts", "cli.ts"), "setup"], {
      cwd: directory, env: { ...environment, OPENCODE_BIN: join(directory, "missing-opencode") }, stdout: "pipe", stderr: "pipe",
    })
    expect(command.exitCode).toBe(1)
    expect(new TextDecoder().decode(command.stderr)).toContain("Cannot verify selected OpenCode binary")
    expect(existsSync(configDirectory)).toBe(false)
    expect(existsSync(join(directory, "opencode.json"))).toBe(false)
  })

  test("setup --project configures the selected directory instead of the working directory", async () => {
    const { directory, configDirectory, run } = await setupFixture()
    const selected = join(directory, "selected-project")
    mkdirSync(selected)
    const command = run(["setup", "--project", selected])
    expect(command.exitCode).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(command.stdout))).toMatchObject({ scope: "project", path: join(selected, "opencode.json") })
    expect(existsSync(join(directory, "opencode.json"))).toBe(false)
    expect(existsSync(configDirectory)).toBe(false)
  })

  test("setup --local configures the current project without creating a global configuration", async () => {
    const { directory, configDirectory, run } = await setupFixture()
    const command = run(["setup", "--local"])
    expect(command.exitCode).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(command.stdout))).toMatchObject({ scope: "project", path: join(directory, "opencode.json"), packagePath: productionPluginDirectory })
    expect(JSON.parse(await readFile(join(directory, "opencode.json"), "utf8")).plugins).toEqual([{ package: productionPluginDirectory }])
    expect(existsSync(configDirectory)).toBe(false)
  })

  test("installed CLI reports its package version without reading the project", async () => {
    const manifest = JSON.parse(await readFile(join(productionPluginDirectory, "package.json"), "utf8"))
    const result = await executeLocalCommand(["--version"], { directory: "/missing-gigacode-project" })
    expect(result).toEqual({ exitCode: 0, output: `${manifest.name} ${manifest.version}` })
  })

  test("installed CLI help exposes setup and executable commands without loading configuration", async () => {
    const result = await executeLocalCommand(["--help"], { directory: "/missing-gigacode-project" })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("gigacode setup [--global | --local | --project <directory>]")
    expect(result.output).toContain("gigacode validate")
    expect(result.output).not.toContain("bun run gigacode")
    const setup = await executeLocalCommand(["setup", "--help"], { directory: "/missing-gigacode-project" })
    expect(setup.exitCode).toBe(0)
    expect(setup.output).toContain("gigacode setup")
    expect(setup.output).toContain("--config-dir")
  })

  test("setup registers the installed package globally and preserves user settings on repeated setup", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "profile", "config")
    mkdirSync(configDirectory, { recursive: true })
    const host = join(directory, "host")
    mkdirSync(join(host, "bin"), { recursive: true })
    const binary = join(host, "bin", "opencode")
    await writeFile(binary, "fixture binary; never executed\n")
    await writeFile(join(host, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.28" }))
    const native = { model: "private/default", providers: { private: { settings: { apiKey: "setup-provider-secret" } } }, plugins: ["another-plugin"], permissions: [{ action: "shell", resource: "*", effect: "ask" }] }
    const configPath = join(configDirectory, "opencode.json")
    const original = JSON.stringify(native)
    await writeFile(configPath, original)
    const optionsPath = join(directory, "options.json")
    await writeFile(optionsPath, JSON.stringify({ limits: { workers: 2 } }))
    const environment = { ...process.env, HOME: join(directory, "profile"), USERPROFILE: join(directory, "profile"), OPENCODE_CONFIG_DIR: join(directory, "unused-default"), OPENCODE_BIN: binary }
    const run = (args: string[]) => Bun.spawnSync([process.execPath, join(productionPluginDirectory, "scripts", "cli.ts"), ...args], { cwd: directory, env: environment, stdout: "pipe", stderr: "pipe" })
    const first = run(["setup", "--config-dir", configDirectory, "--config", optionsPath])
    expect(new TextDecoder().decode(first.stderr)).toBe("")
    expect(first.exitCode).toBe(0)
    const result = JSON.parse(new TextDecoder().decode(first.stdout))
    expect(result).toMatchObject({ scope: "global", packagePath: productionPluginDirectory, path: configPath, supportedVersion: "2.0.28" })
    const installed = JSON.parse(await readFile(configPath, "utf8"))
    expect(installed.plugins).toEqual(["another-plugin", { package: productionPluginDirectory, options: { limits: { workers: 2 } } }])
    expect(installed.providers).toEqual(native.providers)
    expect(installed.permissions).toEqual(native.permissions)
    expect(installed.model).toBe(native.model)
    expect(await readFile(result.backup, "utf8")).toBe(original)
    expect(new TextDecoder().decode(first.stdout)).not.toContain("setup-provider-secret")
    const contents = await readFile(configPath, "utf8")
    const files = await readdir(configDirectory)
    const second = run(["setup", "--global", "--config-dir", configDirectory])
    expect(second.exitCode).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(second.stdout)).changes).toEqual([])
    expect(await readFile(configPath, "utf8")).toBe(contents)
    expect(await readdir(configDirectory)).toEqual(files)
    expect(existsSync(join(directory, "opencode.json"))).toBe(false)
    expect(existsSync(join(directory, "unused-default"))).toBe(false)
  })

  test("exposes the gigacode package executable with the renamed help and slash command", async () => {
    const manifest = JSON.parse(await readFile(join(productionPluginDirectory, "package.json"), "utf8"))
    expect(manifest.name).toBe("opencode-gigacode")
    expect(manifest.bin?.gigacode).toBe("scripts/cli.ts")
    expect(manifest.bin?.ultraopencode).toBeUndefined()
    expect(manifest.scripts.gigacode).toBe("bun run scripts/cli.ts")
    expect(manifest.scripts.ultraopencode).toBeUndefined()
    const command = Bun.spawnSync([process.execPath, manifest.bin.gigacode, "help"], { cwd: productionPluginDirectory, stdout: "pipe", stderr: "pipe" })
    expect(command.exitCode).toBe(0)
    const help = new TextDecoder().decode(command.stdout)
    expect(help).toContain("GigaCode local CLI")
    expect(help).toContain("gigacode setup")
    expect(help).toContain("/gigacode inside OpenCode")
  })

  test("reads options from the opencode-gigacode native package registration", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [{ package: "opencode-gigacode", options: { limits: { workers: 2 } } }] }))
    const result = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output).config.limits.workers).toBe(2)
  })

  test("reads options from a pinned opencode-gigacode registry registration", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [{ package: "opencode-gigacode@0.1.0", options: { limits: { workers: 2 } } }] }))
    const result = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output).config.limits.workers).toBe(2)
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("ignores former named package settings in global and project registrations", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    const globalSource = JSON.stringify({ plugins: [{ package: "open-ultra-code", options: { limits: { workers: 0 }, prompts: { planner: "Former instructions" } } }] })
    const projectSource = JSON.stringify({ plugins: [{ package: "ultra-open-code", options: { limits: { workers: 999 } } }] })
    await writeFile(join(configDirectory, "opencode.json"), globalSource)
    await writeFile(join(directory, "opencode.json"), projectSource)
    const result = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output).config).toEqual(parseConfig({}))
    expect(await readFile(join(configDirectory, "opencode.json"), "utf8")).toBe(globalSource)
    expect(await readFile(join(directory, "opencode.json"), "utf8")).toBe(projectSource)
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("renders an explicit read-only recipe offline without creating workflow state", async () => {
    const { directory } = await fixture()
    const result = await executeLocalCommand(["render", "--recipe", "bug-investigation", "Inspect zero-duration behavior"], { directory })
    expect(result.exitCode).toBe(0)
    const plan = JSON.parse(result.output)
    expect(plan.tasks.map((task: any) => task.role)).toEqual(["explorer", "explorer", "planner"])
    expect(plan.tasks.every((task: any) => !task.writes)).toBe(true)
    expect(plan.criteria).toEqual([{ id: "request", description: "Inspect zero-duration behavior", required: true, kind: "assessment" }])
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
    for (const args of [["render", "--recipe", "unknown", "Inspect"], ["render", "--recipe", "deep-review", "--execute", "Inspect"], ["validate", "--recipe", "deep-review"]]) {
      expect((await executeLocalCommand(args, { directory })).exitCode).toBe(1)
    }
  })
  test("validates global defaults with partial native and GigaCode project overrides without a project installation", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({
      providers: { private: { settings: { apiKey: "global-provider-secret" } } },
      plugins: [{ package: "opencode-gigacode", options: {
        models: { default: "global/default", roles: { planner: "global/planner", reviewer: "global/reviewer" }, stages: { review: "global/review-stage" } },
        limits: { workers: 3, attempts: 15 }, prompts: { planner: "Global planning instructions", reviewer: "Global review instructions" },
        checks: [{ id: "global", command: "bun run global", criterionIds: ["verification"] }],
      } }],
    }))
    await writeFile(join(directory, "gigacode.json"), JSON.stringify({ models: { roles: { planner: "project/planner" } }, limits: { workers: 1 }, prompts: { planner: "Project planning instructions" } }))
    const validated = await executeLocalCommand(["validate", "--global-config", configDirectory], { directory })
    expect(validated.exitCode).toBe(0)
    const config = JSON.parse(validated.output).config
    expect(config.models).toEqual({ default: "global/default", roles: { planner: "project/planner", reviewer: "global/reviewer" }, stages: { review: "global/review-stage" } })
    expect(config.limits).toMatchObject({ workers: 1, attempts: 15 })
    expect(config.prompts).toEqual({ planner: "Project planning instructions", reviewer: "Global review instructions" })
    expect(config.checks.map((check: any) => check.id)).toEqual(["global"])
    expect(validated.output).not.toContain("global-provider-secret")
    expect(existsSync(join(directory, "opencode.json"))).toBe(false)
    expect(existsSync(join(directory, "opencode.jsonc"))).toBe(false)
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("native project registration replaces global options before GigaCode and explicit overrides", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.jsonc"), `// global options\n${JSON.stringify({ plugins: [{ package: productionPluginDirectory, options: { limits: { workers: 3, attempts: 17 }, models: { roles: { planner: "global/planner", reviewer: "global/reviewer" } }, checks: [{ id: "global", command: "bun run global", criterionIds: ["verification"] }] } }] })}`)
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [{ package: productionPluginDirectory, options: { limits: { workers: 2 }, models: { roles: { planner: "native/planner" } } } }] }))
    await writeFile(join(directory, "gigacode.json"), JSON.stringify({ models: { roles: { planner: "project/planner" } }, checks: [] }))
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    const configPath = join(directory, "explicit.json")
    await writeFile(configPath, JSON.stringify({ models: { roles: { planner: "explicit/planner" } }, limits: { workers: 1 } }))
    const validated = await executeLocalCommand(["validate", "--config", configPath], { directory, configDirectory })
    expect(validated.exitCode).toBe(0)
    expect(JSON.parse(validated.output).config.models.roles).toEqual({ planner: "explicit/planner" })
    expect(JSON.parse(validated.output).config).toMatchObject({ limits: { workers: 1, attempts: 24 }, checks: [] })
    const rendered = await executeLocalCommand(["render", "--execute", "Inspect merged configuration"], { directory, configDirectory })
    expect(rendered.exitCode).toBe(0)
    expect(JSON.parse(rendered.output).tasks.find((task: any) => task.id === "verify").checkIds).toEqual([])
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("an empty native project registration replaces global checks and restores project discovery", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [{ package: productionPluginDirectory, options: { limits: { workers: 2 }, checks: [] } }] }))
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [{ package: pathToFileURL(productionPluginDirectory).href }] }))
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }))
    const validated = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(validated.exitCode).toBe(0)
    expect(JSON.parse(validated.output).config.limits.workers).toBe(4)
    expect(JSON.parse(validated.output).config.checks).toEqual([{ id: "test", command: "npm run test", criterionIds: ["verification"] }])
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("rejects ambiguous package aliases across global and native project registrations", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [{ package: "opencode-gigacode", options: { limits: { workers: 2 } } }] }))
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [{ package: productionPluginDirectory, options: { limits: { workers: 1 } } }] }))
    const validated = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(validated.exitCode).toBe(1)
    expect(validated.output).toContain("Ambiguous GigaCode plugin registrations")
    expect(validated.output).toContain("gigacode.json")
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("resolves local global plugin entries against their config directory and ignores similarly named packages", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [
      { package: "some-gigacode-wrapper", options: { limits: { workers: 999 } } },
      { package: "some-open-ultra-code-wrapper", options: { limits: { workers: 999 } } },
      { package: relative(configDirectory, join(productionPluginDirectory, "index.ts")), options: { limits: { workers: 2 } } },
    ] }))
    const validated = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(validated.exitCode).toBe(0)
    expect(JSON.parse(validated.output).config.limits.workers).toBe(2)
  })

  test("accepts native string plugins alongside file URL options for the known GigaCode package", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({ plugins: [
      "unrelated-plugin",
      pathToFileURL(productionPluginDirectory).href,
      { package: pathToFileURL(productionPluginDirectory).href, options: { limits: { workers: 2 } } },
    ] }))
    const validated = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(validated.exitCode).toBe(0)
    expect(JSON.parse(validated.output).config.limits.workers).toBe(2)
    expect(existsSync(join(directory, "opencode.json"))).toBe(false)
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("fails closed for invalid global and project options without copying credentials or creating runtime state", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    const path = join(configDirectory, "opencode.json")
    await writeFile(path, JSON.stringify({ plugins: [{ package: "opencode-gigacode", options: { limits: { workers: 0 } } }] }))
    const invalidGlobal = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(invalidGlobal.exitCode).toBe(1)
    expect(invalidGlobal.output).toContain("limits.workers")
    await writeFile(path, JSON.stringify({ plugins: [{ package: "opencode-gigacode", options: { limits: { workers: 2 } } }] }))
    await writeFile(join(directory, "gigacode.json"), '{"providerSecrets":"must-not-forward"}')
    const invalidProject = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(invalidProject.exitCode).toBe(1)
    expect(invalidProject.output).toContain("Unknown configuration field")
    expect(invalidProject.output).not.toContain("must-not-forward")
    expect((await executeLocalCommand(["validate", "--global-config"], { directory, configDirectory })).output).toContain("Missing --global-config argument")
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("snapshot commands never load global or project configuration", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), "malformed global configuration")
    await writeFile(join(directory, "gigacode.json"), "malformed project configuration")
    const status = await executeLocalCommand(["status"], { directory, configDirectory })
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.output).runs).toEqual([])
    expect((await executeLocalCommand(["status", "--global-config", configDirectory], { directory })).exitCode).toBe(1)
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("reports ambiguous or malformed native configuration without exposing its source", async () => {
    const { directory } = await fixture()
    const configDirectory = join(directory, "global")
    mkdirSync(configDirectory)
    await writeFile(join(configDirectory, "opencode.json"), '{"providers":{"private":{"apiKey":"malformed-source-secret"}}, invalid json}')
    const malformed = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(malformed.exitCode).toBe(1)
    expect(malformed.output).toContain("Invalid native OpenCode configuration")
    expect(malformed.output).not.toContain("malformed-source-secret")
    await writeFile(join(configDirectory, "opencode.json"), "{}")
    await writeFile(join(configDirectory, "opencode.jsonc"), "{}")
    const ambiguous = await executeLocalCommand(["validate"], { directory, configDirectory })
    expect(ambiguous.exitCode).toBe(1)
    expect(ambiguous.output).toContain("Both opencode.json and opencode.jsonc")
    expect(existsSync(join(directory, "opencode.json"))).toBe(false)
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("merges native project settings without forwarding or printing credentials", async () => {
    const { directory, plugin } = await fixture()
    const native = { model: "private/model", providers: { private: { settings: { apiKey: "secret-credential", baseURL: "https://example.invalid/v1" } } }, plugins: [{ package: "another-plugin", options: { active: true } }], experimental: { anotherFlag: true }, permissions: [{ action: "shell", resource: "*", effect: "ask" }] }
    const path = join(directory, "opencode.json")
    await writeFile(path, JSON.stringify(native))
    const installed = await installProject({ directory, pluginPath: join(plugin, "index.ts"), hostVersion: "2.0.25" })
    const result = JSON.parse(await readFile(path, "utf8"))
    expect(result.providers).toEqual(native.providers)
    expect(result.model).toBe(native.model)
    expect(result.permissions).toEqual(native.permissions)
    expect(result.plugins).toEqual([{ package: "another-plugin", options: { active: true } }, { package: plugin }])
    expect(result.experimental).toEqual({ anotherFlag: true, subagent_depth: 2 })
    expect(result.agents.gigacode).toMatchObject({ mode: "primary", hidden: false })
    expect(result.agents.gigacode.permissions).toBeUndefined()
    expect(result.agents["gigacode-supervisor"].mode).toBe("subagent")
    expect(result.agents["gigacode-worker"].permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    expect(await readFile(installed.backup!, "utf8")).toBe(JSON.stringify(native))
    expect(JSON.stringify(installed)).not.toContain("secret-credential")
    await installProject({ directory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(JSON.parse(await readFile(path, "utf8")).plugins).toHaveLength(2)
  })

  test("supports JSONC syntax without damaging URL strings and preserves the original backup", async () => {
    const { directory, plugin } = await fixture()
    const source = '{ // project settings\n "model": "provider/model", "providers": {"custom":{"settings":{"baseURL":"https://example.invalid/a//b"}}}, /* note */ }'
    const path = join(directory, "opencode.jsonc")
    await writeFile(path, source)
    const installed = await installProject({ directory, pluginPath: plugin, hostVersion: "2.0.25" })
    expect(installed.path).toBe(path)
    expect(parseNativeConfiguration(await readFile(path, "utf8")).providers).toEqual({ custom: { settings: { baseURL: "https://example.invalid/a//b" } } })
    expect(await readFile(installed.backup!, "utf8")).toBe(source)
  })

  test("fails before mutation for incompatible runtime and conflicting reserved agents", async () => {
    const { directory, plugin } = await fixture()
    const path = join(directory, "opencode.json")
    await writeFile(path, '{"agents":{"gigacode-supervisor":{"mode":"primary"}}}')
    const original = await readFile(path, "utf8")
    await expect(installProject({ directory, pluginPath: plugin, hostVersion: "2.0.27" })).rejects.toThrow("2.0.25")
    await expect(installProject({ directory, pluginPath: plugin, hostVersion: "2.0.25" })).rejects.toThrow("gigacode-supervisor")
    expect(await readFile(path, "utf8")).toBe(original)
  })

  test("validates configuration and renders inspectable graphs without creating runtime state", async () => {
    const { directory } = await fixture()
    const path = join(directory, "gigacode-options.json")
    await writeFile(path, '{"models":{"roles":{"planner":"provider/model#deep"}},"limits":{"workers":2}}')
    const validated = await executeLocalCommand(["validate", "--config", path], { directory })
    expect(validated.exitCode).toBe(0)
    expect(JSON.parse(validated.output).config.models.roles.planner).toBe("provider/model#deep")
    const rendered = await executeLocalCommand(["render", "Inspect queue ordering"], { directory })
    expect(rendered.exitCode).toBe(0)
    expect(JSON.parse(rendered.output).tasks.map((task: any) => task.role)).toEqual(["planner"])
    const status = await executeLocalCommand(["status"], { directory })
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.output).runs).toEqual([])
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
    expect((await executeLocalCommand(["start", "Fix it"], { directory })).exitCode).toBe(1)
    expect((await executeLocalCommand(["help"], { directory })).output).toContain("OpenCode")
  })

  test("model-only installation preserves omitted checks and previews the same discovered project scripts as the live plugin", async () => {
    const { directory } = await fixture()
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit", lint: "lint-project", build: "build-project" } }))
    await writeFile(join(directory, "bun.lock"), "fixture lock")
    await installProject({ directory, hostVersion: "2.0.25", config: { models: { roles: { planner: "provider/model#deep" } } } })
    const installed = JSON.parse(await readFile(join(directory, "opencode.json"), "utf8"))
    expect(installed.plugins[0].options.checks).toBeUndefined()
    const validated = await executeLocalCommand(["validate"], { directory })
    expect(validated.exitCode).toBe(0)
    const config = JSON.parse(validated.output).config
    expect(config.models.roles.planner).toBe("provider/model#deep")
    expect(config.checks).toEqual(["test", "typecheck", "lint"].map(id => ({ id, command: `bun run ${id}`, criterionIds: ["verification"] })))
    const rendered = await executeLocalCommand(["render", "--execute", "Fix cancellation"], { directory })
    expect(rendered.exitCode).toBe(0)
    const plan = JSON.parse(rendered.output)
    expect(plan.tasks.find((task: any) => task.id === "verify").checkIds).toEqual(["test", "typecheck", "lint"])
    expect(plan.criteria.find((criterion: any) => criterion.id === "verification")).toMatchObject({ required: true, kind: "check" })
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("an explicit empty check list remains disabled despite available project scripts", async () => {
    const { directory } = await fixture()
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    await installProject({ directory, hostVersion: "2.0.25", config: { models: { roles: { planner: "provider/model" } }, checks: [] } })
    expect(JSON.parse(await readFile(join(directory, "opencode.json"), "utf8")).plugins[0].options.checks).toEqual([])
    const validated = await executeLocalCommand(["validate"], { directory })
    expect(JSON.parse(validated.output).config.checks).toEqual([])
    const rendered = await executeLocalCommand(["render", "--execute", "Inspect cancellation"], { directory })
    expect(JSON.parse(rendered.output).tasks.find((task: any) => task.id === "verify").checkIds).toEqual([])
  })

  test("explicit configuration files discover npm scripts while an explicit custom check replaces discovery", async () => {
    const { directory } = await fixture()
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }))
    const path = join(directory, "gigacode-options.json")
    await writeFile(path, JSON.stringify({ limits: { workers: 2 } }))
    const discovered = await executeLocalCommand(["validate", "--config", path], { directory })
    expect(JSON.parse(discovered.output).config.checks).toEqual([{ id: "test", command: "npm run test", criterionIds: ["verification"] }])
    const checks = [{ id: "custom", command: "node custom.js", criterionIds: ["custom-proof"] }]
    await writeFile(path, JSON.stringify({ checks }))
    const explicit = await executeLocalCommand(["validate", "--config", path], { directory })
    expect(JSON.parse(explicit.output).config.checks).toEqual(checks)
  })

  test("snapshot commands ignore former history directories without changing their contents", async () => {
    const { directory } = await fixture()
    const histories = [".ultraopencode", ".ultracode"]
    for (const name of histories) {
      mkdirSync(join(directory, name))
      await writeFile(join(directory, name, "state.sqlite"), `Former ${name} history`)
    }
    for (const verb of ["list", "status"]) {
      const result = await executeLocalCommand([verb], { directory })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.output).runs).toEqual([])
    }
    expect((await executeLocalCommand(["inspect", "previous-run"], { directory })).output).toContain("No local GigaCode state database")
    for (const name of histories) expect(await readFile(join(directory, name, "state.sqlite"), "utf8")).toBe(`Former ${name} history`)
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })

  test("lists and exports saved GigaCode run snapshots with sanitized history", async () => {
    const { directory } = await fixture()
    const state = join(directory, ".gigacode")
    const store = new SQLiteStore(join(state, "state.sqlite"))
    const run: Run = { id: "run_cli", projectId: "project", directory, parentSessionId: "ses_parent", intentId: "intent", intentExpiresAt: 0, objective: "Inspect persisted evidence", mode: "plan", status: "ready", phase: "planning", revision: 1, plans: [], tasks: [], criteria: [], capturedModel: { providerID: "provider", id: "model" }, modelOptions: {}, config: parseConfig({}), policy: [], workspaceHash: "hash", createdAt: 1, updatedAt: 2, activeMs: 0, repairRound: 0, continuation: 0, ownerEpoch: 0, generation: 0, errors: [], notifications: [] }
    store.create(run)
    store.event(run.projectId, { runId: run.id, kind: "example", data: { apiKey: "private-key" } })
    store.close()
    const listed = await executeLocalCommand(["list"], { directory })
    expect(JSON.parse(listed.output).runs[0].id).toBe("run_cli")
    const exported = await executeLocalCommand(["export", "run_cli"], { directory })
    expect(exported.exitCode).toBe(0)
    const paths = JSON.parse(exported.output)
    expect(paths.json).toContain(join(state, "artifacts"))
    expect(await readFile(paths.json, "utf8")).toContain("[REDACTED]")
    expect(await readFile(paths.markdown, "utf8")).toContain("Inspect persisted evidence")
    expect((await executeLocalCommand(["status", "missing"], { directory })).exitCode).toBe(1)
  })

  test("inspects and exports a worktree run from an explicitly selected shared database without changing saved state", async () => {
    const { directory } = await fixture()
    const worktree = join(directory, "worktree")
    mkdirSync(worktree)
    const databasePath = join(directory, ".gigacode", "state.sqlite")
    const store = new SQLiteStore(databasePath)
    const run: Run = { id: "run_worktree", projectId: "shared-project", directory: worktree, parentSessionId: "ses_parent", intentId: "intent", intentExpiresAt: 0, objective: "Inspect worktree evidence", mode: "plan", status: "ready", phase: "planning", revision: 1, plans: [], tasks: [], criteria: [], capturedModel: { providerID: "provider", id: "model" }, modelOptions: {}, config: parseConfig({}), policy: [], workspaceHash: "hash", createdAt: 1, updatedAt: 2, activeMs: 0, repairRound: 0, continuation: 0, ownerEpoch: 7, generation: 3, errors: [], notifications: [] }
    store.create(run)
    store.event(run.projectId, { runId: run.id, kind: "saved-evidence", data: { detail: "unchanged" } })
    const previousRun = store.get(run.id)
    const previousEvents = store.events(run.projectId, run.id)
    store.close()
    const select = ["--project", worktree, "--state", databasePath]
    const inspected = await executeLocalCommand(["inspect", run.id, ...select], { directory })
    expect(inspected.exitCode).toBe(0)
    expect(JSON.parse(inspected.output).run).toMatchObject({ id: run.id, directory: worktree, ownerEpoch: 7, generation: 3 })
    const listed = await executeLocalCommand(["list", ...select], { directory })
    expect(JSON.parse(listed.output).runs.map((saved: any) => saved.id)).toEqual([run.id])
    const status = await executeLocalCommand(["status", run.id, ...select], { directory })
    expect(JSON.parse(status.output).run.status).toBe("ready")
    const exported = await executeLocalCommand(["export", run.id, ...select], { directory })
    expect(exported.exitCode).toBe(0)
    const paths = JSON.parse(exported.output)
    expect(paths.json).toContain(join(directory, ".gigacode", "artifacts"))
    expect(JSON.parse(await readFile(paths.json, "utf8")).data.run.directory).toBe(worktree)
    expect(existsSync(join(worktree, ".gigacode"))).toBe(false)
    expect((await executeLocalCommand(["inspect", run.id, "--project", directory, "--state", databasePath])).exitCode).toBe(1)
    const after = new SQLiteStore(databasePath)
    try {
      expect(after.get(run.id)).toEqual(previousRun)
      expect(after.events(run.projectId, run.id)).toEqual(previousEvents)
    } finally { after.close() }
    expect((await executeLocalCommand(["help"])).output).toContain("--state <state.sqlite>")
  })

  test("explicit state selection is rejected for configuration and graph rendering commands", async () => {
    const { directory } = await fixture()
    const databasePath = join(directory, ".gigacode", "state.sqlite")
    expect((await executeLocalCommand(["validate", "--state", databasePath], { directory })).exitCode).toBe(1)
    expect((await executeLocalCommand(["render", "Describe the workflow", "--state", databasePath], { directory })).exitCode).toBe(1)
    expect((await executeLocalCommand(["list", "--state"], { directory })).output).toContain("Missing --state argument")
    expect(existsSync(join(directory, ".gigacode"))).toBe(false)
  })
})

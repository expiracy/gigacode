import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expectedHostVersion, isolatedEnvironment, prepareHostConfiguration, prepareIsolatedGit, stopHostProcess } from "./host.ts"

async function fixtureProcess(ignoreTerm: boolean) {
  const child = Bun.spawn([process.execPath, "--eval", `process.on("SIGTERM", () => { ${ignoreTerm ? "" : "process.exit(0)"} }); console.log("ready"); setInterval(() => {}, 1000);`], {
    env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true,
  })
  const reader = child.stdout.getReader()
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try {
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toContain("ready")
    return child
  } catch (error) { child.kill("SIGKILL"); await child.exited; throw error }
  finally { clearTimeout(timer); await reader.cancel() }
}

test.skipIf(process.platform === "win32")("a graceful isolated host exits normally without forced termination", async () => {
  const child = await fixtureProcess(false)
  try {
    await stopHostProcess(child, 1_000)
    expect(child.exitCode).toBe(0)
    expect(child.signalCode).toBeNull()
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited }
})

test.skipIf(process.platform === "win32")("an isolated host ignoring SIGTERM is killed within a deadline and still fails cleanup", async () => {
  const child = await fixtureProcess(true)
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Host shutdown remained pending")), 2_000) })
    await expect(Promise.race([stopHostProcess(child, 100), deadline])).rejects.toThrow("shutdown timed out")
    expect(child.signalCode).toBe("SIGKILL")
    expect(() => process.kill(child.pid, 0)).toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited }
})

test("native compatibility candidates are explicit and default to the original tested version", () => {
  expect(expectedHostVersion(undefined)).toBe("2.0.25")
  expect(expectedHostVersion("2.0.25")).toBe("2.0.25")
  expect(expectedHostVersion("2.0.26")).toBe("2.0.26")
  for (const version of ["", "2.0.24", "2.0.27", "latest", "2.0.26 "]) expect(() => expectedHostVersion(version)).toThrow(/candidate/)
})

test("native suites can select the installed 2.0.28 host explicitly", () => {
  expect(expectedHostVersion("2.0.28")).toBe("2.0.28")
})

test("project configuration discovery is disabled unless the isolated probe opts in", () => {
  expect(isolatedEnvironment("C:\\fixture", "local-password").OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1")
  expect(isolatedEnvironment("C:\\fixture", "local-password", { projectConfiguration: true }).OPENCODE_CONFIG_PROJECT_DISABLE).toBeUndefined()
  expect(isolatedEnvironment("C:\\fixture", "local-password", { projectConfiguration: false }).OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1")
})

test("child environment excludes inherited provider credentials and redirects state", () => {
  process.env.GIGACODE_SPIKE_PRIVATE_TEST = "do-not-forward"
  try {
    const environment = isolatedEnvironment("C:\\fixture", "local-password")
    expect(environment.GIGACODE_SPIKE_PRIVATE_TEST).toBeUndefined()
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.OPENCODE_CONFIG_DIR).toContain("fixture")
    expect(environment.XDG_DATA_HOME).toContain("fixture")
    expect(environment.OPENCODE_DB).toContain("fixture")
    expect(environment.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
  } finally {
    delete process.env.GIGACODE_SPIKE_PRIVATE_TEST
  }
})

test("the isolated native host selects a disposable home and Git configuration", () => {
  const root = resolve(".spike", "isolated-host-profile")
  const environment = isolatedEnvironment(root, "fixture-password")
  expect(environment.HOME).toBe(join(root, "home"))
  expect(environment.GIT_CONFIG_GLOBAL).toBe(join(root, "empty.gitconfig"))
  expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1")
})

test.skipIf(process.platform === "win32")("fixture Git isolation survives stripped environment flags and preserves local filter refusal", async () => {
  const root = await mkdtemp(resolve(".spike", "git-profile-"))
  const project = join(root, "project")
  try {
    await mkdir(join(root, "home"))
    await mkdir(project)
    await writeFile(join(root, "home", ".gitconfig"), '[filter "fixture-global"]\n  clean = cat\n')
    await prepareIsolatedGit(root)
    expect(await readFile(join(root, "empty.gitconfig"), "utf8")).toBe("\n")
    // Production readGit deliberately removes GIT_* before spawning Git.
    const environment = Object.fromEntries(Object.entries(isolatedEnvironment(root, "fixture-password")).filter(([name]) => !name.startsWith("GIT_")))
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" })
    expect(git("config", "--get-regexp", "^filter\\.").exitCode).toBe(1)
    expect(git("init", "--quiet", "--initial-branch=main").exitCode).toBe(0)
    await writeFile(join(project, "base.txt"), "baseline\n")
    expect(git("add", "base.txt").exitCode).toBe(0)
    expect(git("-c", "user.name=GigaCode fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Fixture baseline").exitCode).toBe(0)
    expect(git("config", "filter.fixture-local.clean", "cat").exitCode).toBe(0)
    expect(new TextDecoder().decode(git("config", "--get-regexp", "^filter\\.").stdout)).toContain("filter.fixture-local.clean")
    const source = pathToFileURL(resolve("src/worktrees.ts")).href
    const probe = Bun.spawnSync([process.execPath, "--eval", `import { parallelBaseline } from ${JSON.stringify(source)}; try { await parallelBaseline(process.cwd()); process.exitCode = 1 } catch (error) { console.log(error.message) }`], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(new TextDecoder().decode(probe.stdout)).toContain("Parallel writers do not support configured Git filters")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("global fixture bootstrap uses production installer and leaves projects without native configuration", async () => {
  await mkdir(resolve(".spike"), { recursive: true })
  const root = await mkdtemp(resolve(".spike", "global-host-"))
  for (const project of ["project", "other-project"]) await mkdir(join(root, project), { recursive: true })
  await prepareHostConfiguration({ root, fixtureURL: "http://127.0.0.1:1/v1", pluginDirectory: resolve("."), installGlobal: true, pluginOptions: { models: { roles: { planner: "fixture/alternate" } } } })
  const configuration = JSON.parse(await readFile(join(root, "config", "opencode.json"), "utf8"))
  expect(configuration.agents["gigacode-supervisor"].description).toBe("GigaCode workflow supervisor")
  expect(configuration.agents["gigacode-supervisor"].system).toContain("exact runId and intentId")
  expect(configuration.agents["gigacode-supervisor"].permissions).toEqual(["edit", "write", "patch", "shell"].map(action => ({ action, resource: "*", effect: "deny" })))
  expect(configuration.agents["gigacode-worker"].system).toContain("gigacode_submit")
  expect(configuration.plugins).toHaveLength(1)
  expect(configuration.plugins[0].options.models.roles.planner).toBe("fixture/alternate")
  expect(configuration.experimental.subagent_depth).toBe(2)
  expect(configuration.providers.fixture.settings.baseURL).toBe("http://127.0.0.1:1/v1")
  expect(configuration.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  for (const project of ["project", "other-project"]) for (const file of ["opencode.json", "opencode.jsonc"]) expect(await Bun.file(join(root, project, file)).exists()).toBe(false)
})

test("compatibility fixture bootstrap keeps its manual spike agents", async () => {
  await mkdir(resolve(".spike"), { recursive: true })
  const root = await mkdtemp(resolve(".spike", "manual-host-"))
  await prepareHostConfiguration({ root, fixtureURL: "http://127.0.0.1:1/v1", pluginDirectory: resolve("spike/plugin") })
  const configuration = JSON.parse(await readFile(join(root, "config", "opencode.json"), "utf8"))
  expect(configuration.agents["gigacode-supervisor"].description).toBe("Compatibility supervisor")
  expect(configuration.plugins[0].package).toBe(resolve("spike/plugin"))
  expect(configuration.plugins[0].options).toBeUndefined()
})

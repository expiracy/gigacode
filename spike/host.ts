import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createServer } from "node:net"

export function expectedHostVersion(value: string | undefined): "2.0.25" | "2.0.26" | "2.0.28" {
  const version = value ?? "2.0.25"
  if (version !== "2.0.25" && version !== "2.0.26" && version !== "2.0.28") throw new Error(`Unsupported compatibility candidate: ${version}; select 2.0.25, 2.0.26 or 2.0.28 with OPENCODE_TEST_VERSION`)
  return version
}
export const EXPECTED_VERSION = expectedHostVersion(process.env.OPENCODE_TEST_VERSION)

export interface IsolatedHost {
  root: string
  project: string
  otherProject: string
  baseURL: string
  client: OpenCodeClient
  process: Bun.Subprocess
  restart(): Promise<void>
  stop(): Promise<void>
  logs(): string
}

export async function waitFor<T>(
  description: string,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (accepts(value)) return value
      last = value
    } catch (error) {
      last = error instanceof Error ? error.message : error
    }
    await Bun.sleep(100)
  }
  const summary = JSON.stringify(Array.isArray(last) ? last.slice(-3) : last)?.slice(0, 2_000)
  throw new Error(`Timed out: ${description}; last=${summary}`)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", done)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing TCP port")
  const port = address.port
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
  return port
}

export function findBinary(): string {
  const explicit = process.env.OPENCODE_SPIKE_BIN
  if (explicit) return resolve(explicit)
  if (process.platform === "win32") {
    const appData = process.env.APPDATA
    if (appData) {
      const candidate = join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
      if (existsSync(candidate)) return candidate
    }
  }
  const candidate = Bun.which("opencode")
  if (!candidate) throw new Error("Set OPENCODE_SPIKE_BIN to an installed OpenCode 2 binary")
  return candidate
}

/** Never forward provider tokens, user configuration, or telemetry settings. */
export function isolatedEnvironment(root: string, password: string, options: { projectConfiguration?: boolean } = {}): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "OS", "TERM", "LANG"]) {
    if (process.env[name]) environment[name] = process.env[name]!
  }
  return {
    ...environment,
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TMPDIR: join(root, "tmp"),
    OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_CONFIG_DIR: join(root, "config"),
    OPENCODE_DB: join(root, "host.sqlite"),
    ...(options.projectConfiguration ? {} : { OPENCODE_CONFIG_PROJECT_DISABLE: "1" }),
    OPENCODE_TEST_VERSION: EXPECTED_VERSION,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MODELS_PATH: join(root, "models.json"),
    OPENCODE_PASSWORD: password,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "empty.npmrc"),
    npm_config_globalconfig: join(root, "empty.npmrc"),
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
    NO_COLOR: "1",
    CI: "1",
  }
}

export interface IsolatedHostOptions {
  root: string
  fixtureURL: string
  pluginDirectory: string
  pluginOptions?: Record<string, unknown>
  service?: boolean
  installGlobal?: boolean
  projectConfiguration?: boolean
}

/** Keep isolated provider configuration separate from production installation. */
export async function prepareHostConfiguration(options: IsolatedHostOptions): Promise<void> {
  const root = resolve(options.root)
  await mkdir(join(root, "config"), { recursive: true })
  const fixtureModel = {
    name: "Compatibility fixture",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 32_768, output: 4_096 },
  }
  const configuration: Record<string, unknown> = {
    update: "disable",
    model: "fixture/test",
    providers: {
      fixture: {
        name: "Local compatibility fixture",
        env: [],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: options.fixtureURL, apiKey: "fixture-only", provider: "fixture" },
        models: { test: fixtureModel, alternate: { ...fixtureModel, name: "Alternate fixture" } },
      },
    },
    experimental: { subagent_depth: 2 },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    agents: {
      "ultra-supervisor": { mode: "subagent", description: "Compatibility supervisor", system: "Run only the scripted compatibility tools." },
      "ultra-worker": {
        mode: "subagent",
        description: "Compatibility worker",
        system: "Run only the scripted compatibility tools.",
        permissions: [{ action: "subagent", resource: "*", effect: "deny" }],
      },
    },
    plugins: [{ package: resolve(options.pluginDirectory), ...(options.pluginOptions ? { options: options.pluginOptions } : {}) }],
  }
  if (options.installGlobal) {
    delete configuration.experimental
    delete configuration.agents
    delete configuration.plugins
  }
  await writeFile(join(root, "config", "opencode.json"), JSON.stringify(configuration, null, 2))
  if (options.installGlobal) {
    const { installGlobal } = await import("../scripts/install.ts")
    await installGlobal({ configDirectory: join(root, "config"), pluginPath: options.pluginDirectory, hostVersion: EXPECTED_VERSION, config: options.pluginOptions })
  }
}

export async function startHost(options: IsolatedHostOptions): Promise<IsolatedHost> {
  const root = resolve(options.root)
  const project = join(root, "project")
  const otherProject = join(root, "other-project")
  const port = await freePort()
  const password = crypto.randomUUID()
  const baseURL = `http://127.0.0.1:${port}`
  const environment = isolatedEnvironment(root, password, options)
  for (const directory of [project, otherProject, "home", "appdata", "localappdata", "xdg-config", "data", "state", "cache", "tmp", "config", "npm-cache", "bun-cache"].map(p => p === project || p === otherProject ? p : join(root, p))) {
    await mkdir(directory, { recursive: true })
  }
  await writeFile(join(root, "models.json"), "{}\n")
  await writeFile(join(root, "empty.npmrc"), "\n")
  await writeFile(join(project, "protected.txt"), "original\n")
  await writeFile(join(project, "README.md"), "Isolated compatibility fixture. No external model calls.\n")
  if (options.installGlobal) {
    // Fixtures live under this checkout. Distinct repositories stop native
    // canonical project discovery from inheriting the workspace's Git root.
    const git = Bun.which("git")
    if (!git) throw new Error("Git is required to isolate native global-installation projects")
    const noHooks = join(root, "no-git-hooks")
    const emptyGitConfig = join(root, "empty.gitconfig")
    await mkdir(noHooks, { recursive: true })
    await writeFile(emptyGitConfig, "\n")
    await writeFile(join(otherProject, "README.md"), "Other isolated global installation project.\n")
    const gitEnvironment = {
      ...environment,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Ultra integration fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Ultra integration fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    }
    for (const directory of [project, otherProject]) {
      for (const args of [["init", "--quiet", "--initial-branch=main"], ["add", "README.md", ...(directory === project ? ["protected.txt"] : [])], ["commit", "--quiet", "--no-gpg-sign", "--no-verify", "-m", "Initialize isolated integration fixture"]]) {
        const command = Bun.spawn([git, "-c", `core.hooksPath=${noHooks}`, ...args], { cwd: directory, env: gitEnvironment, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
        const [exit, output] = await Promise.all([command.exited, new Response(command.stderr).text()])
        if (exit !== 0) throw new Error(`Could not isolate fixture Git project (${args[0]}): ${output}`)
      }
    }
  }
  await prepareHostConfiguration(options)
  // --service uses its own saved password; keep both stable/channel config names isolated.
  for (const file of ["service.json", "service-v2.json"]) {
    await writeFile(join(root, "config", file), JSON.stringify({ password, remote: false }))
  }
  const binary = findBinary()
  const manifest = join(dirname(dirname(binary)), "package.json")
  if (existsSync(manifest)) {
    const version = JSON.parse(await readFile(manifest, "utf8")).version
    if (version !== EXPECTED_VERSION) throw new Error(`Expected OpenCode ${EXPECTED_VERSION}, installed ${version}`)
  }
  const client = OpenCode.make({ baseUrl: baseURL, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  let log = ""
  let child: Bun.Subprocess
  const drain = async (stream: ReadableStream<Uint8Array> | number | null | undefined) => {
    if (!stream || typeof stream === "number") return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const item = await reader.read()
      if (item.done) return
      log = (log + decoder.decode(item.value).replaceAll(password, "[fixture-password]")).slice(-1_000_000)
    }
  }
  const launch = async () => {
    child = Bun.spawn([binary, "serve", ...(options.service === false ? [] : ["--service"]), "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: project,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    void drain(child.stdout)
    void drain(child.stderr)
    try {
      const info = await waitFor("isolated OpenCode readiness", () => client.server.info({ signal: AbortSignal.timeout(1_000) }), value => value.version === EXPECTED_VERSION, 25_000)
      if (!JSON.stringify(info.paths).includes(root.replaceAll("\\", "/")) && !JSON.stringify(info.paths).includes(root.replaceAll("\\", "\\\\"))) {
        throw new Error("Server paths do not identify the isolated fixture")
      }
    } catch (error) {
      child.kill()
      await child.exited
      await writeFile(join(root, "host.log"), log)
      throw new Error(`${error instanceof Error ? error.message : error}\n${log.slice(-8_000)}`)
    }
  }
  const stop = async () => {
    if (child.exitCode === null) child.kill()
    await child.exited
    await writeFile(join(root, "host.log"), log)
  }
  await launch()
  return {
    root, project, otherProject, baseURL, client,
    get process() { return child },
    async restart() { await stop(); await launch() },
    stop,
    logs: () => log,
  }
}

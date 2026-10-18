import { existsSync, realpathSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseConfigOptions } from "../src/config.ts"
import { assertHostVersion, supportedVersions } from "../src/compatibility.ts"
import { globalConfigDirectory, isRegistryPackage, packageMatches, parseNativeConfiguration } from "../src/native-config.ts"
import { installedVersion, productionPluginDirectory } from "./install.ts"

export interface DoctorCheck { id: string; status: "pass" | "fail" | "warning" | "unverified"; message: string; path?: string }
export interface DoctorReport {
  ok: boolean
  package: { name: string; version: string; directory: string }
  bun: { version: string }
  host: { executable?: string; version?: string; source?: string; compatible: boolean }
  profile: { directory: string; files: string[]; explicitFile?: string }
  project: { directory: string; files: string[] }
  checks: DoctorCheck[]
}
export interface DoctorOptions { directory?: string; configDirectory?: string; environment?: Record<string, string | undefined> }

export const doctorHelp = `gigacode doctor [--json] [--project <directory>] [--global-config <directory>]
Run read-only installation diagnostics. --json prints the structured report;
--project selects the project and --global-config selects its native profile directory.
Reports package, Bun and selected OpenCode versions, profile files, registrations,
required agents, delegation and GigaCode option validity without printing option values.
Exit 1 means a check failed; warnings and unverified live checks do not fail.
Model availability, permissions and native loading require the live host.
No project, configuration or saved workflow files are changed. Bare host version
probing uses a disposable isolated profile and makes no model or network calls.`

export function formatDoctorReport(report: DoctorReport): string {
  return [
    `GigaCode doctor: ${report.ok ? "checks passed" : "checks failed"}`,
    `Package: ${report.package.name} ${report.package.version}`,
    `Bun: ${report.bun.version}`,
    `OpenCode executable: ${report.host.executable ?? "not found"}`,
    `OpenCode version: ${report.host.version ?? "unverified"}`,
    `Profile directory: ${report.profile.directory}`,
    `Profile files: ${report.profile.files.join(", ") || "none"}`,
    `Project: ${report.project.directory}`, "",
    ...report.checks.map(check => `${check.status.toUpperCase()} ${check.id}: ${check.message}${check.path ? `\n  ${check.path}` : ""}`),
  ].join("\n")
}

async function registrationTarget(name: string, directory: string): Promise<string | null | undefined> {
  if (isRegistryPackage(name)) return null
  const path = name.startsWith("file://") ? fileURLToPath(name) : resolve(directory, name)
  const root = /^index\.[jt]s$/.test(basename(path)) ? dirname(path) : path
  if (packageMatches(name, productionPluginDirectory, directory) || basename(root) === "opencode-gigacode") return path
  try { if (JSON.parse(await readFile(join(root, "package.json"), "utf8")).name === "opencode-gigacode") return path }
  catch { /* An unrelated package is not a GigaCode registration. */ }
}

/** Inspect selected files only. Never open a state database or print configuration values. */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const environment = options.environment ?? process.env
  const directory = resolve(options.directory ?? process.cwd())
  const configDirectory = resolve(options.configDirectory ?? globalConfigDirectory(environment, environment.HOME ?? environment.USERPROFILE ?? homedir()))
  const manifest = JSON.parse(await readFile(join(productionPluginDirectory, "package.json"), "utf8"))
  const nativeFiles = [join(configDirectory, "opencode.json"), join(configDirectory, "opencode.jsonc")].filter(existsSync)
  const explicitFile = environment.OPENCODE_CONFIG ? resolve(environment.OPENCODE_CONFIG) : undefined
  const files = [...nativeFiles, ...(explicitFile && !nativeFiles.includes(explicitFile) ? [explicitFile] : [])]
  const projectFiles = [join(directory, "opencode.json"), join(directory, "opencode.jsonc")].filter(existsSync)
  const report: DoctorReport = {
    ok: false, package: { name: manifest.name, version: manifest.version, directory: productionPluginDirectory }, bun: { version: Bun.version },
    host: { compatible: false }, profile: { directory: configDirectory, files, ...(explicitFile ? { explicitFile } : {}) }, project: { directory, files: projectFiles }, checks: [],
  }
  const check = (id: string, status: DoctorCheck["status"], message: string, path?: string) => report.checks.push({ id, status, message, ...(path ? { path } : {}) })
  check("package", "pass", `${manifest.name} ${manifest.version}`, productionPluginDirectory)
  check("bun", Bun.semver.satisfies(Bun.version, manifest.engines.bun) ? "pass" : "fail", `Bun ${Bun.version}; requires ${manifest.engines.bun}`)
  const explicit = environment.OPENCODE_BIN ?? environment.OPENCODE_SPIKE_BIN
  const selected = explicit ?? Bun.which("opencode")
  if (selected !== undefined && selected !== null) report.host.executable = existsSync(resolve(selected)) ? realpathSync(resolve(selected)) : resolve(selected)
  try {
    if (!selected || !existsSync(resolve(selected)) || !statSync(resolve(selected)).isFile()) throw new Error("Missing host")
    const host = installedVersion({ binary: explicit, appData: environment.APPDATA })
    if (/^\d+\.\d+\.\d+$/.test(host.version)) report.host.version = host.version
    report.host.source = host.source
    assertHostVersion(host.version)
    report.host.compatible = true
    check("host", "pass", `OpenCode ${host.version} is a tested host`, report.host.executable)
  } catch {
    check("host", "fail", `Cannot verify a supported OpenCode executable. Select OpenCode ${supportedVersions.join(", ")} on PATH or through OPENCODE_BIN.`, report.host.executable)
  }
  check("project", existsSync(directory) && statSync(directory).isDirectory() ? "pass" : "fail", "Selected project directory", directory)
  if (nativeFiles.length > 1) check("profile", "fail", "Both opencode.json and opencode.jsonc exist; select one native profile file.", configDirectory)
  if (!files.length) check("profile", projectFiles.length ? "warning" : "fail", projectFiles.length ? "No global profile configuration; checking the standalone project installation." : "No native profile configuration exists. Run gigacode setup for this profile.", configDirectory)
  if (projectFiles.length > 1) check("project-native", "fail", "Both project opencode.json and opencode.jsonc exist; select one native file.", directory)
  if (explicitFile && !nativeFiles.includes(explicitFile)) check("profile-selection", "warning", "OPENCODE_CONFIG selects an additional file. Setup writes opencode.json/opencode.jsonc in the displayed profile directory; verify the client uses the intended profile.", explicitFile)
  const agents: Record<string, any> = {}
  let depth: unknown
  const registrations = new Map<string, { entry: any; target: string | null; path: string }>()
  for (const path of [...files, ...projectFiles.filter(path => !files.includes(path))]) {
    let configuration: Record<string, any>
    try { configuration = parseNativeConfiguration(await readFile(path, "utf8")) }
    catch { check("profile", "fail", "Cannot read valid native JSON/JSONC; inspect the file locally.", path); continue }
    check("profile", "pass", "Native profile JSON/JSONC is valid", path)
    if (configuration.agents !== undefined && (!configuration.agents || typeof configuration.agents !== "object" || Array.isArray(configuration.agents))) check("agents", "fail", "Native agents must be an object.", path)
    else for (const name of ["gigacode", "gigacode-supervisor", "gigacode-worker"]) {
      if (Object.hasOwn(configuration.agents ?? {}, name)) {
        const agent = configuration.agents[name]
        agents[name] = agent && typeof agent === "object" && !Array.isArray(agent) ? { ...agents[name], ...agent } : undefined
      }
    }
    if (configuration.experimental !== undefined && (!configuration.experimental || typeof configuration.experimental !== "object" || Array.isArray(configuration.experimental))) check("delegation", "fail", "Native experimental settings must be an object.", path)
    else if (Object.hasOwn(configuration.experimental ?? {}, "subagent_depth")) depth = configuration.experimental.subagent_depth
    const plugins = configuration.plugins
    if (plugins === undefined) continue
    if (!Array.isArray(plugins)) { check("registration", "fail", "Native plugins must be an array.", path); continue }
    const matching: { entry: any; target: string | null; key: string }[] = []
    for (const entry of plugins) {
      const name = typeof entry === "string" ? entry : entry?.package
      if (typeof name !== "string" || typeof entry !== "string" && (!entry || typeof entry !== "object" || Array.isArray(entry))) {
        check("registration", "fail", "A native plugin entry has an invalid package shape.", path); continue
      }
      try {
        const target = await registrationTarget(name, dirname(path))
        if (target !== undefined) matching.push({ entry, target, key: target ?? `registry:${name}` })
      } catch { check("registration", "fail", "A native plugin package reference is invalid.", path) }
    }
    if (matching.length > 1) check("registration", "fail", "Multiple GigaCode registrations exist in one file; retain one registration.", path)
    for (const { entry, target, key } of matching) {
      registrations.set(key, { entry, target, path })
      try { parseConfigOptions(typeof entry === "string" ? undefined : entry.options); check("plugin-options", "pass", "GigaCode registration options are valid", path) }
      catch { check("plugin-options", "fail", "Invalid GigaCode registration options; inspect the configuration locally.", path) }
    }
  }
  check("registration", registrations.size === 1 ? "pass" : "fail", registrations.size === 1 ? "One GigaCode package reference is configured" : registrations.size ? "Different GigaCode package references may load duplicate plugin IDs; retain one package reference." : "GigaCode is not registered in the selected configuration files.")
  for (const { target, path } of registrations.values()) {
    if (target === null) check("registration-target", "unverified", "The registry reference must be resolved and loaded by the live host.", path)
    else {
      let available = false
      try { available = statSync(target).isFile() ? /^index\.[jt]s$/.test(basename(target)) : existsSync(join(target, "index.ts")) || existsSync(join(target, "index.js")) }
      catch { /* Missing or inaccessible registered package. */ }
      check("registration-target", available ? "pass" : "fail", available ? "The registered local package entrypoint exists" : "The registered local package or its entrypoint is missing; rerun setup from the installed package.", target)
    }
  }
  for (const [name, mode] of [["gigacode", "primary"], ["gigacode-supervisor", "subagent"], ["gigacode-worker", "subagent"]]) {
    const agent = agents[name!]
    const valid = agent?.mode === mode && (agent.disabled === undefined || agent.disabled === false) && (agent.hidden === undefined || typeof agent.hidden === "boolean") && (name !== "gigacode" || agent.hidden !== true)
    check(`agent:${name}`, valid ? "pass" : "fail", `Required ${name} agent must be enabled${name === "gigacode" ? ", visible" : ""} and use mode ${mode}.`)
  }
  check("delegation", Number.isSafeInteger(depth) && Number(depth) >= 2 ? "pass" : "fail", "Native delegation depth must be at least two")
  const projectPath = join(directory, "gigacode.json")
  if (existsSync(projectPath)) {
    try { parseConfigOptions(JSON.parse(await readFile(projectPath, "utf8"))); check("project-options", "pass", "Project GigaCode options are valid", projectPath) }
    catch { check("project-options", "fail", "Invalid project GigaCode JSON/options; inspect the file locally.", projectPath) }
  } else check("project-options", "pass", "No optional gigacode.json overrides", projectPath)
  check("live-models", "unverified", "Model availability and tool support require the live OpenCode catalog.")
  check("live-permissions", "unverified", "Native permissions, terminal loading and server connectivity require a live supported host.")
  check("native-discovery", "unverified", "Offline checks do not discover native ancestor/include files or client-injected configuration.")
  report.ok = !report.checks.some(check => check.status === "fail")
  return report
}

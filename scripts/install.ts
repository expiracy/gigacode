import { existsSync, lstatSync, readFileSync } from "node:fs"
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { parseConfigOptions } from "../src/config.ts"
import type { Rule } from "../src/types.ts"

export const supportedVersion = "2.0.25"
export const productionPluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** OpenCode 2.0.25 @opencode/util/global and global-roots, including on Windows. */
export function globalConfigDirectory(environment: Record<string, string | undefined> = process.env, home = homedir()): string {
  return resolve(environment.OPENCODE_CONFIG_DIR ?? join(environment.XDG_CONFIG_HOME || join(home, ".config"), "opencode"))
}

/** Read native JSONC without treating comment markers inside strings as comments. */
export function parseNativeConfiguration(text: string): Record<string, any> {
  let stripped = ""
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quoted) {
      stripped += character
      if (character === "\\") stripped += text[++index] ?? ""
      else if (character === '"') quoted = false
    } else if (character === '"') { quoted = true; stripped += character }
    else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++
      stripped += "\n"
    } else if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2)
      if (end === -1) throw new Error("Unterminated native configuration comment")
      stripped += " "
      index = end + 1
    } else stripped += character
  }
  let normalized = ""
  quoted = false
  for (let index = 0; index < stripped.length; index++) {
    const character = stripped[index]!
    if (quoted) {
      normalized += character
      if (character === "\\") normalized += stripped[++index] ?? ""
      else if (character === '"') quoted = false
    } else if (character === '"') { quoted = true; normalized += character }
    else if (character !== "," || !/^\s*[}\]]/.test(stripped.slice(index + 1))) normalized += character
  }
  let document: unknown
  try { document = JSON.parse(normalized.replace(/^\uFEFF/, "")) }
  catch { throw new Error("Invalid native configuration JSON/JSONC") }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Native configuration must be an object")
  return document as Record<string, any>
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
}

function installedVersion(): { version: string; source: string } {
  const candidates: string[] = []
  const binary = process.env.OPENCODE_BIN ?? process.env.OPENCODE_SPIKE_BIN ?? Bun.which("opencode")
  if (binary) {
    candidates.push(join(dirname(binary), "package.json"), join(dirname(dirname(binary)), "package.json"))
    candidates.push(join(dirname(binary), "node_modules", "@opencode", "cli", "package.json"))
  }
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@opencode", "cli", "package.json"))
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    if (manifest.name === "@opencode/cli" && typeof manifest.version === "string") return { version: manifest.version, source: path }
  }
  throw new Error(`Cannot verify an installed @opencode/cli manifest. Install OpenCode ${supportedVersion}; the plugin also checks the live host version.`)
}

function object(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a native OpenCode 2 object`)
  return value as Record<string, any>
}

function agent(existing: unknown, name: string, system: string, permissions: Rule[]): Record<string, unknown> {
  const settings = existing === undefined ? {} : object(existing, name)
  if (settings.mode !== undefined && settings.mode !== "subagent") throw new Error(`Reserved agent ${name} already has another mode; resolve the naming conflict before installing`)
  if (settings.permissions !== undefined && !Array.isArray(settings.permissions)) throw new Error(`${name}.permissions must be native OpenCode 2 rules`)
  const inherited = structuredClone(settings.permissions ?? []) as Rule[]
  for (const rule of permissions) if (!inherited.some(current => current.action === rule.action && current.resource === rule.resource && current.effect === rule.effect)) inherited.push(rule)
  return { ...settings, mode: "subagent", description: settings.description ?? `Ultra Open Code ${name === "ultra-supervisor" ? "workflow supervisor" : "workflow worker"}`, system: settings.system ?? system, permissions: inherited }
}

export interface InstallResult { scope: "global" | "project"; path: string; packagePath: string; backup?: string; supportedVersion: string; versionSource: string; changes: string[] }
export interface InstallOptions { directory?: string; configDirectory?: string; pluginPath?: string; hostVersion?: string; config?: unknown }

function present(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("Refusing to replace a symlinked configuration")
    return true
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

function packageMatches(entry: string, packagePath: string, directory: string): boolean {
  if (entry === "ultra-open-code") return true
  const path = entry.startsWith("file://") ? fileURLToPath(entry) : /^(?:\.\.?)[\\/]/.test(entry) ? resolve(directory, entry) : entry
  return samePath(path, packagePath) || samePath(path, join(packagePath, "index.ts")) || samePath(path, join(packagePath, "index.js"))
}

async function install(scope: "global" | "project", options: InstallOptions): Promise<InstallResult> {
  const version = options.hostVersion === undefined ? installedVersion() : { version: options.hostVersion, source: "declared by caller; live runtime is checked by the plugin" }
  if (version.version !== supportedVersion) throw new Error(`Ultra Open Code requires OpenCode ${supportedVersion}; found ${version.version}`)
  const requestedDirectory = resolve(scope === "global" ? options.configDirectory ?? globalConfigDirectory() : options.directory ?? process.cwd())
  const directory = existsSync(requestedDirectory) ? await realpath(requestedDirectory) : requestedDirectory
  if (existsSync(directory)) {
    if (!(await stat(directory)).isDirectory()) throw new Error("The target configuration directory must be a directory")
  } else if (scope === "project") throw new Error("The target project must be an existing directory")
  const selected = resolve(options.pluginPath ?? productionPluginDirectory)
  const packagePath = await realpath((await stat(selected)).isFile() ? dirname(selected) : selected)
  if (!existsSync(join(packagePath, "index.ts")) && !existsSync(join(packagePath, "index.js"))) throw new Error("The plugin package must contain its production index.ts or index.js entrypoint")
  const persisted = options.config === undefined ? undefined : parseConfigOptions(options.config)
  const json = join(directory, "opencode.json")
  const jsonc = join(directory, "opencode.jsonc")
  const hasJson = present(json)
  const hasJsonc = present(jsonc)
  if (hasJson && hasJsonc) throw new Error("Both opencode.json and opencode.jsonc exist; select a single configuration before installing")
  const path = hasJsonc ? jsonc : json
  const original = hasJson || hasJsonc ? await readFile(path, "utf8") : undefined
  const configuration = original === undefined ? {} : parseNativeConfiguration(original)
  const plugins = configuration.plugins === undefined ? [] : configuration.plugins
  if (!Array.isArray(plugins)) throw new Error("plugins must be a native OpenCode 2 array")
  for (const entry of plugins) if (typeof entry !== "string" && (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.package !== "string")) throw new Error("Existing plugin entries must use a native package string or {package, options?} shape")
  const matching = plugins.map((entry, index) => packageMatches(typeof entry === "string" ? entry : entry.package, packagePath, directory) ? index : -1).filter(index => index !== -1)
  if (matching.length > 1) throw new Error("Multiple Ultra plugin registrations exist; retain one registration before installing so later entries cannot hide the requested options")
  const existingIndex = matching[0] ?? -1
  if (existingIndex !== -1) {
    const existing = typeof plugins[existingIndex] === "string" ? { package: packagePath } : plugins[existingIndex]
    existing.package = packagePath
    if (persisted !== undefined) existing.options = persisted
    else if (existing.options !== undefined) parseConfigOptions(existing.options)
    plugins[existingIndex] = existing
  } else plugins.push({ package: packagePath, ...(persisted === undefined ? {} : { options: persisted }) })
  configuration.plugins = plugins
  const agents = configuration.agents === undefined ? {} : object(configuration.agents, "agents")
  agents["ultra-supervisor"] = agent(agents["ultra-supervisor"], "ultra-supervisor", "Use the supplied run instructions to call ultra_execute with the exact runId and intentId. Do not edit project files or independently spawn agents.", ["edit", "write", "patch", "shell"].map(action => ({ action, resource: "*", effect: "deny" })))
  agents["ultra-worker"] = agent(agents["ultra-worker"], "ultra-worker", "Follow the supplied Ultra task instructions, respect scoped permissions, and submit a structured result using ultra_submit. Do not spawn additional agents.", [{ action: "subagent", resource: "*", effect: "deny" }])
  configuration.agents = agents
  const experimental = configuration.experimental === undefined ? {} : object(configuration.experimental, "experimental")
  if (experimental.subagent_depth !== undefined && (!Number.isSafeInteger(experimental.subagent_depth) || experimental.subagent_depth < 0)) throw new Error("experimental.subagent_depth is invalid")
  experimental.subagent_depth = Math.max(2, experimental.subagent_depth ?? 0)
  configuration.experimental = experimental
  const output = JSON.stringify(configuration, null, 2) + "\n"
  const result = { scope, path, packagePath, supportedVersion, versionSource: version.source }
  if (output === original) return { ...result, changes: [] }
  // Validate everything before creating directories or replacing user files.
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.ultra-${crypto.randomUUID()}.tmp`
  let backup: string | undefined
  try {
    if (original !== undefined) {
      backup = `${path}.ultra-backup-${crypto.randomUUID()}`
      await writeFile(backup, original, { flag: "wx", mode: 0o600 })
      if (!present(path) || await readFile(path, "utf8") !== original) throw new Error("Configuration changed during installation; retry after reviewing it")
    } else if (present(path)) throw new Error("A configuration appeared during installation; retry after reviewing it")
    await writeFile(temporary, output, { flag: "wx", mode: 0o600 })
    await rename(temporary, path)
  } finally {
    if (existsSync(temporary)) await unlink(temporary)
  }
  return { ...result, ...(backup ? { backup } : {}), changes: [`Registered local Ultra plugin package in ${scope} configuration`, "Configured dedicated supervisor and worker agents without changing permission rules", "Enabled native delegation depth of at least two", "Kept all provider and model settings"] }
}

/** Global availability; project state and ultracode.json overrides stay in each project. */
export async function installGlobal(options: Omit<InstallOptions, "directory"> = {}): Promise<InstallResult> { return install("global", options) }
/** Optional standalone project installation, retained for backwards compatibility. */
export async function installProject(options: Omit<InstallOptions, "configDirectory"> = {}): Promise<InstallResult> { return install("project", options) }

export const installHelp = `bun scripts/install.ts [--global | --local | --project <directory>] [--config-dir <global-directory>] [--plugin <package-or-entrypoint>] [--config <ultra-options.json>]
Defaults to global installation. Requires OpenCode 2.0.25. Preserves existing settings and an original backup when changed.
Global path: OPENCODE_CONFIG_DIR, otherwise XDG_CONFIG_HOME/opencode or ~/.config/opencode.
Optional project overrides: ultracode.json in the project directory; no project installation is required.`

export async function parseInstallArguments(args: string[]): Promise<InstallOptions & { scope: "global" | "project" }> {
  const options: InstallOptions & { scope: "global" | "project" } = { scope: "global" }
  let explicitGlobal = false
  let explicitProject = false
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (seen.has(flag)) throw new Error(`Duplicate installer option: ${flag}`)
    seen.add(flag)
    if (flag === "--global") { explicitGlobal = true; continue }
    if (flag === "--local") { explicitProject = true; continue }
    if (!["--project", "--config-dir", "--plugin", "--config"].includes(flag)) throw new Error(`Unknown installer option: ${flag}. Use --help for usage`)
    const value = args[++index]
    if (!value || value.startsWith("--")) throw new Error(`Missing ${flag} argument`)
    if (flag === "--project") { explicitProject = true; options.directory = value }
    else if (flag === "--config-dir") options.configDirectory = value
    else if (flag === "--plugin") options.pluginPath = value
    else options.config = parseNativeConfiguration(await readFile(resolve(value), "utf8"))
  }
  if (explicitGlobal && explicitProject) throw new Error("Global and project installation cannot be requested together")
  if (explicitProject && options.configDirectory !== undefined) throw new Error("--config-dir applies only to global installation")
  if (explicitProject) options.scope = "project"
  return options
}

if (import.meta.main) {
  try {
    const arguments_ = Bun.argv.slice(2)
    if (arguments_.includes("--help")) {
      console.log(installHelp)
    } else {
      const options = await parseInstallArguments(arguments_)
      console.log(JSON.stringify(await (options.scope === "global" ? installGlobal(options) : installProject(options)), null, 2))
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}

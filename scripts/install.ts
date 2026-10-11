import { existsSync, lstatSync, readFileSync } from "node:fs"
import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseConfig } from "../src/config.ts"
import type { Config, Rule } from "../src/types.ts"

export const supportedVersion = "2.0.25"
export const productionPluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")

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
  const document = JSON.parse(normalized.replace(/^\uFEFF/, ""))
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Project configuration must be an object")
  return document
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

export interface InstallResult { path: string; packagePath: string; backup?: string; supportedVersion: string; versionSource: string; changes: string[] }

function persistedOptions(value: unknown): Partial<Config> {
  const options: Partial<Config> = parseConfig(value)
  // Omitted checks request project-script discovery; an explicit [] disables it.
  if ((value as { checks?: unknown } | undefined)?.checks === undefined) delete options.checks
  return options
}

/** Configure only the requested project; never change global OpenCode settings or provider credentials. */
export async function installProject(options: { directory?: string; pluginPath?: string; hostVersion?: string; config?: unknown } = {}): Promise<InstallResult> {
  const version = options.hostVersion === undefined ? installedVersion() : { version: options.hostVersion, source: "declared by caller; live runtime is checked by the plugin" }
  if (version.version !== supportedVersion) throw new Error(`Ultra Open Code requires OpenCode ${supportedVersion}; found ${version.version}`)
  const directory = await realpath(resolve(options.directory ?? process.cwd()))
  if (!(await stat(directory)).isDirectory()) throw new Error("The target project must be a directory")
  const selected = resolve(options.pluginPath ?? productionPluginDirectory)
  const packagePath = await realpath((await stat(selected)).isFile() ? dirname(selected) : selected)
  if (!existsSync(join(packagePath, "index.ts")) && !existsSync(join(packagePath, "index.js"))) throw new Error("The plugin package must contain its production index.ts or index.js entrypoint")
  const json = join(directory, "opencode.json")
  const jsonc = join(directory, "opencode.jsonc")
  if (existsSync(json) && existsSync(jsonc)) throw new Error("Both opencode.json and opencode.jsonc exist; select a single project configuration before installing")
  const path = existsSync(jsonc) ? jsonc : json
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing to replace a symlinked project configuration")
  const original = existsSync(path) ? await readFile(path, "utf8") : undefined
  const configuration = original === undefined ? {} : parseNativeConfiguration(original)
  const plugins = configuration.plugins === undefined ? [] : configuration.plugins
  if (!Array.isArray(plugins)) throw new Error("plugins must be a native OpenCode 2 array")
  for (const entry of plugins) if (!entry || typeof entry !== "object" || typeof entry.package !== "string") throw new Error("Existing plugin entries must use the OpenCode 2 {package, options?} shape")
  const existing = plugins.find(entry => samePath(entry.package, packagePath) || samePath(entry.package, join(packagePath, "index.ts")) || samePath(entry.package, join(packagePath, "index.js")))
  if (existing) {
    existing.package = packagePath
    if (options.config !== undefined) existing.options = persistedOptions(options.config)
    else if (existing.options !== undefined) parseConfig(existing.options)
  } else plugins.push({ package: packagePath, ...(options.config === undefined ? {} : { options: persistedOptions(options.config) }) })
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
  const temporary = `${path}.ultra-${crypto.randomUUID()}.tmp`
  let backup: string | undefined
  try {
    if (original !== undefined) {
      backup = `${path}.ultra-backup-${crypto.randomUUID()}`
      await writeFile(backup, original, { flag: "wx", mode: 0o600 })
      if (await readFile(path, "utf8") !== original) throw new Error("Project configuration changed during installation; retry after reviewing it")
    } else if (existsSync(path)) throw new Error("A project configuration appeared during installation; retry after reviewing it")
    await writeFile(temporary, output, { flag: "wx", mode: 0o600 })
    await rename(temporary, path)
  } finally {
    if (existsSync(temporary)) await unlink(temporary)
  }
  return { path, packagePath, ...(backup ? { backup } : {}), supportedVersion, versionSource: version.source, changes: ["Registered local Ultra plugin package", "Configured dedicated supervisor and worker agents without changing project permission rules", "Enabled native delegation depth of at least two", "Kept all provider and model settings"] }
}

if (import.meta.main) {
  try {
    const arguments_ = Bun.argv.slice(2)
    if (arguments_.includes("--help")) {
      console.log("bun scripts/install.ts [--project <directory>] [--plugin <package-or-entrypoint>] [--config <ultra-options.json>]\nRequires OpenCode 2.0.25. Creates or updates project configuration and preserves an original backup.")
    } else {
      const options: { directory?: string; pluginPath?: string; config?: unknown } = {}
      for (let index = 0; index < arguments_.length; index++) {
        const flag = arguments_[index]
        const value = arguments_[++index]
        if (!value || !["--project", "--plugin", "--config"].includes(flag!)) throw new Error("Use --help for installer usage")
        if (flag === "--project") options.directory = value
        else if (flag === "--plugin") options.pluginPath = value
        else options.config = parseNativeConfiguration(await readFile(resolve(value), "utf8"))
      }
      console.log(JSON.stringify(await installProject(options), null, 2))
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}

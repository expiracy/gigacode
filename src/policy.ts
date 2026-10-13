import { lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { Role, Rule } from "./types.ts"

type Effect = Rule["effect"]
const ranks: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 }
const mutations = new Set(["edit", "write", "patch", "apply_patch", "delete", "move", "mkdir"])
const pathActions = new Set(["read", "glob", "grep", "list", "external_directory", ...mutations])
const safeActions = new Set(["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "search", "models", "skill", "question", "todoread", "todowrite", "ultra_submit", "ultra_dependency"])
const normalize = (value: string) => value.replaceAll("\\", "/")
const equalCase = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function hostMatch(pattern: string, value: string): boolean {
  const source = escaped(normalize(pattern)).replaceAll("\\*", ".*").replaceAll("\\?", ".")
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "").test(normalize(value))
}

/** Match the host's ordered permission rules; the caller supplies the unmatched effect. */
export function evaluateRules(rules: Rule[], action: string, resource: string, defaultEffect: Effect = "ask"): Effect {
  let effect = defaultEffect
  for (const rule of rules) if (hostMatch(rule.action, action) && hostMatch(rule.resource, resource)) effect = rule.effect
  return effect
}

function strictest(...effects: Effect[]): Effect {
  return effects.reduce((current, effect) => ranks[effect] > ranks[current] ? effect : current, "allow")
}

/** Resolve a missing file through its nearest existing parent, including junctions. */
function canonical(path: string): string {
  let parent = resolve(path)
  const suffix: string[] = []
  for (;;) {
    try { lstatSync(parent); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error
    }
    const next = dirname(parent)
    if (next === parent) return resolve(path)
    suffix.unshift(parent.slice(next.length + (next.endsWith(sep) ? 0 : 1)))
    parent = next
  }
  try {
    return resolve(realpathSync.native(parent), ...suffix)
  } catch {
    // Unresolvable existing paths must not fall back to a weaker lexical allow.
    throw new Error(`Cannot resolve permission scope: ${path}`)
  }
}

function within(directory: string, resource: string): { allowed: boolean; relative: string; absolute?: string } {
  if (!resource || /[\0\r\n]/.test(resource) || resource.startsWith("~") || /^[A-Za-z]+:\/\//.test(resource)) return { allowed: false, relative: "" }
  const root = canonical(directory)
  const target = canonical(resolve(directory, resource))
  const local = relative(root, target)
  return { allowed: local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local), relative: normalize(local), absolute: target }
}

export function owned(pattern: string, resource: string): boolean {
  pattern = normalize(pattern).replace(/^\.\//, "")
  if (/^(?:\/|~|[A-Za-z]:)/.test(pattern) || pattern.split("/").includes("..")) return false
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === "*" && pattern[index + 1] === "*") {
      index++
      if (pattern[index + 1] === "/") { index++; source += "(?:.*/)?" }
      else source += ".*"
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += escaped(character)
  }
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "").test(normalize(resource))
}

function roleEffect(role: Role, action: string): Effect {
  if (action === "subagent") return role === "supervisor" ? "allow" : "deny"
  if (action === "shell") return role === "implementer" || role === "verifier" ? "allow" : "deny"
  if (mutations.has(action)) return role === "implementer" ? "allow" : "deny"
  if (action === "ultra_check") return role === "verifier" ? "allow" : "deny"
  if (action === "ultra_integrate") return role === "implementer" ? "allow" : "deny"
  if (action === "ultra_prepare") return role === "implementer" ? "allow" : "deny"
  if (action === "ultra_execute") return role === "supervisor" ? "allow" : "deny"
  if (action === "external_directory") return "allow" // The separate path boundary still applies.
  return safeActions.has(action) ? "allow" : "deny"
}

/**
 * Tighten an already-evaluated host effect using the captured authorization and
 * worker capability. Never manufacture approval or loosen a native ask/deny.
 * Verifier shell is usable only through the adapter's authorized check wrapper;
 * the adapter must hide raw shell and verify its invocation identity separately.
 */
export function restrictPermission(hostEffect: Effect, runRules: Rule[], role: Role, action: string, resources: string[], ownedPaths: string[] | undefined, directory: string): Effect {
  let effect = strictest(hostEffect, roleEffect(role, action))
  if (effect === "deny") return effect
  for (const resource of resources.length ? resources : ["*"]) {
    if (pathActions.has(action)) {
      try {
        const scope = within(directory, resource)
        if (!scope.allowed) return "deny"
        // Native tools can present absolute paths while captured project rules
        // use relative paths. Match either spelling at the same rule position.
        const names = [resource, scope.relative, scope.absolute!]
        let captured: Effect = "ask"
        for (const rule of runRules) if (hostMatch(rule.action, action) && names.some(name => hostMatch(rule.resource, name))) captured = rule.effect
        effect = strictest(effect, captured)
        if (mutations.has(action)) {
          if (equalCase(scope.relative).split("/").some(part => part === ".ultracode" || part === ".git")) return "deny"
          if (!ownedPaths?.some(pattern => owned(pattern, scope.relative))) return "deny"
        }
      } catch { return "deny" }
    } else effect = strictest(effect, evaluateRules(runRules, action, resource))
    if (effect === "deny") return effect
  }
  return effect
}

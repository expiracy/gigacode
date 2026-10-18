import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

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

export function isRegistryPackage(entry: string): boolean {
  return entry === "opencode-gigacode" || /^opencode-gigacode@\S+$/.test(entry)
}

export function packageMatches(entry: string, packagePath: string, directory: string): boolean {
  if (isRegistryPackage(entry)) return true
  const path = entry.startsWith("file://") ? fileURLToPath(entry) : /^(?:\.\.?)[\\/]/.test(entry) ? resolve(directory, entry) : entry
  return samePath(path, packagePath) || samePath(path, join(packagePath, "index.ts")) || samePath(path, join(packagePath, "index.js"))
}

import { createHash } from "node:crypto"
import { createReadStream, lstatSync } from "node:fs"
import { lstat, readdir, readlink, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export interface Manifest { hash: string; files: Record<string, string> }
const ignored = new Set([".git", ".ultracode", ".ultra-spike", ".spike", "node_modules", ".cache", ".next", "coverage", "dist", "build", "target", "__pycache__"])
export function inside(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path))
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"))
}
/** Runtime metadata must never follow a preexisting symlink or Windows junction. */
export function assertPlainPath(path: string): void {
  let part = resolve(path)
  for (;;) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error(`Runtime metadata path contains a symlink or junction: ${part}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error }
    const parent = dirname(part)
    if (parent === part) return
    part = parent
  }
}
export function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")
}
/** Fingerprints source contents, not mtimes; never follows symlinks outside the checkout. */
export async function manifest(directory: string): Promise<Manifest> {
  const root = await realpath(directory)
  const files: Record<string, string> = {}
  let count = 0
  async function visit(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue
      const absolute = join(path, entry.name)
      const name = relative(root, absolute).replaceAll("\\", "/")
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        files[name] = digest({ link: await readlink(absolute) })
      } else if (info.isDirectory()) {
        await visit(absolute)
      } else if (info.isFile()) {
        if (++count > 50_000) throw new Error("Workspace exceeds the 50,000 source-file fingerprint limit; exclude generated directories")
        if (!inside(root, await realpath(absolute))) throw new Error(`Workspace path escaped its checkout: ${name}`)
        const hash = createHash("sha256")
        for await (const bytes of createReadStream(absolute)) hash.update(bytes)
        files[name] = hash.digest("hex")
      }
    }
  }
  await visit(root)
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  return { hash: digest(ordered), files: ordered }
}
export function changedPaths(before: Manifest, after: Manifest): string[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(path => before.files[path] !== after.files[path]).sort()
}

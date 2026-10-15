import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname, basename } from "node:path"
import { manifest, changedPaths } from "../src/workspace.ts"

async function cleanup(path: string, prefix: string) {
  const absolute = await realpath(path)
  if (dirname(absolute) !== await realpath(tmpdir()) || !basename(absolute).startsWith(prefix)) throw new Error("Refusing to remove a path outside its named temporary fixture")
  await rm(absolute, { recursive: true, force: true })
}

test("workspace fingerprints track contents while excluding runtime state and dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ultra-workspace-"))
  try {
    await writeFile(join(root, "a.ts"), "old")
    const initial = await manifest(root)
    await mkdir(join(root, ".ultraopencode"))
    await mkdir(join(root, "node_modules"))
    await writeFile(join(root, ".ultraopencode", "state.sqlite"), "noise")
    await mkdir(join(root, ".ultracode"))
    await writeFile(join(root, ".ultracode", "state.sqlite"), "legacy noise")
    await writeFile(join(root, "node_modules", "dependency.js"), "noise")
    expect((await manifest(root)).hash).toBe(initial.hash)
    await writeFile(join(root, "a.ts"), "new")
    await writeFile(join(root, "b.ts"), "added")
    const changed = await manifest(root)
    expect(changedPaths(initial, changed)).toEqual(["a.ts", "b.ts"])
    expect(changed.hash).not.toBe(initial.hash)
  } finally { await cleanup(root, "ultra-workspace-") }
})

test("workspace ignores ordering and does not follow links out of the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "ultra-links-"))
  const outside = await mkdtemp(join(tmpdir(), "ultra-outside-"))
  try {
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    const before = await manifest(root)
    await writeFile(join(outside, "secret.txt"), "changed external content")
    const after = await manifest(root)
    expect(after.hash).toBe(before.hash)
    expect(Object.keys(after.files)).toEqual(["linked"])
  } finally { await cleanup(root, "ultra-links-"); await cleanup(outside, "ultra-outside-") }
})

test("runtime metadata rejects a dangling symlink or junction before its target exists", async () => {
  const { assertPlainPath } = await import("../src/workspace.ts")
  const root = await mkdtemp(join(tmpdir(), "ultra-dangling-"))
  try {
    const target = join(root, "missing-target")
    const link = join(root, "dangling")
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
    expect(() => assertPlainPath(link)).toThrow(/symlink|junction/i)
    expect(() => assertPlainPath(join(link, "state.sqlite"))).toThrow(/symlink|junction/i)
  } finally { await cleanup(root, "ultra-dangling-") }
})

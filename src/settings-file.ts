import { renameSync } from "node:fs"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { assertPlainPath } from "./workspace.ts"

const queueKey = Symbol.for("gigacode.settings-writes.v1")
const writes: Map<string, Promise<unknown>> = Reflect.get(globalThis, queueKey) ?? new Map()
Reflect.set(globalThis, queueKey, writes)

/** Different project instances can edit the same global profile. */
export function serializeSettingsWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
  const operation = (writes.get(key) ?? Promise.resolve()).then(work)
  const settled = operation.then(() => {}, () => {})
  writes.set(key, settled)
  void settled.then(() => { if (writes.get(key) === settled) writes.delete(key) })
  return operation
}

export async function replaceSettingsFile(options: {
  path: string; previous?: string; source: string; backupDirectory: string; temporaryDirectory: string
  assertCurrent(): Promise<void>; beforeWrite(): void; signal?: AbortSignal
}): Promise<string | undefined> {
  options.signal?.throwIfAborted()
  let backup: string | undefined
  if (options.previous !== undefined) {
    assertPlainPath(options.backupDirectory)
    await mkdir(options.backupDirectory, { recursive: true })
    backup = join(options.backupDirectory, `${Date.now()}-${crypto.randomUUID()}.json`)
    await writeFile(backup, options.previous, { flag: "wx", mode: 0o600 })
  }
  assertPlainPath(options.temporaryDirectory)
  await mkdir(options.temporaryDirectory, { recursive: true })
  const temporary = join(options.temporaryDirectory, `${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(temporary, options.source, { flag: "wx", mode: 0o600 })
    await options.assertCurrent()
    // No asynchronous gap between cancellation/ownership checks and replacement.
    options.signal?.throwIfAborted()
    options.beforeWrite()
    assertPlainPath(options.path)
    renameSync(temporary, options.path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return backup
}

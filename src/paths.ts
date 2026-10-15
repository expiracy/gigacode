import { lstatSync } from "node:fs"
import { join } from "node:path"

function present(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

/** Retain existing overrides without silently copying or replacing user settings. */
export function projectConfigPath(directory: string): string {
  const current = join(directory, "ultraopencode.json"), legacy = join(directory, "ultracode.json")
  return present(current) || !present(legacy) ? current : legacy
}

export const runtimeNames = [".ultraopencode", ".ultracode"] as const

/** Existing databases and worktree paths remain in place during a branding upgrade. */
export function runtimeDirectory(directory: string): string {
  const current = join(directory, runtimeNames[0]), legacy = join(directory, runtimeNames[1])
  if (present(join(current, "state.sqlite"))) {
    if (present(join(legacy, "state.sqlite"))) throw new Error(`Both ${current} and ${legacy} contain state databases. Retain one active history before continuing; neither was changed.`)
    return current
  }
  return present(legacy) ? legacy : current
}

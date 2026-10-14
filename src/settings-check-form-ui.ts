import type { Context } from "@opencode/plugin/tui/context"
import { parseConfigOptions } from "./config.ts"
import type { SettingsView } from "./settings.ts"
import type { CheckSpec } from "./types.ts"
import { scopeLabel } from "./settings-presentation.ts"

async function promptField(ctx: Context, active: () => boolean, options: { title: string; value?: string; description: string }, validate: (value: string) => unknown) {
  let input = options.value
  while (active()) {
    const value = await ctx.ui.dialog.prompt({ ...options, value: input })
    if (!active() || value === undefined) return
    input = value
    try { validate(value); return value }
    catch (error) {
      if (active()) await ctx.ui.dialog.alert({ title: "Invalid check", message: error instanceof Error ? error.message : "Invalid check" })
    }
  }
}

/** Validate each answer before moving forward; commit only a complete check. */
export async function editCheckForm(ctx: Context, view: SettingsView, checks: CheckSpec[], index: number, active: () => boolean): Promise<CheckSpec | undefined> {
  const previous = checks[index]
  const context = `${scopeLabel(view)} · ${previous ? `Edit ${previous.id}` : "Add check"}`
  const id = await promptField(ctx, active, { title: "Check ID", value: previous?.id, description: `${context} · 1 of 4. A stable identifier, for example types or test. No spaces or path separators.` }, value => {
    parseConfigOptions({ checks: [...checks.filter((_, position) => position !== index), { id: value.trim(), command: "true", criterionIds: [] }] })
  })
  if (id === undefined) return
  const validate = (value: Partial<CheckSpec>) => parseConfigOptions({ checks: [{ id: id.trim(), command: "true", criterionIds: [], ...value }] })
  const command = await promptField(ctx, active, { title: "Check command", value: previous?.command, description: `${context} · 2 of 4. Runs in the project directory during workflow verification. Saving does not run it.` }, value => validate({ command: value }))
  if (command === undefined) return
  const criteria = await promptField(ctx, active, { title: "Criterion IDs", value: previous?.criterionIds.join(", ") ?? "verification", description: `${context} · 3 of 4. Comma-separated acceptance criterion IDs supported by this check. Blank means none.` }, value => validate({ criterionIds: criterionIds(value) }))
  if (criteria === undefined) return
  const timeout = await promptField(ctx, active, { title: "Check timeout (seconds)", value: previous?.timeoutMs === undefined ? "" : String(previous.timeoutMs / 1000), description: `${context} · 4 of 4. Optional; blank uses the worker deadline. Up to three decimal places.` }, value => {
    if (value.trim() && !/^\d+(?:\.\d{1,3})?$/.test(value.trim())) throw new Error("Enter positive timeout seconds with up to three decimal places, or leave blank.")
    validate({ timeoutMs: timeoutMs(value) })
  })
  if (timeout === undefined || !active()) return
  return { id: id.trim(), command, criterionIds: criterionIds(criteria), ...(timeout.trim() ? { timeoutMs: timeoutMs(timeout) } : {}) }
}

const criterionIds = (value: string) => value.trim() ? value.split(",").map(value => value.trim()) : []
const timeoutMs = (value: string) => value.trim() ? Math.round(Number(value.trim()) * 1000) : undefined

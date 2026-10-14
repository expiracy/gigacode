import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { parseConfigOptions } from "./config.ts"
import { checkText, scopeLabel } from "./settings-presentation.ts"
import type { CheckSpec } from "./types.ts"

export async function editChecks(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  const isGlobal = view.scope === "global"
  while (active()) {
    const checks = draft.checks ?? view.inherited.checks
    const action = await ctx.ui.dialog.select({ title: "Verification checks", placeholder: `${scopeLabel(view)} · ${draft.checks === undefined ? "inherited / automatic" : "custom check list"}; saving does not run commands`, options: [
      { title: "Add check", value: "add" },
      ...checks.map((check, index) => ({ title: check.id, value: `check:${index}`, description: check.command })),
      { title: isGlobal ? "Use automatic discovery" : "Use inherited checks", value: "reset", description: isGlobal ? "Detect test, typecheck and lint scripts separately in each project unless overridden" : checkText(view.inherited.checks) },
      { title: "Disable configured checks", value: "disable", description: "Explicit empty list. Verification may be incomplete." },
      { title: "Back to settings", value: "back" },
    ] })
    if (!active() || !action || action === "back") return
    await changeCheck(ctx, view, draft, active, checks, action)
  }
}

async function changeCheck(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean, checks: CheckSpec[], action: string) {
  const isGlobal = view.scope === "global"
  if (action === "reset") { delete draft.checks; return }
  if (action === "disable") {
    const confirmed = await ctx.ui.dialog.confirm({ title: "Disable configured checks?", message: isGlobal ? "An empty global check list disables automatic check discovery across projects unless a project overrides it. Workflows still require independent review and verification evidence to claim success." : "An empty project check list disables inherited and automatically detected checks. Workflows still require independent review and verification evidence to claim success." })
    if (active() && confirmed) draft.checks = []
    return
  }
  let index = -1
  if (action.startsWith("check:")) {
    index = Number(action.slice(6))
    if (!Number.isInteger(index) || !checks[index]) return
    const operation = await ctx.ui.dialog.select({ title: checks[index]!.id, options: [{ title: "Edit check", value: "edit" }, { title: "Remove check", value: "remove" }] })
    if (!active() || !operation) return
    if (operation === "remove") { draft.checks = checks.filter((_, position) => position !== index); return }
    if (operation !== "edit") return
  } else if (action !== "add") return
  const previous = checks[index]
  const id = await ctx.ui.dialog.prompt({ title: "Check ID", value: previous?.id, description: "A stable identifier, for example types or test. No spaces or path separators." })
  if (!active() || id === undefined) return
  const command = await ctx.ui.dialog.prompt({ title: "Check command", value: previous?.command, description: "Runs in the project directory during workflow verification. Saving does not run it." })
  if (!active() || command === undefined) return
  const criteria = await ctx.ui.dialog.prompt({ title: "Criterion IDs", value: previous?.criterionIds.join(", ") ?? "verification", description: "Comma-separated acceptance criterion IDs supported by this check. Blank means none." })
  if (!active() || criteria === undefined) return
  const timeout = await ctx.ui.dialog.prompt({ title: "Check timeout (seconds)", value: previous?.timeoutMs === undefined ? "" : String(previous.timeoutMs / 1000), description: "Optional; blank uses the worker deadline. Up to three decimal places." })
  if (!active() || timeout === undefined) return
  try {
    if (timeout.trim() && !/^\d+(?:\.\d{1,3})?$/.test(timeout.trim())) throw new Error("Enter positive timeout seconds with up to three decimal places, or leave blank.")
    const check = { id: id.trim(), command, criterionIds: criteria.trim() ? criteria.split(",").map(value => value.trim()) : [], ...(timeout.trim() ? { timeoutMs: Math.round(Number(timeout.trim()) * 1000) } : {}) }
    const next = [...checks]
    if (index < 0) next.push(check); else next[index] = check
    draft.checks = parseConfigOptions({ checks: next }).checks!
  } catch (error) {
    if (active()) await ctx.ui.dialog.alert({ title: "Invalid check", message: error instanceof Error ? error.message : "Invalid check" })
  }
}

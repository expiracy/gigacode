import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { parseConfigOptions } from "./config.ts"
import { checkText, scopeLabel, settingsBack } from "./settings-presentation.ts"
import type { CheckSpec } from "./types.ts"
import { editCheckForm } from "./settings-check-form-ui.ts"

export async function editChecks(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  const isGlobal = view.scope === "global"
  let current: string | undefined
  while (active()) {
    const checks = draft.checks ?? view.inherited.checks
    if (current?.startsWith("check:") && !checks[Number(current.slice(6))]) current = "add"
    const source = draft.checks === undefined ? isGlobal ? "automatic discovery" : "inherited checks" : checks.length ? "custom check list" : "checks disabled"
    const action = await ctx.ui.dialog.select({ title: "Verification checks", placeholder: `${scopeLabel(view)} · ${source}`, current, options: [
      { title: "Add check", value: "add", description: "Saving a command does not run it" },
      ...checks.map((check, index) => ({ title: check.id, value: `check:${index}`, description: check.command })),
      { title: isGlobal ? "Use automatic discovery" : "Use inherited checks", value: "reset", description: isGlobal ? "Detect test, typecheck and lint scripts separately in each project unless overridden" : checkText(view.inherited.checks) },
      { title: "Disable checks", value: "disable", description: "Skip configured commands; independent review still applies" },
      settingsBack(view),
    ] })
    if (!active() || !action || action === "back") return
    current = action
    await changeCheck(ctx, view, draft, active, checks, action)
  }
}

async function changeCheck(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean, checks: CheckSpec[], action: string) {
  const isGlobal = view.scope === "global"
  if (action === "reset") { delete draft.checks; return }
  if (action === "disable") {
    const confirmed = await ctx.ui.dialog.confirm({ title: "Disable configured checks?", message: isGlobal ? "An empty global check list disables automatic check discovery across projects unless a project overrides it. Workflows still require independent review and verification evidence to claim success." : "An empty project check list disables inherited and automatically detected checks. Workflows still require independent review and verification evidence to claim success.", label: { confirm: "Disable checks", cancel: "Keep checks" } })
    if (active() && confirmed) draft.checks = []
    return
  }
  let index = -1
  if (action.startsWith("check:")) {
    index = Number(action.slice(6))
    if (!Number.isInteger(index) || !checks[index]) return
    const operation = await ctx.ui.dialog.select({ title: `Check: ${checks[index]!.id}`, placeholder: `${scopeLabel(view)} · ${checks[index]!.command}`, options: [{ title: "Edit check", value: "edit" }, { title: "Remove check", value: "remove", description: "Apply removal on Save" }, { title: "Back to checks", value: "back", category: "Navigation" }] })
    if (!active() || !operation) return
    if (operation === "remove") { draft.checks = checks.filter((_, position) => position !== index); return }
    if (operation !== "edit") return
  } else if (action !== "add") return
  const check = await editCheckForm(ctx, view, checks, index, active)
  if (!active() || !check) return
  const next = [...checks]
  if (index < 0) next.push(check); else next[index] = check
  draft.checks = parseConfigOptions({ checks: next }).checks!
}

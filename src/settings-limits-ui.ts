import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { parseConfigOptions } from "./config.ts"
import { limitFields, limitText, scopeLabel, settingSource, settingsBack } from "./settings-presentation.ts"

function resetLimit(draft: EditableSettings, key: typeof limitFields[number]["value"]) {
  if (draft.limits) { delete draft.limits[key]; if (!Object.keys(draft.limits).length) delete draft.limits }
}

export async function editLimit(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  let current: string | undefined
  while (active()) {
    let resetting = false
    const key = await ctx.ui.dialog.select<string>({ title: "Workflow limits", placeholder: `${scopeLabel(view)} · select a limit to edit`, current, options: [
      ...limitFields.map(field => ({ title: field.title, value: field.value,
        description: `${limitText(draft.limits?.[field.value] ?? view.inherited.limits[field.value], field.seconds)} · ${settingSource(view, draft.limits?.[field.value] !== undefined)}. ${field.description}`,
      })),
      settingsBack(view),
    ], actions: [{ bind: "ctrl+r", title: view.scope === "global" ? "Use built-in default" : "Use inherited value", onTrigger(key) {
      if (!active()) return
      const field = limitFields.find(field => field.value === key)
      if (!field) return
      resetLimit(draft, field.value); current = key; resetting = true
      ctx.ui.dialog.clear()
    } }] })
    if (active() && resetting) continue
    if (!active() || !key || key === "back") return
    const field = limitFields.find(field => field.value === key)
    if (!field) return
    current = key
    await editLimitValue(ctx, view, draft, active, field)
  }
}

async function editLimitValue(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean, field: typeof limitFields[number]) {
  const scope = view.scope === "global" ? "All projects; project overrides still take precedence." : "This project only."
  const reset = view.scope === "global" ? "default" : "inherit"
  let input = String((draft.limits?.[field.value] ?? view.inherited.limits[field.value] ?? 0) / (field.seconds ? 1000 : 1))
  while (active()) {
    const value = await ctx.ui.dialog.prompt({ title: `${field.title}${field.seconds ? " (seconds)" : " (whole number)"}`, value: input, description: `${scope} ${field.description}. Enter ${reset} to restore ${limitText(view.inherited.limits[field.value], field.seconds)}.` })
    if (!active() || value === undefined) return
    if (value.trim().toLowerCase() === reset) {
      resetLimit(draft, field.value)
      return
    }
    input = value
    try {
      if (!(field.seconds ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(value.trim())) throw new Error(field.seconds ? "Enter positive seconds with up to three decimal places." : "Enter a whole number.")
      const number = Math.round(Number(value.trim()) * (field.seconds ? 1000 : 1)), minimum = field.value === "repairRounds" ? 0 : 1
      if (!Number.isSafeInteger(number)) throw new Error("Enter a smaller value within the supported numeric range.")
      if (number < minimum) throw new Error(`${field.title} must be at least ${field.seconds ? "0.001 seconds" : minimum}.`)
      const validated = parseConfigOptions({ limits: { [field.value]: number } }).limits!
      Object.assign(draft.limits ??= {}, validated)
      return
    } catch (error) {
      if (active()) await ctx.ui.dialog.alert({ title: "Invalid limit", message: error instanceof Error ? error.message : "Invalid limit" })
    }
  }
}

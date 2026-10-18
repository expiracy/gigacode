import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { parseConfigOptions } from "./config.ts"
import { editInstructions } from "./settings-instructions-ui.ts"
import { scopeLabel, settingSource, writerPolicy, settingsBack } from "./settings-presentation.ts"

export async function editAdvanced(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  let current: string | undefined
  while (active()) {
    const promptCount = Object.keys({ ...view.inherited.prompts, ...draft.prompts }).length
    const selected = await ctx.ui.dialog.select({ title: "Advanced configuration", placeholder: `${scopeLabel(view)} · ${view.path}`, current, options: [
      { title: "Role instructions", value: "prompts", description: promptCount ? `${promptCount} custom role ${promptCount === 1 ? "instruction" : "instructions"}` : "Built-in role instructions" },
      { title: "Writer policy", value: "writer", description: `${writerPolicy(draft.parallelWrites ?? view.inherited.parallelWrites)} · ${settingSource(view, draft.parallelWrites !== undefined)}` },
      { title: "Automatic-mode threshold", value: "threshold", description: `${draft.autoThreshold ?? view.inherited.autoThreshold} characters · ${settingSource(view, draft.autoThreshold !== undefined)}` },
      settingsBack(view),
    ] })
    if (!active() || !selected || selected === "back") return
    current = selected
    if (selected === "writer") await editWriter(ctx, view, draft, active)
    else if (selected === "threshold") await editThreshold(ctx, view, draft, active)
    else if (selected === "prompts") await editInstructions(ctx, view, draft, active)
    else return
  }
}

async function editThreshold(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  const reset = view.scope === "global" ? "default" : "inherit"
  let input = String(draft.autoThreshold ?? view.inherited.autoThreshold)
  while (active()) {
    const value = await ctx.ui.dialog.prompt({ title: "Automatic-mode threshold (characters)", value: input, description: `${scopeLabel(view)}. Minimum prompt length after /gigacode on; changing it does not enable automatic mode. GigaCode mode is independent. Enter ${reset} to restore ${view.inherited.autoThreshold}.` })
    if (!active() || value === undefined) return
    if (value.trim().toLowerCase() === reset) { delete draft.autoThreshold; return }
    input = value
    try {
      if (!/^\d+$/.test(value.trim())) throw new Error("Invalid threshold")
      draft.autoThreshold = parseConfigOptions({ autoThreshold: Number(value.trim()) }).autoThreshold!
      return
    } catch {
      if (active()) await ctx.ui.dialog.alert({ title: "Invalid automatic-mode threshold", message: "Enter a whole number of at least 1, within the supported numeric range." })
    }
  }
}

async function editWriter(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  const selected = await ctx.ui.dialog.select({ title: "Writer policy", placeholder: `${scopeLabel(view)} · applies to new workflows`, current: draft.parallelWrites === undefined ? "reset" : draft.parallelWrites ? "parallel" : "serial", options: [
    { title: view.scope === "global" ? "Use built-in default" : "Use inherited value", value: "reset", description: writerPolicy(view.inherited.parallelWrites) },
    { title: "Serial writers", value: "serial", description: "One writer at a time; independent read-only tasks can still run together" },
    { title: "Isolated parallel writers", value: "parallel", description: "Independent writers use Git checkouts; requires a clean committed root and native Git permissions" },
    { title: "Back to advanced configuration", value: "back", category: "Navigation" },
  ] })
  if (!active() || !selected) return
  if (selected === "reset") delete draft.parallelWrites
  else if (selected === "serial" || selected === "parallel") draft.parallelWrites = selected === "parallel"
}

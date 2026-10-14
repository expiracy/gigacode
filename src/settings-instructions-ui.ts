import type { Context } from "@opencode/plugin/tui/context"
import { parseConfigOptions, roles } from "./config.ts"
import type { EditableSettings, SettingsView } from "./settings.ts"
import type { Role } from "./types.ts"
import { scopeLabel, settingSource } from "./settings-presentation.ts"

function resetInstructions(draft: EditableSettings, role: Role) {
  if (!draft.prompts) return
  delete draft.prompts[role]
  if (!Object.keys(draft.prompts).length) delete draft.prompts
}

export async function editInstructions(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  let current: string | undefined
  while (active()) {
    let resetting = false
    const selected = await ctx.ui.dialog.select<string>({ title: "Role instructions", placeholder: `${scopeLabel(view)} · select a role to edit`, current, options: [
      ...roles.map(role => ({ title: role[0]!.toUpperCase() + role.slice(1), value: role, description: `${(draft.prompts?.[role] ?? view.inherited.prompts?.[role] ?? "Built-in role guidance").replaceAll(/\s+/g, " ").slice(0, 90)} · ${settingSource(view, draft.prompts?.[role] !== undefined)}` })),
      { title: "Back to advanced configuration", value: "back", category: "Navigation" },
    ], actions: [{ bind: "ctrl+r", title: view.scope === "global" ? "Use built-in instructions" : "Use inherited instructions", onTrigger(key) {
      const role = roles.find(role => role === key)
      if (!active() || !role) return
      resetInstructions(draft, role); current = role; resetting = true
      ctx.ui.dialog.clear()
    } }] })
    if (active() && resetting) continue
    const role = roles.find(role => role === selected)
    if (!active() || !role) return
    current = role
    await editRole(ctx, view, draft, active, role)
  }
}

async function editRole(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean, role: Role) {
  let input = draft.prompts?.[role] ?? view.inherited.prompts?.[role] ?? ""
  while (active()) {
    const value = await ctx.ui.dialog.prompt({ title: `Instructions: ${role}`, value: input, description: `${scopeLabel(view)}. Adds guidance to this role's built-in instructions. Up to 64000 characters; blank restores ${view.scope === "global" ? "built-in" : "inherited"} guidance.` })
    if (!active() || value === undefined) return
    if (!value.trim()) { resetInstructions(draft, role); return }
    input = value
    try {
      const validated = parseConfigOptions({ prompts: { [role]: value } }).prompts!
      Object.assign(draft.prompts ??= {}, validated)
      return
    } catch (error) {
      if (active()) await ctx.ui.dialog.alert({ title: "Invalid role instructions", message: error instanceof Error ? error.message : "Invalid instructions" })
    }
  }
}

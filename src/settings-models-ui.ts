import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { modelFields, modelValue, modelText, scopeLabel, settingSource, settingsBack } from "./settings-presentation.ts"

function setModel(draft: EditableSettings, path: string, value?: string) {
  const models = draft.models ??= {}
  if (path === "default") { if (value === undefined) delete models.default; else models.default = value }
  else {
    const [scope, key] = path.split(".") as ["roles" | "stages", string]
    const entries = models[scope] ??= {}
    if (value === undefined) delete (entries as Record<string, string>)[key]
    else (entries as Record<string, string>)[key] = value
    if (!Object.keys(entries).length) delete models[scope]
  }
  if (!Object.keys(models).length) delete draft.models
}

export async function editModel(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  let current: string | undefined
  while (active()) {
    const field = await ctx.ui.dialog.select({ title: "Workflow models", placeholder: `${scopeLabel(view)} · select a mapping to edit`, current, options: [
      ...modelFields.map(field => ({ ...field,
        description: `${modelText(modelValue(draft.models, field.value) ?? modelValue(view.inherited.models, field.value))} · ${settingSource(view, modelValue(draft.models, field.value) !== undefined)}`,
      })),
      settingsBack(view),
    ] })
    if (!active() || !field || field === "back" || !modelFields.some(option => option.value === field)) return
    current = field
    await editMapping(ctx, view, draft, active, field)
  }
}

async function editMapping(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean, field: string) {
  const override = modelValue(draft.models, field)
  const reference = override ?? modelValue(view.inherited.models, field)
  const label = modelFields.find(option => option.value === field)!.title
  let current = override === undefined ? "reset" : override === "inherit" ? "inherit" : `model:${override.split("#")[0]}`
  while (active()) {
    const selected = await ctx.ui.dialog.select({ title: "Select workflow model", placeholder: `${scopeLabel(view)} · ${label}`, current, options: [
      { title: view.scope === "global" ? "Use built-in default" : "Use inherited value", value: "reset", description: modelText(modelValue(view.inherited.models, field)) },
      { title: "Use chat model", value: "inherit", description: "Always use the initiating conversation's model" },
      ...view.models.map(model => ({ title: model.name, value: `model:${model.providerID}/${model.id}`, description: `${model.providerID}/${model.id}` })),
      { title: "Back to models", value: "back", category: "Navigation" },
    ] })
    if (!active() || !selected || selected === "back") return
    if (selected === "reset" || selected === "inherit") { setModel(draft, field, selected === "reset" ? undefined : "inherit"); return }
    const model = view.models.find(model => selected === `model:${model.providerID}/${model.id}`)
    if (!model) return
    current = selected
    let chosen = `${model.providerID}/${model.id}`
    if (model.variants.length) {
      const previousVariant = reference?.startsWith(`${chosen}#`) ? reference.slice(chosen.length + 1) : undefined
      const variant = await ctx.ui.dialog.select({ title: "Model variant", placeholder: `${scopeLabel(view)} · ${label} · ${chosen}`, current: previousVariant && model.variants.includes(previousVariant) ? `variant:${previousVariant}` : "base", options: [
        { title: "Model default", value: "base" }, ...model.variants.map(variant => ({ title: variant, value: `variant:${variant}` })),
        { title: "Back to model selection", value: "back", category: "Navigation" },
      ] })
      if (!active()) return
      if (!variant || variant === "back") continue
      if (model.variants.some(value => variant === `variant:${value}`)) chosen += `#${variant.slice(8)}`
      else if (variant !== "base") return
    }
    setModel(draft, field, chosen)
    return
  }
}

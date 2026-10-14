import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { modelFields, modelValue, scopeLabel, settingSource } from "./settings-presentation.ts"

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
        description: `${modelValue(draft.models, field.value) ?? modelValue(view.inherited.models, field.value) ?? "Uses remaining model rules"} · ${settingSource(view, modelValue(draft.models, field.value) !== undefined)}`,
      })),
      { title: "Back to settings", value: "back", category: "Navigation" },
    ] })
    if (!active() || !field || field === "back" || !modelFields.some(option => option.value === field)) return
    current = field
    await editMapping(ctx, view, draft, active, field)
  }
}

async function editMapping(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean, field: string) {
  const selected = await ctx.ui.dialog.select({ title: "Select workflow model", placeholder: `${scopeLabel(view)} · models with tool support`, options: [
    { title: view.scope === "global" ? "Use built-in default" : "Use inherited value", value: "reset", description: modelValue(view.inherited.models, field) ?? "Uses remaining model rules" },
    { title: "Follow the initiating chat model", value: "inherit", description: "Explicitly use inherit for this mapping" },
    ...view.models.map(model => ({ title: model.name, value: `model:${model.providerID}/${model.id}`, description: `${model.providerID}/${model.id}` })),
  ] })
  if (!active() || !selected) return
  if (selected === "reset" || selected === "inherit") { setModel(draft, field, selected === "reset" ? undefined : "inherit"); return }
  const model = view.models.find(model => selected === `model:${model.providerID}/${model.id}`)
  if (!model) return
  let reference = `${model.providerID}/${model.id}`
  if (model.variants.length) {
    const variant = await ctx.ui.dialog.select({ title: "Model variant", placeholder: scopeLabel(view), options: [
      { title: "Model default", value: "base" }, ...model.variants.map(variant => ({ title: variant, value: `variant:${variant}` })),
    ] })
    if (!active() || !variant) return
    if (variant.startsWith("variant:")) reference += `#${variant.slice(8)}`
  }
  setModel(draft, field, reference)
}

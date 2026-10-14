import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { modelFields, modelValue } from "./settings-presentation.ts"

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
  const field = await ctx.ui.dialog.select({ title: "Workflow models", placeholder: "Stage settings take precedence over role settings", options: modelFields.map(field => ({ ...field,
    description: `${modelValue(draft.models, field.value) ?? modelValue(view.inherited.models, field.value) ?? "Uses remaining model rules"} · ${modelValue(draft.models, field.value) === undefined ? "inherited" : view.scope === "global" ? "global default" : "project override"}`,
  })) })
  if (!active() || !field) return
  const selected = await ctx.ui.dialog.select({ title: "Select workflow model", placeholder: "Only connected models with tool support are listed", options: [
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
    const variant = await ctx.ui.dialog.select({ title: "Model variant", options: [
      { title: "Model default", value: "base" }, ...model.variants.map(variant => ({ title: variant, value: `variant:${variant}` })),
    ] })
    if (!active() || !variant) return
    if (variant.startsWith("variant:")) reference += `#${variant.slice(8)}`
  }
  setModel(draft, field, reference)
}

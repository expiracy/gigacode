import { modelRef, parseConfigOptions, strictRecord, type ConfigOptions } from "./config.ts"
import type { AvailableModel, ModelOptions } from "./types.ts"

export type EditableSettings = Pick<ConfigOptions, "models" | "limits" | "checks">
export const editableKeys = ["models", "limits", "checks"] as const

export function editableSettings(options: ConfigOptions): EditableSettings {
  const result: EditableSettings = {}
  for (const key of editableKeys) if (options[key] !== undefined) Object.assign(result, { [key]: options[key] })
  return result
}

function modelReferences(models: ModelOptions | undefined): Map<string, string> {
  const references = new Map<string, string>()
  if (models?.default !== undefined) references.set("default", models.default)
  for (const scope of ["roles", "stages"] as const) {
    for (const [key, ref] of Object.entries(models?.[scope] ?? {})) references.set(`${scope}.${key}`, ref)
  }
  return references
}

export function editSettings(previous: ConfigOptions, overrides: unknown, catalog: readonly AvailableModel[]): ConfigOptions {
  const edited = parseConfigOptions(strictRecord(overrides, editableKeys, "editable settings"))
  const before = modelReferences(previous.models)
  for (const [key, reference] of modelReferences(edited.models)) {
    if (reference === "inherit" || before.get(key) === reference) continue
    const ref = modelRef(reference), model = catalog.find(model => model.providerID === ref.providerID && model.id === ref.id)
    if (!model || model.tools === false) throw new Error(`Model ${reference} is not available with tool support; no fallback was selected`)
    if (ref.variant && !model.variants.includes(ref.variant)) throw new Error(`Variant ${ref.variant} is not available for ${ref.providerID}/${ref.id}`)
  }
  const options = { ...previous }
  for (const key of editableKeys) delete options[key]
  return Object.assign(options, edited)
}

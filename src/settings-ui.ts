import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsView } from "./settings.ts"
import { parseConfigOptions, roles, stages } from "./config.ts"
import type { CheckSpec, Limits, ModelOptions } from "./types.ts"

export interface SettingsRpc {
  settings(input: { sessionId: string }, options: { location: { directory: string }; signal: AbortSignal }): Promise<unknown>
  saveSettings(input: { sessionId: string; revision: string; options: EditableSettings }, options: { location: { directory: string }; signal: AbortSignal }): Promise<unknown>
}

const modelFields = [{ title: "Workflow default", value: "default", category: "Default" },
  ...roles.map(role => ({ title: `Role: ${role}`, value: `roles.${role}`, category: "Roles" })),
  ...stages.map(stage => ({ title: `Stage: ${stage}`, value: `stages.${stage}`, category: "Stages" })),
]
const limitFields: { title: string; value: keyof Limits; description: string; seconds?: boolean }[] = [
  { title: "Workers", value: "workers", description: "Maximum concurrent workers per workflow" },
  { title: "Runs", value: "runs", description: "Maximum concurrent workflows" },
  { title: "Attempts", value: "attempts", description: "Total worker attempts per workflow" },
  { title: "Repair rounds", value: "repairRounds", description: "Maximum repair rounds; zero disables repairs" },
  { title: "Worker deadline", value: "workerMs", seconds: true, description: "Time allowed for one worker" },
  { title: "Active run deadline", value: "runMs", seconds: true, description: "Total active workflow time" },
  { title: "Elapsed deadline", value: "elapsedMs", seconds: true, description: "Wall time including pauses" },
  { title: "Steps", value: "steps", description: "Maximum model steps per worker" },
  { title: "Context characters", value: "contextChars", description: "Ultra prompt content budget; host history and tools also use model context" },
]
function limitText(value: number | undefined, seconds?: boolean): string {
  return value === undefined ? "inherited" : seconds ? `${value / 1000} seconds` : String(value)
}

async function editLimit(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  const key = await ctx.ui.dialog.select({ title: "Workflow limits", options: limitFields.map(field => ({ title: field.title, value: field.value,
    description: `${limitText(draft.limits?.[field.value] ?? view.inherited.limits[field.value], field.seconds)} · ${draft.limits?.[field.value] === undefined ? "inherited" : "project override"}. ${field.description}`,
  })) })
  const field = limitFields.find(field => field.value === key)
  if (!active() || !field) return
  const action = await ctx.ui.dialog.select({ title: field.title, options: [
    { title: "Set project value", value: "set", description: field.description },
    { title: "Use inherited value", value: "reset", description: limitText(view.inherited.limits[field.value], field.seconds) },
  ] })
  if (!active() || !action) return
  if (action === "reset") {
    if (draft.limits) { delete draft.limits[field.value]; if (!Object.keys(draft.limits).length) delete draft.limits }
    return
  }
  if (action !== "set") return
  const value = await ctx.ui.dialog.prompt({ title: `${field.title}${field.seconds ? " (seconds)" : " (whole number)"}`, value: String((draft.limits?.[field.value] ?? view.inherited.limits[field.value] ?? 0) / (field.seconds ? 1000 : 1)), placeholder: field.description })
  if (!active() || value === undefined) return
  try {
    if (!(field.seconds ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(value.trim())) throw new Error(field.seconds ? "Enter positive seconds with up to three decimal places." : "Enter a whole number.")
    const number = Math.round(Number(value.trim()) * (field.seconds ? 1000 : 1))
    const validated = parseConfigOptions({ limits: { [field.value]: number } }).limits!
    Object.assign(draft.limits ??= {}, validated)
  } catch (error) {
    if (active()) await ctx.ui.dialog.alert({ title: "Invalid limit", message: error instanceof Error ? error.message : "Invalid limit" })
  }
}

function checkText(checks: CheckSpec[] | undefined): string {
  if (checks === undefined) return "inherited checks / automatic discovery"
  if (!checks.length) return "No checks: workflows cannot claim verified success without verification evidence."
  return checks.map(check => `${check.id}: ${check.command}\n  Criteria: ${check.criterionIds.join(", ") || "none"}; timeout: ${check.timeoutMs === undefined ? "worker deadline" : limitText(check.timeoutMs, true)}`).join("\n")
}

async function editChecks(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  const checks = draft.checks ?? view.inherited.checks
  const action = await ctx.ui.dialog.select({ title: "Verification checks", placeholder: `${draft.checks === undefined ? "Inherited checks" : "Project list"}. This list replaces inherited checks. Saving does not execute commands.`, options: [
    { title: "Add check", value: "add" },
    ...checks.map((check, index) => ({ title: check.id, value: `check:${index}`, description: check.command })),
    { title: "Use inherited checks", value: "reset", description: checkText(view.inherited.checks) },
    { title: "Disable configured checks", value: "disable", description: "Explicit empty list. Verification may be incomplete." },
  ] })
  if (!active() || !action) return
  if (action === "reset") { delete draft.checks; return }
  if (action === "disable") {
    const confirmed = await ctx.ui.dialog.confirm({ title: "Disable configured checks?", message: "An empty project check list disables inherited and automatically detected checks. Workflows still require independent review and verification evidence to claim success." })
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
function modelValue(models: ModelOptions | undefined, path: string): string | undefined {
  if (path === "default") return models?.default
  const [scope, key] = path.split(".")
  return (models?.[scope as "roles" | "stages"] as Record<string, string> | undefined)?.[key!]
}
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

async function editModel(ctx: Context, view: SettingsView, draft: EditableSettings, active: () => boolean) {
  const field = await ctx.ui.dialog.select({ title: "Workflow models", placeholder: "Stage settings take precedence over role settings", options: modelFields.map(field => ({ ...field,
    description: `${modelValue(draft.models, field.value) ?? modelValue(view.inherited.models, field.value) ?? "Uses remaining model rules"} · ${modelValue(draft.models, field.value) === undefined ? "inherited" : "project override"}`,
  })) })
  if (!active() || !field) return
  const selected = await ctx.ui.dialog.select({ title: "Select workflow model", placeholder: "Only connected models with tool support are listed", options: [
    { title: "Use inherited value", value: "reset", description: modelValue(view.inherited.models, field) ?? "Uses remaining model rules" },
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

function changes(view: SettingsView, draft: EditableSettings): string {
  return [...modelFields.filter(field => modelValue(view.overrides.models, field.value) !== modelValue(draft.models, field.value))
    .map(field => `${field.title}: ${modelValue(view.overrides.models, field.value) ?? "inherited"} → ${modelValue(draft.models, field.value) ?? "inherited"}`),
    ...limitFields.filter(field => view.overrides.limits?.[field.value] !== draft.limits?.[field.value])
      .map(field => `${field.title}: ${limitText(view.overrides.limits?.[field.value], field.seconds)} → ${limitText(draft.limits?.[field.value], field.seconds)}`),
    ...(JSON.stringify(view.overrides.checks) === JSON.stringify(draft.checks) ? [] : [`Checks before:\n${checkText(view.overrides.checks ?? view.inherited.checks)}\nChecks after:\n${checkText(draft.checks ?? view.inherited.checks)}${draft.checks === undefined ? "\nUse inherited checks / automatic discovery." : "\nProject check list replaces inherited checks."}`]),
  ].join("\n")
}

export async function editProjectSettings(ctx: Context, sessionId: string, rpc: SettingsRpc, current: () => boolean, signal: AbortSignal): Promise<void> {
  const active = () => !signal.aborted && current()
  const location = ctx.location ?? ctx.data.location.default()
  try {
    const view = await rpc.settings({ sessionId }, { location, signal }) as SettingsView
    if (!active()) return
    if (!view?.effective || !view.inherited || !view.overrides || !view.path || !view.revision) throw new Error("The server returned no editable project settings")
    const draft = structuredClone(view.overrides)
    while (active()) {
      const changed = JSON.stringify(draft) !== JSON.stringify(view.overrides)
      const selected = await ctx.ui.dialog.select({ title: "Ultra project settings", placeholder: view.blocked ?? `Project overrides: ${view.path}`, options: [
        { title: "Models", value: "models", description: "Default model, roles, stages and variants" },
        { title: "Limits", value: "limits", description: "Concurrency, attempts, deadlines and context" },
        { title: "Checks", value: "checks", description: "Configured verification commands" },
        { title: "Review changes", value: "review", disabled: !changed },
        { title: "Save project settings", value: "save", description: view.blocked ?? "Applies to new workflows; global defaults stay unchanged", disabled: !changed || !!view.blocked },
      ] })
      if (!active() || !selected) return
      if (selected === "models") await editModel(ctx, view, draft, active)
      else if (selected === "limits") await editLimit(ctx, view, draft, active)
      else if (selected === "checks") await editChecks(ctx, view, draft, active)
      else if (selected === "review") await ctx.ui.dialog.alert({ title: "Project setting changes", message: changes(view, draft) || "No changes" })
      else if (selected === "save") {
        if (!changed || view.blocked) continue
        const confirmed = await ctx.ui.dialog.confirm({ title: "Save project settings", message: `${view.path}\n\n${changes(view, draft)}\n\nChanges apply to new workflows. Saved plans may need fresh planning because the project configuration changes.`, label: { confirm: "Save project settings", cancel: "Keep editing" } })
        if (!active()) return
        if (!confirmed) continue
        try {
          await rpc.saveSettings({ sessionId, revision: view.revision, options: draft }, { location, signal })
          if (active()) ctx.ui.toast.show({ title: "Ultra settings saved", message: "Project settings apply to new workflows in this location. Global defaults are unchanged.", variant: "success", sessionID: sessionId })
        } catch (error) {
          if (active()) await ctx.ui.dialog.alert({ title: "Unable to confirm settings save", message: `${error instanceof Error ? error.message : "Save request failed"}\nReopen the editor to read current settings before trying again.` })
        }
        return
      } else return
    }
  } catch (error) {
    if (active()) await ctx.ui.dialog.alert({ title: "Ultra settings unavailable", message: error instanceof Error ? error.message : "Unable to load project settings" })
  }
}

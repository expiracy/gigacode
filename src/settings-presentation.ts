import { roles, stages } from "./config.ts"
import type { CheckSpec, Limits, ModelOptions } from "./types.ts"
import type { EditableSettings, SettingsView } from "./settings.ts"

export function scopeLabel(view: SettingsView): string { return view.scope === "global" ? "Global defaults" : "This project" }
export function settingsBack(view: SettingsView) { return { title: view.scope === "global" ? "Back to global defaults" : "Back to project settings", value: "back", category: "Navigation" } }
export function settingSource(view: SettingsView, overridden: boolean): string {
  return overridden ? view.scope === "global" ? "global default" : "project override" : view.scope === "global" ? "built-in default" : "inherited"
}
export function writerPolicy(parallel: boolean): string { return parallel ? "Isolated parallel writers" : "Serial writers" }
export function modelText(reference: string | undefined): string { return reference === "inherit" ? "Chat model" : reference ?? "Other model rules" }

export const modelFields = [{ title: "Workflow default", value: "default", category: "Default" },
  ...roles.map(role => ({ title: `Role: ${role}`, value: `roles.${role}`, category: "Roles" })),
  ...stages.map(stage => ({ title: `Stage: ${stage}`, value: `stages.${stage}`, category: "Stages" })),
]
export const limitFields: { title: string; value: keyof Limits; description: string; seconds?: boolean }[] = [
  { title: "Workers", value: "workers", description: "Maximum concurrent workers per workflow" },
  { title: "Runs", value: "runs", description: "Maximum concurrent workflows" },
  { title: "Attempts", value: "attempts", description: "Total worker attempts per workflow" },
  { title: "Repair rounds", value: "repairRounds", description: "Maximum repair rounds; zero disables repairs" },
  { title: "Worker deadline", value: "workerMs", seconds: true, description: "Time allowed for one worker" },
  { title: "Active run deadline", value: "runMs", seconds: true, description: "Total active workflow time" },
  { title: "Elapsed deadline", value: "elapsedMs", seconds: true, description: "Wall time including pauses" },
  { title: "Steps", value: "steps", description: "Maximum model steps per worker" },
  { title: "Context characters", value: "contextChars", description: "GigaCode prompt content budget; host history and tools also use model context" },
]
export function limitText(value: number | undefined, seconds?: boolean): string {
  return value === undefined ? "inherited" : seconds ? `${value / 1000} seconds` : String(value)
}

export function checkText(checks: CheckSpec[] | undefined): string {
  if (checks === undefined) return "inherited checks / automatic discovery"
  if (!checks.length) return "No checks: workflows cannot claim verified success without verification evidence."
  return checks.map(check => `${check.id}: ${check.command}\n  Criteria: ${check.criterionIds.join(", ") || "none"}; timeout: ${check.timeoutMs === undefined ? "worker deadline" : limitText(check.timeoutMs, true)}`).join("\n")
}

export function modelValue(models: ModelOptions | undefined, path: string): string | undefined {
  if (path === "default") return models?.default
  const [scope, key] = path.split(".")
  return (models?.[scope as "roles" | "stages"] as Record<string, string> | undefined)?.[key!]
}
export function changes(view: SettingsView, draft: EditableSettings): string {
  const fallback = view.scope === "global" ? "built-in default" : "inherited"
  const model = (options: EditableSettings, path: string) => modelValue(options.models, path) === undefined
    ? `${fallback} (${modelText(modelValue(view.inherited.models, path))})`
    : modelText(modelValue(options.models, path))
  const limit = (options: EditableSettings, field: typeof limitFields[number]) => options.limits?.[field.value] === undefined
    ? `${fallback} (${limitText(view.inherited.limits[field.value], field.seconds)})`
    : limitText(options.limits[field.value], field.seconds)
  const checks = (value: CheckSpec[] | undefined) => value === undefined && view.scope === "global" ? "Automatic discovery in each project, unless overridden." : checkText(value ?? view.inherited.checks)
  const writer = (value: boolean | undefined) => value === undefined ? `${fallback} (${writerPolicy(view.inherited.parallelWrites)})` : writerPolicy(value)
  const threshold = (value: number | undefined) => value === undefined ? `${fallback} (${view.inherited.autoThreshold} characters)` : `${value} characters`
  const instructions = (options: EditableSettings, role: typeof roles[number]) => options.prompts?.[role] ?? `${fallback}:\n${view.inherited.prompts?.[role] ?? "Built-in role guidance"}`
  return [...modelFields.filter(field => modelValue(view.overrides.models, field.value) !== modelValue(draft.models, field.value))
    .map(field => `${field.title}: ${model(view.overrides, field.value)} → ${model(draft, field.value)}`),
    ...limitFields.filter(field => view.overrides.limits?.[field.value] !== draft.limits?.[field.value])
      .map(field => `${field.title}: ${limit(view.overrides, field)} → ${limit(draft, field)}`),
    ...(view.overrides.parallelWrites === draft.parallelWrites ? [] : [`Writer policy: ${writer(view.overrides.parallelWrites)} → ${writer(draft.parallelWrites)}`]),
    ...(view.overrides.autoThreshold === draft.autoThreshold ? [] : [`Automatic-mode threshold: ${threshold(view.overrides.autoThreshold)} → ${threshold(draft.autoThreshold)}`]),
    ...roles.filter(role => view.overrides.prompts?.[role] !== draft.prompts?.[role])
      .map(role => `Role instructions (${role})\nBefore:\n${instructions(view.overrides, role)}\nAfter:\n${instructions(draft, role)}`),
    ...(JSON.stringify(view.overrides.checks) === JSON.stringify(draft.checks) ? [] : [`Checks before:\n${checks(view.overrides.checks)}\nChecks after:\n${checks(draft.checks)}${draft.checks === undefined ? "" : view.scope === "global" ? "\nGlobal check list applies unless a project overrides it." : "\nProject check list replaces inherited checks."}`]),
  ].join("\n")
}

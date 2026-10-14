import { roles, stages } from "./config.ts"
import type { CheckSpec, Limits, ModelOptions } from "./types.ts"
import type { EditableSettings, SettingsView } from "./settings.ts"

export function scopeLabel(view: SettingsView): string { return view.scope === "global" ? "Global defaults" : "This project" }
export function settingSource(view: SettingsView, overridden: boolean): string {
  return overridden ? view.scope === "global" ? "global default" : "project override" : view.scope === "global" ? "built-in default" : "inherited"
}

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
  { title: "Context characters", value: "contextChars", description: "Ultra prompt content budget; host history and tools also use model context" },
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
  const limit = (options: EditableSettings, field: typeof limitFields[number]) => options.limits?.[field.value] === undefined
    ? `${fallback} (${limitText(view.inherited.limits[field.value], field.seconds)})`
    : limitText(options.limits[field.value], field.seconds)
  const checks = (value: CheckSpec[] | undefined) => value === undefined && view.scope === "global" ? "Automatic discovery in each project, unless overridden." : checkText(value ?? view.inherited.checks)
  return [...modelFields.filter(field => modelValue(view.overrides.models, field.value) !== modelValue(draft.models, field.value))
    .map(field => `${field.title}: ${modelValue(view.overrides.models, field.value) ?? "inherited"} → ${modelValue(draft.models, field.value) ?? "inherited"}`),
    ...limitFields.filter(field => view.overrides.limits?.[field.value] !== draft.limits?.[field.value])
      .map(field => `${field.title}: ${limit(view.overrides, field)} → ${limit(draft, field)}`),
    ...(JSON.stringify(view.overrides.checks) === JSON.stringify(draft.checks) ? [] : [`Checks before:\n${checks(view.overrides.checks)}\nChecks after:\n${checks(draft.checks)}${draft.checks === undefined ? "" : view.scope === "global" ? "\nGlobal check list applies unless a project overrides it." : "\nProject check list replaces inherited checks."}`]),
  ].join("\n")
}

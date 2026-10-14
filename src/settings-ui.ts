import type { Context } from "@opencode/plugin/tui/context"
import type { EditableSettings, SettingsScope, SettingsView } from "./settings.ts"
import { editModel } from "./settings-models-ui.ts"
import { editLimit } from "./settings-limits-ui.ts"
import { editChecks } from "./settings-checks-ui.ts"
import { changes, scopeLabel } from "./settings-presentation.ts"

export interface SettingsRpc {
  settings(input: { sessionId: string; scope?: SettingsScope }, options: { location: { directory: string }; signal: AbortSignal }): Promise<unknown>
  saveSettings(input: { sessionId: string; scope?: SettingsScope; revision: string; options: EditableSettings }, options: { location: { directory: string }; signal: AbortSignal }): Promise<unknown>
}

export async function editSettings(ctx: Context, sessionId: string, rpc: SettingsRpc, current: () => boolean, signal: AbortSignal, scope: SettingsScope = "project"): Promise<"back" | void> {
  const active = () => !signal.aborted && current()
  const location = ctx.location ?? ctx.data.location.default()
  try {
    const scopeInput = scope === "global" ? { scope } : {}
    const view = await rpc.settings({ sessionId, ...scopeInput }, { location, signal }) as SettingsView
    if (!active()) return
    if (!view?.effective || !view.inherited || !view.overrides || !view.path || !view.revision) throw new Error("The server returned no editable project settings")
    if (scope === "global" && view.scope !== "global") throw new Error("Reload the updated Ultra plugin before editing global defaults.")
    view.scope = scope
    const title = scope === "global" ? "Ultra global defaults" : "Ultra project settings"
    const saveTitle = scope === "global" ? "Save global defaults" : "Save project settings"
    const impact = scope === "global" ? "All projects using this OpenCode profile. Project overrides take precedence. Reload OpenCode to apply global defaults across projects; existing runs keep their captured settings." : "Changes apply to new workflows. Saved plans may need fresh planning because the project configuration changes."
    const draft = structuredClone(view.overrides)
    while (active()) {
      const changed = JSON.stringify(draft) !== JSON.stringify(view.overrides)
      const selected = await ctx.ui.dialog.select({ title, placeholder: view.blocked ?? `${changed ? "Unsaved changes · " : ""}${scope === "global" ? "All projects; project overrides take precedence" : "This project only"}`, options: [
        { title: "Models", value: "models", description: "Default model, roles, stages and variants" },
        { title: "Limits", value: "limits", description: "Concurrency, attempts, deadlines and context" },
        { title: "Checks", value: "checks", description: "Configured verification commands" },
        { title: "Advanced configuration", value: "advanced", description: "Role instructions, writer policy and automatic mode · JSON" },
        { title: "Review changes", value: "review", disabled: !changed },
        { title: saveTitle, value: "save", description: view.blocked ?? (scope === "global" ? "All projects; reload OpenCode after saving" : "Applies to new workflows; global defaults stay unchanged"), disabled: !changed || !!view.blocked },
        { title: "Change scope", value: "back", description: "Choose project settings or global defaults" },
      ] })
      if (!active()) return
      if (!selected || selected === "back") {
        if (changed) {
          const discard = await ctx.ui.dialog.confirm({ title: "Discard unsaved changes?", message: `${view.path}\n\n${changes(view, draft)}\n\nThese changes have not been saved. ${selected === "back" ? "Return to scope selection without carrying this draft over?" : "Close the editor and discard this draft?"}`, label: { confirm: "Discard changes", cancel: "Keep editing" } })
          if (!active()) return
          if (!discard) continue
        }
        return "back"
      }
      if (selected === "models") await editModel(ctx, view, draft, active)
      else if (selected === "limits") await editLimit(ctx, view, draft, active)
      else if (selected === "checks") await editChecks(ctx, view, draft, active)
      else if (selected === "advanced") await ctx.ui.dialog.alert({ title: "Advanced configuration", message: `${scopeLabel(view)}\n${view.path}\n\nThese effective options are edited in JSON configuration:\n\n${JSON.stringify({ prompts: view.effective.prompts, parallelWrites: view.effective.parallelWrites, autoThreshold: view.effective.autoThreshold }, null, 2)}` })
      else if (selected === "review") await ctx.ui.dialog.alert({ title: "Setting changes", message: `${impact}\n\n${changes(view, draft) || "No changes"}` })
      else if (selected === "save") {
        if (!changed || view.blocked) continue
        const confirmed = await ctx.ui.dialog.confirm({ title: saveTitle, message: `${view.path}\n\n${changes(view, draft)}\n\n${impact}`, label: { confirm: saveTitle, cancel: "Keep editing" } })
        if (!active()) return
        if (!confirmed) continue
        try {
          await rpc.saveSettings({ sessionId, ...scopeInput, revision: view.revision, options: draft }, { location, signal })
          if (active()) ctx.ui.toast.show({ title: "Ultra settings saved", message: scope === "global" ? "Global defaults saved. Reload OpenCode to apply them across projects. Project overrides still take precedence." : "Project settings apply to new workflows in this location. Global defaults are unchanged.", variant: "success", sessionID: sessionId })
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
